"""Órdenes de compra (auditoría del dueño, tanda 5, i3).

Ciclo: `draft` → `sent` → `partially_received` → `received`, o
`cancelled` con motivo desde cualquiera que no esté recibida del todo. Una
orden nace a mano o desde la reposición sugerida (`inventory.replenishment`,
la cantidad sale de `app.analytics.hooks.replenishment_suggested_qty`, sin
otra regla). Mientras está en borrador se edita entera; después, sólo cambia
de estado.

**Recepciones**: una recepción puede nombrar la orden (`purchase_order_id`).
Al confirmarla, cada línea abierta de la orden cuyo insumo viene en la
recepción queda cerrada por ella («cierra las líneas que cubre»), aunque
haya llegado menos de lo pedido: la diferencia queda a la vista
(pedido contra recibido, derivado). Las líneas que no vinieron siguen
abiertas para una próxima recepción. Si la recepción se revierte, sus
líneas vuelven a abrirse y el estado se recalcula.

Todo lo que sale de acá es de administración: lleva precios esperados.
"""

from __future__ import annotations

from datetime import date
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.audit.service import record_audit
from app.auth.deps import Actor
from app.core import clock, features, tz
from app.core.errors import AppError, NotFoundError
from app.core.quantity import (
    QTY_SCALE,
    format_cost_micros,
    format_qty_base,
    line_cost_micros,
    micros_to_pesos,
    parse_cost_micros,
    parse_qty_base,
)
from app.inventory import hooks as inventory_hooks
from app.inventory.models import Ingredient
from app.purchases.models import (
    PurchaseOrder,
    PurchaseOrderLine,
    PurchaseOrderSource,
    PurchaseOrderStatus,
    Reception,
    ReceptionLine,
    ReceptionStatus,
    Supplier,
)
from app.purchases.schemas import (
    PurchaseOrderFromReplenishmentIn,
    PurchaseOrderIn,
    PurchaseOrderLineOut,
    PurchaseOrderOut,
)
from app.stores.models import Store

#: Estados en que una recepción todavía puede cubrir la orden.
RECEIVABLE = frozenset({PurchaseOrderStatus.DRAFT, PurchaseOrderStatus.SENT, PurchaseOrderStatus.PARTIALLY_RECEIVED})
#: Estados que se pueden cancelar (lo recibido del todo ya no tiene qué cancelar).
CANCELLABLE = RECEIVABLE

STATUS_LABEL = {
    PurchaseOrderStatus.DRAFT: "borrador",
    PurchaseOrderStatus.SENT: "enviada",
    PurchaseOrderStatus.PARTIALLY_RECEIVED: "recibida en parte",
    PurchaseOrderStatus.RECEIVED: "recibida",
    PurchaseOrderStatus.CANCELLED: "cancelada",
}


# ---------------------------------------------------------------------------
# Lectura.
# ---------------------------------------------------------------------------


def get_order_or_404(db: Session, *, organization_id: int, order_id: int) -> PurchaseOrder:
    row = db.get(PurchaseOrder, order_id)
    if row is None or row.organization_id != organization_id:
        raise NotFoundError("La orden de compra no existe en esta organización")
    return row


def order_lines(db: Session, *, order_id: int, include_removed: bool = False) -> list[PurchaseOrderLine]:
    stmt = select(PurchaseOrderLine).where(PurchaseOrderLine.order_id == order_id)
    if not include_removed:
        stmt = stmt.where(PurchaseOrderLine.removed_at.is_(None))
    return list(db.execute(stmt.order_by(PurchaseOrderLine.position, PurchaseOrderLine.id)).scalars())


def list_orders(
    db: Session, *, store_id: int, status: str | None = None, supplier_id: int | None = None
) -> list[PurchaseOrder]:
    stmt = select(PurchaseOrder).where(PurchaseOrder.store_id == store_id)
    if status is not None:
        stmt = stmt.where(PurchaseOrder.status == PurchaseOrderStatus(status))
    if supplier_id is not None:
        stmt = stmt.where(PurchaseOrder.supplier_id == supplier_id)
    return list(db.execute(stmt.order_by(PurchaseOrder.number.desc())).scalars())


