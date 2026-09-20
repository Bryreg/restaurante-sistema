"""Seed de desarrollo. Se corre a mano, **nunca** al arrancar la API:

    python -m app.seed

Idempotente: si ya existe el admin de demo, no repite nada (lo prueba
`tests/core/test_seed.py`). Si existe `app.catalog.seed.seed_catalog`, la
llama para cargar la carta (find_spec: puede no existir todavía); igual con
`app.inventory.seed.seed_inventory` (insumos, dominio propio, siempre
disponible) y `app.recipes.seed.seed_recipes` (fichas y preparaciones,
territorio de otro agente en el pedido 2a: protegido con
`app.core.modules.find_spec_safe`, no con `importlib.util.find_spec` crudo,
porque el paquete puede no tener ni carpeta todavía — `docs/ESTADO.md`,
"defecto encontrado y corregido" de 1b-1).
"""

from __future__ import annotations

import importlib
import importlib.util
from datetime import timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth.models import Employee
from app.catalog import service as catalog_service
from app.catalog.models import Product
from app.core import clock, tz
from app.core.modules import find_spec_safe
from app.core.tax import rate_for_code
from app.fiscal.models import FiscalDocumentType, FiscalRange
from app.core.db import Base, SessionLocal, engine
from app.core.models_registry import import_all_models
from app.core.security import hash_secret
from app.inventory.seed import seed_counts_and_purchase, seed_inventory
from app.orders.models import Order, OrderChannel, OrderItem, OrderItemStatus, OrderStatus
from app.stores import service as stores_service
from app.stores.models import (
    Organization,
    Store,
    StoreCashSettings,
    StoreFiscalConfig,
    StoreSalesSettings,
    Table,
    UvtValue,
    Zone,
)
from app.stores.service import (
    DEFAULT_COURSE_TARGET_MINUTES,
    DEFAULT_COURSES,
    DEFAULT_COURTESY_REASONS,
    DEFAULT_DISCOUNT_REASONS,
    DEFAULT_PAYMENT_METHODS,
    DEFAULT_STATIONS,
    DEFAULT_VOID_REASONS,
)

ADMIN_EMAIL = "admin@demo.local"
ADMIN_PASSWORD = "cambiar"
ADMIN_PIN = "9000"
STORE_PIN = "123456"  # seis dígitos: el teclado de activación del POS pide 6
SUPERVISOR_PIN = "5001"
OPERATOR_PINS = ["6001", "6002", "6003", "6004"]  # el primero (6001) puede cobrar


