"""`seed_catalog` es idempotente y deja veinte productos, un combo fijo y un
menú del día con opciones activas hoy."""

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

    assert len(products) == 20
    assert 4 <= len(categories) <= 5
    assert len(combos) == 2  # el combo fijo y el corrientazo

    products_with_modifiers = [p for p in products if p.name in {"Bandeja paisa", "Pechuga a la plancha", "Lomo al trapo"}]
    assert len(products_with_modifiers) == 3

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

    assert first_count == second_count == 20
