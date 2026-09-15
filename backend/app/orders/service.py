"""Reglas de negocio de la comanda (`CONTRATO-INTERNO-1b-1.md §2.3`, §2.4).

Las firmas públicas que cruzan territorio (`get_order_or_404`,
`compute_order_totals`, `compute_sub_account_totals`, `order_out`,
`assert_payable`, `claim_payment`, `auto_send_pending_for_payment`,
`business_date_for_sale`) las llama `backend-cobro` desde `app.payments` y
`backend-base` desde `app.shifts` — no se les cambia la firma sin avisar.

Lo que la comanda necesita de la carta se **lee** de `app.catalog.models` y se
**llama** en `app.catalog.service`; nunca se modifica ese módulo.
"""

from __future__ import annotations

import importlib
import importlib.util
from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Any

from sqlalchemy import delete, func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.audit.service import record_audit
from app.auth import service as auth_service
from app.auth.deps import Actor
from app.auth.models import Employee
from app.catalog import service as catalog_service
from app.catalog.models import Combo, ComboGroup, ComboOption, ModifierGroup, ModifierOption, Product
from app.core import clock, features, tz
from app.core.errors import AppError, ConflictError, NotFoundError
from app.core.modules import find_spec_safe
from app.notifications.service import notify
from app.orders import money
from app.orders.models import (
    CourtesyReason,
    DiscountReason,
    Order,
    OrderChannel,
    OrderDiscount,
    OrderEvent,
    OrderItem,
    OrderItemStatus,
    OrderRound,
    OrderStatus,
    OrderSubAccount,
    OrderSubAccountItem,
    OrderTable,
    VoidReason,
    WasteStub,
)
from app.orders.schemas import (
    AddItemsIn,
    ComboSelectionOut,
    CourtesyItemIn,
    CourtesyOut,
    DiscountIn,
    EmployeeRef,
    FavoriteOut,
    MergeIn,
    ModifierOut,
    MoveIn,
    OrderCreateIn,
    OrderDiscountOut,
    OrderItemIn,
    OrderItemOut,
    OrderOut,
    OrderRoundOut,
    PatchItemIn,
    PreBillLineOut,
    PreBillOut,
    SplitGroupIn,
    SubAccountItemOut,
    SubAccountOut,
    TableRef,
    TableStatusOut,
    TablesStatusOut,
    TakeoutOut,
    TaxLineOut,
    TipInfoOut,
    TotalsOut,
    VoidInfoOut,
    VoidOrderIn,
    ZoneStatusOut,
)
from app.shifts import service as shifts_service
from app.shifts.models import BusinessDay, Shift, ShiftStatus
from app.stores import service as stores_service
from app.stores.models import Store, Table, Zone

# Colombia: tasa entera por código de impuesto. No existe un mapeo así en
# `app.catalog`/`app.stores` (territorio ajeno); se declara acá porque la
# comanda es la primera que necesita convertir el `tax_code` de la carta en
# una tasa entera para la matemática de la venta (declarado en `gaps`).
TAX_RATE_BY_CODE: dict[str, int] = {"inc_8": 8, "iva_19": 19, "excluded": 0}

_OPEN_ORDER_STATUSES = (OrderStatus.OPEN, OrderStatus.TO_PAY)
_LIVE_ITEM_STATUSES_SENT = (OrderItemStatus.SENT, OrderItemStatus.READY, OrderItemStatus.SERVED)


# ---------------------------------------------------------------------------
# Lectura con aislamiento por organización/sede
# ---------------------------------------------------------------------------


def get_order_or_404(db: Session, *, actor: Actor, order_id: int) -> Order:
    order = db.get(Order, order_id)
    if order is None or order.organization_id != actor.organization_id:
        raise NotFoundError("La comanda no existe")
    if actor.kind == "device" and order.store_id != actor.store_id:
        raise NotFoundError("La comanda no existe")
    return order


def get_sub_account_or_404(db: Session, order: Order, sub_account_id: int) -> OrderSubAccount:
    row = db.get(OrderSubAccount, sub_account_id)
    if row is None or row.order_id != order.id:
        raise NotFoundError("La sub-cuenta no existe en esta comanda")
    return row


def _get_item_or_404(db: Session, order: Order, item_id: int) -> OrderItem:
    item = db.get(OrderItem, item_id)
    if item is None or item.order_id != order.id:
        raise NotFoundError("El ítem no existe en esta comanda")
    return item


# ---------------------------------------------------------------------------
# La matemática de la venta, aplicada a la comanda y a las sub-cuentas.
# ---------------------------------------------------------------------------


def _live_items(db: Session, order_id: int) -> list[OrderItem]:
    return list(
        db.execute(
            select(OrderItem)
            .where(OrderItem.order_id == order_id, OrderItem.status != OrderItemStatus.VOIDED)
            .order_by(OrderItem.id)
        ).scalars()
    )


def _line_input(item: OrderItem) -> money.LineInput:
    gross = item.unit_price * item.qty
    # Defensivo: un ítem que pasó a cortesía después de tener un descuento de
    # línea puede quedar con `discount_amount` > 0 y `gross` 0; nunca dejamos
    # que el descuento supere el bruto (rompería `net = gross - discount`).
    item_discount = min(item.discount_amount, gross)
    return money.LineInput(
        item_id=item.id,
        gross=gross,
        tax_rate=item.tax_rate,
        item_discount=item_discount,
        is_combo=item.combo_id is not None,
        price_includes_tax=item.price_includes_tax,
    )


def _live_order_discount_rows(db: Session, order_id: int) -> list[OrderDiscount]:
    return list(
        db.execute(
            select(OrderDiscount)
            .where(OrderDiscount.order_id == order_id, OrderDiscount.scope == "order", OrderDiscount.voided_at.is_(None))
            .order_by(OrderDiscount.at, OrderDiscount.id)
        ).scalars()
    )


def compute_order_totals(db: Session, order: Order) -> money.OrderTotals:
    items = _live_items(db, order.id)
    lines = [_line_input(i) for i in items]
    discount_rows = _live_order_discount_rows(db, order.id)
    pairs = [(d.kind, d.value) for d in discount_rows]
    return money.compute_totals(lines, pairs)


def _sub_account_item_allocations(db: Session, order: Order) -> dict[int, dict[str, int]]:
    """`order_sub_account_items.id` -> {gross, discount, base, tax, net} de su
    porción. Cada porción se calcula prorateando (`money.prorate`) el valor de
    la línea completa por los `portions` de todas las filas que comparten ese
    ítem en la comanda (no solo las de una sub-cuenta): así la suma de todas
    las sub-cuentas reproduce exactamente el total de la comanda (invariante
    #2 del contrato)."""
    totals = compute_order_totals(db, order)
    line_by_item = {lt.item_id: lt for lt in totals.lines}

    rows = list(
        db.execute(
            select(OrderSubAccountItem, OrderSubAccount.seq)
            .join(OrderSubAccount, OrderSubAccountItem.sub_account_id == OrderSubAccount.id)
            .where(OrderSubAccount.order_id == order.id)
            .order_by(OrderSubAccountItem.order_item_id, OrderSubAccount.seq, OrderSubAccountItem.id)
        ).all()
    )
    by_item: dict[int, list[OrderSubAccountItem]] = {}
    for row, _seq in rows:
        by_item.setdefault(row.order_item_id, []).append(row)

    allocations: dict[int, dict[str, int]] = {}
    for order_item_id, entries in by_item.items():
        line = line_by_item.get(order_item_id)
        if line is None:
            for entry in entries:
                allocations[entry.id] = {"gross": 0, "discount": 0, "base": 0, "tax": 0, "net": 0}
            continue
        weights = [entry.portions for entry in entries]
        gross_shares = money.prorate(line.gross, weights)
        discount_shares = money.prorate(line.discount, weights)
        base_shares = money.prorate(line.base, weights)
        net_shares = money.prorate(line.net, weights)
        for entry, g, d, b, n in zip(entries, gross_shares, discount_shares, base_shares, net_shares):
            allocations[entry.id] = {"gross": g, "discount": d, "base": b, "tax": n - b, "net": n}
    return allocations


def compute_sub_account_totals(db: Session, sub_account: OrderSubAccount) -> money.OrderTotals:
    order = db.get(Order, sub_account.order_id)
    if order is None:
        return money.OrderTotals(subtotal=0, discount_total=0, total=0, tax_total=0, tip_base=0)
    allocations = _sub_account_item_allocations(db, order)
    rows = list(
        db.execute(select(OrderSubAccountItem).where(OrderSubAccountItem.sub_account_id == sub_account.id)).scalars()
    )
    subtotal = discount_total = tax_total = total = 0
    tax_buckets: dict[int, list[int]] = {}
    for row in rows:
        item = db.get(OrderItem, row.order_item_id)
        alloc = allocations.get(row.id, {"gross": 0, "discount": 0, "base": 0, "tax": 0, "net": 0})
        subtotal += alloc["gross"]
        discount_total += alloc["discount"]
        tax_total += alloc["tax"]
        total += alloc["net"]
        rate = item.tax_rate if item is not None else 0
        bucket = tax_buckets.setdefault(rate, [0, 0])
        bucket[0] += alloc["base"]
        bucket[1] += alloc["tax"]
    tax_lines = [money.TaxLine(rate=r, base=b, tax=t) for r, (b, t) in sorted(tax_buckets.items())]
    return money.OrderTotals(
        subtotal=subtotal,
        discount_total=discount_total,
        total=total,
        tax_total=tax_total,
        tip_base=total - tax_total,
        tax_lines=tax_lines,
        lines=[],
    )