def _received_by_ingredient(db: Session, *, order_id: int) -> tuple[dict[int, int], list[int]]:
    """Lo recibido por las recepciones CONFIRMADAS de la orden, por insumo
    (milésimas de la base), y los ids de esas recepciones."""
    rows = db.execute(
        select(ReceptionLine.ingredient_id, ReceptionLine.qty_received_base, Reception.id)
        .join(Reception, Reception.id == ReceptionLine.reception_id)
        .where(Reception.purchase_order_id == order_id, Reception.status == ReceptionStatus.CONFIRMED)
        .order_by(Reception.id)
    ).all()
    totals: dict[int, int] = {}
    reception_ids: list[int] = []
    for ingredient_id, qty, reception_id in rows:
        totals[ingredient_id] = totals.get(ingredient_id, 0) + int(qty)
        if reception_id not in reception_ids:
            reception_ids.append(reception_id)
    return totals, reception_ids


def _to_purchase_milli(qty_base: int, factor: int) -> int:
    """Milésimas de la base → milésimas de la unidad de compra, mitad hacia
    arriba (la misma aritmética de `hooks.receptions_of_day`)."""
    factor = max(1, int(factor))
    return (qty_base * 2 + factor) // (2 * factor)


def order_out(db: Session, order: PurchaseOrder) -> PurchaseOrderOut:
    store = db.get(Store, order.store_id)
    supplier = db.get(Supplier, order.supplier_id)
    lines = order_lines(db, order_id=order.id)
    ingredients = inventory_hooks.ingredients_by_id(db, store_id=order.store_id, ids=[ln.ingredient_id for ln in lines])
    received, reception_ids = _received_by_ingredient(db, order_id=order.id)

    total_micros = 0
    missing_price = 0
    line_outs: list[PurchaseOrderLineOut] = []
    for ln in lines:
        ingredient = ingredients.get(ln.ingredient_id)
        if ln.expected_unit_price_micros is None:
            missing_price += 1
        else:
            # milésimas de unidad de compra × micros por unidad de compra.
            total_micros += line_cost_micros(ln.qty_purchase_milli, ln.expected_unit_price_micros)
        line_outs.append(
            PurchaseOrderLineOut(
                id=ln.id,
                ingredient_id=ln.ingredient_id,
                ingredient_name=ingredient.name if ingredient is not None else f"Insumo #{ln.ingredient_id}",
                quantity=format_qty_base(ln.qty_purchase_milli),
                purchase_unit=ln.purchase_unit,
                qty_base=format_qty_base(ln.qty_base),
                base_unit=ingredient.base_unit.value if ingredient is not None else "",
                expected_unit_price=(
                    format_cost_micros(ln.expected_unit_price_micros) if ln.expected_unit_price_micros is not None else None
                ),
                received_quantity=format_qty_base(_to_purchase_milli(received.get(ln.ingredient_id, 0), ln.purchase_factor)),
                closed=ln.closed_reception_id is not None,
                closed_reception_id=ln.closed_reception_id,
            )
        )
    if not lines:
        expected_total, reason = None, "La orden no tiene líneas"
    elif missing_price:
        expected_total = None
        reason = (
            f"{missing_price} {'línea no tiene' if missing_price == 1 else 'líneas no tienen'} precio esperado: "
            "el total no se puede saber"
        )
    else:
        expected_total, reason = micros_to_pesos(total_micros), None

    return PurchaseOrderOut(
        id=order.id,
        store_id=order.store_id,
        store_name=store.name if store is not None else "",
        supplier_id=order.supplier_id,
        supplier_name=supplier.name if supplier is not None else f"Proveedor #{order.supplier_id}",
        supplier_nit=supplier.nit if supplier is not None else None,
        supplier_contact_name=supplier.contact_name if supplier is not None else None,
        supplier_contact_phone=supplier.contact_phone if supplier is not None else None,
        number=order.number,
        status=order.status.value,  # type: ignore[arg-type]
        source=order.source.value,  # type: ignore[arg-type]
        expected_date=order.expected_date,
        notes=order.notes,
        created_by_employee_name=order.created_by_employee_name,
        created_at=order.created_at,
        business_date=order.business_date,
        sent_at=order.sent_at,
        sent_by_employee_name=order.sent_by_employee_name,
        cancelled_at=order.cancelled_at,
        cancelled_by_employee_name=order.cancelled_by_employee_name,
        cancel_reason=order.cancel_reason,
        expected_total=expected_total,
        expected_total_reason=reason,
        reception_ids=reception_ids,
        lines=line_outs,
    )