def _seed_channel_orders(
    db: Session, *, org: Organization, store: Store, admin: Employee, courier: Employee
) -> dict[str, bool]:
    """Pedido 2c: un pedido de DOMICILIO (con su cargo como línea) y uno de
    PLATAFORMA (con `external_id`), para que una base recién sembrada
    muestre el camino nuevo — sin esto, `docs/ESTADO.md` § "el seed corre
    dos veces sin duplicar nada" vale igual, pero nadie ve una comanda de
    domicilio o de plataforma hasta crear una a mano.

    Construidos por ORM directo, como el resto de este archivo (no llama
    `app.orders.service.create_order`): un turno de caja es "una caja por
    turno con responsable" (`docs/SPEC-NEGOCIO.md §11.1`) y dejar uno
    abierto acá bloquearía el primer turno REAL que alguien abra desde el
    POS con `OPEN_SHIFT_EXISTS` — `shift_id=NULL` dejan las dos comandas en
    el mismo estado que una comanda `open` trasladada
    (`app.orders.hooks.detach_open_orders`), no en un estado nuevo.

    CONTRATO C4-bis: la plataforma con comisión la siembra
    `app.channels.seed.seed_channels(db, *, organization, store, admin) ->
    {"platform_id": int}` (territorio de `backend-dinero-canales`),
    protegido con `find_spec_safe` — si `app.channels` no está montado
    todavía, se siembra igual el pedido de domicilio y se SALTA el de
    plataforma, sin romper el seed."""
    now = clock.now_utc()
    business_date = tz.today_business_date(store.cutoff_hour)
    fiscal = stores_service.current_fiscal(db, store.id)
    price_includes_tax = fiscal.price_includes_tax if fiscal is not None else True

    def _line(order: Order, product: Product, *, unit_price: int, station: str | None) -> OrderItem:
        return OrderItem(
            organization_id=org.id,
            store_id=store.id,
            order_id=order.id,
            product_id=product.id,
            combo_id=None,
            name=product.name,
            qty=1,
            seat=None,
            course=product.default_course or "main",
            station=station,
            list_price=unit_price,
            unit_price=unit_price,
            tax_code=product.tax_code,
            tax_rate=rate_for_code(product.tax_code),
            price_includes_tax=price_includes_tax,
            modifiers=[],
            modifiers_text=None,
            combo_selections=None,
            note=None,
            status=OrderItemStatus.PENDING,
            discount_amount=0,
            unit_cost=None,
            recipe_version=None,
            added_by_employee_id=admin.id,
            added_by_employee_name=admin.name,
            created_at=now,
        )

    # "Pescado frito (mojarra)" es a propósito el producto sembrado con
    # `price_delivery`/`price_platform` PROPIOS (`app.catalog.seed`): las dos
    # comandas de acá lo usan para que la base sembrada también ejercite el
    # camino "el canal tiene su propio precio", no sólo el fallback a mesa.
    main_product = (
        db.execute(
            select(Product).where(Product.store_id == store.id, Product.name == "Pescado frito (mojarra)")
        )
        .scalars()
        .first()
    )
    if main_product is None:
        main_product = (
            db.execute(
                select(Product)
                .where(Product.store_id == store.id, Product.is_delivery_fee.is_(False))
                .order_by(Product.id)
            )
            .scalars()
            .first()
        )
    fee_product = catalog_service.get_delivery_fee_product(db, store.id)

    seeded_delivery = False
    if main_product is not None and fee_product is not None:
        delivery_order = Order(
            organization_id=org.id,
            store_id=store.id,
            shift_id=None,
            business_date=business_date,
            channel=OrderChannel.DELIVERY,
            status=OrderStatus.OPEN,
            version=1,
            covers=None,
            note="Sembrado por 2c: domicilio de referencia",
            delivery_address="Calle 45 # 12-30, Apto 301",
            delivery_phone="3001234567",
            courier_employee_id=courier.id,
            courier_employee_name=courier.name,
            opened_by_employee_id=admin.id,
            opened_by_employee_name=admin.name,
            opened_at=now,
            bill_print_count=0,
            kitchen_view_enabled=True,
            created_at=now,
            updated_at=now,
        )
        db.add(delivery_order)
        db.flush()
        main_price = main_product.price_delivery if main_product.price_delivery is not None else main_product.price_dine_in
        fee_price = fee_product.price_delivery if fee_product.price_delivery is not None else fee_product.price_dine_in
        db.add(_line(delivery_order, main_product, unit_price=main_price, station=main_product.station))
        # El cargo: la MISMA función `_line`, `station=None` a propósito
        # (nunca pasa por cocina) — es exactamente el camino de
        # `app.orders.service._build_delivery_fee_item`, repetido a mano
        # acá porque este archivo no llama `app.orders.service` (mismo
        # criterio que el resto del seed: construcción directa por ORM).
        db.add(_line(delivery_order, fee_product, unit_price=fee_price, station=None))
        db.flush()
        seeded_delivery = True

    seeded_platform = False
    if main_product is not None and find_spec_safe("app.channels.seed") is not None:
        channels_seed_module = importlib.import_module("app.channels.seed")
        seed_channels = getattr(channels_seed_module, "seed_channels", None)
        platform_id: int | None = None
        if callable(seed_channels):
            result = seed_channels(db, organization=org, store=store, admin=admin)
            platform_id = result.get("platform_id") if isinstance(result, dict) else None

        if platform_id is not None:
            platform_ref: Any = None
            if find_spec_safe("app.channels.hooks") is not None:
                channels_hooks = importlib.import_module("app.channels.hooks")
                get_platform_fn = getattr(channels_hooks, "get_platform", None)
                if callable(get_platform_fn):
                    platform_ref = get_platform_fn(db, store_id=store.id, platform_id=platform_id)

            platform_order = Order(
                organization_id=org.id,
                store_id=store.id,
                shift_id=None,
                business_date=business_date,
                channel=OrderChannel.PLATFORM,
                status=OrderStatus.OPEN,
                version=1,
                covers=None,
                note="Sembrado por 2c: pedido de plataforma de referencia",
                platform_id=platform_id,
                platform_name=getattr(platform_ref, "name", None),
                platform_commission_bp=getattr(platform_ref, "commission_bp", None),
                platform_external_id="RAPPI-DEV-0001",
                opened_by_employee_id=admin.id,
                opened_by_employee_name=admin.name,
                opened_at=now,
                bill_print_count=0,
                kitchen_view_enabled=True,
                created_at=now,
                updated_at=now,
            )
            db.add(platform_order)
            db.flush()
            platform_price = main_product.price_platform if main_product.price_platform is not None else main_product.price_dine_in
            db.add(_line(platform_order, main_product, unit_price=platform_price, station=main_product.station))
            db.flush()
            seeded_platform = True

    return {"delivery": seeded_delivery, "platform": seeded_platform}


