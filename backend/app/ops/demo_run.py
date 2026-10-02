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
- `--corregir-compras`: corrección única de las cantidades de las compras
  que el simulador cargó en unidad de compra (ver `_fix_purchase_units`).
  Con `--continuar` además, corrige y después continúa.
- `--corregir-minimos`: corrección única de los mínimos de stock que el seed
  viejo guardó mil veces más chicos (ver `_fix_seed_min_stock`).
- `--reabastecer`: el pedido de la mañana de hoy a todos los proveedores,
  con la misma regla del simulador (llegar a ~5 veces el mínimo). Para sacar
  de negativo lo que se quedó sin comprar.
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


def _fix_purchase_units() -> None:
    """Corrección única de la demo (2026-09-30): el simulador mandaba
    `qty_received` en UNIDAD DE COMPRA y la API lo guarda en UNIDAD BASE, así
    que cada compra de la demo entró dividida por `purchase_factor` (10 L de
    leche como 10 ml). La plata quedó bien (precio por unidad de compra,
    costo por unidad base, base de la factura); sólo las CANTIDADES están mal.

    Multiplica por el factor la cantidad de cada renglón mal cargado: el que
    tiene la base de la factura `factor` veces más alta que el costo por
    unidad base por la cantidad guardada (el seed y los borradores de la
    tablet estaban bien y no se tocan), el movimiento de inventario que generó y su lote. Después
    reparte el stock resultante de cada insumo entre sus lotes: lo último en
    vencer queda con saldo, lo primero ya se consumió (FEFO). Queda en la
    auditoría y no corre dos veces."""
    from app.audit.models import AuditLog
    from app.audit.service import record_audit
    from app.core.db import SessionLocal
    from app.inventory.models import Ingredient, StockBatch, StockMovement
    from app.purchases.models import Reception, ReceptionDraft, ReceptionLine

    with SessionLocal() as db:
        done = db.execute(
            select(AuditLog.id).where(AuditLog.entity == "demo_fix", AuditLog.action == "purchase_units")
        ).first()
        if done is not None:
            print("demo_run: la corrección de compras ya se aplicó; no se repite.", flush=True)
            return
        from_drafts = {
            r for (r,) in db.execute(select(ReceptionDraft.reception_id).where(ReceptionDraft.reception_id.is_not(None)))
        }
        rows = db.execute(
            select(ReceptionLine, Ingredient, Reception)
            .join(Ingredient, Ingredient.id == ReceptionLine.ingredient_id)
            .join(Reception, Reception.id == ReceptionLine.reception_id)
        ).all()
        fixed_lines = 0
        touched: dict[int, int] = {}  # ingredient_id -> store_id
        for line, ing, reception in rows:
            factor = int(ing.purchase_factor)
            if factor <= 1 or reception.id in from_drafts:
                continue
            # Sólo los renglones mal cargados: la plata quedó bien, así que la
            # base de la factura es `factor` veces lo que da el costo por
            # unidad base por la cantidad guardada. Uno bien cargado (el seed,
            # una recepción de verdad) da 1 y no se toca.
            implied = line.unit_cost_micros * line.qty_received_base / 1_000_000_000
            if implied <= 0 or line.tax_base <= 0 or abs(line.tax_base / implied - factor) > factor * 0.1:
                continue
            line.qty_received_base *= factor
            line.qty_invoiced_base *= factor
            if line.stock_movement_id is not None:
                movement = db.get(StockMovement, line.stock_movement_id)
                if movement is not None:
                    movement.qty_base *= factor
            for rev in db.execute(
                select(StockMovement).where(
                    StockMovement.ref_type == "reception_line_reversal", StockMovement.ref_id == line.id
                )
            ).scalars():
                rev.qty_base *= factor
            if line.stock_batch_id is not None:
                batch = db.get(StockBatch, line.stock_batch_id)
                if batch is not None:
                    batch.qty_received *= factor
            touched[ing.id] = reception.store_id
            fixed_lines += 1
        db.flush()

        for ingredient_id, store_id in touched.items():
            ledger = db.execute(
                select(func.coalesce(func.sum(StockMovement.qty_base), 0)).where(
                    StockMovement.store_id == store_id, StockMovement.ingredient_id == ingredient_id
                )
            ).scalar_one()
            left = max(0, int(ledger))
            batches = db.execute(
                select(StockBatch)
                .where(
                    StockBatch.store_id == store_id,
                    StockBatch.ingredient_id == ingredient_id,
                    StockBatch.reversed_at.is_(None),
                )
                .order_by(StockBatch.expires_at.is_(None).desc(), StockBatch.expires_at.desc(), StockBatch.received_at.desc())
            ).scalars()
            for batch in batches:
                batch.qty_remaining = min(batch.qty_received, left)
                left -= batch.qty_remaining

        audit_store_id: int | None = next(iter(touched.values()), None)
        organization_id = db.execute(select(Reception.organization_id)).scalars().first()
        if organization_id is not None:
            record_audit(
                db,
                actor=None,
                organization_id=organization_id,
                store_id=audit_store_id,
                entity="demo_fix",
                entity_id="purchase_units",
                action="purchase_units",
                before=None,
                after={"lines": fixed_lines, "ingredients": len(touched)},
                reason="Demo: compras cargadas en unidad de compra en vez de unidad base; se multiplican por el factor.",
            )
        db.commit()
    print(f"demo_run: compras corregidas: {fixed_lines} renglones, {len(touched)} insumos.", flush=True)
    _ensure_delivery_fee_product()


