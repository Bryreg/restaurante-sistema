"""Corre la operación simulada de `app.demo` contra la base del despliegue.

Proceso aparte, lanzado por `app.ops.demo_once`. Qué cambia respecto de
`python -m app.demo`, todo SÓLO dentro de este proceso:

- Las claves: en vez de las de desarrollo escritas en `app.demo`, usa las
  reales que el dueño puso en `DEMO_CLAVES` (admin, PIN de sede y PIN de cada
  persona). Toda llamada pasa por la API con su verificación normal.
- La apertura: la demo abre con base fija y la sede abre hoy por sobres. Se
  pasa a base fija mientras dura la simulación y se devuelve a sobres al
  final, pase lo que pase.
- El turno abandonado que haya quedado abierto se cierra antes con el cierre
  administrativo (con motivo), porque la simulación abre un turno por día.
- No corre dos veces: si la sede ya tiene cinco turnos cerrados, sale.
- `--continuar`: sobre una demo ya cargada, simula sólo los días que faltan
  desde el último turno cerrado hasta AYER (el día de hoy lo vive la sede en
  tiempo real). Sin días que faltan, sale sin hacer nada.
"""

from __future__ import annotations

import argparse
import json
import os

from sqlalchemy import func, select


def _set_opening_mode(mode: str) -> None:
    from app.core.db import SessionLocal
    from app.stores.models import StoreCashSettings

    with SessionLocal() as db:
        for cs in db.execute(select(StoreCashSettings)).scalars():
            cs.opening_mode = mode
        db.commit()


def _already_loaded() -> bool:
    from app.core.db import SessionLocal
    from app.shifts.models import Shift

    with SessionLocal() as db:
        closed = db.execute(select(func.count()).select_from(Shift).where(Shift.status == "closed")).scalar_one()
    return int(closed) >= 5


def _missing_days() -> list:
    """Los días operativos entre el último turno cerrado y ayer (Bogotá)."""
    from datetime import timedelta

    from app.core import tz
    from app.core.db import SessionLocal
    from app.shifts.models import BusinessDay, Shift
    from app.stores.models import Store

    with SessionLocal() as db:
        store = db.execute(select(Store).order_by(Store.id)).scalars().first()
        if store is None:
            return []
        last = db.execute(
            select(func.max(BusinessDay.business_date))
            .join(Shift, Shift.business_day_id == BusinessDay.id)
            .where(Shift.store_id == store.id, Shift.status == "closed")
        ).scalar_one()
        yesterday = tz.today_business_date(store.cutoff_hour) - timedelta(days=1)
    if last is None or last >= yesterday:
        return []
    return [last + timedelta(days=i) for i in range(1, (yesterday - last).days + 1)]


def _use_real_credentials(demo: object, claves: dict) -> None:
    pins: dict[str, str] = claves["pins"]
    demo.ADMIN = (claves["admin_email"], claves["admin_password"])  # type: ignore[attr-defined]
    demo.STORE_PIN = claves["store_pin"]  # type: ignore[attr-defined]
    if "Admin Demo" in pins:
        demo.ADMIN_PIN = pins["Admin Demo"]  # type: ignore[attr-defined]
    if "Supervisor Demo" in pins:
        demo.SUPERVISOR_PIN = pins["Supervisor Demo"]  # type: ignore[attr-defined]
    demo.STAFF = [  # type: ignore[attr-defined]
        (name, role, pins.get(name, pin), can_charge, area, wage)
        for name, role, pin, can_charge, area, wage in demo.STAFF  # type: ignore[attr-defined]
    ]


def _close_abandoned(sim: object) -> None:
    """Cierre administrativo de los turnos que quedaron abiertos de días
    anteriores, con motivo, por la puerta de la API."""
    api = sim.admin  # type: ignore[attr-defined]
    for shift in api.get(f"/admin/shifts?store_id={sim.store_id}&include_open=true") or []:  # type: ignore[attr-defined]
        if shift.get("status") == "open":
            sim.attempt(  # type: ignore[attr-defined]
                f"cerrar turno abandonado {shift['id']}",
                api.post,
                f"/admin/shifts/{shift['id']}/close-administrative",
                {"reason": "Turno de prueba abandonado; se cierra para cargar la operación de demostración."},
            )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--days", type=int, default=14)
    parser.add_argument("--seed", type=int, default=2026)
    parser.add_argument("--continuar", action="store_true")
    args = parser.parse_args()

    days: list = []
    if args.continuar:
        days = _missing_days()
        if not days:
            print("demo_run: no faltan días; la operación ya llega hasta ayer.", flush=True)
            return
    elif _already_loaded():
        print("demo_run: la sede ya tiene operación cargada; no se repite.", flush=True)
        return

    import app.demo as demo
    from app.core import clock, security

    _use_real_credentials(demo, json.loads(os.environ["DEMO_CLAVES"]))
    # Igual que `python -m app.demo`: sólo en este proceso, la expiración del
    # JWT se valida contra el reloj simulado (los días corren en el pasado).
    security.read_token = demo._read_token_on_clock  # type: ignore[assignment]
    import app.auth.deps as deps

    if hasattr(deps, "read_token"):
        deps.read_token = demo._read_token_on_clock  # type: ignore[attr-defined]

    if args.continuar:
        print(f"demo_run: continuando {len(days)} días: {days[0]} a {days[-1]}…", flush=True)
    else:
        print(f"demo_run: simulando {args.days} días…", flush=True)
    # Otra semilla al continuar: días nuevos, no una copia de los primeros.
    sim = demo.Demo(days=len(days) or args.days, seed=args.seed + (len(days) and days[0].toordinal()))
    # En producción la cookie de sesión es `Secure`: el cliente en proceso
    # tiene que hablar por https para que la guarde y la devuelva.
    from fastapi.testclient import TestClient

    from app.main import app as asgi_app

    sim.admin.c = TestClient(asgi_app, base_url="https://testserver")  # type: ignore[attr-defined]
    sim.pos.c = TestClient(asgi_app, base_url="https://testserver")  # type: ignore[attr-defined]
    _set_opening_mode("fixed_base")
    try:
        if args.continuar:
            demo.set_local(days[0], "06:30")
            sim.login()
            _close_abandoned(sim)
            sim.continue_days(days)
        else:
            sim.login()
            _close_abandoned(sim)
            sim.run()
    except Exception as exc:  # el resumen se imprime igual
        import traceback

        traceback.print_exc()
        sim.issues.append(f"El simulador se detuvo: {exc!r}")
    finally:
        clock.set_clock(None)
        _set_opening_mode("envelopes")

    for line in sim.day_summaries:
        print("demo_run: " + line, flush=True)
    print(f"demo_run: rechazos de la API: {len(sim.report.findings)}", flush=True)
    for f in sim.report.findings[:40]:
        print(f"demo_run:   {f.status} {f.method} {f.path} ({f.step}) {f.body[:160]}", flush=True)
    for issue in sim.issues:
        print("demo_run: obs: " + issue, flush=True)
    print("demo_run: terminado", flush=True)


if __name__ == "__main__":
    main()