# ---------------------------------------------------------------------------
# Escritura.
# ---------------------------------------------------------------------------


def _require_person(actor: Actor) -> tuple[int, str]:
    if actor.employee_id is None or not actor.employee_name:
        raise AppError(code="IDENTIFY_REQUIRED", message="Entrá con tu cuenta de administrador para operar órdenes de compra", status=401)
    return actor.employee_id, actor.employee_name


def _supplier_for(db: Session, *, store: Store, supplier_id: int) -> Supplier:
    supplier = db.get(Supplier, supplier_id)
    if supplier is None or supplier.store_id != store.id:
        raise NotFoundError("El proveedor no existe en esta sede")
    if not supplier.active:
        raise AppError(
            code="SUPPLIER_INACTIVE",
            message="El proveedor está inactivo; reactivalo en Compras › Proveedores antes de pedirle",
            status=400,
        )
    return supplier


def _prepare_lines(db: Session, *, store: Store, data: PurchaseOrderIn) -> list[dict[str, Any]]:
    """Valida TODO antes de escribir (`get_db` comitea ante un `AppError`)."""
    seen: set[int] = set()
    out: list[dict[str, Any]] = []
    for idx, line in enumerate(data.lines):
        ingredient = inventory_hooks.get_ingredient(db, store_id=store.id, ingredient_id=line.ingredient_id)
        if ingredient is None:
            raise NotFoundError(f"lines[{idx}]: el insumo {line.ingredient_id} no existe en esta sede")
        if not ingredient.active:
            raise AppError(
                code="INGREDIENT_INACTIVE", message=f'lines[{idx}]: el insumo "{ingredient.name}" está inactivo', status=400
            )
        if ingredient.id in seen:
            raise AppError(
                code="VALIDATION_ERROR",
                message=f'"{ingredient.name}" está dos veces en la orden: sumá las cantidades en una sola línea',
                status=400,
            )
        seen.add(ingredient.id)
        qty_milli = parse_qty_base(line.quantity, field=f"lines[{idx}].quantity")
        if qty_milli <= 0:
            raise AppError(
                code="VALIDATION_ERROR",
                message=f'lines[{idx}]: la cantidad de "{ingredient.name}" tiene que ser mayor a cero',
                status=400,
            )
        price: int | None = None
        if line.expected_unit_price is not None and line.expected_unit_price.strip() != "":
            price = parse_cost_micros(line.expected_unit_price, field=f"lines[{idx}].expected_unit_price")
            if price < 0:
                raise AppError(
                    code="VALIDATION_ERROR", message=f"lines[{idx}]: el precio esperado no puede ser negativo", status=400
                )
        out.append({"ingredient": ingredient, "qty_milli": qty_milli, "price": price})
    return out


def _write_lines(db: Session, *, order: PurchaseOrder, prepared: list[dict[str, Any]]) -> None:
    """Deja la orden con exactamente estas líneas. Una línea que ya existía
    para el insumo se actualiza (o se reactiva, si se había sacado); las que
    no vienen quedan `removed_at` — nunca un `DELETE`."""
    now = clock.now_utc()
    existing = {ln.ingredient_id: ln for ln in order_lines(db, order_id=order.id, include_removed=True)}
    wanted: set[int] = set()
    for position, item in enumerate(prepared):
        ingredient: Ingredient = item["ingredient"]
        wanted.add(ingredient.id)
        values = {
            "position": position,
            "qty_purchase_milli": item["qty_milli"],
            "purchase_unit": ingredient.purchase_unit,
            "purchase_factor": ingredient.purchase_factor,
            # Una sola conversión, acá (igual que la recepción del POS).
            "qty_base": item["qty_milli"] * ingredient.purchase_factor,
            "expected_unit_price_micros": item["price"],
            "removed_at": None,
        }
        row = existing.get(ingredient.id)
        if row is None:
            db.add(PurchaseOrderLine(order_id=order.id, ingredient_id=ingredient.id, **values))
        else:
            for key, value in values.items():
                setattr(row, key, value)
    for ingredient_id, row in existing.items():
        if ingredient_id not in wanted and row.removed_at is None:
            row.removed_at = now
    db.flush()


