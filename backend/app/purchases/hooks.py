"""Adaptador único hacia dominios ajenos, y el contrato que `purchases`
publica hacia `reports`.

**Hacia `app.inventory`** (contrato vinculante publicado en la misión de este
agente — firmas y orden de parámetros no se tocan):

    create_stock_batch(db, *, organization_id, store_id, ingredient_id, qty_base,
                       unit_cost_micros, cost_source, lot_code=None, expires_at=None,
                       received_at, business_date, source_type, source_id) -> StockBatch
    reverse_stock_batch(db, *, batch_id) -> None   # AppError("LOT_CONSUMED", status=409)
                                                    # si el lote ya se consumió en parte

Import **perezoso, dentro de cada función** — nunca a nivel de módulo — para
que este archivo sea el único lugar donde mirar si `backend-inventario`
todavía no aterrizó estas dos funciones. Si no existen, la llamada levanta
`AttributeError` (no se atrapa a propósito: no es un `AppError`, así que
`app.core.db.get_db` hace `rollback()` completo de la transacción en curso —
es la forma más simple de no dejar nada a medias mientras la dependencia no
aterriza). `app.purchases.service` nunca cae a otra causa ni sustituye estas
llamadas por nada propio.

**Hacia `reports`** (contrato publicado por este dominio, `find_spec_safe`,
nunca se llama desde afuera de otra forma):

    overdue_payables(db, *, store_id) -> list[dict]
        # {payable_id, supplier_id, supplier_name, due_date, balance, days_overdue}
    pending_review_payables_count(db, *, store_id) -> int
    reception_invoice_ratio(db, *, store_id, date_from, date_to) -> tuple[int, int]
        # (con factura, total)
    pending_drafts_count(db, store_id) -> int
        # recepciones registradas en el POS que esperan al administrador
        # (bandeja de Hoy)
    receptions_of_day(db, *, store_id, business_date) -> list[dict]
        # las líneas de las recepciones CONFIRMADAS del día operativo, con
        # su lote y vencimiento, para «Entradas de mercancía» de Hoy

**Hacia `shifts`** (2026-09-29, pantalla «Cuadres» como el café):

    supplier_names_by_cash_movement(db, movement_ids) -> dict[int, str]
        # {id del egreso del cajón: nombre del proveedor al que se le pagó}
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.purchases.models import (
    Payable,
    PayableStatus,
    Payment,
    Reception,
    ReceptionDraft,
    ReceptionDraftStatus,
    ReceptionStatus,
    Supplier,
)


def create_stock_batch(
    db: Session,
    *,
    organization_id: int,
    store_id: int,
    ingredient_id: int,
    qty_base: int,
    unit_cost_micros: int,
    cost_source: Any,
    lot_code: str | None = None,
    expires_at: date | None = None,
    received_at: datetime,
    business_date: date,
    source_type: str,
    source_id: int,
) -> Any:
    from app.inventory import hooks as inventory_hooks

    return inventory_hooks.create_stock_batch(
        db,
        organization_id=organization_id,
        store_id=store_id,
        ingredient_id=ingredient_id,
        qty_base=qty_base,
        unit_cost_micros=unit_cost_micros,
        cost_source=cost_source,
        lot_code=lot_code,
        expires_at=expires_at,
        received_at=received_at,
        business_date=business_date,
        source_type=source_type,
        source_id=source_id,
    )


def reverse_stock_batch(db: Session, *, batch_id: int) -> None:
    from app.inventory import hooks as inventory_hooks

    inventory_hooks.reverse_stock_batch(db, batch_id=batch_id)


# ---------------------------------------------------------------------------
# Contrato publicado hacia `reports`.
# ---------------------------------------------------------------------------


def overdue_payables(db: Session, *, store_id: int) -> list[dict]:
    """Cuentas por pagar vencidas (`due_date` pasada) con saldo vivo, sin
    importar si están `pending_review` o `approved` (una vencida sin
    aprobar es doblemente urgente). El saldo se deriva igual que en
    `app.purchases.service.payable_balance` — no hay una segunda fórmula."""
    from app.core import clock

    today = clock.now_utc().date()
    rows = db.execute(
        select(Payable, Supplier.name)
        .join(Supplier, Supplier.id == Payable.supplier_id)
        .where(
            Payable.store_id == store_id,
            Payable.status != PayableStatus.CANCELLED,
            Payable.due_date < today,
        )
    ).all()
    result: list[dict] = []
    for payable, supplier_name in rows:
        paid = db.execute(
            select(func.coalesce(func.sum(Payment.amount), 0)).where(
                Payment.payable_id == payable.id, Payment.voided_at.is_(None)
            )
        ).scalar_one()
        balance = payable.amount - int(paid)
        if balance <= 0:
            continue
        result.append(
            {
                "payable_id": payable.id,
                "supplier_id": payable.supplier_id,
                "supplier_name": supplier_name,
                "due_date": payable.due_date.isoformat(),
                "balance": balance,
                "days_overdue": (today - payable.due_date).days,
            }
        )
    return result


def pending_review_payables_count(db: Session, *, store_id: int) -> int:
    return int(
        db.execute(
            select(func.count()).select_from(Payable).where(
                Payable.store_id == store_id, Payable.status == PayableStatus.PENDING_REVIEW
            )
        ).scalar_one()
    )


def reception_invoice_ratio(db: Session, *, store_id: int, date_from: date, date_to: date) -> tuple[int, int]:
    """`(con factura, total)` de recepciones confirmadas en el rango
    `[date_from, date_to]` de fecha de negocio."""
    rows = db.execute(
        select(Reception.no_invoice).where(
            Reception.store_id == store_id,
            Reception.status == ReceptionStatus.CONFIRMED,
            Reception.business_date >= date_from,
            Reception.business_date <= date_to,
        )
    ).all()
    total = len(rows)
    with_invoice = sum(1 for (no_invoice,) in rows if not no_invoice)
    return with_invoice, total


def pending_drafts_count(db: Session, store_id: int) -> int:
    """Cuántas recepciones registradas desde el POS esperan que el
    administrador les ponga precios (`pending`), para la bandeja de Hoy.
    Nunca `None`: sin ninguna, es 0 de verdad (no «no sé»)."""
    return int(
        db.execute(
            select(func.count()).select_from(ReceptionDraft).where(
                ReceptionDraft.store_id == store_id, ReceptionDraft.status == ReceptionDraftStatus.PENDING
            )
        ).scalar_one()
    )


def receptions_of_day(db: Session, *, store_id: int, business_date: date) -> list[dict]:
    """Las líneas de las recepciones **confirmadas** del día operativo
    `business_date` (una revertida ya no es una entrada: su lote se dio de
    baja), en el orden en que llegaron. La cantidad se publica en la
    **unidad de compra**, convertida con la misma aritmética entera que usa
    la recepción al escribir (`qty_purchase_milli * purchase_factor`, acá al
    revés, mitad hacia arriba en la milésima), como texto decimal. Sin
    precios ni costos: Hoy muestra qué entró, no cuánto costó."""
    from app.core.quantity import format_qty_base
    from app.inventory.models import Ingredient
    from app.purchases.models import ReceptionLine

    rows = db.execute(
        select(Reception, ReceptionLine, Supplier.name, Ingredient)
        .join(ReceptionLine, ReceptionLine.reception_id == Reception.id)
        .join(Supplier, Supplier.id == Reception.supplier_id)
        .join(Ingredient, Ingredient.id == ReceptionLine.ingredient_id)
        .where(
            Reception.store_id == store_id,
            Reception.status == ReceptionStatus.CONFIRMED,
            Reception.business_date == business_date,
        )
        .order_by(Reception.at, Reception.id, ReceptionLine.id)
    ).all()
    result: list[dict] = []
    for reception, line, supplier_name, ingredient in rows:
        factor = max(1, int(ingredient.purchase_factor))
        qty_purchase_milli = (line.qty_received_base * 2 + factor) // (2 * factor)
        result.append(
            {
                "reception_id": reception.id,
                "line_id": line.id,
                "received_at": reception.at,
                "supplier_name": supplier_name,
                "ingredient_id": ingredient.id,
                "ingredient_name": ingredient.name,
                "qty": format_qty_base(qty_purchase_milli),
                "purchase_unit": ingredient.purchase_unit,
                "lot_code": line.lot_code,
                "expires_at": line.expires_at,
                "stock_batch_id": line.stock_batch_id,
                "received_by": reception.received_by_employee_name,
            }
        )
    return result
def supplier_names_by_cash_movement(db: Session, movement_ids: list[int]) -> dict[int, str]:
    """A qué proveedor se le pagó con cada egreso del cajón (causa
    `supplier_payment`): por el pago de una cuenta por pagar
    (`Payment.cash_movement_id`) o por una recepción registrada en el POS
    (`ReceptionDraft.cash_movement_id`). Lo lee «Movimientos de caja» de
    Cuadres (`app.shifts.service.build_timeline`). Sólo el nombre: nunca un
    costo."""
    ids = [int(i) for i in movement_ids]
    if not ids:
        return {}
    out: dict[int, str] = {}
    by_payment = db.execute(
        select(Payment.cash_movement_id, Supplier.name)
        .join(Payable, Payable.id == Payment.payable_id)
        .join(Supplier, Supplier.id == Payable.supplier_id)
        .where(Payment.cash_movement_id.in_(ids))
    ).all()
    for movement_id, name in by_payment:
        if movement_id is not None:
            out[int(movement_id)] = name
    by_draft = db.execute(
        select(ReceptionDraft.cash_movement_id, Supplier.name)
        .join(Supplier, Supplier.id == ReceptionDraft.supplier_id)
        .where(ReceptionDraft.cash_movement_id.in_(ids))
    ).all()
    for movement_id, name in by_draft:
        if movement_id is not None:
            out.setdefault(int(movement_id), name)
    return out
