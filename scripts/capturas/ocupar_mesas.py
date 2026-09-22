"""Deja el salón como está un restaurante a media tarde.

Mesas ocupadas **y el riel de canales con vida**: pedidos para llevar
esperando en el mostrador y domicilios en camino. El generador cobra todas
sus comandas, así que al terminar el salón queda vacío por los cuatro
costados, y el riel de `m2b` —que existe justamente para que el mesero
atienda mostrador y domicilios sin cambiar de pantalla— no tendría nada que
mostrar.

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
from app.orders.schemas import (
    AddItemsIn,
    DeliveryIn,
    ModifierSelectionIn,
    OrderCreateIn,
    OrderItemIn,
    TakeoutIn,
)
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


#: El riel: qué hay en mostrador y en la calle. Nombre, qué pidieron y si ya
#: se marchó — un pedido marchado está «en cocina», uno sin marchar «tomando
#: pedido», y con domiciliario asignado «en camino».
PARA_LLEVAR = [
    ("Camila Arbeláez", ["Bandeja paisa", "Limonada de coco"], 11, True),
    ("Jhon Sepúlveda", ["Arroz con pollo", "Gaseosa"], 6, True),
    ("Mostrador", ["Empanadas de carne (x3)", "Jugo de mango"], 2, False),
]
DOMICILIOS = [
    ("Cra 11 #65-40", "3125558841", ["Pescado frito (mojarra)", "Limonada de coco"], 14),
    ("Calle 72 #9-15, apto 502", "3004417790", ["Lomo al trapo", "Cerveza Águila"], 9),
]


def _armar_el_local(db, store) -> None:
    """Le da al salón las referencias y la barra que un local real tiene.

    Van acá y no en el seed porque son decisiones DE ESTE local: otro
    restaurante tiene otro ventanal y puede no tener barra. El seed deja un
    salón genérico; este guion lo convierte en Chapinero.
    """
    from app.stores.models import Zone

    referencias = {"Salón": "Entrada|Ventanal / Calle 63|Paso a cocina", "Terraza": "Escaleras|Jardín"}
    for zona in db.execute(select(Zone).where(Zone.store_id == store.id)).scalars():
        if zona.name in referencias:
            zona.landmarks = referencias[zona.name]

    # La última mesa pasa a ser la barra: seis puestos, y el plano la dibuja
    # como una tira en vez de una tarjeta.
    barra = db.execute(
        select(Table).where(Table.store_id == store.id, Table.number == "8")
    ).scalar_one_or_none()
    if barra is not None:
        barra.is_counter = True
        barra.number = "Barra"
        barra.seats = 6
    db.flush()


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

    _armar_el_local(db, store)

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

    # ── El riel: para llevar y domicilios ───────────────────────────────────
    canales = []
    try:
        for nombre, platos, hace, marchada in PARA_LLEVAR:
            clock.set_clock(lambda t=base - timedelta(minutes=hace): t)
            orden = orders_service.create_order(
                db, actor=actor, store=store,
                payload=OrderCreateIn(channel="takeout", takeout=TakeoutIn(customer_name=nombre)),
            )
            db.flush()
            items = [
                OrderItemIn(product_id=p.id, qty=1, modifiers=_modificadores(db, p, rng))
                for p in (por_nombre.get(n) for n in platos) if p is not None
            ]
            orden = orders_service.add_items(
                db, order=orden, actor=actor,
                payload=AddItemsIn(expected_version=orden.version, items=items),
            )
            if marchada:
                orden = orders_service.send_order(db, order=orden, actor=actor, expected_version=orden.version)
            db.commit()
            canales.append(("para llevar", nombre, orders_service.compute_order_totals(db, orden).total))

        domiciliario = db.execute(select(Employee).where(Employee.name == "Wilson Tabares")).scalar_one_or_none()
        if domiciliario is not None and "delivery" in (store.active_channels or []):
            for direccion, telefono, platos, hace in DOMICILIOS:
                clock.set_clock(lambda t=base - timedelta(minutes=hace): t)
                orden = orders_service.create_order(
                    db, actor=actor, store=store,
                    payload=OrderCreateIn(
                        channel="delivery",
                        delivery=DeliveryIn(address=direccion, phone=telefono,
                                            courier_employee_id=domiciliario.id),
                    ),
                )
                db.flush()
                items = [
                    OrderItemIn(product_id=p.id, qty=1, modifiers=_modificadores(db, p, rng))
                    for p in (por_nombre.get(n) for n in platos) if p is not None
                ]
                orden = orders_service.add_items(
                    db, order=orden, actor=actor,
                    payload=AddItemsIn(expected_version=orden.version, items=items),
                )
                orden = orders_service.send_order(db, order=orden, actor=actor, expected_version=orden.version)
                db.commit()
                canales.append(("domicilio", direccion, orders_service.compute_order_totals(db, orden).total))
    finally:
        clock.set_clock(None)

    for numero, comensales, n, total, hace, marchada in abiertas:
        estado = "marchada" if marchada else "SIN marchar (recién tomada)"
        print(f"  mesa {numero}: {comensales} comensales. {n} ítems. ${total:,}"
              f". hace {hace} min. {estado}".replace(",", "."))
    for canal, quien, total in canales:
        print(f"  {canal}: {quien} — ${total:,}".replace(",", "."))
    print(f"\n  {len(abiertas)} mesas ocupadas, {len(mesas) - len(abiertas)} libres; "
          f"{len(canales)} comandas en el riel.")


if __name__ == "__main__":
    main()
