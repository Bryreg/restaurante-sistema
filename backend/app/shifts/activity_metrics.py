"""Métricas de venta de `GET /admin/employees/{id}/activity` (ampliación
1b-2, `docs/SPEC-NEGOCIO.md §9.3` «Turnos y personal»).

Lee, de sólo lectura y protegido con `app.core.modules.find_spec_safe`
(`app.orders`/`app.payments`/`app.fiscal` pueden no estar instalados en un
árbol mínimo de pruebas, aunque en este proyecto ya existen completos desde
1b-1), los **snapshots** de la venta — nunca la carta actual
(`docs/ESTADO.md § Reglas duras`: "una venta pasada no se revalora").

Vive separado de `app.shifts.service` para no inflar ese archivo: el router
lo llama a través de `app.shifts.service.employee_activity`.
"""

from __future__ import annotations

import importlib
import statistics
from collections.abc import Sequence
from datetime import date
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.modules import find_spec_safe
from app.core.quantity import micros_to_pesos
from app.shifts.schemas import (
    EmployeeActivityCourtesies,
    EmployeeActivityDiscounts,
    EmployeeActivityMetrics,
    EmployeeActivitySales,
    EmployeeActivityTips,
    EmployeeActivityVoids,
)

_OTHER_TIP_METHODS = {"platform", "voucher", "other"}
_REQUIRED_MODULES = ("app.orders.models", "app.payments.models", "app.fiscal.models")


def _modules_available() -> bool:
    return all(find_spec_safe(name) is not None for name in _REQUIRED_MODULES)


def _enum_value(value: Any) -> str:
    return value.value if hasattr(value, "value") else str(value)