def _next_number(db: Session, *, store_id: int) -> int:
    current = db.execute(
        select(func.coalesce(func.max(PurchaseOrder.number), 0)).where(PurchaseOrder.store_id == store_id)
    ).scalar_one()
    return int(current) + 1


def _create(
    db: Session, *, actor: Actor, store: Store, data: PurchaseOrderIn, source: PurchaseOrderSource
) -> PurchaseOrder:
    employee_id, employee_name = _require_person(actor)
    supplier = _supplier_for(db, store=store, supplier_id=data.supplier_id)
    prepared = _prepare_lines(db, store=store, data=data)
    now = clock.now_utc()
    order = PurchaseOrder(
        organization_id=store.organization_id,
        store_id=store.id,
        supplier_id=supplier.id,
        number=_next_number(db, store_id=store.id),
        status=PurchaseOrderStatus.DRAFT,
        source=source,
        expected_date=data.expected_date,
        notes=(data.notes or "").strip() or None,
        created_by_employee_id=employee_id,
        created_by_employee_name=employee_name,
        created_at=now,
        business_date=tz.business_date_for(now, store.cutoff_hour),
        updated_at=now,
    )
    db.add(order)
    db.flush()
    _write_lines(db, order=order, prepared=prepared)
    record_audit(
        db,
        actor=actor,
        organization_id=store.organization_id,
        store_id=store.id,
        entity="purchase_order",
        entity_id=order.id,
        action="create",
        before=None,
        after={"number": order.number, "supplier_id": supplier.id, "source": source.value, "lines": len(prepared)},
    )
    return order


def create_order(db: Session, *, actor: Actor, store: Store, data: PurchaseOrderIn) -> PurchaseOrder:
    return _create(db, actor=actor, store=store, data=data, source=PurchaseOrderSource.MANUAL)