def _totals_out(totals: money.OrderTotals) -> TotalsOut:
    return TotalsOut(
        subtotal=totals.subtotal,
        discount_total=totals.discount_total,
        tax_lines=[TaxLineOut(rate=t.rate, base=t.base, tax=t.tax) for t in totals.tax_lines],
        tax_total=totals.tax_total,
        total=totals.total,
    )


def _tip_info(db: Session, order: Order, totals: money.OrderTotals) -> TipInfoOut | None:
    if order.channel == OrderChannel.STAFF_MEAL:
        return None
    if not features.is_enabled(db, order.organization_id, order.store_id, "pos.tips"):
        return None
    settings = stores_service.get_sales_settings(db, order.store_id)
    pct = Decimal(str(settings.tip_suggested_pct))
    if pct > Decimal("10"):
        pct = Decimal("10")
    if pct < 0:
        pct = Decimal("0")
    basis_points = int((pct * 100).to_integral_value())
    tip_base = max(totals.tip_base, 0)
    suggested_amount = money.round_half_up(tip_base * basis_points, 10000)
    return TipInfoOut(base=totals.tip_base, suggested_pct=float(pct), suggested_amount=suggested_amount)


def _order_document_id(db: Session, order_id: int) -> int | None:
    """Lee `app.fiscal.models.FiscalDocument` sólo si ya existe (construcción
    en paralelo con `backend-cobro`: `find_spec` como en el resto del repo)."""
    if find_spec_safe("app.fiscal.models") is None:
        return None
    module = importlib.import_module("app.fiscal.models")
    fiscal_document_cls = getattr(module, "FiscalDocument", None)
    if fiscal_document_cls is None:
        return None
    return db.execute(
        select(fiscal_document_cls.id)
        .where(fiscal_document_cls.order_id == order_id, fiscal_document_cls.sub_account_id.is_(None))
        .order_by(fiscal_document_cls.id.desc())
    ).scalars().first()


def _order_table_refs(db: Session, order_id: int) -> list[TableRef]:
    rows = db.execute(
        select(Table, Zone.name)
        .join(Zone, Table.zone_id == Zone.id)
        .join(OrderTable, OrderTable.table_id == Table.id)
        .where(OrderTable.order_id == order_id, OrderTable.released_at.is_(None))
        .order_by(Table.number)
    ).all()
    return [TableRef(id=t.id, number=t.number, zone_name=zone_name) for t, zone_name in rows]


def sub_account_out(db: Session, sub_account: OrderSubAccount) -> SubAccountOut:
    order = db.get(Order, sub_account.order_id)
    totals = compute_sub_account_totals(db, sub_account)
    allocations = _sub_account_item_allocations(db, order) if order else {}
    rows = list(
        db.execute(select(OrderSubAccountItem).where(OrderSubAccountItem.sub_account_id == sub_account.id)).scalars()
    )
    items_out: list[SubAccountItemOut] = []
    for row in rows:
        item = db.get(OrderItem, row.order_item_id)
        alloc = allocations.get(row.id, {"net": 0})
        items_out.append(
            SubAccountItemOut(
                item_id=row.order_item_id,
                name=item.name if item else "",
                qty=item.qty if item else 0,
                portions=row.portions,
                of_portions=row.of_portions,
                share=alloc.get("net", 0),
            )
        )
    tip = _tip_info(db, order, totals) if order is not None else None
    return SubAccountOut(
        id=sub_account.id,
        seq=sub_account.seq,
        label=sub_account.label,
        seat=sub_account.seat,
        status=sub_account.status,  # type: ignore[arg-type]
        items=items_out,
        totals=_totals_out(totals),
        tip=tip,
        document_id=sub_account.document_id,
    )


def order_out(db: Session, order: Order, *, for_device: bool) -> OrderOut:
    """`for_device=True` nunca serializa `unit_cost` (siempre `NULL` en 1b de
    todos modos: la bandera queda para cuando fase 2 traiga costo real y la
    respuesta de admin pueda divergir de la del dispositivo)."""
    del for_device  # ver docstring: en 1b no hay campo que ocultar distinto

    totals = compute_order_totals(db, order)
    line_by_item = {lt.item_id: lt for lt in totals.lines}

    tables = _order_table_refs(db, order.id)
    rounds = [
        OrderRoundOut(round_no=r.round_no, sent_at=r.sent_at, sent_at_payment=r.sent_at_payment)
        for r in db.execute(select(OrderRound).where(OrderRound.order_id == order.id).order_by(OrderRound.round_no)).scalars()
    ]

    items_rows = list(db.execute(select(OrderItem).where(OrderItem.order_id == order.id).order_by(OrderItem.id)).scalars())
    items_out: list[OrderItemOut] = []
    for item in items_rows:
        lt = line_by_item.get(item.id)
        courtesy = None
        if item.courtesy_reason is not None:
            courtesy = CourtesyOut(
                reason=item.courtesy_reason.value,
                note=item.courtesy_note,
                authorized_by=EmployeeRef(id=item.courtesy_authorized_by_employee_id, name=item.courtesy_authorized_by_employee_name or "")
                if item.courtesy_authorized_by_employee_id
                else None,
                at=item.courtesy_at,  # type: ignore[arg-type]
                after_bill=item.courtesy_after_bill,
            )
        void = None
        if item.voided_at is not None:
            void = VoidInfoOut(
                reason=item.void_reason.value if item.void_reason else "other",  # type: ignore[union-attr]
                note=item.void_note,
                by=EmployeeRef(id=item.voided_by_employee_id, name=item.voided_by_employee_name or "") if item.voided_by_employee_id else None,
                authorized_by=EmployeeRef(id=item.void_authorized_by_employee_id, name=item.void_authorized_by_employee_name or "")
                if item.void_authorized_by_employee_id
                else None,
                at=item.voided_at,
                after_bill=item.void_after_bill,
                minutes_since_sent=item.void_minutes_since_sent,
            )
        items_out.append(
            OrderItemOut(
                id=item.id,
                product_id=item.product_id,
                combo_id=item.combo_id,
                name=item.name,
                qty=item.qty,
                seat=item.seat,
                course=item.course,
                station=item.station,
                list_price=item.list_price,
                unit_price=item.unit_price,
                tax_code=item.tax_code,
                tax_rate=item.tax_rate,
                modifiers=[ModifierOut(**m) for m in (item.modifiers or [])],
                modifiers_text=item.modifiers_text,
                combo_selections=[ComboSelectionOut(**c) for c in item.combo_selections] if item.combo_selections else None,
                note=item.note,
                status=item.status.value,  # type: ignore[arg-type]
                round_no=item.round_no,
                sent_at=item.sent_at,
                ready_at=item.ready_at,
                served_at=item.served_at,
                sent_at_payment=item.sent_at_payment,
                gross=lt.gross if lt else 0,
                discount=lt.discount if lt else 0,
                net=lt.net if lt else 0,
                tax=lt.tax if lt else 0,
                courtesy=courtesy,
                void=void,
            )
        )

    discounts_rows = list(
        db.execute(
            select(OrderDiscount)
            .where(OrderDiscount.order_id == order.id, OrderDiscount.voided_at.is_(None))
            .order_by(OrderDiscount.id)
        ).scalars()
    )
    discounts_out = [
        OrderDiscountOut(
            id=d.id,
            scope=d.scope,  # type: ignore[arg-type]
            item_id=d.item_id,
            kind=d.kind,  # type: ignore[arg-type]
            value=d.value,
            amount=d.amount,
            reason=d.reason.value,  # type: ignore[arg-type]
            note=d.note,
            by=EmployeeRef(id=d.employee_id, name=d.employee_name),
            authorized_by=EmployeeRef(id=d.authorized_by_employee_id, name=d.authorized_by_employee_name or "") if d.authorized_by_employee_id else None,
            after_bill=d.after_bill,
            at=d.at,
        )
        for d in discounts_rows
    ]

    sub_accounts_rows = list(
        db.execute(select(OrderSubAccount).where(OrderSubAccount.order_id == order.id).order_by(OrderSubAccount.seq)).scalars()
    )
    sub_accounts_out = [sub_account_out(db, row) for row in sub_accounts_rows]

    takeout = None
    if order.channel == OrderChannel.TAKEOUT and order.takeout_customer_name is not None:
        takeout = TakeoutOut(customer_name=order.takeout_customer_name, phone=order.takeout_phone, promised_at=order.promised_at)

    consumed_by = EmployeeRef(id=order.consumed_by_employee_id, name=order.consumed_by_employee_name or "") if order.consumed_by_employee_id else None
    paid_by = EmployeeRef(id=order.paid_by_employee_id, name=order.paid_by_employee_name or "") if order.paid_by_employee_id else None

    tip = _tip_info(db, order, totals)
    document_id = _order_document_id(db, order.id)

    return OrderOut(
        id=order.id,
        version=order.version,
        channel=order.channel.value,  # type: ignore[arg-type]
        status=order.status.value,  # type: ignore[arg-type]
        business_date=order.business_date,
        shift_id=order.shift_id,
        tables=tables,
        covers=order.covers,
        note=order.note,
        takeout=takeout,
        consumed_by=consumed_by,
        opened_by=EmployeeRef(id=order.opened_by_employee_id, name=order.opened_by_employee_name),
        opened_at=order.opened_at,
        bill_presented_at=order.bill_presented_at,
        bill_print_count=order.bill_print_count,
        paid_at=order.paid_at,
        closed_at=order.closed_at,
        paid_by=paid_by,
        voided_at=order.voided_at,
        void_reason=order.void_reason.value if order.void_reason else None,  # type: ignore[union-attr]
        merged_into_order_id=order.merged_into_order_id,
        transferred_from_shift_id=order.transferred_from_shift_id,
        kitchen_view_enabled=order.kitchen_view_enabled,
        split_parts=order.split_parts,
        rounds=rounds,
        items=items_out,
        discounts=discounts_out,
        sub_accounts=sub_accounts_out,
        totals=_totals_out(totals),
        tip=tip,
        document_id=document_id,
    )