# Los mínimos que siembra `app/recipes/seed.py`, en unidad base. El seed de
# antes guardaba este entero crudo en una columna en milésimas.
SEED_MIN_STOCK = {
    "Pechuga de pollo": 2_000, "Pollo en pechuga": 2_000, "Papa criolla": 5_000, "Arroz blanco": 10_000,
    "Arroz": 10_000, "Limón": 50, "Panela": 3_000, "Gaseosa 400ml (botella)": 24, "Sal de mesa": 1_000,
    "Sal": 1_000,
}


def _fix_seed_min_stock() -> None:
    """Corrección única de la demo (2026-09-30): el seed de recetas de antes
    guardaba el mínimo de stock sin escalar (el limón con 0,05 unidades, la
    gaseosa con 0,024 botellas), así que esos insumos nunca quedaban «bajo
    mínimo» y el simulador no los volvía a pedir. Sólo toca los insumos del
    seed cuyo valor guardado es exactamente el entero crudo; queda en la
    auditoría y no corre dos veces."""
    from app.audit.models import AuditLog
    from app.audit.service import record_audit
    from app.core.db import SessionLocal
    from app.core.quantity import QTY_SCALE
    from app.inventory.models import Ingredient

    with SessionLocal() as db:
        done = db.execute(
            select(AuditLog.id).where(AuditLog.entity == "demo_fix", AuditLog.action == "seed_min_stock")
        ).first()
        if done is not None:
            print("demo_run: la corrección de mínimos ya se aplicó; no se repite.", flush=True)
            return
        fixed: list[Ingredient] = []
        for ing in db.execute(select(Ingredient).where(Ingredient.name.in_(SEED_MIN_STOCK))).scalars():
            if ing.min_stock == SEED_MIN_STOCK[ing.name]:
                ing.min_stock = SEED_MIN_STOCK[ing.name] * QTY_SCALE
                fixed.append(ing)
        if fixed:
            record_audit(
                db,
                actor=None,
                organization_id=fixed[0].organization_id,
                store_id=fixed[0].store_id,
                entity="demo_fix",
                entity_id="seed_min_stock",
                action="seed_min_stock",
                before=None,
                after={"ingredients": sorted(i.name for i in fixed)},
                reason="Demo: mínimos del seed guardados sin escalar; se multiplican por la escala de cantidades.",
            )
        db.commit()
    print(f"demo_run: mínimos corregidos: {len(fixed)} insumos.", flush=True)


def _ensure_delivery_fee_product() -> None:
    """La carta de la demo no tenía cargo de domicilio y la API rechazaba
    todo domicilio. Se crea uno por sede si falta (el mismo servicio que usa
    `POST /admin/products`)."""
    from app.catalog import service as catalog_service
    from app.catalog.models import Category
    from app.catalog.schemas import ProductIn, ProductPricesIn
    from app.core.db import SessionLocal
    from app.stores.models import Store

    with SessionLocal() as db:
        for store in db.execute(select(Store)).scalars():
            if catalog_service.get_delivery_fee_product(db, store.id) is not None:
                continue
            category = db.execute(
                select(Category).where(Category.store_id == store.id).order_by(Category.id.desc())
            ).scalars().first()
            if category is None:
                print(f"demo_run: la sede {store.id} no tiene categorías; sin cargo de domicilio.", flush=True)
                continue
            catalog_service.create_product(
                db,
                organization_id=store.organization_id,
                store_id=store.id,
                data=ProductIn(
                    category_id=category.id,
                    name="Cargo de domicilio",
                    prices=ProductPricesIn(dine_in=5_000, delivery=5_000),
                    is_delivery_fee=True,
                ),
            )
            print(f"demo_run: cargo de domicilio creado en la sede {store.id}.", flush=True)
        db.commit()


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
    parser.add_argument("--corregir-compras", action="store_true")
    parser.add_argument("--corregir-minimos", action="store_true")
    parser.add_argument("--reabastecer", action="store_true")
    args = parser.parse_args()

    days: list = []
    if args.corregir_compras:
        _fix_purchase_units()
    if args.corregir_minimos:
        _fix_seed_min_stock()
    if (args.corregir_compras or args.corregir_minimos) and not (args.continuar or args.reabastecer):
        return
    if args.continuar and not args.reabastecer:
        days = _missing_days()
        if not days:
            print("demo_run: no faltan días; la operación ya llega hasta ayer.", flush=True)
            return
    elif not args.reabastecer and _already_loaded():
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

    if args.reabastecer:
        print("demo_run: pedido de hoy a los proveedores…", flush=True)
    elif args.continuar:
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
        if args.reabastecer:
            from datetime import datetime

            today = datetime.now(demo.BOGOTA).date()
            demo.set_local(today, "07:00")
            sim.login()
            sim.load_existing()
            sim.restock(today, everyone=True)
            print(f"demo_run: pedido de hoy: {sim.report.counts['compras']} compras.", flush=True)
        elif args.continuar:
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
