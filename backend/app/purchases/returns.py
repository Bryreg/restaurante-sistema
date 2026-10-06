"""Devoluciones al proveedor y notas crédito (auditoría del dueño, tanda 5, i4).

Una línea de una recepción confirmada se puede devolver, toda o en parte,
con motivo y PIN de administrador:

- **Stock**: sale con un movimiento `RECEPTION_REVERSAL` (`ref_type=
  "supplier_return"`) al costo final de la línea, y se descuenta del lote
  EXACTO de esa línea (`inventory.hooks.return_from_stock_batch`), no del
  que FEFO elija. Se reusa la causa de la reversa a propósito: una
  devolución es la reversa parcial de una recepción, y el enum de causas es
  un conjunto cerrado que los reportes ya agrupan.
- **Plata**: `amount` = cantidad devuelta × costo unitario sin impuesto + la
  parte proporcional del impuesto de la línea, en pesos (una sola vez, en
  el borde). Hasta lo que la cuenta por pagar todavía debía, la baja
  (`applied_to_payable`); lo que sobra —la cuenta ya estaba pagada— queda
  como saldo a favor con el proveedor (`credit_amount`, la nota crédito).
- **Auditoría**: `record_audit(entity="supplier_return")` con el saldo de la
  cuenta por pagar antes y después.

Nada se borra; una recepción con devoluciones no se revierte entera
(`RECEPTION_HAS_RETURNS`): su lote ya no está completo.
"""

from __future__ import annotations

from datetime import date
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.audit.service import record_audit
from app.auth import service as auth_service
from app.auth.deps import Actor
from app.core import clock, tz
from app.core.errors import AppError, NotFoundError
from app.core.quantity import format_qty_base, line_cost_micros, micros_to_pesos, parse_qty_base
from app.inventory import hooks as inventory_hooks
from app.inventory.models import CostSource, MovementCause
from app.purchases.models import (
    Payable,
    PayableStatus,
    Reception,
    ReceptionLine,
    ReceptionStatus,
    SupplierReturn,
)
from app.stores.models import Store


def returned_qty_by_line(db: Session, *, line_ids: list[int]) -> dict[int, int]:
    """Cuánto se devolvió ya de cada línea de recepción (milésimas de la base)."""
    if not line_ids:
        return {}
    rows = db.execute(
        select(SupplierReturn.reception_line_id, func.sum(SupplierReturn.qty_base))
        .where(SupplierReturn.reception_line_id.in_(line_ids))
        .group_by(SupplierReturn.reception_line_id)
    ).all()
    return {int(line_id): int(total) for line_id, total in rows}


def applied_by_payable(db: Session, *, payable_ids: list[int]) -> dict[int, int]:
    """Lo que las devoluciones ya bajaron de cada cuenta por pagar (pesos).
    Lo leen `service.payable_balance` y `service.payables_summary`: la única
    regla del saldo."""
    if not payable_ids:
        return {}
    rows = db.execute(
        select(SupplierReturn.payable_id, func.sum(SupplierReturn.applied_to_payable))
        .where(SupplierReturn.payable_id.in_(payable_ids))
        .group_by(SupplierReturn.payable_id)
    ).all()
    return {int(pid): int(total) for pid, total in rows if pid is not None}


def has_returns(db: Session, *, reception_id: int) -> bool:
    return (
        db.execute(
            select(func.count()).select_from(SupplierReturn).where(SupplierReturn.reception_id == reception_id)
        ).scalar_one()
        > 0
    )


def _line_amount(line: ReceptionLine, qty_base: int) -> int:
    """La plata de devolver `qty_base` de la línea, a precio de la factura:
    lo sin impuesto (acumulado en micros, redondeado una vez) más la parte
    proporcional del impuesto de la línea, mitad hacia arriba."""
    pretax = micros_to_pesos(line_cost_micros(qty_base, line.unit_cost_micros))
    tax = 0
    if line.tax_amount > 0 and line.qty_invoiced_base > 0:
        tax = (line.tax_amount * qty_base * 2 + line.qty_invoiced_base) // (2 * line.qty_invoiced_base)
    return pretax + tax