def _check_version(db: Session, order: Order, expected_version: int, *, actor: Actor) -> None:
    if order.version != expected_version:
        raise ConflictError(
            "La comanda cambió en otra tablet: revisá y repetí la acción",
            code="STALE_VERSION",
            extra={"order": order_out(db, order, for_device=(actor.kind != "admin")).model_dump(mode="json")},
        )


# ---------------------------------------------------------------------------
# Mesas y favoritos
# ---------------------------------------------------------------------------


def tables_status(db: Session, *, store_id: int) -> TablesStatusOut:
    zones = list(db.execute(select(Zone).where(Zone.store_id == store_id, Zone.active.is_(True)).order_by(Zone.sort_order, Zone.id)).scalars())
    zones_out: list[ZoneStatusOut] = []
    for zone in zones:
        tables = list(db.execute(select(Table).where(Table.zone_id == zone.id, Table.active.is_(True)).order_by(Table.number)).scalars())
        tables_out: list[TableStatusOut] = []
        for table in tables:
            ot = db.execute(select(OrderTable).where(OrderTable.table_id == table.id, OrderTable.released_at.is_(None))).scalars().first()
            if ot is None:
                tables_out.append(TableStatusOut(id=table.id, number=table.number, seats=table.seats, status="free"))
                continue
            order = db.get(Order, ot.order_id)
            if order is None:
                tables_out.append(TableStatusOut(id=table.id, number=table.number, seats=table.seats, status="free"))
                continue
            status: Any = "to_pay" if order.status == OrderStatus.TO_PAY else "occupied"
            total = compute_order_totals(db, order).total
            tables_out.append(
                TableStatusOut(
                    id=table.id,
                    number=table.number,
                    seats=table.seats,
                    status=status,
                    order_id=order.id,
                    opened_at=order.opened_at,
                    covers=order.covers,
                    total=total,
                )
            )
        zones_out.append(ZoneStatusOut(id=zone.id, name=zone.name, tables=tables_out))
    return TablesStatusOut(zones=zones_out)


def list_favorites(db: Session, *, store_id: int) -> list[FavoriteOut]:
    store = db.get(Store, store_id)
    cutoff_hour = store.cutoff_hour if store is not None else 6
    today = tz.today_business_date(cutoff_hour)
    since = today - timedelta(days=7)
    rows = db.execute(
        select(OrderItem.product_id, func.sum(OrderItem.qty))
        .join(Order, OrderItem.order_id == Order.id)
        .where(
            Order.store_id == store_id,
            Order.status == OrderStatus.PAID,
            Order.business_date >= since,
            OrderItem.status != OrderItemStatus.VOIDED,
            OrderItem.product_id.is_not(None),
        )
        .group_by(OrderItem.product_id)
        .order_by(func.sum(OrderItem.qty).desc())
        .limit(12)
    ).all()
    return [FavoriteOut(product_id=pid, qty=int(qty)) for pid, qty in rows]


def _current_open_shift(db: Session, store_id: int) -> Shift | None:
    return db.execute(select(Shift).where(Shift.store_id == store_id, Shift.status == ShiftStatus.OPEN)).scalars().first()


def list_orders(db: Session, *, actor: Actor, status: str | None, channel: str | None) -> list[Order]:
    stmt = select(Order).where(Order.store_id == actor.store_id)
    if status:
        status_enum = OrderStatus(status)
        stmt = stmt.where(Order.status == status_enum)
        if status_enum == OrderStatus.PAID:
            shift = _current_open_shift(db, actor.store_id)  # type: ignore[arg-type]
            stmt = stmt.where(Order.shift_id == (shift.id if shift is not None else -1))
    if channel:
        stmt = stmt.where(Order.channel == OrderChannel(channel))
    stmt = stmt.order_by(Order.opened_at.desc())
    return list(db.execute(stmt).scalars())


# ---------------------------------------------------------------------------
# Crear comanda
# ---------------------------------------------------------------------------

_CHANNEL_FEATURE: dict[OrderChannel, str] = {
    OrderChannel.COUNTER: "pos.counter",
    OrderChannel.DINE_IN: "pos.tables",
    OrderChannel.TAKEOUT: "pos.takeout",
    OrderChannel.STAFF_MEAL: "pos.staff_meal",
}


def _load_active_tables(db: Session, store_id: int, table_ids: list[int]) -> list[Table]:
    rows = list(db.execute(select(Table).where(Table.id.in_(table_ids), Table.store_id == store_id, Table.active.is_(True))).scalars())
    by_id = {t.id: t for t in rows}
    missing = [tid for tid in table_ids if tid not in by_id]
    if missing:
        raise NotFoundError(f"La mesa {missing[0]} no existe en esta sede")
    return [by_id[tid] for tid in table_ids]


def business_date_for_sale(db: Session, shift: Shift, store: Store, now: datetime) -> date:
    if shifts_service.is_shift_stale(db, shift, store):
        return tz.today_business_date(store.cutoff_hour)
    day = db.get(BusinessDay, shift.business_day_id)
    if day is not None:
        return day.business_date
    return tz.today_business_date(store.cutoff_hour)


def create_order(db: Session, *, actor: Actor, store: Store, payload: OrderCreateIn) -> Order:
    channel = OrderChannel(payload.channel)
    if channel not in _CHANNEL_FEATURE:
        raise AppError("CHANNEL_DISABLED", "Este canal no está disponible en este pedido", extra={"channel": channel.value})
    features.assert_feature(db, store.organization_id, store.id, _CHANNEL_FEATURE[channel])

    if channel in (OrderChannel.COUNTER, OrderChannel.DINE_IN, OrderChannel.TAKEOUT):
        if channel.value not in (store.active_channels or []):
            raise AppError(
                "CHANNEL_DISABLED",
                f'El canal "{channel.value}" no está activo en esta sede: activalo en Configuración',
                extra={"channel": channel.value},
            )

    shift = shifts_service.get_current_shift(db, store=store)
    if shift is None:
        raise AppError("NO_OPEN_SHIFT", "Abrí un turno para poder vender", status=400)

    tables: list[Table] = []
    if channel == OrderChannel.DINE_IN:
        if not payload.table_ids:
            raise AppError("TABLE_REQUIRED", "Elegí al menos una mesa para una comanda de mesa")
        tables = _load_active_tables(db, store.id, payload.table_ids)
        for table in tables:
            existing = db.execute(select(OrderTable).where(OrderTable.table_id == table.id, OrderTable.released_at.is_(None))).scalars().first()
            if existing is not None:
                raise ConflictError(f"La mesa {table.number} ya tiene una comanda abierta", code="TABLE_ALREADY_OPEN", extra={"table_id": table.id})

    consumed_by: Employee | None = None
    if channel == OrderChannel.STAFF_MEAL:
        if payload.consumed_by_employee_id is None:
            raise AppError("STAFF_MEAL_CONSUMER_REQUIRED", "Elegí quién consume para una comanda de personal")
        consumed_by = db.get(Employee, payload.consumed_by_employee_id)
        if consumed_by is None or consumed_by.organization_id != store.organization_id or not consumed_by.active:
            raise NotFoundError("El empleado no existe")
        if consumed_by.store_id is not None and consumed_by.store_id != store.id:
            raise NotFoundError("El empleado no existe en esta sede")

    now = clock.now_utc()
    business_date = business_date_for_sale(db, shift, store, now)
    covers = payload.covers if payload.covers is not None else (sum(t.seats for t in tables) if tables else None)
    kitchen_view_enabled = features.is_enabled(db, store.organization_id, store.id, "kitchen.view")

    order = Order(
        organization_id=store.organization_id,
        store_id=store.id,
        shift_id=shift.id,
        business_date=business_date,
        channel=channel,
        status=OrderStatus.OPEN,
        version=1,
        covers=covers,
        note=payload.note,
        takeout_customer_name=payload.takeout.customer_name if payload.takeout else None,
        takeout_phone=payload.takeout.phone if payload.takeout else None,
        promised_at=payload.takeout.promised_at if payload.takeout else None,
        consumed_by_employee_id=consumed_by.id if consumed_by else None,
        consumed_by_employee_name=consumed_by.name if consumed_by else None,
        opened_by_employee_id=actor.employee_id,  # type: ignore[arg-type]
        opened_by_employee_name=actor.employee_name,  # type: ignore[arg-type]
        opened_at=now,
        bill_print_count=0,
        kitchen_view_enabled=kitchen_view_enabled,
        created_at=now,
        updated_at=now,
    )
    db.add(order)
    try:
        db.flush()
    except IntegrityError as exc:
        db.rollback()
        raise ConflictError("La mesa ya tiene una comanda abierta: recargá el mapa de mesas", code="TABLE_ALREADY_OPEN") from exc

    for table in tables:
        db.add(OrderTable(order_id=order.id, table_id=table.id, store_id=store.id, seated_at=now, released_at=None))
    if tables:
        try:
            db.flush()
        except IntegrityError as exc:
            db.rollback()
            raise ConflictError("La mesa ya tiene una comanda abierta: recargá el mapa de mesas", code="TABLE_ALREADY_OPEN") from exc

    db.add(
        OrderEvent(
            organization_id=store.organization_id,
            store_id=store.id,
            order_id=order.id,
            kind="opened",
            payload={"channel": channel.value},
            employee_id=actor.employee_id,
            employee_name=actor.employee_name,
            authorized_by_employee_id=None,
            authorized_by_employee_name=None,
            after_bill=False,
            at=now,
        )
    )
    db.flush()
    record_audit(
        db,
        actor=actor,
        organization_id=store.organization_id,
        store_id=store.id,
        entity="order",
        entity_id=order.id,
        action="create",
        before=None,
        after={"channel": channel.value, "table_ids": payload.table_ids},
    )
    return order


