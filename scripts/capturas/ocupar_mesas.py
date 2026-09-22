"""Deja el salón como está un restaurante a media tarde: con mesas ocupadas.

El generador cobra todas sus comandas, así que al terminar las ocho mesas
quedan libres. Un salón vacío a las seis de la tarde no es el estado de un
restaurante que funciona, y el video tiene que mostrar el que funciona.

Pasa por los servicios reales, igual que `app.demo_operacion`: las comandas
quedan abiertas contra el turno abierto de verdad, con sus ítems.
"""
import random
import sys
from datetime import timedelta

from sqlalchemy import select

from app.auth.deps import Actor
from app.auth.models import Employee
from app.catalog.models import ModifierGroup, ModifierOption, Product
from app.core import clock
from app.core.db import SessionLocal
from app.core.models_registry import import_all_models
from app.orders import service as orders_service
from app.orders.schemas import AddItemsIn, ModifierSelectionIn, OrderCreateIn, OrderItemIn
from app.shifts.models import Shift, ShiftStatus
from app.stores.models import Store, Table

import_all_models()

#: Qué mesa, cuántos comensales, qué pidieron, hace cuántos minutos, y si ya
#: se marchó a cocina. `number` es TEXTO en el modelo, no un entero — la
#: primera versión de esto buscaba por `2` y no encontraba ninguna mesa, en
#: silencio.
#:
#: **Lo de marchar importa.** El servidor marca una mesa como demorada cuando
#: lleva más de `UNSENT_MINUTES_THRESHOLD` (15 min) con platos sin enviar a
#: cocina. Si el guion abre tres mesas y no marcha ninguna, a los quince
#: minutos las tres se ponen rojas y el plano queda todo en alarma — que es
#: la misma falla que «una diferencia que aparece todos los días enseña a
#: ignorar las diferencias». Un salón real tiene casi todo marchado y a lo
#: sumo una mesa atrasada.
MESAS = [
    ("2", 2, ["Bandeja paisa", "Limonada de coco", "Gaseosa"], 18, True),
    ("5", 4, ["Ajiaco santafereño", "Pescado frito (mojarra)", "Arroz con pollo",
              "Jugo de mango", "Cerveza Águila"], 34, True),
    # Ésta sí queda sin marchar y sin pasar el umbral: es la mesa que el mesero
    # acaba de tomar.
    ("7", 3, ["Lomo al trapo", "Pechuga a la plancha", "Limonada de coco"], 6, False),
]


def _modificadores(db, producto, rng):
    """Sólo los obligatorios: la bandeja y el lomo piden término de la carne."""
    salida = []
    for g in db.execute(select(ModifierGroup).where(ModifierGroup.product_id == producto.id)).scalars():
        if not g.required and g.min <= 0:
            continue
        opciones = list(
            db.execute(select(ModifierOption.id).where(ModifierOption.modifier_group_id == g.id)).scalars()
        )
        if opciones:
            salida.append(ModifierSelectionIn(option_id=rng.choice(opciones)))
    return salida


def main() -> None:
    rng = random.Random(7)
    db = SessionLocal()
    store = db.execute(select(Store).order_by(Store.id)).scalars().first()
    turno = db.execute(
        select(Shift).where(Shift.store_id == store.id, Shift.status == ShiftStatus.OPEN)
    ).scalar_one_or_none()
    if turno is None:
        sys.exit("No hay turno abierto: corré `app.demo_operacion --meses 0 --hoy-en-curso` antes.")

    mesero = db.execute(select(Employee).where(Employee.name == "Katherine Arango")).scalar_one_or_none()
    if mesero is None:
        sys.exit("Falta el elenco: corré el generador antes.")
    actor = Actor(kind="device", organization_id=store.organization_id, store_id=store.id,
                  employee_id=mesero.id, employee_name=mesero.name, role=mesero.role)

    por_nombre = {p.name: p for p in db.execute(select(Product).where(Product.store_id == store.id)).scalars()}
    mesas = {t.number: t for t in db.execute(select(Table).where(Table.store_id == store.id)).scalars()}

    base = clock.now_utc()
    abiertas = []
    try:
        # Escalonadas hacia atrás: la mesa 2 lleva más rato sentada que la 7.
        for numero, comensales, platos, hace_minutos, marchada in MESAS:
            mesa = mesas.get(numero)
            if mesa is None:
                print(f"  (no existe la mesa {numero})")
                continue
            clock.set_clock(lambda t=base - timedelta(minutes=hace_minutos): t)
            orden = orders_service.create_order(
                db, actor=actor, store=store,
                payload=OrderCreateIn(channel="dine_in", table_ids=[mesa.id], covers=comensales),
            )
            db.flush()
            items = [
                OrderItemIn(product_id=p.id, qty=1, modifiers=_modificadores(db, p, rng))
                for p in (por_nombre.get(n) for n in platos)
                if p is not None
            ]
            if not items:
                continue
            orden = orders_service.add_items(
                db, order=orden, actor=actor,
                payload=AddItemsIn(expected_version=orden.version, items=items),
            )
            if marchada:
                orden = orders_service.send_order(
                    db, order=orden, actor=actor, expected_version=orden.version
                )
            db.commit()
            abiertas.append(
                (numero, comensales, len(items),
                 orders_service.compute_order_totals(db, orden).total, hace_minutos, marchada)
            )
    finally:
        clock.set_clock(None)

    for numero, comensales, n, total, hace, marchada in abiertas:
        estado = "marchada" if marchada else "SIN marchar (recién tomada)"
        print(f"  mesa {numero}: {comensales} comensales. {n} ítems. ${total:,}"
              f". hace {hace} min. {estado}".replace(",", "."))
    print(f"\n  {len(abiertas)} mesas ocupadas, {len(mesas) - len(abiertas)} libres.")


if __name__ == "__main__":
    main()