def seed(db: Session) -> None:
    existing = db.execute(select(Employee).where(Employee.email == ADMIN_EMAIL)).scalars().first()
    if existing is not None:
        print("Seed ya aplicado (ya existe el admin de demo); no se repite nada.")
        return

    now = clock.now_utc()

    org = Organization(name="Restaurante Demo", profile="standard", created_at=now, updated_at=now)
    db.add(org)
    db.flush()

    store = Store(
        organization_id=org.id,
        name="Sede Centro",
        nit="900123456",
        dv="7",
        legal_name="Restaurante Demo SAS",
        address="Calle 10 # 5-30",
        municipality_dane="11001",
        opening_hours=[{"weekday": d, "open": "11:00", "close": "22:00"} for d in range(7)],
        cutoff_hour=6,
        active_channels=["counter", "dine_in", "takeout"],
        store_pin_hash=hash_secret(STORE_PIN),
        active=True,
        created_at=now,
        updated_at=now,
    )
    db.add(store)
    db.flush()

    db.add(
        StoreFiscalConfig(
            store_id=store.id,
            valid_from=now.date(),
            person_type="natural",
            regime="ordinary",
            franchise=False,
            inc_responsible=True,
            iva_responsible=False,
            rut_codes=[],
            price_includes_tax=True,
            default_tax="inc_8",
            created_at=now,
        )
    )
    db.add(StoreCashSettings(store_id=store.id, updated_at=now))
    db.add(
        StoreSalesSettings(
            store_id=store.id,
            payment_methods=list(DEFAULT_PAYMENT_METHODS),
            void_reasons=list(DEFAULT_VOID_REASONS),
            discount_reasons=list(DEFAULT_DISCOUNT_REASONS),
            courtesy_reasons=list(DEFAULT_COURTESY_REASONS),
            courses=list(DEFAULT_COURSES),
            stations=list(DEFAULT_STATIONS),
            course_target_minutes=dict(DEFAULT_COURSE_TARGET_MINUTES),
            updated_at=now,
        )
    )
    db.add(UvtValue(organization_id=org.id, year=2026, value=52_374))

    # Rangos de numeración de DESARROLLO. Sin esto `fiscal.dee_pos` (encendida
    # por defecto en los tres perfiles) corta el primer cobro con
    # `400 NO_FISCAL_RANGE`: una base recién sembrada no podría vender, y el
    # camino de demostración quedaría cortado antes de empezar. Se cargan
    # rangos en vez de apagar la flag para que el seed ejercite el camino
    # REAL (reservar dentro del rango, alertar al 80 %, agotarse).
    # La resolución es deliberadamente falsa y está rotulada: si alguna vez
    # aparece en un documento de producción, se ve a simple vista.
    # `valid_from` arranca 30 días atrás a propósito: la fecha de negocio se
    # calcula en `America/Bogota` (UTC-5) con hora de corte, así que puede
    # quedar un día detrás de la fecha UTC de este seed.
    range_from = now.date() - timedelta(days=30)
    range_until = now.date() + timedelta(days=365 * 5)
    for doc_type, prefix in (
        (FiscalDocumentType.POS_EQUIVALENT, "DEVPOS"),
        (FiscalDocumentType.INVOICE, "DEVFAC"),
        (FiscalDocumentType.CREDIT_NOTE, "DEVNC"),
        (FiscalDocumentType.DEBIT_NOTE, "DEVND"),
        (FiscalDocumentType.ADJUSTMENT_NOTE, "DEVNA"),
    ):
        db.add(
            FiscalRange(
                organization_id=org.id,
                store_id=store.id,
                document_type=doc_type,
                prefix=prefix,
                from_number=1,
                to_number=5_000,
                next_number=1,
                resolution_number="DEV-NO-ES-RESOLUCION-DIAN",
                resolution_date=now.date(),
                valid_from=range_from,
                valid_until=range_until,
                technical_key=None,
                created_at=now,
            )
        )

    admin = Employee(
        organization_id=org.id,
        store_id=None,
        name="Admin Demo",
        role="admin",
        pin_hash=hash_secret(ADMIN_PIN),
        email=ADMIN_EMAIL,
        password_hash=hash_secret(ADMIN_PASSWORD),
        can_charge=False,
        discount_limit_pct=None,
        document=None,
        active=True,
        failed_pin_attempts=0,
        pin_locked_until=None,
        created_at=now,
        updated_at=now,
    )
    supervisor = Employee(
        organization_id=org.id,
        store_id=store.id,
        name="Supervisor Demo",
        role="supervisor",
        pin_hash=hash_secret(SUPERVISOR_PIN),
        email=None,
        password_hash=None,
        can_charge=False,
        discount_limit_pct=None,
        document=None,
        active=True,
        failed_pin_attempts=0,
        pin_locked_until=None,
        created_at=now,
        updated_at=now,
    )
    db.add_all([admin, supervisor])

    operator_names = ["Operador 1", "Operador 2", "Operador 3", "Operador 4"]
    operators: list[Employee] = []
    for i, (name, pin) in enumerate(zip(operator_names, OPERATOR_PINS)):
        operator_row = Employee(
            organization_id=org.id,
            store_id=store.id,
            name=name,
            role="operator",
            pin_hash=hash_secret(pin),
            email=None,
            password_hash=None,
            can_charge=(i == 0),
            discount_limit_pct=None,
            document=None,
            active=True,
            failed_pin_attempts=0,
            pin_locked_until=None,
            created_at=now,
            updated_at=now,
        )
        db.add(operator_row)
        operators.append(operator_row)

    zone_salon = Zone(store_id=store.id, name="Salón", sort_order=1, active=True)
    zone_terraza = Zone(store_id=store.id, name="Terraza", sort_order=2, active=True)
    db.add_all([zone_salon, zone_terraza])
    db.flush()

    for i in range(1, 5):
        db.add(Table(zone_id=zone_salon.id, store_id=store.id, number=str(i), seats=4, active=True))
    for i in range(5, 9):
        db.add(Table(zone_id=zone_terraza.id, store_id=store.id, number=str(i), seats=4, active=True))
    db.flush()

    if importlib.util.find_spec("app.catalog.seed") is not None:
        catalog_seed_module = importlib.import_module("app.catalog.seed")
        seed_catalog = getattr(catalog_seed_module, "seed_catalog", None)
        if callable(seed_catalog):
            seed_catalog(db, store)

    # Insumos de desarrollo (2a): siempre disponible, dominio propio de este
    # archivo. Ejercita `yield_pct` != 100, costo oficial con origen,
    # `min_stock` real, un `key_item`, un `consumption_untracked` y un par
    # con sustituto en cascada.
    seeded_ingredients = seed_inventory(db, store)

    # Fichas y preparaciones (2a, territorio de `backend-recetas`): puede no
    # existir todavía — `find_spec_safe`, nunca `importlib.util.find_spec`
    # crudo, porque `app.recipes` puede no tener ni carpeta.
    seeded_recipes_summary: str | None = None
    if find_spec_safe("app.recipes.seed") is not None:
        recipes_seed_module = importlib.import_module("app.recipes.seed")
        seed_recipes = getattr(recipes_seed_module, "seed_recipes", None)
        if callable(seed_recipes):
            seed_recipes(db, store)
            seeded_recipes_summary = "cargadas"

    # Proveedores y recepciones (2b, territorio de `purchases`): puede no
    # existir todavía — mismo patrón `find_spec_safe` de arriba, nunca
    # `importlib.util.find_spec` crudo.
    seeded_purchases_summary: str | None = None
    if find_spec_safe("app.purchases.seed") is not None:
        purchases_seed_module = importlib.import_module("app.purchases.seed")
        seed_purchases = getattr(purchases_seed_module, "seed_purchases", None)
        if callable(seed_purchases):
            seed_purchases(db, store)
            seeded_purchases_summary = "cargadas"

    # Orden: insumos -> recetas -> compras -> conteo completo 1 -> movimientos
    # -> conteo completo 2 (2b, territorio de `backend-inventario`). Dos
    # conteos, no uno: con uno solo el food cost real queda `null` para
    # siempre (`app/inventory/seed.py::seed_counts_and_purchase`, decisión
    # declarada ahí). No depende de que `app.purchases` exista.
    seeded_counts = seed_counts_and_purchase(db, store, admin)

    # Pedido 2c: comandas de domicilio y de plataforma (§3.3). Corre al
    # final, después de que la carta (con el cargo de domicilio) ya existe.
    seeded_channel_orders = _seed_channel_orders(db, org=org, store=store, admin=admin, courier=operators[1])

    db.commit()

    print("Seed aplicado.")
    print(f"  Organización: {org.name} (perfil {org.profile})")
    print(f"  Sede: {store.name} — PIN de sede: {STORE_PIN}")
    print(f"  Admin: {ADMIN_EMAIL} / {ADMIN_PASSWORD}  (PIN POS del admin: {ADMIN_PIN})")
    print(f"  Supervisor PIN: {SUPERVISOR_PIN}")
    print(f"  Operadores PIN: {', '.join(OPERATOR_PINS)} (el primero, {OPERATOR_PINS[0]}, puede cobrar)")
    print("  Rangos de numeración: DE DESARROLLO (DEVPOS/DEVFAC/DEVNC/DEVND/DEVNA, 1-5000),")
    print("    con resolución FALSA 'DEV-NO-ES-RESOLUCION-DIAN'. Antes de operar de verdad,")
    print("    cargá el rango autorizado en Admin → Rangos de numeración.")
    if seeded_ingredients:
        names = ", ".join(i.name for i in seeded_ingredients)
        print(f"  Insumos: 5 cargados (con yield_pct != 100, costo oficial, sustituto en cascada; ver {names}, ...)")
    else:
        print("  Insumos: ya existían, no se repitió nada.")
    if seeded_recipes_summary is not None:
        print(f"  Fichas y preparaciones: {seeded_recipes_summary} (app.recipes.seed.seed_recipes).")
    else:
        print("  Fichas y preparaciones: app.recipes todavía no existe o no las cargó.")
    if seeded_purchases_summary is not None:
        print(f"  Proveedores y recepciones: {seeded_purchases_summary} (app.purchases.seed.seed_purchases).")
    else:
        print("  Proveedores y recepciones: app.purchases todavía no existe o no las cargó.")
    if seeded_counts:
        print("  Inventario 2b: dos conteos completos aplicados y consecutivos, con una compra en el medio")
        print("    (food cost real y promedio ponderado ya tienen con qué calcularse).")
    else:
        print("  Inventario 2b: ya existían conteos, no se repitió nada.")
    if seeded_channel_orders.get("delivery"):
        print("  Pedido 2c: una comanda de DOMICILIO sembrada, con el cargo de domicilio como línea.")
    else:
        print("  Pedido 2c: no se sembró la comanda de domicilio (falta un producto o el cargo de domicilio en la carta).")
    if seeded_channel_orders.get("platform"):
        print("  Pedido 2c: una comanda de PLATAFORMA sembrada (app.channels.seed.seed_channels).")
    else:
        print("  Pedido 2c: app.channels todavía no existe o no sembró una plataforma; no se cargó el pedido de plataforma.")


def main() -> None:
    import_all_models()
    # `app.recipes` (territorio ajeno) todavía no está en `MODEL_MODULES`
    # (otro agente lo agrega al integrar el dominio), así que
    # `import_all_models()` no lo trae solo. Sin este import defensivo,
    # `Base.metadata.create_all(engine)` no crea `recipes`/`preparations`, y
    # la llamada de acá abajo a `app.recipes.seed.seed_recipes` revienta con
    # `OperationalError: no such table: recipes` -- el mismo problema que
    # `find_spec_safe` resuelve para el arranque de la API, pero para el
    # *esquema*, no para el *import*.
    if find_spec_safe("app.recipes.models") is not None:
        importlib.import_module("app.recipes.models")
    Base.metadata.create_all(engine)
    db = SessionLocal()
    try:
        seed(db)
    finally:
        db.close()


if __name__ == "__main__":
    main()
