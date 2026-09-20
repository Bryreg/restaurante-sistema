"""`seed_catalog` es idempotente y deja veintiún productos (pedido 2c: se
agregó el cargo de domicilio), un combo fijo y un menú del día con opciones
activas hoy."""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.catalog.models import Category, Combo, ComboGroup, ComboOption, Product
from app.catalog.seed import seed_catalog
from app.stores.models import Store


def test_seed_catalog_creates_expected_shape(db: Session, store: Store) -> None:
    seed_catalog(db, store)
    db.flush()

    products = db.execute(select(Product).where(Product.store_id == store.id)).scalars().all()
    categories = db.execute(select(Category).where(Category.store_id == store.id)).scalars().all()
    combos = db.execute(select(Combo).where(Combo.store_id == store.id)).scalars().all()

    assert len(products) == 21
    assert len(categories) == 6  # 5 de la carta + "Servicio" (pedido 2c)
    assert len(combos) == 2  # el combo fijo y el corrientazo

    products_with_modifiers = [p for p in products if p.name in {"Bandeja paisa", "Pechuga a la plancha", "Lomo al trapo"}]
    assert len(products_with_modifiers) == 3

    fee_product = next(p for p in products if p.name == "Cargo de domicilio")
    assert fee_product.is_delivery_fee is True
    non_fee_delivery_flags = [p.is_delivery_fee for p in products if p.name != "Cargo de domicilio"]
    assert not any(non_fee_delivery_flags)

    pescado = next(p for p in products if p.name == "Pescado frito (mojarra)")
    assert pescado.price_delivery == 38_000 and pescado.price_platform == 40_000
    assert pescado.price_delivery != pescado.price_dine_in

    # Al menos un producto sin precios propios de canal, para que el
    # fallback al precio de mesa quede sembrado también (§4.3).
    assert any(p.price_delivery is None and p.name != "Cargo de domicilio" for p in products)

    corrientazo = next(c for c in combos if c.name == "Corrientazo del día")
    # `ComboOption` no tiene `combo_id` directo (cuelga de `ComboGroup`); se
    # verifica que exista al menos una opción activa hoy por combo vía join.
    rows = db.execute(
        select(ComboOption)
        .join(ComboGroup, ComboOption.combo_group_id == ComboGroup.id)
        .where(ComboGroup.combo_id == corrientazo.id, ComboOption.active_today.is_(True))
    ).scalars().all()
    assert len(rows) >= 1


def test_seed_catalog_is_idempotent(db: Session, store: Store) -> None:
    seed_catalog(db, store)
    db.flush()
    first_count = len(db.execute(select(Product).where(Product.store_id == store.id)).scalars().all())

    seed_catalog(db, store)
    db.flush()
    second_count = len(db.execute(select(Product).where(Product.store_id == store.id)).scalars().all())

    assert first_count == second_count == 21