def employee_sales_metrics(
    db: Session,
    *,
    organization_id: int,
    store_id: int | None,
    employee_id: int,
    date_from: date | None,
    date_to: date | None,
) -> EmployeeActivityMetrics | None:
    """`None` si `app.orders`/`app.payments`/`app.fiscal` no están instalados
    (árbol mínimo); nunca ceros por defecto — la ausencia del dato no es lo
    mismo que "sin actividad" (`docs/ESTADO.md`: `null` no es 0)."""

    if not _modules_available():
        return None

    orders_models = importlib.import_module("app.orders.models")
    payments_models = importlib.import_module("app.payments.models")
    fiscal_models = importlib.import_module("app.fiscal.models")

    Order = orders_models.Order
    OrderItem = orders_models.OrderItem
    OrderDiscount = orders_models.OrderDiscount
    VoidReason = orders_models.VoidReason
    Payment = payments_models.Payment
    FiscalDocument = fiscal_models.FiscalDocument
    DocumentReprint = fiscal_models.DocumentReprint

    def _scope_order(stmt: Any, order_col: Any) -> Any:
        if store_id is not None:
            stmt = stmt.where(order_col.store_id == store_id)
        if date_from is not None:
            stmt = stmt.where(order_col.business_date >= date_from)
        if date_to is not None:
            stmt = stmt.where(order_col.business_date <= date_to)
        return stmt

    # -- Comandas pagadas que abrió esta persona -------------------------
    orders_stmt = select(Order).where(
        Order.organization_id == organization_id,
        Order.opened_by_employee_id == employee_id,
        Order.status == "paid",
    )
    orders_stmt = _scope_order(orders_stmt, Order)
    orders = list(db.execute(orders_stmt).scalars())
    order_ids = [o.id for o in orders]

    sales_net = 0
    if order_ids:
        doc_stmt = select(FiscalDocument.total, FiscalDocument.tax_total).where(
            FiscalDocument.order_id.in_(order_ids), FiscalDocument.status == "issued"
        )
        for total, tax_total in db.execute(doc_stmt).all():
            sales_net += int(total) - int(tax_total)
    orders_count = len(orders)
    avg_ticket = sales_net // orders_count if orders_count else None

    # -- Anulaciones de ítem que esta persona ejecutó ---------------------
    void_stmt = (
        select(OrderItem, Order)
        .join(Order, OrderItem.order_id == Order.id)
        .where(OrderItem.voided_by_employee_id == employee_id, Order.organization_id == organization_id)
    )
    void_stmt = _scope_order(void_stmt, Order)
    void_rows = list(db.execute(void_stmt).all())

    void_n = len(void_rows)
    void_amount = sum(int(item.unit_price) * int(item.qty) for item, _ in void_rows)
    void_after_bill = sum(1 for item, _ in void_rows if item.void_after_bill)
    walkouts = sum(1 for item, _ in void_rows if item.void_reason == VoidReason.WALKOUT)

    paid_order_ids_with_void = {order.id for _, order in void_rows if order.status == "paid"}
    cash_paid_order_ids: set[int] = set()
    if paid_order_ids_with_void:
        cash_rows = db.execute(
            select(Payment.order_id).where(
                Payment.order_id.in_(paid_order_ids_with_void),
                Payment.method == "cash",
                Payment.voided_at.is_(None),
            )
        ).all()
        cash_paid_order_ids = {r[0] for r in cash_rows}
    void_on_cash = sum(1 for _, order in void_rows if order.id in cash_paid_order_ids)

    void_pct = (void_amount / sales_net) if sales_net > 0 else None

    # -- Descuentos que esta persona aplicó --------------------------------
    disc_stmt = (
        select(OrderDiscount)
        .join(Order, OrderDiscount.order_id == Order.id)
        .where(
            OrderDiscount.employee_id == employee_id,
            OrderDiscount.voided_at.is_(None),
            Order.organization_id == organization_id,
        )
    )
    disc_stmt = _scope_order(disc_stmt, Order)
    discounts = list(db.execute(disc_stmt).scalars())
    discounts_n = len(discounts)
    discounts_amount = sum(int(d.amount) for d in discounts)

    # -- Cortesías que esta persona autorizó --------------------------------
    court_stmt = (
        select(OrderItem)
        .join(Order, OrderItem.order_id == Order.id)
        .where(
            OrderItem.courtesy_authorized_by_employee_id == employee_id,
            OrderItem.courtesy_reason.is_not(None),
            Order.organization_id == organization_id,
        )
    )
    court_stmt = _scope_order(court_stmt, Order)
    courtesy_items = list(db.execute(court_stmt).scalars())
    courtesies_n = len(courtesy_items)
    courtesies_amount = sum(int(i.list_price) * int(i.qty) for i in courtesy_items)
    # A costo (pedido 2a): se suma en MICROS y se convierte una sola vez, para
    # no perder el sub-peso — `unit_cost` ya viene redondeado por ítem.
    courtesy_micros = [
        int(i.unit_cost_micros) * int(i.qty) for i in courtesy_items if i.unit_cost_micros is not None
    ]
    courtesies_cost = micros_to_pesos(sum(courtesy_micros)) if courtesy_micros else None

    # -- Reimpresiones que esta persona hizo ------------------------------
    reprint_stmt = (
        select(DocumentReprint)
        .join(FiscalDocument, DocumentReprint.document_id == FiscalDocument.id)
        .where(DocumentReprint.employee_id == employee_id, FiscalDocument.organization_id == organization_id)
    )
    if store_id is not None:
        reprint_stmt = reprint_stmt.where(FiscalDocument.store_id == store_id)
    if date_from is not None:
        reprint_stmt = reprint_stmt.where(FiscalDocument.business_date >= date_from)
    if date_to is not None:
        reprint_stmt = reprint_stmt.where(FiscalDocument.business_date <= date_to)
    reprints_count = len(list(db.execute(reprint_stmt).scalars()))

    # -- % de ítems que se enviaron recién al cobrar -----------------------
    sent_at_payment_pct: float | None = None
    if order_ids:
        flags_stmt = (
            select(OrderItem.sent_at_payment)
            .join(Order, OrderItem.order_id == Order.id)
            .where(
                Order.id.in_(order_ids),
                Order.kitchen_view_enabled.is_(True),
                OrderItem.status != "voided",
            )
        )
        flags = [bool(row[0]) for row in db.execute(flags_stmt).all()]
        if flags:
            sent_at_payment_pct = sum(1 for f in flags if f) / len(flags)

    # -- Propinas que esta persona cobró ------------------------------------
    tips_stmt = select(Payment.method, Payment.tip_amount).where(
        Payment.employee_id == employee_id,
        Payment.organization_id == organization_id,
        Payment.voided_at.is_(None),
    )
    if store_id is not None:
        tips_stmt = tips_stmt.where(Payment.store_id == store_id)
    if date_from is not None:
        tips_stmt = tips_stmt.where(Payment.business_date >= date_from)
    if date_to is not None:
        tips_stmt = tips_stmt.where(Payment.business_date <= date_to)
    tips = {"cash": 0, "card": 0, "transfer": 0, "other": 0}
    for method, tip_amount in db.execute(tips_stmt).all():
        bucket = _enum_value(method)
        if bucket in _OTHER_TIP_METHODS:
            bucket = "other"
        if bucket not in tips:
            bucket = "other"
        tips[bucket] += int(tip_amount or 0)

    return EmployeeActivityMetrics(
        sales=EmployeeActivitySales(net=sales_net, orders=orders_count, avg_ticket=avg_ticket),
        voids=EmployeeActivityVoids(
            n=void_n,
            amount=void_amount,
            pct_of_sales=void_pct,
            after_bill=void_after_bill,
            on_cash=void_on_cash,
            walkouts=walkouts,
        ),
        discounts=EmployeeActivityDiscounts(n=discounts_n, amount=discounts_amount),
        courtesies=EmployeeActivityCourtesies(n=courtesies_n, amount=courtesies_amount, theoretical_cost=courtesies_cost),
        reprints=reprints_count,
        sent_at_payment_pct=sent_at_payment_pct,
        tips=EmployeeActivityTips(
            cash=tips["cash"],
            card=tips["card"],
            transfer=tips["transfer"],
            other=tips["other"],
            total=sum(tips.values()),
        ),
    )