# ---------------------------------------------------------------------------
# Ítems: agregar, editar, enviar, marcar listo/entregado
# ---------------------------------------------------------------------------


def _normalize_station(value: str | None) -> str | None:
    if value is None:
        return None
    normalized = value.strip().lower()
    if normalized in ("", "none"):
        return None
    return value


def _channel_list_price(product: Product, channel: OrderChannel) -> int:
    if channel == OrderChannel.TAKEOUT:
        return product.price_takeout if product.price_takeout is not None else product.price_dine_in
    return product.price_dine_in


def _resolve_modifiers(db: Session, product: Product, modifiers_in: list[Any]) -> tuple[list[dict[str, Any]], int]:
    groups = list(db.execute(select(ModifierGroup).where(ModifierGroup.product_id == product.id)).scalars())
    if not groups and not modifiers_in:
        return [], 0
    options = (
        list(db.execute(select(ModifierOption).where(ModifierOption.modifier_group_id.in_([g.id for g in groups]))).scalars())
        if groups
        else []
    )
    options_by_id = {o.id: o for o in options}
    groups_by_id = {g.id: g for g in groups}

    counts_by_group: dict[int, int] = {}
    resolved: list[dict[str, Any]] = []
    delta_sum = 0
    for selection in modifiers_in:
        option = options_by_id.get(selection.option_id)
        if option is None:
            raise AppError("MODIFIER_SELECTION_INVALID", "Alguna opción de modificador no existe para este producto")
        if not option.available:
            raise AppError("OPTION_UNAVAILABLE", f'La opción "{option.name}" está agotada', extra={"option_id": option.id})
        group = groups_by_id[option.modifier_group_id]
        counts_by_group[group.id] = counts_by_group.get(group.id, 0) + 1
        resolved.append({"option_id": option.id, "group_name": group.name, "name": option.name, "price_delta": option.price_delta})
        delta_sum += option.price_delta

    for group in groups:
        count = counts_by_group.get(group.id, 0)
        if count < group.min or count > group.max or (group.required and count == 0):
            raise AppError("MODIFIER_SELECTION_INVALID", f'El grupo "{group.name}" necesita entre {group.min} y {group.max} opciones')

    return resolved, delta_sum


def _build_product_item(db: Session, order: Order, item_in: OrderItemIn, actor: Actor, now: datetime, *, modifiers_enabled: bool) -> OrderItem:
    product = db.get(Product, item_in.product_id)
    if product is None or product.organization_id != order.organization_id or product.store_id != order.store_id:
        raise NotFoundError("El producto no existe")
    if not product.active or not product.available:
        raise AppError("PRODUCT_UNAVAILABLE", f'"{product.name}" no está disponible', extra={"product_id": product.id, "remaining": product.daily_remaining})

    daily_count_enabled = features.is_enabled(db, order.organization_id, order.store_id, "pos.daily_count")
    if daily_count_enabled and product.daily_remaining is not None and item_in.qty > product.daily_remaining:
        raise AppError(
            "PRODUCT_UNAVAILABLE",
            f'Quedan {product.daily_remaining} de "{product.name}"',
            extra={"product_id": product.id, "remaining": product.daily_remaining},
        )

    if item_in.modifiers and not modifiers_enabled:
        raise AppError("FEATURE_DISABLED", 'La función "pos.modifiers" está apagada; habilitala en Admin → Funciones', extra={"feature": "pos.modifiers"})
    modifiers_json, delta_sum = _resolve_modifiers(db, product, item_in.modifiers) if modifiers_enabled else ([], 0)

    list_price = _channel_list_price(product, order.channel)
    tax_code = catalog_service.resolve_tax_code(db, order.store_id, product.tax_code)
    fiscal = stores_service.current_fiscal(db, order.store_id)
    price_includes_tax = fiscal.price_includes_tax if fiscal is not None else True
    tax_rate = TAX_RATE_BY_CODE.get(tax_code, 0)

    is_staff_meal = order.channel == OrderChannel.STAFF_MEAL
    unit_price = 0 if is_staff_meal else (list_price + delta_sum)
    if is_staff_meal:
        tax_rate = 0

    course = item_in.course or product.default_course or "main"
    station = _normalize_station(product.station)
    modifiers_text = ", ".join(m["name"] for m in modifiers_json) or None

    return OrderItem(
        organization_id=order.organization_id,
        store_id=order.store_id,
        order_id=order.id,
        product_id=product.id,
        combo_id=None,
        name=product.name,
        qty=item_in.qty,
        seat=item_in.seat,
        course=course,
        station=station,
        list_price=list_price,
        unit_price=unit_price,
        tax_code=tax_code,
        tax_rate=tax_rate,
        price_includes_tax=price_includes_tax,
        modifiers=modifiers_json,
        modifiers_text=modifiers_text,
        combo_selections=None,
        note=item_in.note,
        status=OrderItemStatus.PENDING,
        discount_amount=0,
        unit_cost=None,
        recipe_version=None,
        added_by_employee_id=actor.employee_id,  # type: ignore[arg-type]
        added_by_employee_name=actor.employee_name,  # type: ignore[arg-type]
        created_at=now,
    )


def _build_combo_item(db: Session, order: Order, item_in: OrderItemIn, actor: Actor, now: datetime) -> OrderItem:
    features.assert_feature(db, order.organization_id, order.store_id, "pos.combos")
    combo = db.get(Combo, item_in.combo_id)
    if combo is None or combo.organization_id != order.organization_id or combo.store_id != order.store_id:
        raise NotFoundError("El combo no existe")
    if not combo.active:
        raise AppError("COMBO_NOT_ACTIVE", f'El combo "{combo.name}" no está activo')
    if not catalog_service.combo_active_now(combo.schedule, now):
        raise AppError("COMBO_NOT_ACTIVE", f'El combo "{combo.name}" no está disponible en este horario')
    catalog_service.assert_combo_sellable(db, combo)

    groups = list(db.execute(select(ComboGroup).where(ComboGroup.combo_id == combo.id).order_by(ComboGroup.sort_order, ComboGroup.id)).scalars())
    selections_by_group: dict[int, int] = {s.group_id: s.option_id for s in item_in.combo_selections}
    if set(selections_by_group.keys()) != {g.id for g in groups}:
        raise AppError("COMBO_SELECTION_INVALID", "Elegí exactamente una opción por cada grupo del combo")

    selections_out: list[dict[str, Any]] = []
    station: str | None = None
    for group in groups:
        option_id = selections_by_group[group.id]
        option = db.get(ComboOption, option_id)
        if option is None or option.combo_group_id != group.id:
            raise AppError("COMBO_SELECTION_INVALID", "Alguna opción del combo no pertenece a su grupo")
        if not option.active_today or not option.available_today:
            raise AppError("COMBO_SELECTION_INVALID", "Alguna opción del combo no está disponible hoy")
        product = db.get(Product, option.product_id)
        selections_out.append(
            {"group_id": group.id, "group_name": group.name, "option_id": option.id, "product_id": option.product_id, "product_name": product.name if product else ""}
        )
        if station is None and product is not None:
            normalized = _normalize_station(product.station)
            if normalized is not None:
                station = normalized

    tax_code = catalog_service.resolve_tax_code(db, order.store_id, None)
    fiscal = stores_service.current_fiscal(db, order.store_id)
    price_includes_tax = fiscal.price_includes_tax if fiscal is not None else True
    tax_rate = TAX_RATE_BY_CODE.get(tax_code, 0)

    is_staff_meal = order.channel == OrderChannel.STAFF_MEAL
    list_price = combo.price
    unit_price = 0 if is_staff_meal else list_price
    if is_staff_meal:
        tax_rate = 0
    course = item_in.course or "main"

    return OrderItem(
        organization_id=order.organization_id,
        store_id=order.store_id,
        order_id=order.id,
        product_id=None,
        combo_id=combo.id,
        name=combo.name,
        qty=item_in.qty,
        seat=item_in.seat,
        course=course,
        station=station,
        list_price=list_price,
        unit_price=unit_price,
        tax_code=tax_code,
        tax_rate=tax_rate,
        price_includes_tax=price_includes_tax,
        modifiers=[],
        modifiers_text=None,
        combo_selections=selections_out,
        note=item_in.note,
        status=OrderItemStatus.PENDING,
        discount_amount=0,
        unit_cost=None,
        recipe_version=None,
        added_by_employee_id=actor.employee_id,  # type: ignore[arg-type]
        added_by_employee_name=actor.employee_name,  # type: ignore[arg-type]
        created_at=now,
    )


