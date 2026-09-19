"""`app.purchases.seed.seed_purchases(db, store)` — idempotente, deja 2
proveedores, >= 2 recepciones con lote y vencimiento (la segunda con fecha
posterior y vencimientos distintos) y 1 cuenta por pagar aprobada con pago
parcial."""

from __future__ import annotations

from typing import Any

from sqlalchemy.orm import Session

from app.auth.models import Employee
from app.purchases.models import Payable, PayableStatus, Payment, Reception, ReceptionLine, Supplier
from app.stores.models import Store


def test_seed_purchases_creates_suppliers_receptions_and_a_partially_paid_payable(
    db: Session, store: Store, employees: dict[str, Employee], ingredient_seeded: Any
) -> None:
    from app.purchases.seed import seed_purchases

    seed_purchases(db, store)
    db.commit()

    suppliers = db.query(Supplier).filter(Supplier.store_id == store.id).all()
    assert len(suppliers) == 2
    assert any(s.invoices_required for s in suppliers)
    assert any(not s.invoices_required for s in suppliers)

    receptions = db.query(Reception).filter(Reception.store_id == store.id).order_by(Reception.business_date).all()
    assert len(receptions) >= 2
    assert receptions[0].business_date < receptions[-1].business_date

    lines = db.query(ReceptionLine).join(Reception).filter(Reception.store_id == store.id).all()
    assert all(line.lot_code is not None for line in lines)
    assert all(line.expires_at is not None for line in lines)
    expiries = {line.expires_at for line in lines}
    assert len(expiries) >= 2  # vencimientos distintos entre las dos recepciones

    payables = db.query(Payable).filter(Payable.store_id == store.id).all()
    approved = [p for p in payables if p.status == PayableStatus.APPROVED]
    assert len(approved) == 1
    payments = db.query(Payment).filter(Payment.payable_id == approved[0].id).all()
    assert len(payments) == 1
    assert 0 < payments[0].amount < approved[0].amount


def test_seed_purchases_is_idempotent(db: Session, store: Store, employees: dict[str, Employee], ingredient_seeded: Any) -> None:
    from app.purchases.seed import seed_purchases

    seed_purchases(db, store)
    db.commit()
    seed_purchases(db, store)
    db.commit()

    assert db.query(Supplier).filter(Supplier.store_id == store.id).count() == 2
    assert db.query(Reception).filter(Reception.store_id == store.id).count() == 2
