"""Seed de desarrollo. Se corre a mano, **nunca** al arrancar la API:

    python -m app.seed

Idempotente: si ya existe el admin de demo, no repite nada (lo prueba
`tests/core/test_seed.py`). Si existe `app.catalog.seed.seed_catalog`, la
llama para cargar la carta (find_spec: puede no existir todavía).
"""

from __future__ import annotations

import importlib
import importlib.util

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth.models import Employee
from app.core import clock
from app.core.db import Base, SessionLocal, engine
from app.core.models_registry import import_all_models
from app.core.security import hash_secret
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
STORE_PIN = "1234"
SUPERVISOR_PIN = "5001"
OPERATOR_PINS = ["6001", "6002", "6003", "6004"]  # el primero (6001) puede cobrar


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
    for i, (name, pin) in enumerate(zip(operator_names, OPERATOR_PINS)):
        db.add(
            Employee(
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
        )

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

    db.commit()

    print("Seed aplicado.")
    print(f"  Organización: {org.name} (perfil {org.profile})")
    print(f"  Sede: {store.name} — PIN de sede: {STORE_PIN}")
    print(f"  Admin: {ADMIN_EMAIL} / {ADMIN_PASSWORD}  (PIN POS del admin: {ADMIN_PIN})")
    print(f"  Supervisor PIN: {SUPERVISOR_PIN}")
    print(f"  Operadores PIN: {', '.join(OPERATOR_PINS)} (el primero, {OPERATOR_PINS[0]}, puede cobrar)")


def main() -> None:
    import_all_models()
    Base.metadata.create_all(engine)
    db = SessionLocal()
    try:
        seed(db)
    finally:
        db.close()


if __name__ == "__main__":
    main()