def add_items(db: Session, *, order: Order, actor: Actor, payload: AddItemsIn) -> Order:
    _check_version(db, order, payload.expected_version, actor=actor)
    if order.status not in _OPEN_ORDER_STATUSES:
        raise AppError("ORDER_NOT_OPEN", "La comanda no está abierta")
    if order.bill_presented_at is not None:
        if payload.authorizer_pin is None:
            raise AppError("BILL_PRESENTED_NEEDS_AUTH", "La cuenta ya se presentó: pedí el PIN de un supervisor o administrador")
        auth_service.verify_authorizer(
            db, organization_id=order.organization_id, store_id=order.store_id, pin=payload.authorizer_pin, action="after_bill_change", requested_by=actor
        )

    seats_enabled = features.is_enabled(db, order.organization_id, order.store_id, "pos.seats")
    courses_enabled = features.is_enabled(db, order.organization_id, order.store_id, "pos.courses")
    modifiers_enabled = features.is_enabled(db, order.organization_id, order.store_id, "pos.modifiers")

    now = clock.now_utc()
    new_rows: list[OrderItem] = []
    for item_in in payload.items:
        if item_in.product_id is None and item_in.combo_id is None:
            raise AppError("VALIDATION_ERROR", "items: cada ítem necesita product_id o combo_id")
        if item_in.product_id is not None and item_in.combo_id is not None:
            raise AppError("VALIDATION_ERROR", "items: un ítem no puede tener product_id y combo_id a la vez")
        if item_in.seat is not None and not seats_enabled:
            raise AppError("FEATURE_DISABLED", 'La función "pos.seats" está apagada; habilitala en Admin → Funciones', extra={"feature": "pos.seats"})
        if item_in.course is not None and not courses_enabled:
            raise AppError("FEATURE_DISABLED", 'La función "pos.courses" está apagada; habilitala en Admin → Funciones', extra={"feature": "pos.courses"})
        row = (
            _build_combo_item(db, order, item_in, actor, now)
            if item_in.combo_id is not None
            else _build_product_item(db, order, item_in, actor, now, modifiers_enabled=modifiers_enabled)
        )
        new_rows.append(row)
        db.add(row)

    order.version += 1
    order.updated_at = now
    db.flush()
    record_audit(
        db, actor=actor, organization_id=order.organization_id, store_id=order.store_id, entity="order", entity_id=order.id,
        action="add_items", before=None, after={"count": len(new_rows), "item_ids": [r.id for r in new_rows]},
    )
    return order


def patch_item(db: Session, *, order: Order, item_id: int, actor: Actor, payload: PatchItemIn) -> Order:
    _check_version(db, order, payload.expected_version, actor=actor)
    item = _get_item_or_404(db, order, item_id)
    if item.status != OrderItemStatus.PENDING:
        raise AppError("ITEM_NOT_PENDING", "Sólo se puede editar un ítem mientras está pendiente")
    if payload.qty is not None:
        item.qty = payload.qty
    if payload.note is not None:
        item.note = payload.note
    if payload.seat is not None:
        item.seat = payload.seat
    order.version += 1
    order.updated_at = clock.now_utc()
    db.flush()
    return order


def _apply_send(db: Session, order: Order, items: list[OrderItem], round_row: OrderRound, now: datetime, actor: Actor, *, sent_at_payment: bool, force_served: bool) -> None:
    daily_count_enabled = features.is_enabled(db, order.organization_id, order.store_id, "pos.daily_count")
    qty_by_product: dict[int, int] = {}
    for item in items:
        item.round_id = round_row.id
        item.round_no = round_row.round_no
        item.sent_at = now
        if sent_at_payment:
            item.sent_at_payment = True
        if not force_served and item.station:
            item.status = OrderItemStatus.SENT
        else:
            item.status = OrderItemStatus.SERVED
            item.served_at = now
        if daily_count_enabled and item.product_id is not None:
            qty_by_product[item.product_id] = qty_by_product.get(item.product_id, 0) + item.qty
    for product_id, qty in qty_by_product.items():
        product = db.get(Product, product_id)
        if product is None or product.daily_remaining is None:
            continue
        product.daily_remaining = max(product.daily_remaining - qty, 0)
        if product.daily_remaining <= 0:
            catalog_service.set_product_availability(db, product, available=False, daily_count=None, actor=actor)
    db.flush()


def _next_round_no(db: Session, order_id: int) -> int:
    max_round = db.execute(select(func.coalesce(func.max(OrderRound.round_no), 0)).where(OrderRound.order_id == order_id)).scalar_one()
    return int(max_round) + 1


def send_order(db: Session, *, order: Order, actor: Actor, expected_version: int) -> Order:
    _check_version(db, order, expected_version, actor=actor)
    if order.status not in _OPEN_ORDER_STATUSES:
        raise AppError("ORDER_NOT_OPEN", "La comanda no está abierta")
    pending = list(db.execute(select(OrderItem).where(OrderItem.order_id == order.id, OrderItem.status == OrderItemStatus.PENDING)).scalars())
    if not pending:
        raise AppError("NOTHING_TO_SEND", "No hay ítems pendientes para enviar")
    now = clock.now_utc()
    round_no = _next_round_no(db, order.id)
    round_row = OrderRound(order_id=order.id, round_no=round_no, sent_at=now, sent_by_employee_id=actor.employee_id, sent_by_employee_name=actor.employee_name, sent_at_payment=False)  # type: ignore[arg-type]
    db.add(round_row)
    db.flush()
    _apply_send(db, order, pending, round_row, now, actor, sent_at_payment=False, force_served=False)
    order.version += 1
    order.updated_at = now
    db.flush()
    record_audit(db, actor=actor, organization_id=order.organization_id, store_id=order.store_id, entity="order", entity_id=order.id, action="send", before=None, after={"round_no": round_no, "items": len(pending)})
    return order


def auto_send_pending_for_payment(db: Session, order: Order, *, actor: Actor, now: datetime) -> int:
    pending = list(db.execute(select(OrderItem).where(OrderItem.order_id == order.id, OrderItem.status == OrderItemStatus.PENDING)).scalars())
    if not pending:
        return 0
    round_no = _next_round_no(db, order.id)
    round_row = OrderRound(order_id=order.id, round_no=round_no, sent_at=now, sent_by_employee_id=actor.employee_id, sent_by_employee_name=actor.employee_name, sent_at_payment=True)  # type: ignore[arg-type]
    db.add(round_row)
    db.flush()
    force_served = not order.kitchen_view_enabled
    _apply_send(db, order, pending, round_row, now, actor, sent_at_payment=True, force_served=force_served)
    return len(pending)


def mark_ready(db: Session, *, order: Order, item_id: int, actor: Actor) -> Order:
    item = _get_item_or_404(db, order, item_id)
    if item.status == OrderItemStatus.SENT:
        item.status = OrderItemStatus.READY
        item.ready_at = clock.now_utc()
        db.flush()
    return order


def mark_served(db: Session, *, order: Order, item_id: int, actor: Actor) -> Order:
    item = _get_item_or_404(db, order, item_id)
    if item.status in (OrderItemStatus.SENT, OrderItemStatus.READY):
        item.status = OrderItemStatus.SERVED
        item.served_at = clock.now_utc()
        db.flush()
    return order


# ---------------------------------------------------------------------------
# Anulaciones y cortesía
# ---------------------------------------------------------------------------