def create_return(
    db: Session,
    *,
    actor: Actor,
    store: Store,
    reception: Reception,
    line_id: int,
    qty: str,
    reason: str,
    authorizer_pin: str,
) -> SupplierReturn:
    # -- Validar TODO antes de escribir (`get_db` comitea ante un AppError). --
    clean_reason = reason.strip()
    if not clean_reason:
        raise AppError(code="REASON_REQUIRED", message="Escribí por qué se le devuelve esta mercancía al proveedor", status=400)
    if reception.status != ReceptionStatus.CONFIRMED:
        raise AppError(
            code="RECEPTION_REVERSED",
            message="Esta recepción fue revertida: ya no hay mercancía que devolver",
            status=409,
        )
    line = db.get(ReceptionLine, line_id)
    if line is None or line.reception_id != reception.id:
        raise NotFoundError("Esa línea no es de esta recepción")
    qty_base = parse_qty_base(qty, field="qty")
    if qty_base <= 0:
        raise AppError(code="VALIDATION_ERROR", message="qty: la cantidad a devolver tiene que ser mayor a cero", status=400)
    already = returned_qty_by_line(db, line_ids=[line.id]).get(line.id, 0)
    available = line.qty_received_base - already
    if qty_base > available:
        raise AppError(
            code="RETURN_EXCEEDS_RECEIVED",
            message=(
                f"De esta línea se recibieron {format_qty_base(line.qty_received_base)} y ya se devolvieron "
                f"{format_qty_base(already)}: se pueden devolver hasta {format_qty_base(available)}"
            ),
            status=400,
        )
    if actor.employee_id is None or not actor.employee_name:
        raise AppError(code="IDENTIFY_REQUIRED", message="Entrá con tu cuenta de administrador para registrar la devolución", status=401)
    authorizer = auth_service.verify_authorizer(
        db,
        organization_id=reception.organization_id,
        store_id=reception.store_id,
        pin=authorizer_pin,
        action="purchases.supplier_return",
        requested_by=actor,
    )

    from app.purchases import service

    payable = service.get_payable_for_reception(db, reception_id=reception.id)
    amount = _line_amount(line, qty_base)
    balance_before: int | None = None
    applied = 0
    if payable is not None and payable.status != PayableStatus.CANCELLED:
        balance_before = service.payable_balance(db, payable)
        applied = max(0, min(amount, balance_before))
    credit = amount - applied

    # -- Escribir. --
    now = clock.now_utc()
    business_date: date = tz.business_date_for(now, store.cutoff_hour)
    row = SupplierReturn(
        organization_id=reception.organization_id,
        store_id=reception.store_id,
        supplier_id=reception.supplier_id,
        reception_id=reception.id,
        reception_line_id=line.id,
        ingredient_id=line.ingredient_id,
        payable_id=payable.id if payable is not None else None,
        qty_base=qty_base,
        unit_cost_micros=line.final_unit_cost_micros,
        amount=amount,
        applied_to_payable=applied,
        credit_amount=credit,
        reason=clean_reason,
        stock_batch_id=line.stock_batch_id,
        employee_id=actor.employee_id,
        employee_name=actor.employee_name,
        authorized_by_employee_id=authorizer.id,
        authorized_by_employee_name=authorizer.name,
        created_at=now,
        business_date=business_date,
    )
    db.add(row)
    db.flush()

    if line.stock_batch_id is not None:
        inventory_hooks.return_from_stock_batch(db, batch_id=line.stock_batch_id, qty_base=qty_base)
    movement = inventory_hooks.record_movement(
        db,
        organization_id=reception.organization_id,
        store_id=reception.store_id,
        ingredient_id=line.ingredient_id,
        qty_base=-qty_base,
        cause=MovementCause.RECEPTION_REVERSAL,
        cost_micros=line.final_unit_cost_micros,
        cost_source=CostSource.LAST_PURCHASE,
        actor=actor,
        business_date=business_date,
        at=now,
        ref_type="supplier_return",
        ref_id=row.id,
        note=f"Devolución al proveedor: {clean_reason}",
    )
    row.stock_movement_id = movement.id
    db.flush()

    record_audit(
        db,
        actor=actor,
        organization_id=reception.organization_id,
        store_id=reception.store_id,
        entity="supplier_return",
        entity_id=row.id,
        action="create",
        before={"payable_id": row.payable_id, "payable_balance": balance_before},
        after={
            "reception_id": reception.id,
            "reception_line_id": line.id,
            "qty": format_qty_base(qty_base),
            "amount": amount,
            "applied_to_payable": applied,
            "credit_amount": credit,
            "payable_balance": None if balance_before is None else balance_before - applied,
            "authorized_by": authorizer.name,
        },
        reason=clean_reason,
    )
    return row


def list_returns(
    db: Session, *, store_id: int, supplier_id: int | None = None, reception_id: int | None = None
) -> list[SupplierReturn]:
    stmt = select(SupplierReturn).where(SupplierReturn.store_id == store_id)
    if supplier_id is not None:
        stmt = stmt.where(SupplierReturn.supplier_id == supplier_id)
    if reception_id is not None:
        stmt = stmt.where(SupplierReturn.reception_id == reception_id)
    return list(db.execute(stmt.order_by(SupplierReturn.created_at.desc(), SupplierReturn.id.desc())).scalars())


def return_out(db: Session, row: SupplierReturn) -> dict[str, Any]:
    from app.purchases.models import Supplier

    ingredient = inventory_hooks.get_ingredient(db, store_id=row.store_id, ingredient_id=row.ingredient_id)
    supplier = db.get(Supplier, row.supplier_id)
    return {
        "id": row.id,
        "store_id": row.store_id,
        "supplier_id": row.supplier_id,
        "supplier_name": supplier.name if supplier is not None else f"Proveedor #{row.supplier_id}",
        "reception_id": row.reception_id,
        "reception_line_id": row.reception_line_id,
        "ingredient_id": row.ingredient_id,
        "ingredient_name": ingredient.name if ingredient is not None else f"Insumo #{row.ingredient_id}",
        "base_unit": ingredient.base_unit.value if ingredient is not None else "",
        "payable_id": row.payable_id,
        "qty": format_qty_base(row.qty_base),
        "amount": row.amount,
        "applied_to_payable": row.applied_to_payable,
        "credit_amount": row.credit_amount,
        "reason": row.reason,
        "employee_name": row.employee_name,
        "authorized_by_employee_name": row.authorized_by_employee_name,
        "created_at": row.created_at,
        "business_date": row.business_date,
    }
