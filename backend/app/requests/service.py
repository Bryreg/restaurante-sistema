"""Toda la lógica de las solicitudes del salón.

Reglas que este archivo hace cumplir (y que el router no repite):

- **Se pide con turno abierto.** Quien pide es quien está en el turno; la
  solicitud queda atada a ese turno y a la fecha de negocio de la sede.
- **Validar antes de escribir.** `get_db` hace `commit()` también ante un
  `AppError`: cada función decide todo en variables locales y escribe al
  final (`tests/audit/test_write_before_reject.py`).
- **Aprobar hace algo.** Insumos aprobados quedan «por comprar» y Compras los
  lee de `hooks.approved_supply_lines`; sencilla aprobada queda «por
  entregar» y se cierra con el Cambio del turno, que es el único canje del
  cajón. Este dominio **no mueve plata ni inventario**: no crea recepciones,
  ni pagos, ni movimientos de caja.
- **Nada se borra.** Rechazar es un estado con motivo; cada transición deja
  auditoría con antes y después.
- **Sin costos.** Nada de acá lee ni publica un costo: la tablet consume
  estas mismas respuestas.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import timedelta
from typing import TYPE_CHECKING, Any

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.audit.service import record_audit
from app.auth.deps import Actor
from app.core import clock, features, money, tz
from app.core.errors import AppError, ConflictError, NotFoundError
from app.core.quantity import format_qty_base, parse_qty_base
from app.inventory import hooks as inventory_hooks
from app.requests.models import (
    ChangeRequest,
    StaffRequest,
    StaffRequestKind,
    StaffRequestLine,
    StaffRequestStatus,
    SupplyRequest,
)
from app.requests.schemas import (
    ApproveIn,
    ChangeRequestIn,
    PersonRef,
    ReceivedIn,
    RejectIn,
    RequestLineOut,
    StaffRequestOut,
    SupplyItemOut,
    SupplyRequestIn,
    SupplySuggestionOut,
    SupplySuggestionsOut,
)
from app.shifts import hooks as shifts_hooks
from app.shifts.schemas import DenominationCountIn, DenominationIn
from app.stores.models import Store

if TYPE_CHECKING:
    from app.inventory.models import Ingredient

FEATURE = "pos.requests"
SUPPLY_FEATURE = "inventory.perpetual"
CHANGE_FEATURE = "cash.swaps"


# ---------------------------------------------------------------------------
# Piezas comunes
# ---------------------------------------------------------------------------


def _open_shift_id(db: Session, store_id: int) -> int | None:
    return db.execute(shifts_hooks.open_shift_ids_query(store_id)).scalars().first()


def _require_open_shift(db: Session, store_id: int) -> int:
    shift_id = _open_shift_id(db, store_id)
    if shift_id is None:
        raise AppError(
            "NO_OPEN_SHIFT",
            "No hay un turno abierto en esta sede; abrí el turno en la pantalla Turno y volvé a pedir",
            status=409,
        )
    return shift_id


def _clean_text(value: str | None) -> str | None:
    if value is None:
        return None
    text = value.strip()
    return text or None


def _normalize_denominations(payload: DenominationCountIn) -> tuple[list[dict[str, int]], int]:
    """Valida el desglose con la misma función que el turno
    (`money.validate_denominations`) y lo deja limpio: sin renglones en cero,
    una fila por denominación, de mayor a menor."""
    denoms = [money.Denomination(value=d.value, count=d.count) for d in payload.denominations]
    total = money.validate_denominations(denoms, payload.total)
    if total <= 0:
        raise AppError(
            "CHANGE_EMPTY",
            "Indicá cuántos billetes o monedas de cada denominación necesitás",
        )
    merged: dict[int, int] = {}
    for d in denoms:
        if d.count > 0:
            merged[d.value] = merged.get(d.value, 0) + d.count
    rows = [{"value": value, "count": merged[value]} for value in sorted(merged, reverse=True)]
    return rows, total


def _person(employee_id: int | None, name: str | None) -> PersonRef | None:
    if employee_id is None:
        return None
    return PersonRef(id=employee_id, name=name or "")


def _denoms_out(rows: list[Any] | None) -> list[DenominationIn] | None:
    if rows is None:
        return None
    return [DenominationIn(value=int(r["value"]), count=int(r["count"])) for r in rows]


def _lines_of(db: Session, request_ids: Sequence[int]) -> dict[int, list[StaffRequestLine]]:
    out: dict[int, list[StaffRequestLine]] = {rid: [] for rid in request_ids}
    if not request_ids:
        return out
    rows = db.execute(
        select(StaffRequestLine)
        .where(StaffRequestLine.request_id.in_(list(request_ids)))
        .order_by(StaffRequestLine.id)
    ).scalars()
    for line in rows:
        out[line.request_id].append(line)
    return out


def _line_out(line: StaffRequestLine, ingredient: Ingredient | None) -> RequestLineOut:
    """El renglón en la unidad base (lo guardado) y en la unidad cómoda del
    insumo (para mostrar). Sin el insumo —no debería pasar: los insumos no se
    borran— la unidad cómoda es la base misma, nunca un número inventado."""
    if ingredient is not None:
        _mode, entry_unit = inventory_hooks.entry_unit_of(ingredient)

        def to_entry(qty: int) -> str:
            return format_qty_base(inventory_hooks.base_to_entry_milli(ingredient, qty))
    else:
        entry_unit = _BASE_UNIT_WORD.get(line.base_unit, line.base_unit)

        def to_entry(qty: int) -> str:
            return format_qty_base(qty)

    return RequestLineOut(
        id=line.id,
        ingredient_id=line.ingredient_id,
        ingredient_name=line.ingredient_name,
        base_unit=line.base_unit,
        qty_requested=format_qty_base(line.qty_requested),
        qty_approved=format_qty_base(line.qty_approved) if line.qty_approved is not None else None,
        suggested_qty=format_qty_base(line.suggested_qty) if line.suggested_qty is not None else None,
        entry_unit=entry_unit,
        qty_requested_entry=to_entry(line.qty_requested),
        qty_approved_entry=to_entry(line.qty_approved) if line.qty_approved is not None else None,
    )


#: La unidad base en palabras, para el caso sin insumo. «unit» no se muestra.
_BASE_UNIT_WORD = {"g": "g", "ml": "ml", "unit": "unidad"}


def _status_value(status: StaffRequestStatus | str) -> str:
    return status.value if isinstance(status, StaffRequestStatus) else str(status)


def to_out(
    request: StaffRequest, lines: list[StaffRequestLine], ingredients: dict[int, Ingredient] | None = None
) -> StaffRequestOut:
    found = ingredients or {}
    return StaffRequestOut(
        id=request.id,
        kind=request.kind,  # type: ignore[arg-type]
        status=_status_value(request.status),  # type: ignore[arg-type]
        shift_id=request.shift_id,
        business_date=request.business_date,
        requested_by=PersonRef(id=request.requested_by_employee_id, name=request.requested_by_employee_name),
        requested_at=request.requested_at,
        note=request.note,
        reason=request.reason,
        lines=[_line_out(line, found.get(line.ingredient_id)) for line in lines],
        requested_denominations=_denoms_out(request.requested_denominations),
        requested_total=request.requested_total,
        approved_denominations=_denoms_out(request.approved_denominations),
        approved_total=request.approved_total,
        resolved_by=_person(request.resolved_by_employee_id, request.resolved_by_employee_name),
        resolved_at=request.resolved_at,
        resolution_note=request.resolution_note,
        closed_by=_person(request.closed_by_employee_id, request.closed_by_employee_name),
        closed_at=request.closed_at,
        cash_swap_id=request.cash_swap_id,
    )


def to_out_many(db: Session, requests: Sequence[StaffRequest]) -> list[StaffRequestOut]:
    lines = _lines_of(db, [r.id for r in requests])
    by_store: dict[int, set[int]] = {}
    for r in requests:
        by_store.setdefault(r.store_id, set()).update(line.ingredient_id for line in lines.get(r.id, []))
    ingredients: dict[int, Ingredient] = {}
    for store_id, ids in by_store.items():
        ingredients.update(inventory_hooks.ingredients_by_id(db, store_id=store_id, ids=sorted(ids)))
    return [to_out(r, lines.get(r.id, []), ingredients) for r in requests]


def _snapshot(request: StaffRequest) -> dict[str, Any]:
    return {
        "status": _status_value(request.status),
        "approved_total": request.approved_total,
        "resolution_note": request.resolution_note,
        "cash_swap_id": request.cash_swap_id,
    }


# ---------------------------------------------------------------------------
# Sugerencias de insumos (sin costos)
# ---------------------------------------------------------------------------


def _suggested_by_ingredient(db: Session, store_id: int) -> dict[int, tuple[dict[str, Any], int]]:
    """`{insumo: (alerta, cantidad sugerida)}` de los insumos bajo mínimo.

    Sale de `inventory.hooks.low_stock_alerts`, que ya no trae costos. No se
    llama además a `negative_stock_alerts`: el mínimo es obligatorio y mayor
    que cero, así que todo insumo en negativo ya está bajo mínimo, y esa
    función recorre el libro entero buscando rachas que acá no se muestran.

    La cantidad sugerida parte de la misma regla de la reposición sugerida
    del administrador (`suggested_qty` de «Reposición»): lo que falta para
    volver al mínimo configurado, `mínimo − stock`. Después se redondea HACIA
    ARRIBA a la unidad cómoda (`inventory.units.rounded_entry_suggestion`):
    nadie pide «503,177 g», pide medio kilo. El sesgo es declarado: se
    sugiere un poco más, nunca de menos.
    """
    alerts = {int(a["ingredient_id"]): a for a in inventory_hooks.low_stock_alerts(db, store_id=store_id)}
    ingredients = inventory_hooks.ingredients_by_id(db, store_id=store_id, ids=sorted(alerts))
    out: dict[int, tuple[dict[str, Any], int]] = {}
    for ingredient_id, alert in alerts.items():
        missing = int(alert["min_stock"]) - int(alert["qty_base"])
        ingredient = ingredients.get(ingredient_id)
        if missing <= 0 or ingredient is None:
            continue
        _entry, rounded_base = inventory_hooks.rounded_entry_suggestion(ingredient, missing)
        out[ingredient_id] = (alert, rounded_base)
    return out


#: Cuántos «frecuentes» se ofrecen y en qué ventana se miran.
FREQUENT_LIMIT = 8
FREQUENT_WINDOW_DAYS = 60


def _frequent_items(db: Session, *, store: Store) -> list[SupplyItemOut]:
    """Los insumos que más se pidieron en la sede en los últimos
    `FREQUENT_WINDOW_DAYS` días (por cantidad de pedidos), activos."""
    since = clock.now_utc() - timedelta(days=FREQUENT_WINDOW_DAYS)
    rows = db.execute(
        select(StaffRequestLine.ingredient_id, func.count(StaffRequestLine.id).label("n"))
        .join(StaffRequest, StaffRequest.id == StaffRequestLine.request_id)
        .where(
            StaffRequest.store_id == store.id,
            StaffRequest.kind == StaffRequestKind.SUPPLY.value,
            StaffRequest.requested_at >= since,
        )
        .group_by(StaffRequestLine.ingredient_id)
    ).all()
    ranked = sorted(((int(r[0]), int(r[1])) for r in rows), key=lambda r: -r[1])
    ingredients = inventory_hooks.ingredients_by_id(db, store_id=store.id, ids=[r[0] for r in ranked])
    out: list[SupplyItemOut] = []
    for ingredient_id, _n in ranked:
        ingredient = ingredients.get(ingredient_id)
        if ingredient is None or not ingredient.active:
            continue
        out.append(_item_out(ingredient))
        if len(out) >= FREQUENT_LIMIT:
            break
    return out


def _item_out(ingredient: Ingredient) -> SupplyItemOut:
    mode, unit = inventory_hooks.entry_unit_of(ingredient)
    return SupplyItemOut(ingredient_id=ingredient.id, name=ingredient.name, entry_mode=mode, entry_unit=unit)  # type: ignore[arg-type]


def supply_suggestions(db: Session, *, store: Store, employee_id: int | None = None) -> SupplySuggestionsOut:
    """Lo que falta, filtrado por el área de quien pide (`inventory.hooks.
    requester_area`): el del bar ve licores, el de cocina carnes. Sin área
    asignada ni puesto que coincida con un área, la sede entera."""
    if not features.is_enabled(db, store.organization_id, store.id, SUPPLY_FEATURE):
        return SupplySuggestionsOut(
            available=False,
            reason="El inventario no se lleva en esta sede, así que no hay stock para comparar con el mínimo",
            rows=[],
        )
    area = inventory_hooks.requester_area(db, store=store, employee_id=employee_id)
    suggested = _suggested_by_ingredient(db, store.id)
    ingredients = inventory_hooks.ingredients_by_id(db, store_id=store.id, ids=sorted(suggested))
    in_area = set(area.ingredient_ids)
    rows: list[SupplySuggestionOut] = []
    other = 0
    for ingredient_id, (alert, rounded_base) in suggested.items():
        if area.via != "none" and ingredient_id not in in_area:
            other += 1
            continue
        ingredient = ingredients[ingredient_id]
        mode, unit = inventory_hooks.entry_unit_of(ingredient)
        qty = int(alert["qty_base"])
        rows.append(
            SupplySuggestionOut(
                ingredient_id=ingredient_id,
                name=str(alert["name"]),
                base_unit=str(alert["base_unit"]),
                current_stock=format_qty_base(qty),
                min_stock=format_qty_base(int(alert["min_stock"])),
                negative=qty < 0,
                suggested_qty=format_qty_base(rounded_base),
                entry_mode=mode,  # type: ignore[arg-type]
                entry_unit=unit,
                suggested_entry_qty=format_qty_base(inventory_hooks.base_to_entry_milli(ingredient, rounded_base)),
            )
        )
    # Primero los negativos, después por nombre.
    rows.sort(key=lambda r: (not r.negative, r.name.lower()))
    return SupplySuggestionsOut(
        available=True,
        reason=None,
        rows=rows,
        area_name=area.area_name,
        area_via=area.via,  # type: ignore[arg-type]
        other_areas_count=other,
        frequent=_frequent_items(db, store=store),
    )


# ---------------------------------------------------------------------------
# Operador: pedir
# ---------------------------------------------------------------------------


def create_supply_request(db: Session, *, actor: Actor, store: Store, payload: SupplyRequestIn) -> SupplyRequest:
    features.assert_feature(db, store.organization_id, store.id, SUPPLY_FEATURE)
    shift_id = _require_open_shift(db, store.id)
    if actor.employee_id is None or actor.employee_name is None:
        raise AppError("IDENTIFY_REQUIRED", "Identificate con tu PIN", status=401)

    suggested = _suggested_by_ingredient(db, store.id)
    seen: set[int] = set()
    lines: list[dict[str, Any]] = []
    for line in payload.lines:
        if line.ingredient_id in seen:
            raise AppError(
                "DUPLICATE_INGREDIENT",
                "Un insumo aparece dos veces en el pedido; dejá un solo renglón con la cantidad total",
            )
        seen.add(line.ingredient_id)
        ingredient = inventory_hooks.get_ingredient(db, store_id=store.id, ingredient_id=line.ingredient_id)
        if ingredient is None or not ingredient.active:
            raise NotFoundError("El insumo no existe o está inactivo en esta sede")
        if line.entry_unit is not None:
            _mode, unit = inventory_hooks.entry_unit_of(ingredient)
            if line.entry_unit != unit:
                raise AppError(
                    "VALIDATION_ERROR",
                    f"{ingredient.name}: se pide en {unit}; recargá la pantalla de Solicitudes y volvé a pedir",
                )
            qty = inventory_hooks.entry_qty_to_base(ingredient, line.qty)
        else:
            qty = parse_qty_base(line.qty, field=ingredient.name)
        if qty <= 0:
            raise AppError(
                "VALIDATION_ERROR",
                f"{ingredient.name}: poné una cantidad mayor a cero o quitá el insumo del pedido",
            )
        lines.append(
            {
                "ingredient_id": ingredient.id,
                "ingredient_name": ingredient.name,
                "base_unit": ingredient.base_unit.value,
                "qty_requested": qty,
                "suggested_qty": suggested[ingredient.id][1] if ingredient.id in suggested else None,
            }
        )
    note = _clean_text(payload.note)

    now = clock.now_utc()
    request = SupplyRequest(
        organization_id=store.organization_id,
        store_id=store.id,
        shift_id=shift_id,
        business_date=tz.business_date_for(now, store.cutoff_hour),
        status=StaffRequestStatus.PENDING,
        note=note,
        requested_by_employee_id=actor.employee_id,
        requested_by_employee_name=actor.employee_name,
        requested_at=now,
    )
    db.add(request)
    db.flush()
    for values in lines:
        db.add(StaffRequestLine(request_id=request.id, **values))
    db.flush()
    record_audit(
        db,
        actor=actor,
        organization_id=store.organization_id,
        store_id=store.id,
        entity="staff_request",
        entity_id=request.id,
        action="create",
        before=None,
        after={"kind": "supply", "lines": len(lines), "note": note},
    )
    return request


def create_change_request(db: Session, *, actor: Actor, store: Store, payload: ChangeRequestIn) -> ChangeRequest:
    features.assert_feature(db, store.organization_id, store.id, CHANGE_FEATURE)
    shift_id = _require_open_shift(db, store.id)
    if actor.employee_id is None or actor.employee_name is None:
        raise AppError("IDENTIFY_REQUIRED", "Identificate con tu PIN", status=401)
    reason = _clean_text(payload.reason)
    if reason is None:
        raise AppError("REASON_REQUIRED", "Escribí para qué necesitás la sencilla")
    rows, total = _normalize_denominations(payload.denominations)

    now = clock.now_utc()
    request = ChangeRequest(
        organization_id=store.organization_id,
        store_id=store.id,
        shift_id=shift_id,
        business_date=tz.business_date_for(now, store.cutoff_hour),
        status=StaffRequestStatus.PENDING,
        reason=reason,
        requested_denominations=rows,
        requested_total=total,
        requested_by_employee_id=actor.employee_id,
        requested_by_employee_name=actor.employee_name,
        requested_at=now,
    )
    db.add(request)
    db.flush()
    record_audit(
        db,
        actor=actor,
        organization_id=store.organization_id,
        store_id=store.id,
        entity="staff_request",
        entity_id=request.id,
        action="create",
        before=None,
        after={"kind": "change", "requested_total": total, "reason": reason},
    )
    return request


# ---------------------------------------------------------------------------
# Lecturas
# ---------------------------------------------------------------------------


def list_mine(db: Session, *, store: Store) -> list[StaffRequest]:
    """Las del turno abierto (en cualquier estado) más las aprobadas que
    siguen pendientes de comprar o de entregar, vengan del turno que vengan."""
    open_ids = shifts_hooks.open_shift_ids_query(store.id)
    stmt = (
        select(StaffRequest)
        .where(
            StaffRequest.store_id == store.id,
            or_(StaffRequest.shift_id.in_(open_ids), StaffRequest.status == StaffRequestStatus.APPROVED),
        )
        .order_by(StaffRequest.requested_at.desc(), StaffRequest.id.desc())
    )
    return list(db.execute(stmt).scalars())


def list_for_admin(
    db: Session,
    *,
    store: Store,
    status: StaffRequestStatus | None,
    kind: StaffRequestKind | None,
    limit: int = 200,
) -> list[StaffRequest]:
    stmt = select(StaffRequest).where(StaffRequest.store_id == store.id)
    if status is not None:
        stmt = stmt.where(StaffRequest.status == status)
    if kind is not None:
        stmt = stmt.where(StaffRequest.kind == kind.value)
    # Pendientes: la más vieja primero (es la que más espera). El resto: la
    # más reciente primero.
    if status == StaffRequestStatus.PENDING:
        stmt = stmt.order_by(StaffRequest.requested_at, StaffRequest.id)
    else:
        stmt = stmt.order_by(StaffRequest.requested_at.desc(), StaffRequest.id.desc())
    return list(db.execute(stmt.limit(limit)).scalars())


def pending_count(db: Session, *, store_id: int) -> int:
    stmt = select(func.count(StaffRequest.id)).where(
        StaffRequest.store_id == store_id, StaffRequest.status == StaffRequestStatus.PENDING
    )
    return int(db.execute(stmt).scalar_one())


# ---------------------------------------------------------------------------
# Administrador: resolver
# ---------------------------------------------------------------------------


def get_for_admin(db: Session, *, actor: Actor, request_id: int) -> StaffRequest:
    """La solicitud, validando que sea de la organización del administrador
    (un id ajeno es `404`) y que la función esté encendida en SU sede."""
    request = db.get(StaffRequest, request_id)
    if request is None or request.organization_id != actor.organization_id:
        raise NotFoundError("La solicitud no existe")
    features.assert_feature(db, request.organization_id, request.store_id, FEATURE)
    return request


def _require_status(request: StaffRequest, expected: StaffRequestStatus, message: str) -> None:
    if _status_value(request.status) != expected.value:
        raise ConflictError(message, code="REQUEST_STATUS_CONFLICT")


def approve(db: Session, *, actor: Actor, request: StaffRequest, payload: ApproveIn) -> StaffRequest:
    _require_status(request, StaffRequestStatus.PENDING, "Esta solicitud ya se resolvió; recargá la bandeja")
    note = _clean_text(payload.note)
    before = _snapshot(request)

    line_updates: list[tuple[StaffRequestLine, int]] = []
    approved_rows: list[dict[str, int]] | None = None
    approved_total: int | None = None

    if request.kind == StaffRequestKind.SUPPLY.value:
        if payload.denominations is not None:
            raise AppError("VALIDATION_ERROR", "Un pedido de insumos no lleva denominaciones")
        lines = _lines_of(db, [request.id])[request.id]
        by_id = {line.id: line for line in lines}
        adjusted: dict[int, int] = {}
        for adj in payload.lines or []:
            line = by_id.get(adj.line_id)
            if line is None:
                raise NotFoundError("Ese insumo no es parte de esta solicitud; recargá la bandeja")
            qty = parse_qty_base(adj.qty, field=line.ingredient_name)
            if qty < 0:
                raise AppError("VALIDATION_ERROR", f"{line.ingredient_name}: la cantidad no puede ser negativa")
            adjusted[line.id] = qty
        line_updates = [(line, adjusted.get(line.id, line.qty_requested)) for line in lines]
        if not any(qty > 0 for _, qty in line_updates):
            raise AppError(
                "NOTHING_APPROVED",
                "Aprobaste todo en cero; si no se va a comprar nada, rechazá la solicitud con el motivo",
            )
    else:
        if payload.lines:
            raise AppError("VALIDATION_ERROR", "Un pedido de sencilla no lleva insumos")
        if payload.denominations is not None:
            approved_rows, approved_total = _normalize_denominations(payload.denominations)
        else:
            approved_rows = list(request.requested_denominations or [])
            approved_total = request.requested_total

    now = clock.now_utc()
    for line, qty in line_updates:
        line.qty_approved = qty
    if approved_rows is not None:
        request.approved_denominations = approved_rows
        request.approved_total = approved_total
    request.status = StaffRequestStatus.APPROVED
    request.resolved_by_employee_id = actor.employee_id
    request.resolved_by_employee_name = actor.employee_name
    request.resolved_at = now
    request.resolution_note = note
    db.flush()
    record_audit(
        db,
        actor=actor,
        organization_id=request.organization_id,
        store_id=request.store_id,
        entity="staff_request",
        entity_id=request.id,
        action="approve",
        before=before,
        after={
            **_snapshot(request),
            "lines": {line.id: qty for line, qty in line_updates} or None,
        },
    )
    return request


def reject(db: Session, *, actor: Actor, request: StaffRequest, payload: RejectIn) -> StaffRequest:
    _require_status(request, StaffRequestStatus.PENDING, "Esta solicitud ya se resolvió; recargá la bandeja")
    reason = _clean_text(payload.reason)
    if reason is None:
        raise AppError("REASON_REQUIRED", "Escribí el motivo del rechazo: quien pidió lo va a ver en el POS")
    before = _snapshot(request)
    request.status = StaffRequestStatus.REJECTED
    request.resolved_by_employee_id = actor.employee_id
    request.resolved_by_employee_name = actor.employee_name
    request.resolved_at = clock.now_utc()
    request.resolution_note = reason
    db.flush()
    record_audit(
        db,
        actor=actor,
        organization_id=request.organization_id,
        store_id=request.store_id,
        entity="staff_request",
        entity_id=request.id,
        action="reject",
        before=before,
        after=_snapshot(request),
        reason=reason,
    )
    return request


def mark_bought(db: Session, *, actor: Actor | None, request: StaffRequest, note: str | None) -> StaffRequest:
    if request.kind != StaffRequestKind.SUPPLY.value:
        raise AppError("VALIDATION_ERROR", "Sólo un pedido de insumos se marca comprado")
    _require_status(
        request, StaffRequestStatus.APPROVED, "Sólo un pedido aprobado y por comprar se puede marcar comprado"
    )
    clean_note = _clean_text(note)
    before = _snapshot(request)
    request.status = StaffRequestStatus.BOUGHT
    request.closed_by_employee_id = actor.employee_id if actor else None
    request.closed_by_employee_name = actor.employee_name if actor else None
    request.closed_at = clock.now_utc()
    db.flush()
    record_audit(
        db,
        actor=actor,
        organization_id=request.organization_id,
        store_id=request.store_id,
        entity="staff_request",
        entity_id=request.id,
        action="mark_bought",
        before=before,
        after=_snapshot(request),
        reason=clean_note,
    )
    return request


# ---------------------------------------------------------------------------
# Operador: la sencilla llegó
# ---------------------------------------------------------------------------


def _cash_swap_store_id(db: Session, cash_swap_id: int) -> int | None:
    """La sede de un Cambio, o `None` si no existe (por `app.shifts.hooks`)."""
    return shifts_hooks.cash_swap_store_id(db, cash_swap_id)


def mark_received(
    db: Session, *, actor: Actor, store: Store, request_id: int, payload: ReceivedIn
) -> StaffRequest:
    request = db.get(StaffRequest, request_id)
    if request is None or request.store_id != store.id:
        raise NotFoundError("La solicitud no existe")
    if request.kind != StaffRequestKind.CHANGE.value:
        raise AppError("VALIDATION_ERROR", "Sólo un pedido de sencilla se marca recibido")
    _require_status(
        request,
        StaffRequestStatus.APPROVED,
        "Esta sencilla no está aprobada y por entregar; recargá tus solicitudes",
    )
    if payload.cash_swap_id is not None:
        if _cash_swap_store_id(db, payload.cash_swap_id) != store.id:
            raise NotFoundError("Ese Cambio no existe en esta sede")
        taken = db.execute(
            select(StaffRequest.id).where(
                StaffRequest.cash_swap_id == payload.cash_swap_id, StaffRequest.id != request.id
            )
        ).first()
        if taken is not None:
            raise ConflictError(
                "Ese Cambio ya está atado a otra sencilla; registrá un Cambio nuevo para ésta",
                code="CASH_SWAP_ALREADY_LINKED",
            )

    before = _snapshot(request)
    request.status = StaffRequestStatus.RECEIVED
    request.cash_swap_id = payload.cash_swap_id
    request.closed_by_employee_id = actor.employee_id
    request.closed_by_employee_name = actor.employee_name
    request.closed_at = clock.now_utc()
    db.flush()
    record_audit(
        db,
        actor=actor,
        organization_id=request.organization_id,
        store_id=request.store_id,
        entity="staff_request",
        entity_id=request.id,
        action="received",
        before=before,
        after=_snapshot(request),
    )
    return request