def void_item(db: Session, *, order: Order, item_id: int, actor: Actor, expected_version: int, reason: str, note: str | None, authorizer_pin: str | None) -> Order:
    _check_version(db, order, expected_version, actor=actor)
    if order.status not in _OPEN_ORDER_STATUSES:
        raise AppError("ORDER_NOT_OPEN", "La comanda no está abierta")
    item = _get_item_or_404(db, order, item_id)
    if item.status == OrderItemStatus.VOIDED:
        raise AppError("VALIDATION_ERROR", "Este ítem ya está anulado")
    if reason == VoidReason.OTHER.value and not note:
        raise AppError("VALIDATION_ERROR", 'note: obligatoria cuando el motivo es "other"')

    needs_auth = item.status != OrderItemStatus.PENDING or order.bill_presented_at is not None
    authorizer = None
    if needs_auth:
        authorizer = auth_service.verify_authorizer(db, organization_id=order.organization_id, store_id=order.store_id, pin=authorizer_pin, action="void_sent_item", requested_by=actor)

    now = clock.now_utc()
    was_sent = item.sent_at is not None
    prior_status = item.status
    item.status = OrderItemStatus.VOIDED
    item.void_reason = VoidReason(reason)
    item.void_note = note
    item.voided_at = now
    item.voided_by_employee_id = actor.employee_id
    item.voided_by_employee_name = actor.employee_name
    item.void_authorized_by_employee_id = authorizer.id if authorizer else None
    item.void_authorized_by_employee_name = authorizer.name if authorizer else None
    item.void_after_bill = order.bill_presented_at is not None
    item.void_minutes_since_sent = int((now - item.sent_at).total_seconds() // 60) if was_sent and item.sent_at else None

    if prior_status in _LIVE_ITEM_STATUSES_SENT:
        db.add(
            WasteStub(
                organization_id=order.organization_id, store_id=order.store_id, order_id=order.id, order_item_id=item.id,
                product_id=item.product_id, product_name=item.name, qty=item.qty, reason=VoidReason(reason), note=note,
                employee_id=actor.employee_id, employee_name=actor.employee_name,  # type: ignore[arg-type]
                authorized_by_employee_id=authorizer.id if authorizer else None,
                authorized_by_employee_name=authorizer.name if authorizer else None,
                at=now, ingredient_id=None, resolved=False,
            )
        )

    order.version += 1
    order.updated_at = now
    db.flush()
    record_audit(db, actor=actor, organization_id=order.organization_id, store_id=order.store_id, entity="order_item", entity_id=item.id, action="void", before={"status": prior_status.value}, after={"reason": reason}, reason=note)
    return order


def courtesy_item(db: Session, *, order: Order, item_id: int, actor: Actor, payload: CourtesyItemIn) -> Order:
    _check_version(db, order, payload.expected_version, actor=actor)
    features.assert_feature(db, order.organization_id, order.store_id, "pos.courtesies")
    if order.status not in _OPEN_ORDER_STATUSES:
        raise AppError("ORDER_NOT_OPEN", "La comanda no está abierta")
    item = _get_item_or_404(db, order, item_id)
    if item.status == OrderItemStatus.VOIDED:
        raise AppError("VALIDATION_ERROR", "Este ítem está anulado")

    authorizer = auth_service.verify_authorizer(db, organization_id=order.organization_id, store_id=order.store_id, pin=payload.authorizer_pin, action="courtesy", requested_by=actor)

    now = clock.now_utc()
    item.unit_price = 0
    item.discount_amount = 0
    item.courtesy_reason = CourtesyReason(payload.reason)
    item.courtesy_note = payload.note
    item.courtesy_authorized_by_employee_id = authorizer.id
    item.courtesy_authorized_by_employee_name = authorizer.name
    item.courtesy_at = now
    item.courtesy_after_bill = order.bill_presented_at is not None

    order.version += 1
    order.updated_at = now
    db.flush()
    record_audit(db, actor=actor, organization_id=order.organization_id, store_id=order.store_id, entity="order_item", entity_id=item.id, action="courtesy", before=None, after={"reason": payload.reason})
    _check_courtesy_limit(db, order=order)
    return order


def _check_courtesy_limit(db: Session, *, order: Order) -> None:
    if order.shift_id is None:
        return
    settings = stores_service.get_sales_settings(db, order.store_id)
    count = int(
        db.execute(
            select(func.count()).select_from(OrderItem).join(Order, OrderItem.order_id == Order.id).where(Order.shift_id == order.shift_id, OrderItem.courtesy_at.is_not(None))
        ).scalar_one()
    )
    if count > settings.courtesy_shift_limit:
        notify(
            db, organization_id=order.organization_id, store_id=order.store_id, type="courtesy_limit", level="warning",
            title="Límite de cortesías superado",
            body=f"El turno ya acumula {count} cortesías (límite {settings.courtesy_shift_limit}).",
            payload={"shift_id": order.shift_id, "count": count},
            dedupe_key=f"courtesy_limit:{order.shift_id}",
        )


def void_order(db: Session, *, order: Order, actor: Actor, payload: VoidOrderIn) -> Order:
    _check_version(db, order, payload.expected_version, actor=actor)
    if order.status not in _OPEN_ORDER_STATUSES:
        raise AppError("ORDER_NOT_OPEN", "La comanda no está abierta")
    if payload.reason == VoidReason.OTHER.value and not payload.note:
        raise AppError("VALIDATION_ERROR", 'note: obligatoria cuando el motivo es "other"')

    items = list(db.execute(select(OrderItem).where(OrderItem.order_id == order.id, OrderItem.status != OrderItemStatus.VOIDED)).scalars())
    any_sent = any(i.sent_at is not None for i in items)
    needs_auth = any_sent or order.bill_presented_at is not None
    authorizer = None
    if needs_auth:
        authorizer = auth_service.verify_authorizer(db, organization_id=order.organization_id, store_id=order.store_id, pin=payload.authorizer_pin, action="void_order", requested_by=actor)

    now = clock.now_utc()
    for item in items:
        was_sent = item.sent_at is not None
        if was_sent:
            db.add(
                WasteStub(
                    organization_id=order.organization_id, store_id=order.store_id, order_id=order.id, order_item_id=item.id,
                    product_id=item.product_id, product_name=item.name, qty=item.qty, reason=VoidReason(payload.reason), note=payload.note,
                    employee_id=actor.employee_id, employee_name=actor.employee_name,  # type: ignore[arg-type]
                    authorized_by_employee_id=authorizer.id if authorizer else None,
                    authorized_by_employee_name=authorizer.name if authorizer else None,
                    at=now, ingredient_id=None, resolved=False,
                )
            )
        item.status = OrderItemStatus.VOIDED
        item.void_reason = VoidReason(payload.reason)
        item.void_note = payload.note
        item.voided_at = now
        item.voided_by_employee_id = actor.employee_id
        item.voided_by_employee_name = actor.employee_name
        item.void_authorized_by_employee_id = authorizer.id if authorizer else None
        item.void_authorized_by_employee_name = authorizer.name if authorizer else None
        item.void_after_bill = order.bill_presented_at is not None
        item.void_minutes_since_sent = int((now - item.sent_at).total_seconds() // 60) if was_sent and item.sent_at else None

    _release_tables(db, order, now)
    order.status = OrderStatus.VOIDED
    order.voided_at = now
    order.void_reason = VoidReason(payload.reason)
    order.void_note = payload.note
    order.voided_by_employee_id = actor.employee_id
    order.voided_by_employee_name = actor.employee_name
    order.void_authorized_by_employee_id = authorizer.id if authorizer else None
    order.void_authorized_by_employee_name = authorizer.name if authorizer else None
    order.void_after_bill = order.bill_presented_at is not None
    order.version += 1
    order.updated_at = now

    db.add(
        OrderEvent(
            organization_id=order.organization_id, store_id=order.store_id, order_id=order.id, kind="voided",
            payload={"reason": payload.reason}, employee_id=actor.employee_id, employee_name=actor.employee_name,
            authorized_by_employee_id=authorizer.id if authorizer else None, authorized_by_employee_name=authorizer.name if authorizer else None,
            after_bill=order.void_after_bill, at=now,
        )
    )
    db.flush()
    record_audit(db, actor=actor, organization_id=order.organization_id, store_id=order.store_id, entity="order", entity_id=order.id, action="void", before={"status": "open"}, after={"reason": payload.reason}, reason=payload.note)
    return order


# ---------------------------------------------------------------------------
# Descuentos
# ---------------------------------------------------------------------------


def add_discount(db: Session, *, order: Order, actor: Actor, payload: DiscountIn) -> Order:
    _check_version(db, order, payload.expected_version, actor=actor)
    if order.status not in _OPEN_ORDER_STATUSES:
        raise AppError("ORDER_NOT_OPEN", "La comanda no está abierta")

    now = clock.now_utc()
    item: OrderItem | None = None
    if payload.scope == "item":
        if payload.item_id is None:
            raise AppError("VALIDATION_ERROR", "item_id: obligatorio para un descuento de línea")
        item = _get_item_or_404(db, order, payload.item_id)
        if item.combo_id is not None:
            raise AppError("COMBO_NO_LINE_DISCOUNT", "Los combos no aceptan descuento de línea")

    totals_before = compute_order_totals(db, order)

    if item is not None:
        gross_full = item.unit_price * item.qty
        amount = money.round_half_up(gross_full * payload.value, 100) if payload.kind == "percent" else payload.value
        if item.discount_amount + amount > gross_full:
            raise AppError("DISCOUNT_EXCEEDS_LINE", "El descuento supera el valor de la línea")
        item.discount_amount += amount
    else:
        remaining_base = totals_before.subtotal - totals_before.discount_total
        amount = money.round_half_up(remaining_base * payload.value, 100) if payload.kind == "percent" else payload.value
        amount = min(amount, max(remaining_base, 0))

    employee = db.get(Employee, actor.employee_id) if actor.employee_id else None
    settings = stores_service.get_sales_settings(db, order.store_id)
    limit_pct = float(employee.discount_limit_pct) if employee is not None and employee.discount_limit_pct is not None else float(settings.discount_limit_pct)

    existing_discount_total = totals_before.discount_total
    total_after = existing_discount_total + amount
    subtotal = totals_before.subtotal
    requested_pct = (total_after / subtotal * 100) if subtotal else 0.0

    authorizer = None
    after_bill = order.bill_presented_at is not None
    if requested_pct > limit_pct:
        if payload.authorizer_pin is None:
            raise AppError(
                "DISCOUNT_LIMIT_EXCEEDED",
                f"El descuento supera el límite permitido ({limit_pct:g}%): pedí el PIN de un supervisor o administrador",
                extra={"limit_pct": limit_pct, "requested_pct": round(requested_pct, 2)},
            )
        authorizer = auth_service.verify_authorizer(db, organization_id=order.organization_id, store_id=order.store_id, pin=payload.authorizer_pin, action="discount_over_limit", requested_by=actor)

    discount_row = OrderDiscount(
        organization_id=order.organization_id, store_id=order.store_id, order_id=order.id,
        item_id=item.id if item else None, scope=payload.scope, kind=payload.kind, value=payload.value, amount=amount,
        reason=DiscountReason(payload.reason), note=payload.note, employee_id=actor.employee_id, employee_name=actor.employee_name,  # type: ignore[arg-type]
        authorized_by_employee_id=authorizer.id if authorizer else None, authorized_by_employee_name=authorizer.name if authorizer else None,
        after_bill=after_bill, at=now, voided_at=None,
    )
    db.add(discount_row)
    order.version += 1
    order.updated_at = now
    db.flush()
    record_audit(db, actor=actor, organization_id=order.organization_id, store_id=order.store_id, entity="order_discount", entity_id=discount_row.id, action="create", before=None, after={"scope": payload.scope, "amount": amount})

    _check_discount_rate_high(db, order=order, actor=actor, settings=settings)
    return order


def remove_discount(db: Session, *, order: Order, discount_id: int, actor: Actor, expected_version: int) -> Order:
    _check_version(db, order, expected_version, actor=actor)
    discount = db.get(OrderDiscount, discount_id)
    if discount is None or discount.order_id != order.id:
        raise NotFoundError("El descuento no existe en esta comanda")
    now = clock.now_utc()
    if discount.voided_at is None:
        discount.voided_at = now
        if discount.scope == "item" and discount.item_id is not None:
            item = db.get(OrderItem, discount.item_id)
            if item is not None:
                item.discount_amount = max(item.discount_amount - discount.amount, 0)
    order.version += 1
    order.updated_at = now
    db.flush()
    return order


def _employee_shift_sales_total(db: Session, *, shift_id: int, employee_id: int) -> int:
    orders = list(db.execute(select(Order).where(Order.shift_id == shift_id, Order.paid_by_employee_id == employee_id, Order.status == OrderStatus.PAID)).scalars())
    return sum(compute_order_totals(db, o).total for o in orders)


def _employee_shift_discount_total(db: Session, *, shift_id: int, employee_id: int) -> int:
    return int(
        db.execute(
            select(func.coalesce(func.sum(OrderDiscount.amount), 0))
            .join(Order, OrderDiscount.order_id == Order.id)
            .where(Order.shift_id == shift_id, OrderDiscount.employee_id == employee_id, OrderDiscount.voided_at.is_(None))
        ).scalar_one()
    )


def _check_discount_rate_high(db: Session, *, order: Order, actor: Actor, settings: Any) -> None:
    if order.shift_id is None or actor.employee_id is None:
        return
    sales = _employee_shift_sales_total(db, shift_id=order.shift_id, employee_id=actor.employee_id)
    if sales <= 0:
        return
    discounts = _employee_shift_discount_total(db, shift_id=order.shift_id, employee_id=actor.employee_id)
    pct = discounts / sales * 100
    daily_limit = float(settings.discount_daily_limit_pct)
    if pct > daily_limit:
        notify(
            db, organization_id=order.organization_id, store_id=order.store_id, type="discount_rate_high", level="warning",
            title="Descuentos por encima del límite diario",
            body=f"{actor.employee_name} acumuló ${discounts} de descuento sobre ${sales} en ventas este turno ({pct:.1f}%).",
            payload={"employee_id": actor.employee_id, "shift_id": order.shift_id},
            dedupe_key=f"discount_rate_high:{order.shift_id}:{actor.employee_id}",
        )


# ---------------------------------------------------------------------------
# Unir y mover mesas; anular comanda
# ---------------------------------------------------------------------------


def _release_tables(db: Session, order: Order, now: datetime) -> None:
    db.execute(update(OrderTable).where(OrderTable.order_id == order.id, OrderTable.released_at.is_(None)).values(released_at=now))
    db.flush()


def merge_orders(db: Session, *, order: Order, actor: Actor, payload: MergeIn) -> Order:
    _check_version(db, order, payload.expected_version, actor=actor)
    if payload.from_order_id == order.id:
        raise AppError("MERGE_SAME_ORDER", "No podés unir una comanda consigo misma")
    source = get_order_or_404(db, actor=actor, order_id=payload.from_order_id)
    if order.status not in _OPEN_ORDER_STATUSES or source.status not in _OPEN_ORDER_STATUSES:
        raise AppError("MERGE_NOT_OPEN", "Las dos comandas tienen que estar abiertas para unirse")

    after_bill = order.bill_presented_at is not None or source.bill_presented_at is not None
    authorizer = None
    if after_bill:
        authorizer = auth_service.verify_authorizer(db, organization_id=order.organization_id, store_id=order.store_id, pin=payload.authorizer_pin, action="after_bill_change", requested_by=actor)

    now = clock.now_utc()
    db.execute(update(OrderItem).where(OrderItem.order_id == source.id).values(order_id=order.id))
    db.execute(update(OrderSubAccount).where(OrderSubAccount.order_id == source.id).values(order_id=order.id))
    db.execute(update(OrderDiscount).where(OrderDiscount.order_id == source.id, OrderDiscount.scope == "item").values(order_id=order.id))

    order_scope_discounts = list(db.execute(select(OrderDiscount).where(OrderDiscount.order_id == source.id, OrderDiscount.scope == "order", OrderDiscount.voided_at.is_(None))).scalars())
    for d in order_scope_discounts:
        d.voided_at = now
        d.note = ((d.note + " ") if d.note else "") + f"Anulado por unión con la comanda #{order.id}"

    source_tables = list(db.execute(select(OrderTable).where(OrderTable.order_id == source.id, OrderTable.released_at.is_(None))).scalars())
    for t in source_tables:
        t.released_at = now
        db.add(OrderTable(order_id=order.id, table_id=t.table_id, store_id=order.store_id, seated_at=now, released_at=None))

    source.status = OrderStatus.MERGED
    source.merged_into_order_id = order.id
    source.merged_at = now
    source.updated_at = now

    order.version += 1
    order.updated_at = now

    db.add(OrderEvent(organization_id=order.organization_id, store_id=order.store_id, order_id=order.id, kind="merged_in", payload={"from_order_id": source.id}, employee_id=actor.employee_id, employee_name=actor.employee_name, authorized_by_employee_id=authorizer.id if authorizer else None, authorized_by_employee_name=authorizer.name if authorizer else None, after_bill=after_bill, at=now))
    db.add(OrderEvent(organization_id=source.organization_id, store_id=source.store_id, order_id=source.id, kind="merged_out", payload={"into_order_id": order.id}, employee_id=actor.employee_id, employee_name=actor.employee_name, authorized_by_employee_id=authorizer.id if authorizer else None, authorized_by_employee_name=authorizer.name if authorizer else None, after_bill=after_bill, at=now))
    db.flush()
    record_audit(db, actor=actor, organization_id=order.organization_id, store_id=order.store_id, entity="order", entity_id=order.id, action="merge", before=None, after={"from_order_id": source.id})
    return order


def move_order(db: Session, *, order: Order, actor: Actor, payload: MoveIn) -> Order:
    _check_version(db, order, payload.expected_version, actor=actor)
    if order.status not in _OPEN_ORDER_STATUSES:
        raise AppError("ORDER_NOT_OPEN", "La comanda no está abierta")
    tables = _load_active_tables(db, order.store_id, payload.table_ids)
    for table in tables:
        existing = db.execute(select(OrderTable).where(OrderTable.table_id == table.id, OrderTable.released_at.is_(None))).scalars().first()
        if existing is not None and existing.order_id != order.id:
            raise ConflictError(f"La mesa {table.number} ya tiene una comanda abierta", code="TABLE_ALREADY_OPEN", extra={"table_id": table.id})

    after_bill = order.bill_presented_at is not None
    authorizer = None
    if after_bill:
        authorizer = auth_service.verify_authorizer(db, organization_id=order.organization_id, store_id=order.store_id, pin=payload.authorizer_pin, action="after_bill_change", requested_by=actor)

    now = clock.now_utc()
    current = list(db.execute(select(OrderTable).where(OrderTable.order_id == order.id, OrderTable.released_at.is_(None))).scalars())
    for t in current:
        t.released_at = now
    for table in tables:
        db.add(OrderTable(order_id=order.id, table_id=table.id, store_id=order.store_id, seated_at=now, released_at=None))

    order.version += 1
    order.updated_at = now
    db.add(OrderEvent(organization_id=order.organization_id, store_id=order.store_id, order_id=order.id, kind="tables_moved", payload={"table_ids": payload.table_ids}, employee_id=actor.employee_id, employee_name=actor.employee_name, authorized_by_employee_id=authorizer.id if authorizer else None, authorized_by_employee_name=authorizer.name if authorizer else None, after_bill=after_bill, at=now))
    try:
        db.flush()
    except IntegrityError as exc:
        db.rollback()
        raise ConflictError("La mesa ya tiene una comanda abierta: recargá el mapa de mesas", code="TABLE_ALREADY_OPEN") from exc
    return order


# ---------------------------------------------------------------------------
# Precuenta y división de cuenta
# ---------------------------------------------------------------------------


def present_bill(db: Session, *, order: Order, actor: Actor, expected_version: int) -> Order:
    _check_version(db, order, expected_version, actor=actor)
    if order.status not in _OPEN_ORDER_STATUSES:
        raise AppError("ORDER_NOT_OPEN", "La comanda no está abierta")
    live_count = int(db.execute(select(func.count()).select_from(OrderItem).where(OrderItem.order_id == order.id, OrderItem.status != OrderItemStatus.VOIDED)).scalar_one())
    if live_count == 0:
        raise AppError("ORDER_EMPTY", "Agregá al menos un ítem antes de presentar la cuenta")

    now = clock.now_utc()
    first_time = order.bill_presented_at is None
    if first_time:
        order.bill_presented_at = now
        order.status = OrderStatus.TO_PAY
    order.bill_print_count += 1
    order.version += 1
    order.updated_at = now
    db.add(OrderEvent(organization_id=order.organization_id, store_id=order.store_id, order_id=order.id, kind="bill_presented", payload={"first_time": first_time}, employee_id=actor.employee_id, employee_name=actor.employee_name, authorized_by_employee_id=None, authorized_by_employee_name=None, after_bill=False, at=now))
    db.flush()
    return order


def build_pre_bill(db: Session, order: Order) -> PreBillOut:
    totals = compute_order_totals(db, order)
    line_by_item = {lt.item_id: lt for lt in totals.lines}
    items = _live_items(db, order.id)
    lines = []
    for item in items:
        lt = line_by_item.get(item.id)
        if lt is None:
            continue
        lines.append(PreBillLineOut(description=item.name, qty=item.qty, unit_price=item.unit_price, gross=lt.gross, discount=lt.discount, net=lt.net))
    tip = _tip_info(db, order, totals)
    assert order.bill_presented_at is not None
    return PreBillOut(
        order_id=order.id, version=order.version, lines=lines, subtotal=totals.subtotal, discount_total=totals.discount_total,
        tax_lines=[TaxLineOut(rate=t.rate, base=t.base, tax=t.tax) for t in totals.tax_lines], tax_total=totals.tax_total, total=totals.total,
        tip=tip, bill_presented_at=order.bill_presented_at, bill_print_count=order.bill_print_count,
    )


def split_bill_equal(db: Session, *, order: Order, actor: Actor, expected_version: int, parts: int) -> tuple[list[int], int]:
    _check_version(db, order, expected_version, actor=actor)
    if order.status not in _OPEN_ORDER_STATUSES:
        raise AppError("ORDER_NOT_OPEN", "La comanda no está abierta")
    totals = compute_order_totals(db, order)
    per_part = money.prorate(totals.total, [1] * parts)
    now = clock.now_utc()
    order.split_parts = parts
    order.version += 1
    order.updated_at = now
    db.add(OrderEvent(organization_id=order.organization_id, store_id=order.store_id, order_id=order.id, kind="split", payload={"mode": "equal", "parts": parts}, employee_id=actor.employee_id, employee_name=actor.employee_name, authorized_by_employee_id=None, authorized_by_employee_name=None, after_bill=order.bill_presented_at is not None, at=now))
    db.flush()
    return per_part, totals.total


def split_bill_items(db: Session, *, order: Order, actor: Actor, expected_version: int, groups: list[SplitGroupIn]) -> list[OrderSubAccount]:
    _check_version(db, order, expected_version, actor=actor)
    if order.status not in _OPEN_ORDER_STATUSES:
        raise AppError("ORDER_NOT_OPEN", "La comanda no está abierta")
    if not groups:
        raise AppError("VALIDATION_ERROR", "groups: agregá al menos un grupo")

    live_items = _live_items(db, order.id)
    live_ids = {i.id for i in live_items}

    entries_by_item: dict[int, list[tuple[int, int]]] = {}
    for gi, group in enumerate(groups):
        for item_id in group.item_ids:
            entries_by_item.setdefault(item_id, []).append((gi, 1))
        for shared in group.shared:
            entries_by_item.setdefault(shared.item_id, []).append((gi, shared.portions))

    for item_id in entries_by_item:
        if item_id not in live_ids:
            raise AppError("VALIDATION_ERROR", f"item_id {item_id}: no pertenece a esta comanda o no está vivo")

    missing = sorted(live_ids - set(entries_by_item.keys()))
    if missing:
        raise AppError("SPLIT_ITEMS_INCOMPLETE", "Asigná todos los ítems a una sub-cuenta antes de dividir", extra={"missing_item_ids": missing})

    existing = list(db.execute(select(OrderSubAccount).where(OrderSubAccount.order_id == order.id)).scalars())
    if existing:
        if any(sa.status == "paid" for sa in existing):
            raise AppError("VALIDATION_ERROR", "Ya hay sub-cuentas pagadas: no se puede rehacer la división")
        old_ids = [sa.id for sa in existing]
        db.execute(delete(OrderSubAccountItem).where(OrderSubAccountItem.sub_account_id.in_(old_ids)))
        db.execute(delete(OrderSubAccount).where(OrderSubAccount.id.in_(old_ids)))
        db.flush()

    now = clock.now_utc()
    new_accounts: list[OrderSubAccount] = []
    for gi, group in enumerate(groups):
        label = group.label or f"Cuenta {gi + 1}"
        acc = OrderSubAccount(order_id=order.id, seq=gi + 1, label=label, seat=group.seat, status="open", paid_at=None, document_id=None, created_at=now)
        db.add(acc)
        db.flush()
        new_accounts.append(acc)

    for item_id, entries in entries_by_item.items():
        of_portions = sum(p for _, p in entries)
        for gi, portions in entries:
            db.add(OrderSubAccountItem(sub_account_id=new_accounts[gi].id, order_item_id=item_id, portions=portions, of_portions=of_portions))

    order.version += 1
    order.updated_at = now
    db.add(OrderEvent(organization_id=order.organization_id, store_id=order.store_id, order_id=order.id, kind="split", payload={"mode": "items", "groups": len(groups)}, employee_id=actor.employee_id, employee_name=actor.employee_name, authorized_by_employee_id=None, authorized_by_employee_name=None, after_bill=order.bill_presented_at is not None, at=now))
    db.flush()
    return new_accounts


def list_sub_accounts(db: Session, order: Order) -> list[OrderSubAccount]:
    return list(db.execute(select(OrderSubAccount).where(OrderSubAccount.order_id == order.id).order_by(OrderSubAccount.seq)).scalars())


# ---------------------------------------------------------------------------
# Cobro (lo llama `backend-cobro` desde `app.payments.service.pay_order`)
# ---------------------------------------------------------------------------


def assert_payable(db: Session, order: Order, *, sub_account: OrderSubAccount | None) -> None:
    if order.status not in _OPEN_ORDER_STATUSES:
        raise AppError("ORDER_NOT_OPEN", "La comanda no está abierta", status=400)
    live_count = int(db.execute(select(func.count()).select_from(OrderItem).where(OrderItem.order_id == order.id, OrderItem.status != OrderItemStatus.VOIDED)).scalar_one())
    if live_count == 0:
        raise AppError("ORDER_EMPTY", "Agregá al menos un ítem antes de cobrar", status=400)
    has_sub_accounts = int(db.execute(select(func.count()).select_from(OrderSubAccount).where(OrderSubAccount.order_id == order.id)).scalar_one()) > 0
    if has_sub_accounts and sub_account is None:
        raise AppError("SUB_ACCOUNT_REQUIRED", "Esta comanda está dividida: indicá la sub-cuenta a cobrar", status=400)
    if sub_account is not None and sub_account.status != "open":
        raise AppError("SUB_ACCOUNT_ALREADY_PAID", "Esta sub-cuenta ya fue cobrada", status=400)
    if order.shift_id is None:
        raise AppError("NO_OPEN_SHIFT", "Abrí un turno para poder cobrar esta comanda", status=400)
    shift = db.get(Shift, order.shift_id)
    if shift is None or shift.status != ShiftStatus.OPEN:
        raise AppError("NO_OPEN_SHIFT", "Abrí un turno para poder cobrar esta comanda", status=400)


def claim_payment(db: Session, order: Order, *, sub_account: OrderSubAccount | None, actor: Actor, now: datetime) -> bool:
    """`UPDATE` condicional atómico y portable (SQLite/Postgres): el `rowcount`
    decide quién ganó la carrera, nunca un `SELECT` previo + `UPDATE` separado."""
    if sub_account is not None:
        result = db.execute(update(OrderSubAccount).where(OrderSubAccount.id == sub_account.id, OrderSubAccount.status == "open").values(status="paid", paid_at=now))
        if result.rowcount == 0:  # type: ignore[attr-defined]
            raise ConflictError("Esta sub-cuenta ya fue cobrada; consultá el comprobante", code="SUB_ACCOUNT_ALREADY_PAID")
        db.flush()
        db.refresh(sub_account)
        remaining_open = int(db.execute(select(func.count()).select_from(OrderSubAccount).where(OrderSubAccount.order_id == order.id, OrderSubAccount.status == "open")).scalar_one())
        if remaining_open > 0:
            return False

    result = db.execute(
        update(Order)
        .where(Order.id == order.id, Order.status.in_(_OPEN_ORDER_STATUSES), Order.paid_at.is_(None))
        .values(status=OrderStatus.PAID, paid_at=now, closed_at=now, paid_by_employee_id=actor.employee_id, paid_by_employee_name=actor.employee_name, version=Order.version + 1)
    )
    if result.rowcount == 0:  # type: ignore[attr-defined]
        raise ConflictError("Esta comanda ya fue cobrada; consultá el comprobante", code="ORDER_ALREADY_PAID")
    db.flush()
    db.refresh(order)
    _release_tables(db, order, now)
    return True


# ---------------------------------------------------------------------------
# Admin
# ---------------------------------------------------------------------------


def admin_list_orders(
    db: Session, *, store_id: int, date_from: date | None, date_to: date | None, status: str | None, channel: str | None, flags: list[str] | None
) -> list[dict[str, Any]]:
    stmt = select(Order).where(Order.store_id == store_id)
    if date_from is not None:
        stmt = stmt.where(Order.business_date >= date_from)
    if date_to is not None:
        stmt = stmt.where(Order.business_date <= date_to)
    if status:
        stmt = stmt.where(Order.status == OrderStatus(status))
    if channel:
        stmt = stmt.where(Order.channel == OrderChannel(channel))
    orders = list(db.execute(stmt.order_by(Order.opened_at.desc())).scalars())

    out: list[dict[str, Any]] = []
    for order in orders:
        totals = compute_order_totals(db, order)
        items = list(db.execute(select(OrderItem).where(OrderItem.order_id == order.id)).scalars())
        voided_items = sum(1 for i in items if i.status == OrderItemStatus.VOIDED)
        voids_after_bill = sum(1 for i in items if i.status == OrderItemStatus.VOIDED and i.void_after_bill)
        courtesies = sum(1 for i in items if i.courtesy_reason is not None)
        sent_at_payment_items = sum(1 for i in items if i.sent_at_payment)
        live_items_count = sum(1 for i in items if i.status != OrderItemStatus.VOIDED)
        table_numbers = [t.number for t in db.execute(select(Table).join(OrderTable, OrderTable.table_id == Table.id).where(OrderTable.order_id == order.id)).scalars()]
        transferred = order.transferred_from_shift_id is not None or order.transferred_to_shift_id is not None

        row = {
            "id": order.id, "business_date": order.business_date, "shift_id": order.shift_id, "channel": order.channel.value,
            "tables": table_numbers, "covers": order.covers, "status": order.status.value, "opened_by": order.opened_by_employee_name,
            "opened_at": order.opened_at, "bill_presented_at": order.bill_presented_at, "paid_at": order.paid_at,
            "items_count": live_items_count, "total": totals.total, "voided_items": voided_items, "voids_after_bill": voids_after_bill,
            "courtesies": courtesies, "discount_total": totals.discount_total, "sent_at_payment_items": sent_at_payment_items,
            "transferred": transferred,
        }

        if flags:
            keep = True
            for flag in flags:
                if flag == "voided" and order.status != OrderStatus.VOIDED:
                    keep = False
                elif flag == "courtesy" and courtesies == 0:
                    keep = False
                elif flag == "discounted" and totals.discount_total == 0:
                    keep = False
                elif flag == "staff_meal" and order.channel != OrderChannel.STAFF_MEAL:
                    keep = False
                elif flag == "transferred" and not transferred:
                    keep = False
                elif flag == "after_bill" and voids_after_bill == 0:
                    keep = False
            if not keep:
                continue
        out.append(row)
    return out
