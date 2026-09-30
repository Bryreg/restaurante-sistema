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
- `--reiniciar`: BORRA la base entera y vuelve a cargar la demo desde cero
  (esquema, seed, claves reales de `DEMO_CLAVES` y `--days` días de
  operación). Exige además `DEMO_REINICIAR=borrar-todo` en el entorno: dos
  llaves para lo que no tiene vuelta atrás.
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


RESET_CONFIRMATION = "borrar-todo"


def _reset_database(claves: dict) -> None:
    """Borra todo, migra, siembra y pone las claves reales. Sólo con las dos
    llaves (`--reiniciar` en el marcador y `DEMO_REINICIAR=borrar-todo`)."""
    from alembic import command
    from alembic.config import Config
    from pathlib import Path
    from sqlalchemy import text

    from app.auth.models import Employee
    from app.core.db import Base, SessionLocal, engine
    from app.core.models_registry import import_all_models
    from app.core.security import hash_secret
    from app.stores.models import Store

    import_all_models()
    dropped = False
    if engine.dialect.name == "postgresql":
        try:
            with engine.begin() as conn:
                conn.execute(text("SET lock_timeout = '60s'"))
                conn.execute(text("DROP SCHEMA public CASCADE"))
                conn.execute(text("CREATE SCHEMA public"))
            dropped = True
        except Exception as exc:  # sin permiso sobre el esquema: tabla por tabla
            print(f"demo_run: no se pudo borrar el esquema ({exc!r}); se borran las tablas.", flush=True)
    if not dropped:
        Base.metadata.drop_all(engine)
        with engine.begin() as conn:
            conn.execute(text("DROP TABLE IF EXISTS alembic_version"))
    backend_dir = Path(__file__).resolve().parents[2]
    command.upgrade(Config(str(backend_dir / "alembic.ini")), "head")
    print("demo_run: base borrada y migrada.", flush=True)

    from app import seed as seed_module

    with SessionLocal() as db:
        seed_module.seed(db)
    pins: dict[str, str] = claves["pins"]
    with SessionLocal() as db:
        for emp in db.execute(select(Employee)).scalars():
            if emp.email == seed_module.ADMIN_EMAIL:
                emp.email = claves["admin_email"]
                emp.password_hash = hash_secret(claves["admin_password"])
            if emp.name in pins:
                emp.pin_hash = hash_secret(pins[emp.name])
            if emp.name.startswith("Operador "):
                emp.active = False
        for store in db.execute(select(Store)).scalars():
            store.store_pin_hash = hash_secret(claves["store_pin"])
        db.commit()
    print("demo_run: seed con las claves reales.", flush=True)


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
    parser.add_argument("--reiniciar", action="store_true")
    args = parser.parse_args()

    days: list = []
    if args.reiniciar:
        if os.environ.get("DEMO_REINICIAR") != RESET_CONFIRMATION:
            print(
                f"demo_run: --reiniciar pide DEMO_REINICIAR={RESET_CONFIRMATION} en el entorno; no se borra nada.",
                flush=True,
            )
            return
        _reset_database(json.loads(os.environ["DEMO_CLAVES"]))
    elif args.continuar:
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
