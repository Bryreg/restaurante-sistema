"""Carta de desarrollo: `seed_catalog(db, store)`. La llama `app.seed.seed()`
(vía `find_spec`, nunca al arrancar la API) después de crear zonas y mesas.

Idempotente: si la sede ya tiene alguna categoría, no repite nada — así un
`python -m app.seed` corrido dos veces no duplica la carta.
"""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.catalog.models import Category, Combo, ComboGroup, ComboOption, ModifierGroup, ModifierOption, Product
from app.core import clock
from app.stores.models import Store
from app.stores.service import current_fiscal


def seed_catalog(db: Session, store: Store) -> None:
    if db.execute(select(Category).where(Category.store_id == store.id)).scalars().first() is not None:
        return

    org_id = store.organization_id
    now = clock.now_utc()
    fiscal = current_fiscal(db, store.id)
    default_tax = fiscal.default_tax if fiscal is not None else "inc_8"

    def _category(name: str, sort_order: int, course: str | None, station: str | None) -> Category:
        row = Category(
            organization_id=org_id,
            store_id=store.id,
            name=name,
            sort_order=sort_order,
            default_course=course,
            default_station=station,
            active=True,
        )
        db.add(row)
        db.flush()
        return row

    def _product(
        category: Category,
        name: str,
        price_dine_in: int,
        *,
        description: str | None = None,
        station: str | None = None,
        course: str | None = None,
        price_takeout: int | None = None,
        price_delivery: int | None = None,
        price_platform: int | None = None,
        is_delivery_fee: bool = False,
    ) -> Product:
        row = Product(
            organization_id=org_id,
            store_id=store.id,
            category_id=category.id,
            name=name,
            description=description,
            station=station if station is not None else category.default_station,
            default_course=course if course is not None else category.default_course,
            price_dine_in=price_dine_in,
            price_takeout=price_takeout,
            price_delivery=price_delivery,
            price_platform=price_platform,
            tax_code=default_tax,
            is_delivery_fee=is_delivery_fee,
            active=True,
            available=True,
            daily_count=None,
            daily_remaining=None,
            unavailable_by_employee_id=None,
            unavailable_by_employee_name=None,
            unavailable_at=None,
            created_at=now,
            updated_at=now,
        )
        db.add(row)
        db.flush()
        return row

    def _modifier_group(product: Product, name: str, *, required: bool, min_: int, max_: int) -> ModifierGroup:
        group = ModifierGroup(
            organization_id=org_id,
            store_id=store.id,
            product_id=product.id,
            name=name,
            required=required,
            min=min_,
            max=max_,
            sort_order=0,
        )
        db.add(group)
        db.flush()
        return group

    def _modifier_option(group: ModifierGroup, name: str, price_delta: int) -> ModifierOption:
        option = ModifierOption(
            organization_id=org_id,
            store_id=store.id,
            modifier_group_id=group.id,
            name=name,
            price_delta=price_delta,
            sort_order=0,
            available=True,
            recipe_effect=None,
        )
        db.add(option)
        db.flush()
        return option

    # -- Categorías -----------------------------------------------------------
    entradas = _category("Entradas", 1, "starter", "cold_kitchen")
    sopas = _category("Sopas", 2, "starter", "hot_kitchen")
    fuertes = _category("Platos Fuertes", 3, "main", "hot_kitchen")
    bebidas = _category("Bebidas", 4, "beverage", "bar")
    postres = _category("Postres", 5, "dessert", "desserts")

    # -- Entradas (4) -----------------------------------------------------------
    _product(entradas, "Patacón con hogao", 12_000)
    _product(entradas, "Empanadas de carne (x3)", 9_000)
    _product(entradas, "Ceviche de camarón", 28_000)
    _product(entradas, "Tostones con guacamole", 14_000)

    # -- Sopas (3) — grupo "Sopa" del corrientazo --------------------------------
    sancocho = _product(sopas, "Sancocho de gallina", 22_000)
    ajiaco = _product(sopas, "Ajiaco santafereño", 24_000)
    sopa_guineo = _product(sopas, "Sopa de guineo", 16_000)

    # -- Platos fuertes (7) — 3 con modificadores, 2 "principio" y 3 "proteína" --
    bandeja = _product(fuertes, "Bandeja paisa", 38_000, description="Frijoles, arroz, carne, chicharrón, huevo, aguacate y plátano")
    _modifier_group_bandeja = _modifier_group(bandeja, "Término de la carne", required=True, min_=1, max_=1)
    _modifier_option(_modifier_group_bandeja, "A punto", 0)
    _modifier_option(_modifier_group_bandeja, "Bien asado", 0)
    _modifier_option(_modifier_group_bandeja, "Poco asado", 0)

    frijoles = _product(fuertes, "Frijoles con garra", 26_000)
    lentejas = _product(fuertes, "Lentejas con chorizo", 24_000)

    pechuga = _product(fuertes, "Pechuga a la plancha", 30_000)
    modifier_group_pechuga = _modifier_group(pechuga, "Acompañamiento extra", required=False, min_=0, max_=2)
    _modifier_option(modifier_group_pechuga, "Papa criolla", 5_000)
    _modifier_option(modifier_group_pechuga, "Arroz", 3_000)
    _modifier_option(modifier_group_pechuga, "Ensalada", 0)

    arroz_con_pollo = _product(fuertes, "Arroz con pollo", 26_000)
    # Pedido 2c (§4.3): precio por canal — éste tiene delivery y platform
    # PROPIOS (distintos del de mesa); el resto de la carta (arriba y abajo)
    # se queda sin ellos a propósito, para que el fallback al precio de mesa
    # también se vea sembrado (`test_delivery_and_platform_prices_fallback_
    # to_dine_in`, `tests/orders/test_channel_prices.py`).
    pescado = _product(fuertes, "Pescado frito (mojarra)", 34_000, price_delivery=38_000, price_platform=40_000)

    lomo = _product(fuertes, "Lomo al trapo", 42_000)
    modifier_group_lomo = _modifier_group(lomo, "Término de la carne", required=True, min_=1, max_=1)
    _modifier_option(modifier_group_lomo, "A punto", 0)
    _modifier_option(modifier_group_lomo, "Bien asado", 0)
    _modifier_option(modifier_group_lomo, "Poco asado", 0)

    # -- Bebidas (4) — grupo "Jugo" del corrientazo -----------------------------
    limonada = _product(bebidas, "Limonada de coco", 9_000)
    jugo_mango = _product(bebidas, "Jugo de mango", 8_000)
    gaseosa = _product(bebidas, "Gaseosa", 5_000)
    _product(bebidas, "Cerveza Águila", 7_000)

    # -- Postres (2) --------------------------------------------------------------
    _product(postres, "Flan de café", 10_000)
    _product(postres, "Postre de natas", 9_000)

    # -- Combo fijo: "Combo Ejecutivo" (no es menú del día: siempre el mismo) ----
    combo_ejecutivo = Combo(
        organization_id=org_id,
        store_id=store.id,
        name="Combo Ejecutivo",
        price=25_000,
        active=True,
        schedule={"days": [0, 1, 2, 3, 4, 5, 6], "from": "11:00", "to": "21:00"},
        created_at=now,
        updated_at=now,
    )
    db.add(combo_ejecutivo)
    db.flush()

    grupo_plato = ComboGroup(
        organization_id=org_id, store_id=store.id, combo_id=combo_ejecutivo.id, name="Plato", sort_order=0
    )
    db.add(grupo_plato)
    db.flush()
    for product in (arroz_con_pollo, pechuga):
        db.add(
            ComboOption(
                organization_id=org_id,
                store_id=store.id,
                combo_group_id=grupo_plato.id,
                product_id=product.id,
                active_today=True,
                available_today=True,
            )
        )

    grupo_bebida_combo = ComboGroup(
        organization_id=org_id, store_id=store.id, combo_id=combo_ejecutivo.id, name="Bebida", sort_order=1
    )
    db.add(grupo_bebida_combo)
    db.flush()
    for product in (gaseosa, jugo_mango):
        db.add(
            ComboOption(
                organization_id=org_id,
                store_id=store.id,
                combo_group_id=grupo_bebida_combo.id,
                product_id=product.id,
                active_today=True,
                available_today=True,
            )
        )

    # -- Menú del día: "Corrientazo" (lunes a sábado, 11:30-15:00) ---------------
    corrientazo = Combo(
        organization_id=org_id,
        store_id=store.id,
        name="Corrientazo del día",
        price=18_000,
        active=True,
        schedule={"days": [0, 1, 2, 3, 4, 5], "from": "11:30", "to": "15:00"},
        created_at=now,
        updated_at=now,
    )
    db.add(corrientazo)
    db.flush()

    def _combo_option(group: ComboGroup, product: Product, *, active_today: bool = True) -> None:
        db.add(
            ComboOption(
                organization_id=org_id,
                store_id=store.id,
                combo_group_id=group.id,
                product_id=product.id,
                active_today=active_today,
                available_today=True,
            )
        )

    grupo_sopa = ComboGroup(organization_id=org_id, store_id=store.id, combo_id=corrientazo.id, name="Sopa", sort_order=0)
    db.add(grupo_sopa)
    db.flush()
    for product in (sancocho, ajiaco, sopa_guineo):
        _combo_option(grupo_sopa, product)

    grupo_principio = ComboGroup(
        organization_id=org_id, store_id=store.id, combo_id=corrientazo.id, name="Principio", sort_order=1
    )
    db.add(grupo_principio)
    db.flush()
    for product in (frijoles, lentejas):
        _combo_option(grupo_principio, product)

    grupo_proteina = ComboGroup(
        organization_id=org_id, store_id=store.id, combo_id=corrientazo.id, name="Proteína", sort_order=2
    )
    db.add(grupo_proteina)
    db.flush()
    _combo_option(grupo_proteina, pechuga, active_today=True)
    _combo_option(grupo_proteina, arroz_con_pollo, active_today=True)
    # El pescado no entró al menú de hoy (se armó sin él): demuestra que
    # "armar el menú de hoy" es una curaduría real, no "todo prendido".
    _combo_option(grupo_proteina, pescado, active_today=False)

    grupo_jugo = ComboGroup(organization_id=org_id, store_id=store.id, combo_id=corrientazo.id, name="Jugo", sort_order=3)
    db.add(grupo_jugo)
    db.flush()
    for product in (jugo_mango, limonada):
        _combo_option(grupo_jugo, product)

    # -- Pedido 2c: el cargo de domicilio, como producto real (§4.3) --------
    # `app.orders.service.create_order` lo busca por sede
    # (`app.catalog.service.get_delivery_fee_product`) y lo agrega solo al
    # crear una comanda `delivery`; `GET /catalog` (device) lo excluye del
    # menú (`is_delivery_fee`). Sin ficha técnica a propósito: no debe
    # descontar inventario ni tener costo.
    servicio = _category("Servicio", 6, None, None)
    _product(
        servicio,
        "Cargo de domicilio",
        5_000,
        description="Costo del envío a domicilio (se agrega solo al crear la comanda)",
        is_delivery_fee=True,
    )

    db.flush()