def create_from_replenishment(
    db: Session, *, actor: Actor, store: Store, data: PurchaseOrderFromReplenishmentIn
) -> PurchaseOrder:
    """Un borrador con lo que la reposición sugerida dice que falta. La
    cantidad sugerida (en la base) se lleva a unidades de compra ENTERAS,
    redondeando hacia arriba: al proveedor no se le piden 0,37 bultos."""
    features.assert_feature(db, store.organization_id, store.id, "inventory.replenishment")
    supplier = _supplier_for(db, store=store, supplier_id=data.supplier_id)
    from app.analytics import hooks as analytics_hooks

    suggested = analytics_hooks.replenishment_suggested_qty(db, store=store)
    if data.ingredient_ids:
        wanted = list(dict.fromkeys(data.ingredient_ids))
    else:
        assigned = db.execute(
            select(Ingredient.id).where(
                Ingredient.store_id == store.id, Ingredient.active.is_(True), Ingredient.supplier_id == supplier.id
            )
        ).scalars()
        wanted = sorted(assigned)
    ingredients = inventory_hooks.ingredients_by_id(db, store_id=store.id, ids=wanted)

    from app.purchases.schemas import PurchaseOrderLineIn

    lines: list[PurchaseOrderLineIn] = []
    for ingredient_id in wanted:
        ingredient = ingredients.get(ingredient_id)
        qty_base = suggested.get(ingredient_id, 0)
        if ingredient is None or not ingredient.active or qty_base <= 0:
            continue
        per_unit = ingredient.purchase_factor * QTY_SCALE
        whole_units = -(-qty_base // per_unit)
        lines.append(PurchaseOrderLineIn(ingredient_id=ingredient.id, quantity=str(whole_units)))
    if not lines:
        raise AppError(
            code="NOTHING_TO_ORDER",
            message=(
                f"La reposición sugerida no pide nada de {supplier.name}: asigná el proveedor a sus insumos en "
                "Inventario › Insumos, o armá la orden a mano"
            ),
            status=400,
        )
    order_in = PurchaseOrderIn(supplier_id=supplier.id, lines=lines)
    return _create(db, actor=actor, store=store, data=order_in, source=PurchaseOrderSource.REPLENISHMENT)


def update_order(db: Session, *, actor: Actor, store: Store, order: PurchaseOrder, data: PurchaseOrderIn) -> PurchaseOrder:
    """Sólo un borrador se edita, y entero: proveedor, fecha, notas y
    líneas. Las líneas que salen quedan marcadas `removed_at`, no se
    borran."""
    _require_person(actor)
    if order.status != PurchaseOrderStatus.DRAFT:
        raise AppError(
            code="PURCHASE_ORDER_NOT_DRAFT",
            message="Sólo se edita una orden en borrador; esta ya se envió. Cancelala y armá otra si cambió el pedido",
            status=409,
        )
    supplier = _supplier_for(db, store=store, supplier_id=data.supplier_id)
    prepared = _prepare_lines(db, store=store, data=data)
    before = {"supplier_id": order.supplier_id, "lines": len(order_lines(db, order_id=order.id))}
    order.supplier_id = supplier.id
    order.expected_date = data.expected_date
    order.notes = (data.notes or "").strip() or None
    order.updated_at = clock.now_utc()
    _write_lines(db, order=order, prepared=prepared)
    record_audit(
        db,
        actor=actor,
        organization_id=order.organization_id,
        store_id=order.store_id,
        entity="purchase_order",
        entity_id=order.id,
        action="update",
        before=before,
        after={"supplier_id": supplier.id, "lines": len(prepared)},
    )
    return order


def send_order(db: Session, *, actor: Actor, store: Store, order: PurchaseOrder) -> PurchaseOrder:
    employee_id, employee_name = _require_person(actor)
    if order.status != PurchaseOrderStatus.DRAFT:
        raise AppError(
            code="PURCHASE_ORDER_NOT_DRAFT",
            message=f"Esta orden ya está {STATUS_LABEL[order.status]}: sólo un borrador se marca como enviado",
            status=409,
        )
    now = clock.now_utc()
    order.status = PurchaseOrderStatus.SENT
    order.sent_at = now
    order.sent_business_date = tz.business_date_for(now, store.cutoff_hour)
    order.sent_by_employee_id = employee_id
    order.sent_by_employee_name = employee_name
    order.updated_at = now
    db.flush()
    record_audit(
        db,
        actor=actor,
        organization_id=order.organization_id,
        store_id=order.store_id,
        entity="purchase_order",
        entity_id=order.id,
        action="send",
        before={"status": "draft"},
        after={"status": "sent"},
    )
    return order


def cancel_order(db: Session, *, actor: Actor, order: PurchaseOrder, reason: str) -> PurchaseOrder:
    employee_id, employee_name = _require_person(actor)
    clean = reason.strip()
    if not clean:
        raise AppError(code="REASON_REQUIRED", message="Escribí por qué se cancela la orden", status=400)
    if order.status not in CANCELLABLE:
        raise AppError(
            code="PURCHASE_ORDER_NOT_CANCELLABLE",
            message=f"Esta orden ya está {STATUS_LABEL[order.status]}: no hay nada que cancelar",
            status=409,
        )
    before = order.status.value
    now = clock.now_utc()
    order.status = PurchaseOrderStatus.CANCELLED
    order.cancelled_at = now
    order.cancelled_by_employee_id = employee_id
    order.cancelled_by_employee_name = employee_name
    order.cancel_reason = clean
    order.updated_at = now
    db.flush()
    record_audit(
        db,
        actor=actor,
        organization_id=order.organization_id,
        store_id=order.store_id,
        entity="purchase_order",
        entity_id=order.id,
        action="cancel",
        before={"status": before},
        after={"status": "cancelled"},
        reason=clean,
    )
    return order


# ---------------------------------------------------------------------------
# El cruce con las recepciones (lo llama `app.purchases.service`).
# ---------------------------------------------------------------------------


def assert_receivable(db: Session, *, store: Store, supplier_id: int, order_id: int) -> PurchaseOrder:
    """Fase de validación de la recepción: la orden existe en la sede, es
    del mismo proveedor y todavía espera mercancía. No escribe nada."""
    order = db.get(PurchaseOrder, order_id)
    if order is None or order.store_id != store.id:
        raise NotFoundError("La orden de compra no existe en esta sede")
    if order.supplier_id != supplier_id:
        raise AppError(
            code="PURCHASE_ORDER_SUPPLIER_MISMATCH",
            message=f"La orden #{order.number} es de otro proveedor: elegí la orden de este proveedor o ninguna",
            status=400,
        )
    if order.status not in RECEIVABLE:
        raise AppError(
            code="PURCHASE_ORDER_CLOSED",
            message=f"La orden #{order.number} ya está {STATUS_LABEL[order.status]}: no espera mercancía",
            status=409,
        )
    return order


def _recompute_status(db: Session, order: PurchaseOrder) -> None:
    lines = order_lines(db, order_id=order.id)
    closed = sum(1 for ln in lines if ln.closed_reception_id is not None)
    if lines and closed == len(lines):
        order.status = PurchaseOrderStatus.RECEIVED
    elif closed > 0:
        order.status = PurchaseOrderStatus.PARTIALLY_RECEIVED
    else:
        order.status = PurchaseOrderStatus.SENT if order.sent_at is not None else PurchaseOrderStatus.DRAFT


def close_lines_for_reception(
    db: Session, *, actor: Actor, order: PurchaseOrder, reception: Reception, ingredient_ids: set[int]
) -> list[int]:
    """Cierra las líneas abiertas de la orden cuyos insumos vinieron en la
    recepción y recalcula el estado. Devuelve los ids de las líneas que
    cerró."""
    now = clock.now_utc()
    closed: list[int] = []
    before = order.status.value
    for ln in order_lines(db, order_id=order.id):
        if ln.closed_reception_id is None and ln.ingredient_id in ingredient_ids:
            ln.closed_reception_id = reception.id
            ln.closed_at = now
            closed.append(ln.id)
    db.flush()
    _recompute_status(db, order)
    order.updated_at = now
    db.flush()
    record_audit(
        db,
        actor=actor,
        organization_id=order.organization_id,
        store_id=order.store_id,
        entity="purchase_order",
        entity_id=order.id,
        action="receive",
        before={"status": before},
        after={"status": order.status.value, "reception_id": reception.id, "closed_line_ids": closed},
    )
    return closed


def reopen_lines_for_reversal(db: Session, *, actor: Actor, reception: Reception) -> None:
    """La recepción se revirtió: las líneas que había cerrado vuelven a
    esperar mercancía. Una orden cancelada sigue cancelada (sólo se reabren
    sus líneas, que dejan de figurar como cubiertas)."""
    if reception.purchase_order_id is None:
        return
    order = db.get(PurchaseOrder, reception.purchase_order_id)
    if order is None:
        return
    before = order.status.value
    reopened: list[int] = []
    for ln in order_lines(db, order_id=order.id):
        if ln.closed_reception_id == reception.id:
            ln.closed_reception_id = None
            ln.closed_at = None
            reopened.append(ln.id)
    db.flush()
    if order.status != PurchaseOrderStatus.CANCELLED:
        _recompute_status(db, order)
    order.updated_at = clock.now_utc()
    db.flush()
    record_audit(
        db,
        actor=actor,
        organization_id=order.organization_id,
        store_id=order.store_id,
        entity="purchase_order",
        entity_id=order.id,
        action="reception_reversed",
        before={"status": before},
        after={"status": order.status.value, "reception_id": reception.id, "reopened_line_ids": reopened},
    )


def delivery_days_by_supplier(db: Session, *, store_id: int, since: date | None = None) -> dict[int, list[int]]:
    """Cuántos días tardó cada proveedor en entregar: del día operativo en
    que se marcó enviada la orden a la PRIMERA recepción confirmada que la
    cubrió. Sólo órdenes enviadas y con recepción. Lo lee la comparación de
    proveedores (i2)."""
    stmt = (
        select(PurchaseOrder.supplier_id, PurchaseOrder.sent_business_date, func.min(Reception.business_date))
        .join(Reception, Reception.purchase_order_id == PurchaseOrder.id)
        .where(
            PurchaseOrder.store_id == store_id,
            PurchaseOrder.sent_business_date.is_not(None),
            Reception.status == ReceptionStatus.CONFIRMED,
        )
        .group_by(PurchaseOrder.id, PurchaseOrder.supplier_id, PurchaseOrder.sent_business_date)
    )
    out: dict[int, list[int]] = {}
    for supplier_id, sent_date, first_reception in db.execute(stmt).all():
        if sent_date is None or first_reception is None:
            continue
        if since is not None and first_reception < since:
            continue
        out.setdefault(int(supplier_id), []).append(max(0, (first_reception - sent_date).days))
    return out