def _mean(values: Sequence[float]) -> float:
    return statistics.fmean(values)


def team_average_metrics(
    db: Session,
    *,
    organization_id: int,
    store_id: int | None,
    date_from: date | None,
    date_to: date | None,
    exclude_employee_id: int | None = None,
) -> EmployeeActivityMetrics | None:
    """Promedio simple (no ponderado por ventas) de la misma métrica sobre
    cada persona que abrió al menos una comanda pagada en el período —
    "comparado contra el promedio del equipo" (SPEC-NEGOCIO §9.3). `None` si
    no hay ningún dato (módulos ausentes o nadie vendió en el período)."""

    if not _modules_available():
        return None

    orders_models = importlib.import_module("app.orders.models")
    Order = orders_models.Order

    stmt = select(Order.opened_by_employee_id).where(
        Order.organization_id == organization_id, Order.status == "paid"
    )
    if store_id is not None:
        stmt = stmt.where(Order.store_id == store_id)
    if date_from is not None:
        stmt = stmt.where(Order.business_date >= date_from)
    if date_to is not None:
        stmt = stmt.where(Order.business_date <= date_to)
    stmt = stmt.distinct()

    employee_ids = [row[0] for row in db.execute(stmt).all()]
    if exclude_employee_id is not None:
        employee_ids = [e for e in employee_ids if e != exclude_employee_id]
    if not employee_ids:
        return None

    per_employee = [
        employee_sales_metrics(
            db,
            organization_id=organization_id,
            store_id=store_id,
            employee_id=eid,
            date_from=date_from,
            date_to=date_to,
        )
        for eid in employee_ids
    ]
    metrics = [m for m in per_employee if m is not None]
    if not metrics:
        return None

    avg_tickets = [m.sales.avg_ticket for m in metrics if m.sales.avg_ticket is not None]
    void_pcts = [m.voids.pct_of_sales for m in metrics if m.voids.pct_of_sales is not None]
    sent_pcts = [m.sent_at_payment_pct for m in metrics if m.sent_at_payment_pct is not None]

    return EmployeeActivityMetrics(
        sales=EmployeeActivitySales(
            net=round(_mean([m.sales.net for m in metrics])),
            orders=round(_mean([m.sales.orders for m in metrics])),
            avg_ticket=round(_mean(avg_tickets)) if avg_tickets else None,
        ),
        voids=EmployeeActivityVoids(
            n=round(_mean([m.voids.n for m in metrics])),
            amount=round(_mean([m.voids.amount for m in metrics])),
            pct_of_sales=_mean(void_pcts) if void_pcts else None,
            after_bill=round(_mean([m.voids.after_bill for m in metrics])),
            on_cash=round(_mean([m.voids.on_cash for m in metrics])),
            walkouts=round(_mean([m.voids.walkouts for m in metrics])),
        ),
        discounts=EmployeeActivityDiscounts(
            n=round(_mean([m.discounts.n for m in metrics])),
            amount=round(_mean([m.discounts.amount for m in metrics])),
        ),
        courtesies=EmployeeActivityCourtesies(
            n=round(_mean([m.courtesies.n for m in metrics])),
            amount=round(_mean([m.courtesies.amount for m in metrics])),
            # Promedia sólo a quienes tienen costo; si nadie lo tiene queda
            # `None`, no `0` — el promedio de "sin dato" no es cero.
            theoretical_cost=(
                round(_mean(costos))
                if (costos := [m.courtesies.theoretical_cost for m in metrics if m.courtesies.theoretical_cost is not None])
                else None
            ),
        ),
        reprints=round(_mean([m.reprints for m in metrics])),
        sent_at_payment_pct=_mean(sent_pcts) if sent_pcts else None,
        tips=EmployeeActivityTips(
            cash=round(_mean([m.tips.cash for m in metrics])),
            card=round(_mean([m.tips.card for m in metrics])),
            transfer=round(_mean([m.tips.transfer for m in metrics])),
            other=round(_mean([m.tips.other for m in metrics])),
            total=round(_mean([m.tips.total for m in metrics])),
        ),
    )
