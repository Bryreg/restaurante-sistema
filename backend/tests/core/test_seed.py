"""El seed corre aparte del arranque y corriendo dos veces no duplica nada."""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth.models import Employee
from app.seed import ADMIN_EMAIL, seed
from app.stores.models import Store, Table, Zone


def test_seed_is_idempotent(db: Session) -> None:
    seed(db)
    db.commit()
    employees_after_first = db.execute(select(Employee)).scalars().all()
    stores_after_first = db.execute(select(Store)).scalars().all()

    seed(db)
    db.commit()
    employees_after_second = db.execute(select(Employee)).scalars().all()
    stores_after_second = db.execute(select(Store)).scalars().all()

    assert len(employees_after_second) == len(employees_after_first)
    assert len(stores_after_second) == len(stores_after_first)


def test_seed_creates_expected_demo_data(db: Session) -> None:
    seed(db)
    db.commit()

    admin = db.execute(select(Employee).where(Employee.email == ADMIN_EMAIL)).scalars().first()
    assert admin is not None
    assert admin.role == "admin"

    stores = db.execute(select(Store)).scalars().all()
    assert len(stores) == 1

    zones = db.execute(select(Zone)).scalars().all()
    tables = db.execute(select(Table)).scalars().all()
    assert len(zones) == 2
    assert len(tables) == 8

    operators = db.execute(select(Employee).where(Employee.role == "operator")).scalars().all()
    assert len(operators) == 4
    assert sum(1 for o in operators if o.can_charge) == 1
