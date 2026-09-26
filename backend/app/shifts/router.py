"""Endpoints del turno de caja (`/api/v1/shifts/...` y `/api/v1/admin/shifts/...`).

El prefijo `/api/v1` lo agrega `app.main.create_app` al descubrir este router
(`app.shifts.router`); acá las rutas se escriben sin ese prefijo, tal como las
define `features/fase-1a-cimientos/spec.md` (contrato de API vinculante).
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import date, datetime
from typing import Any, cast

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.audit.service import record_audit
from app.banking import hooks as banking_hooks
from app.auth.deps import Actor, admin_store, current_actor, current_admin, current_device, current_operator
from app.auth.models import Employee
from app.core import clock, features
from app.core.csv import csv_response, wants_csv
from app.core.db import get_db
from app.core.errors import AppError
from app.core.idempotency import hash_request_body, idempotency_key, run_idempotent
from app.shifts import hooks as shifts_hooks, service, tips as tips_service
from app.shifts.models import BusinessDay, CashMovement, CashPickup, CashSwap, HandoverKind, Shift, ShiftHandover, ShiftStatus
from app.shifts.schemas import (
    ShiftCashSummaryOut,
    AdminAdjustOpeningIn,
    AdminCloseAdministrativeIn,
    AdminReopenIn,
    AdminReviewIn,
    AdminShiftListItem,
    BusinessDayListItem,
    CashMovementIn,
    CashMovementOut,
    CashPickupIn,
    CashPickupOut,
    CashPickupReverseIn,
    CashSwapIn,
    CashSwapOut,
    CloseConfirmIn,
    CloseConfirmOut,
    CloseCountIn,
    CloseCountOut,
    ClosePrecheckOut,
    CloseReviewOut,
    EmployeeActivityOut,
    EmployeeRef,
    HandoverIn,
    HandoverKindLiteral,
    HandoverOut,
    OpenShiftIn,
    OpenShiftOut,
    RosterActionIn,
    RosterActionOut,
    RosterEntryOut,
    SalesByMethodOut,
    ShiftCurrentOut,
    ShiftSummaryOut,
    ShiftTipsOut,
    SingleStepCloseIn,
    SingleStepCloseOut,
    TimelineEventOut,
    TipPayoutIn,
    TipPayoutOut,
)
from app.stores.models import Store

router = APIRouter()


# ---------------------------------------------------------------------------
# Idempotencia: helper compartido por los endpoints que la exigen
# ---------------------------------------------------------------------------


def _idempotent(
    db: Session,
    *,
    organization_id: int,
    scope: str,
    request: Request,
    payload: BaseModel,
    fn: Callable[[], tuple[int, dict[str, Any]]],
) -> JSONResponse:
    key = idempotency_key(request)
    request_hash = hash_request_body(payload.model_dump(mode="json"))
    status_code, body = run_idempotent(
        db, organization_id=organization_id, scope=scope, key=key, request_hash=request_hash, fn=fn
    )
    return JSONResponse(status_code=status_code, content=body)


def _store_of(db: Session, actor: Actor) -> Store:
    store = db.get(Store, actor.store_id)
    if store is None:
        raise AppError("DEVICE_NOT_ACTIVATED", "Activá el dispositivo con el PIN de sede", status=401)
    return store


def _admin_get_shift(db: Session, actor: Actor, shift_id: int) -> Shift:
    shift = db.get(Shift, shift_id)
    if shift is None:
        raise AppError("NOT_FOUND", "El turno no existe", status=404)
    admin_store(db, actor, shift.store_id)  # 404 si la sede no es de la organización del admin
    return shift


def _optional_employee_ref(employee_id: int | None, employee_name: str | None) -> EmployeeRef | None:
    if employee_id is None:
        return None
    return EmployeeRef(id=employee_id, name=employee_name or "")


def _kind_str(kind: HandoverKind | str) -> HandoverKindLiteral:
    """Normaliza `ShiftHandover.kind`: puede llegar como el enum de SQLAlchemy
    (instancia recién creada, todavía en la sesión) o como el `str` plano que
    devuelve una fila releída después de que la sesión expira sus objetos —
    `.value` a ciegas revienta en el segundo caso (B-2, iteración 2)."""

    value = kind.value if isinstance(kind, HandoverKind) else kind
    return cast(HandoverKindLiteral, value)


def _can_see_expected(db: Session, actor: Actor, shift: Shift) -> bool:
    """Único lugar que decide quién ve el esperado y todo lo derivado de él
    (`expected_cash`, `pickups[].expected_at_pickup`, `handovers[].breakdown`,
    y desde 1b-1 también `sales`/`tips`): el admin (por tipo de actor o por
    rol) siempre; el responsable de caja del turno SOLO si `cash.blind_close`
    está apagada en su sede (O-1, CONTRATO-INTERNO-1b-1.md §2.4 «Caja»); el
    operador que no es responsable, nunca. Con la flag encendida el
    responsable ve el esperado recién en el paso 2 del cierre
    (`GET /shifts/{id}/close/{count_id}/review`, que no pasa por esta
    función: llama directo a `service.review_close`)."""

    if actor.kind == "admin" or actor.role == "admin":
        return True
    if actor.employee_id is None or actor.employee_id != shift.cash_responsible_id:
        return False
    return not features.is_enabled(db, shift.organization_id, shift.store_id, "cash.blind_close")


def _sales_and_tips(db: Session, shift: Shift) -> tuple[SalesByMethodOut, SalesByMethodOut]:
    totals = service.hooks.get_sales_totals(db, shift.id)
    sales = SalesByMethodOut(cash=totals.cash, card=totals.card, transfer=totals.transfer, other=totals.other)
    tips = SalesByMethodOut(
        cash=totals.tips_cash, card=totals.tips_card, transfer=totals.tips_transfer, other=totals.tips_other
    )
    return sales, tips


def _shift_summary(db: Session, shift: Shift, actor: Actor) -> ShiftSummaryOut:
    show_expected = _can_see_expected(db, actor, shift)
    day = db.get(BusinessDay, shift.business_day_id)
    assert day is not None
    roster = service.list_roster(db, shift.id)
    movements = list(db.execute(select(CashMovement).where(CashMovement.shift_id == shift.id).order_by(CashMovement.at)).scalars())
    swaps = list(db.execute(select(CashSwap).where(CashSwap.shift_id == shift.id).order_by(CashSwap.at)).scalars())
    pickups = list(db.execute(select(CashPickup).where(CashPickup.shift_id == shift.id).order_by(CashPickup.at)).scalars())
    handovers_rows = list(
        db.execute(select(ShiftHandover).where(ShiftHandover.shift_id == shift.id).order_by(ShiftHandover.at)).scalars()
    )

    expected_cash: int | None = None
    sales: SalesByMethodOut | None = None
    tips: SalesByMethodOut | None = None
    # Pedido 2c: el efectivo de domicilios sin liquidar se publica en su
    # propio renglón, gateado por el MISMO predicado que el esperado
    # (`_can_see_expected`): es una cifra de plata derivada, y el cierre a
    # ciegas no se puede sortear leyéndola. `None` cuando no se puede ver
    # —nunca `0`, que sería "no hay"—. La lista operativa por domiciliario,
    # que el operador sí necesita para recibir la plata, vive en
    # `GET /delivery-settlements/pending` (`app.channels.router`).
    delivery_cash_pending: int | None = None
    if show_expected:
        breakdown = service.compute_breakdown(db, shift)
        expected_cash = shift.expected_cash if shift.status != ShiftStatus.OPEN else breakdown["expected"]
        delivery_cash_pending = breakdown["delivery_cash_pending"]
        sales, tips = _sales_and_tips(db, shift)

    return ShiftSummaryOut(
        id=shift.id,
        business_date=day.business_date,
        status=shift.status,
        opened_at=shift.opened_at,
        opened_by=EmployeeRef(id=shift.opened_by_employee_id, name=shift.opened_by_employee_name),
        cash_responsible=EmployeeRef(id=shift.cash_responsible_id, name=shift.cash_responsible_name),
        opening_cash_total=shift.opening_cash_total,
        cash_reserve=shift.cash_reserve,
        roster=[RosterEntryOut.model_validate(r) for r in roster],
        movements=[CashMovementOut.model_validate(m) for m in movements],
        swaps=[CashSwapOut(id=s.id, amount=s.amount, at=s.at) for s in swaps],
        pickups=[
            CashPickupOut.model_validate(p).model_copy(update={"expected_at_pickup": None})
            if not show_expected
            else CashPickupOut.model_validate(p)
            for p in pickups
        ],
        handovers=[
            HandoverOut(
                id=h.id,
                kind=_kind_str(h.kind),
                from_responsible=EmployeeRef(id=h.from_responsible_id, name=h.from_responsible_name),
                new_responsible=_optional_employee_ref(h.new_responsible_id, h.new_responsible_name),
                counted_cash=h.counted_cash,
                counted_card=h.counted_card,
                counted_transfer=h.counted_transfer,
                breakdown=h.breakdown if show_expected else None,
                at=h.at,
            )
            for h in handovers_rows
        ],
        expected_cash=expected_cash,
        sales=sales,
        tips=tips,
        delivery_cash_pending=delivery_cash_pending,
        counted_cash=shift.counted_cash,
        difference=shift.difference,
        close_cause=shift.close_cause.value if shift.close_cause else None,
        to_deposit=shift.to_deposit,
        closed_at=shift.closed_at,
        closed_without_count=shift.closed_without_count,
        reviewed_by=EmployeeRef(id=shift.reviewed_by_employee_id, name=shift.reviewed_by_employee_name or "")
        if shift.reviewed_by_employee_id
        else None,
        reviewed_at=shift.reviewed_at,
    )


def _admin_shift_item(db: Session, shift: Shift) -> AdminShiftListItem:
    day = db.get(BusinessDay, shift.business_day_id)
    assert day is not None
    store = db.get(Store, shift.store_id)
    assert store is not None
    stale = service.is_shift_stale(db, shift, store) if shift.status == ShiftStatus.OPEN else False
    # Esta lista es sólo de administrador (`current_admin`), igual que
    # `_shift_summary` con actor admin: con el turno abierto publica el
    # esperado vivo (`compute_breakdown`, la única fórmula) y no el `None`
    # de la columna, que se llena al cerrar. Antes Dinero › Operacional decía
    # «—» para el mismo turno que Hoy mostraba con su esperado.
    expected = (
        service.compute_breakdown(db, shift)["expected"] if shift.status == ShiftStatus.OPEN else shift.expected_cash
    )
    responsible = db.get(Employee, shift.cash_responsible_id)
    return AdminShiftListItem(
        id=shift.id,
        business_date=day.business_date,
        store_id=shift.store_id,
        status=shift.status,
        opened_at=shift.opened_at,
        closed_at=shift.closed_at,
        cash_responsible=EmployeeRef(id=shift.cash_responsible_id, name=shift.cash_responsible_name),
        cash_responsible_active=bool(responsible.active) if responsible is not None else None,
        expected_cash=expected,
        counted_cash=shift.counted_cash,
        difference=shift.difference,
        is_stale=stale,
        reviewed_at=shift.reviewed_at,
        recounted_after_review=bool(service.recounted_count_ids(db, shift.id)),
    )


# ---------------------------------------------------------------------------
# Turno actual y apertura
# ---------------------------------------------------------------------------


@router.get("/shifts/current")
def get_current(actor: Actor = Depends(current_device), db: Session = Depends(get_db)) -> ShiftCurrentOut | None:
    store = _store_of(db, actor)
    shift = service.get_current_shift(db, store=store)
    if shift is None:
        return None

    is_stale = service.notify_if_stale(db, shift, store)
    over = service.notify_if_cash_over_threshold(db, shift, store)

    day = db.get(BusinessDay, shift.business_day_id)
    assert day is not None
    roster = service.list_roster(db, shift.id)

    show_expected = _can_see_expected(db, actor, shift)
    expected: int | None = None
    sales: SalesByMethodOut | None = None
    tips: SalesByMethodOut | None = None
    delivery_cash_pending: int | None = None
    if show_expected:
        breakdown = service.compute_breakdown(db, shift)
        expected = breakdown["expected"]
        delivery_cash_pending = breakdown["delivery_cash_pending"]
        sales, tips = _sales_and_tips(db, shift)

    return ShiftCurrentOut(
        id=shift.id,
        business_date=day.business_date,
        opened_at=shift.opened_at,
        cash_responsible=EmployeeRef(id=shift.cash_responsible_id, name=shift.cash_responsible_name),
        roster=[RosterEntryOut.model_validate(r) for r in roster],
        expected_cash=expected,
        sales=sales,
        tips=tips,
        delivery_cash_pending=delivery_cash_pending,
        is_stale=is_stale,
        cash_over_threshold=over,
    )


class CarryCandidateOut(BaseModel):
    shift_id: int
    business_date: date
    outstanding: int


@router.get("/shifts/carry-candidates")
def get_carry_candidates(actor: Actor = Depends(current_device), db: Session = Depends(get_db)) -> list[CarryCandidateOut]:
    """Los días con plata por consignar, para que quien abre marque cuáles
    están físicamente en el cajón (`OpenShiftIn.carried_shift_ids`). Con
    «Consignaciones» apagada no hay saldo publicado: lista vacía, y la
    apertura sigue siendo sólo la base."""
    store = _store_of(db, actor)
    if not features.is_enabled(db, store.organization_id, store.id, "money.deposits"):
        return []
    return [
        CarryCandidateOut(shift_id=p.shift_id, business_date=p.business_date, outstanding=p.outstanding)
        for p in banking_hooks.pending_shifts(db, organization_id=store.organization_id, store_id=store.id)
    ]


@router.post("/shifts/open", status_code=201)
def post_open_shift(
    payload: OpenShiftIn, request: Request, actor: Actor = Depends(current_operator), db: Session = Depends(get_db)
) -> JSONResponse:
    store = _store_of(db, actor)
    # Abrir es contar la base: sólo quien puede tocar la caja (sin turno
    # todavía, eso es `can_charge`, supervisor o admin).
    shifts_hooks.require_cash_permission(db, actor=actor, shift=None)

    def _do() -> tuple[int, dict[str, Any]]:
        shift = service.open_shift(db, actor=actor, store=store, payload=payload)
        day = db.get(BusinessDay, shift.business_day_id)
        assert day is not None
        out = OpenShiftOut(
            id=shift.id,
            business_day_id=shift.business_day_id,
            business_date=day.business_date,
            status=shift.status,
            opened_at=shift.opened_at,
            cash_responsible=EmployeeRef(id=shift.cash_responsible_id, name=shift.cash_responsible_name),
            opening_cash_total=shift.opening_cash_total,
            cash_reserve=shift.cash_reserve,
        )
        return 201, out.model_dump(mode="json")

    return _idempotent(db, organization_id=actor.organization_id, scope="shifts.open", request=request, payload=payload, fn=_do)


@router.get("/shifts/{shift_id}")
def get_shift_summary(shift_id: int, actor: Actor = Depends(current_actor), db: Session = Depends(get_db)) -> ShiftSummaryOut:
    shift = db.get(Shift, shift_id)
    if shift is None or shift.organization_id != actor.organization_id:
        raise AppError("NOT_FOUND", "El turno no existe en esta organización", status=404)
    if actor.kind == "device" and actor.store_id != shift.store_id:
        raise AppError("NOT_FOUND", "El turno no existe en esta sede", status=404)
    return _shift_summary(db, shift, actor)


# ---------------------------------------------------------------------------
# Propinas del turno (1b-2)
# ---------------------------------------------------------------------------


@router.get("/shifts/{shift_id}/tips")
def get_shift_tips(shift_id: int, actor: Actor = Depends(current_actor), db: Session = Depends(get_db)) -> ShiftTipsOut:
    """A diferencia de `expected_cash` (oculto al responsable con
    `cash.blind_close`, O-1), la propina no arma el cuadre de caja: no hay
    razón de integridad para esconderla, así que esta ruta no aplica
    `_can_see_expected` (decisión declarada en el entregable)."""

    shift = db.get(Shift, shift_id)
    if shift is None or shift.organization_id != actor.organization_id:
        raise AppError("NOT_FOUND", "El turno no existe en esta organización", status=404)
    if actor.kind == "device" and actor.store_id != shift.store_id:
        raise AppError("NOT_FOUND", "El turno no existe en esta sede", status=404)
    return tips_service.get_shift_tips(db, shift=shift)


# ---------------------------------------------------------------------------
# Roster
# ---------------------------------------------------------------------------


def _roster_action_at(entry: Any, action: str) -> datetime:
    if action == "in":
        return entry.in_at  # type: ignore[no-any-return]
    if action == "out":
        return entry.out_at  # type: ignore[no-any-return]
    pauses = entry.pauses or []
    last = pauses[-1] if pauses else {}
    key = "start" if action == "pause_start" else "end"
    value = last.get(key)
    return datetime.fromisoformat(value) if value else clock.now_utc()


@router.post("/shifts/{shift_id}/roster")
def post_roster(
    shift_id: int, payload: RosterActionIn, actor: Actor = Depends(current_device), db: Session = Depends(get_db)
) -> RosterActionOut:
    store = _store_of(db, actor)
    shift = service.get_shift_or_404(db, store_id=store.id, shift_id=shift_id)
    entry = service.roster_action(db, actor=actor, shift=shift, payload=payload)
    return RosterActionOut(employee_id=entry.employee_id, action=payload.action, at=_roster_action_at(entry, payload.action))


# ---------------------------------------------------------------------------
# Relevos y arqueo sorpresa
# ---------------------------------------------------------------------------


class HandoverCandidateOut(BaseModel):
    id: int
    name: str
    on_shift: bool


@router.get("/shifts/{shift_id}/handover-candidates")
def get_handover_candidates(
    shift_id: int, actor: Actor = Depends(current_device), db: Session = Depends(get_db)
) -> list[HandoverCandidateOut]:
    """A quién se le puede entregar el cajón (`service.handover_candidates`):
    sólo nombre e id —nunca `can_charge` ni otro dato del empleado—, y si
    está en el turno. La pantalla del relevo ofrece primero a los del turno."""
    store = _store_of(db, actor)
    shift = service.get_shift_or_404(db, store_id=store.id, shift_id=shift_id)
    return [
        HandoverCandidateOut(id=e.id, name=e.name, on_shift=on_shift)
        for e, on_shift in service.handover_candidates(db, shift=shift)
    ]


@router.post("/shifts/{shift_id}/handovers", status_code=201)
def post_handover(
    shift_id: int,
    payload: HandoverIn,
    request: Request,
    actor: Actor = Depends(current_operator),
    db: Session = Depends(get_db),
    _feature: None = Depends(features.require_feature("cash.handovers")),
) -> JSONResponse:
    store = _store_of(db, actor)
    shift = service.get_shift_or_404(db, store_id=store.id, shift_id=shift_id)
    shifts_hooks.require_cash_permission(db, actor=actor, shift=shift)

    def _do() -> tuple[int, dict[str, Any]]:
        handover = service.create_handover(db, actor=actor, shift=shift, store=store, payload=payload)
        out = HandoverOut(
            id=handover.id,
            kind=_kind_str(handover.kind),
            from_responsible=EmployeeRef(id=handover.from_responsible_id, name=handover.from_responsible_name),
            new_responsible=_optional_employee_ref(handover.new_responsible_id, handover.new_responsible_name),
            counted_cash=handover.counted_cash,
            counted_card=handover.counted_card,
            counted_transfer=handover.counted_transfer,
            breakdown=handover.breakdown,
            at=handover.at,
        )
        return 201, out.model_dump(mode="json")

    return _idempotent(
        db, organization_id=actor.organization_id, scope="shifts.handovers", request=request, payload=payload, fn=_do
    )


# ---------------------------------------------------------------------------
# Movimientos de caja
# ---------------------------------------------------------------------------


@router.post("/shifts/{shift_id}/cash-movements", status_code=201)
def post_cash_movement(
    shift_id: int,
    payload: CashMovementIn,
    request: Request,
    actor: Actor = Depends(current_operator),
    db: Session = Depends(get_db),
) -> JSONResponse:
    store = _store_of(db, actor)
    shift = service.get_shift_or_404(db, store_id=store.id, shift_id=shift_id)
    shifts_hooks.require_cash_permission(db, actor=actor, shift=shift)

    def _do() -> tuple[int, dict[str, Any]]:
        movement = service.create_cash_movement(db, actor=actor, shift=shift, store=store, payload=payload)
        out = CashMovementOut.model_validate(movement)
        return 201, out.model_dump(mode="json")

    return _idempotent(
        db, organization_id=actor.organization_id, scope="shifts.cash_movements", request=request, payload=payload, fn=_do
    )


# ---------------------------------------------------------------------------
# Cambio (sencilla)
# ---------------------------------------------------------------------------


@router.post("/shifts/{shift_id}/cash-swaps", status_code=201)
def post_cash_swap(
    shift_id: int,
    payload: CashSwapIn,
    actor: Actor = Depends(current_operator),
    db: Session = Depends(get_db),
    _feature: None = Depends(features.require_feature("cash.swaps")),
) -> CashSwapOut:
    store = _store_of(db, actor)
    shift = service.get_shift_or_404(db, store_id=store.id, shift_id=shift_id)
    shifts_hooks.require_cash_permission(db, actor=actor, shift=shift)
    swap = service.create_cash_swap(db, actor=actor, shift=shift, payload=payload)
    return CashSwapOut(id=swap.id, amount=swap.amount, at=swap.at)


# ---------------------------------------------------------------------------
# Retiros
# ---------------------------------------------------------------------------


@router.post("/shifts/{shift_id}/pickups", status_code=201)
def post_pickup(
    shift_id: int,
    payload: CashPickupIn,
    request: Request,
    actor: Actor = Depends(current_operator),
    db: Session = Depends(get_db),
    _feature: None = Depends(features.require_feature("cash.pickups")),
) -> JSONResponse:
    store = _store_of(db, actor)
    shift = service.get_shift_or_404(db, store_id=store.id, shift_id=shift_id)
    shifts_hooks.require_cash_permission(db, actor=actor, shift=shift)

    def _do() -> tuple[int, dict[str, Any]]:
        pickup = service.create_pickup(db, actor=actor, shift=shift, store=store, payload=payload)
        out = CashPickupOut.model_validate(pickup)
        return 201, out.model_dump(mode="json")

    return _idempotent(
        db, organization_id=actor.organization_id, scope="shifts.pickups", request=request, payload=payload, fn=_do
    )


@router.post("/shifts/{shift_id}/pickups/{pickup_id}/reverse")
def post_pickup_reverse(
    shift_id: int,
    pickup_id: int,
    payload: CashPickupReverseIn,
    actor: Actor = Depends(current_operator),
    db: Session = Depends(get_db),
    _feature: None = Depends(features.require_feature("cash.pickups")),
) -> CashPickupOut:
    store = _store_of(db, actor)
    shift = service.get_shift_or_404(db, store_id=store.id, shift_id=shift_id)
    shifts_hooks.require_cash_permission(db, actor=actor, shift=shift)
    pickup = service.get_pickup_or_404(db, shift=shift, pickup_id=pickup_id)
    pickup = service.reverse_pickup(
        db, actor=actor, shift=shift, pickup=pickup, reason=payload.reason, authorizer_pin=payload.authorizer_pin
    )
    return CashPickupOut.model_validate(pickup)


# ---------------------------------------------------------------------------
# Cierre a ciegas en tres pasos (cash.blind_close encendido)
# ---------------------------------------------------------------------------


@router.get("/shifts/{shift_id}/close/precheck")
def get_close_precheck(
    shift_id: int,
    actor: Actor = Depends(current_operator),
    db: Session = Depends(get_db),
) -> ClosePrecheckOut:
    """«Paso 0» del cierre: comandas abiertas, domicilios sin liquidar y lo
    que el cierre va a pedir (datáfono, transferencias, foto), más el conteo
    sellado si ya hay uno. Sin ningún monto: el cierre sigue a ciegas."""
    store = _store_of(db, actor)
    shift = service.get_shift_or_404(db, store_id=store.id, shift_id=shift_id)
    shifts_hooks.require_cash_permission(db, actor=actor, shift=shift)
    return ClosePrecheckOut(**service.close_precheck(db, shift=shift, store=store))


@router.post("/shifts/{shift_id}/close/count", status_code=201)
def post_close_count(
    shift_id: int,
    payload: CloseCountIn,
    request: Request,
    actor: Actor = Depends(current_operator),
    db: Session = Depends(get_db),
    _feature: None = Depends(features.require_feature("cash.blind_close")),
) -> JSONResponse:
    store = _store_of(db, actor)
    shift = service.get_shift_or_404(db, store_id=store.id, shift_id=shift_id)
    shifts_hooks.require_cash_permission(db, actor=actor, shift=shift)

    def _do() -> tuple[int, dict[str, Any]]:
        count = service.create_close_count(db, actor=actor, shift=shift, store=store, payload=payload)
        return 201, CloseCountOut(count_id=count.id).model_dump(mode="json")

    return _idempotent(
        db, organization_id=actor.organization_id, scope="shifts.close_count", request=request, payload=payload, fn=_do
    )


@router.get("/shifts/{shift_id}/close/{count_id}/review")
def get_close_review(
    shift_id: int,
    count_id: int,
    actor: Actor = Depends(current_operator),
    db: Session = Depends(get_db),
    _feature: None = Depends(features.require_feature("cash.blind_close")),
) -> CloseReviewOut:
    store = _store_of(db, actor)
    shift = service.get_shift_or_404(db, store_id=store.id, shift_id=shift_id)
    shifts_hooks.require_cash_permission(db, actor=actor, shift=shift)
    count = service.get_close_count_or_404(db, shift=shift, count_id=count_id)
    review = CloseReviewOut(**service.review_close(db, shift=shift, store=store, count=count))
    # Abrir el paso 2 es ver el esperado: se anota (una vez) para marcar un
    # recuento posterior como «recontado después de ver el esperado».
    if not count.superseded and shift.status == ShiftStatus.OPEN:
        service.mark_review_opened(db, actor=actor, shift=shift, count=count)
    return review


@router.post("/shifts/{shift_id}/close/{count_id}/confirm")
def post_close_confirm(
    shift_id: int,
    count_id: int,
    payload: CloseConfirmIn,
    actor: Actor = Depends(current_operator),
    db: Session = Depends(get_db),
    _feature: None = Depends(features.require_feature("cash.blind_close")),
) -> CloseConfirmOut:
    store = _store_of(db, actor)
    shift = service.get_shift_or_404(db, store_id=store.id, shift_id=shift_id)
    shifts_hooks.require_cash_permission(db, actor=actor, shift=shift)
    count = service.get_close_count_or_404(db, shift=shift, count_id=count_id)
    result = service.confirm_close(
        db,
        actor=actor,
        shift=shift,
        store=store,
        count=count,
        difference_seen=payload.difference_seen,
        cause=payload.cause,
        note=payload.note,
        closes_day=payload.closes_day,
        transfer_open_orders=payload.transfer_open_orders,
    )
    return CloseConfirmOut(**result)


# ---------------------------------------------------------------------------
# Cierre en un solo paso (cash.blind_close apagado)
# ---------------------------------------------------------------------------


@router.post("/shifts/{shift_id}/close")
def post_close_single(
    shift_id: int,
    payload: SingleStepCloseIn,
    request: Request,
    actor: Actor = Depends(current_operator),
    db: Session = Depends(get_db),
) -> JSONResponse:
    store = _store_of(db, actor)
    shift = service.get_shift_or_404(db, store_id=store.id, shift_id=shift_id)
    shifts_hooks.require_cash_permission(db, actor=actor, shift=shift)

    # `cash.blind_close` es mutuamente excluyente por flag, no dos rutas que
    # conviven (veredicto del Conciliador, iteración 2): con la flag encendida
    # este endpoint de un solo paso queda cerrado y el cliente tiene que usar
    # count → review → confirm. Se resuelve ANTES de `_idempotent`/`_do` para
    # que el rechazo no quede grabado como respuesta idempotente resuelta.
    if features.is_enabled(db, actor.organization_id, actor.store_id, "cash.blind_close"):
        raise AppError(
            code="BLIND_CLOSE_REQUIRED",
            message="Esta sede cierra a ciegas en tres pasos; usá el conteo de cierre del turno",
            extra={"feature": "cash.blind_close"},
        )

    def _do() -> tuple[int, dict[str, Any]]:
        result = service.close_single_step(db, actor=actor, shift=shift, store=store, payload=payload)
        return 200, SingleStepCloseOut(**result).model_dump(mode="json")

    return _idempotent(db, organization_id=actor.organization_id, scope="shifts.close", request=request, payload=payload, fn=_do)


# ---------------------------------------------------------------------------
# Admin: listados, timeline, rescates y actividad
# ---------------------------------------------------------------------------


@router.get("/admin/shifts")
def admin_list_shifts(
    store_id: int,
    request: Request,
    date_from: date | None = Query(None, alias="from"),
    date_to: date | None = Query(None, alias="to"),
    include_open: bool = Query(
        False,
        description="Suma los turnos abiertos de cualquier fecha: un turno abandonado de un día anterior no se esconde por su fecha",
    ),
    format: str | None = Query(None, description='"csv" exporta el listado como CSV'),
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> Any:
    del format  # declarado sólo para el OpenAPI (deuda de 1b-2, pedido 2b la cierra); el valor real lo lee `wants_csv(request)`.
    store = admin_store(db, actor, store_id)
    shifts = service.list_admin_shifts(
        db, store_id=store.id, date_from=date_from, date_to=date_to, include_open=include_open
    )
    rows = [_admin_shift_item(db, s) for s in shifts]
    if wants_csv(request):
        return csv_response([r.model_dump(mode="json") for r in rows], filename="shifts.csv")
    return rows


@router.get("/admin/shifts/summary")
def admin_shifts_summary(
    store_id: int,
    date_from: date | None = Query(None, alias="from"),
    date_to: date | None = Query(None, alias="to"),
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> ShiftCashSummaryOut:
    """Resumen de caja del mismo rango que `GET /admin/shifts` (informe de
    visualización #10): diferencias con signo, faltantes/sobrantes y cortes
    por responsable y por día."""
    store = admin_store(db, actor, store_id)
    return ShiftCashSummaryOut(
        store_id=store.id,
        date_from=date_from,
        date_to=date_to,
        **service.cash_summary(db, store=store, date_from=date_from, date_to=date_to),
    )


@router.get("/admin/shifts/{shift_id}/timeline")
def admin_timeline(shift_id: int, actor: Actor = Depends(current_admin), db: Session = Depends(get_db)) -> list[TimelineEventOut]:
    shift = _admin_get_shift(db, actor, shift_id)
    return [TimelineEventOut(**e) for e in service.build_timeline(db, shift)]


@router.post("/admin/shifts/{shift_id}/review")
def admin_review(
    shift_id: int, payload: AdminReviewIn, actor: Actor = Depends(current_admin), db: Session = Depends(get_db)
) -> ShiftSummaryOut:
    shift = _admin_get_shift(db, actor, shift_id)
    shift.reviewed_by_employee_id = actor.employee_id
    shift.reviewed_by_employee_name = actor.employee_name or "Administrador"
    shift.reviewed_at = clock.now_utc()
    db.flush()
    record_audit(
        db,
        actor=actor,
        organization_id=shift.organization_id,
        store_id=shift.store_id,
        entity="shift",
        entity_id=shift.id,
        action="review",
        before=None,
        after={"reviewed_at": shift.reviewed_at.isoformat()},
        reason=payload.note,
    )
    return _shift_summary(db, shift, actor)


@router.post("/admin/shifts/{shift_id}/close-administrative")
def admin_close_administrative(
    shift_id: int, payload: AdminCloseAdministrativeIn, actor: Actor = Depends(current_admin), db: Session = Depends(get_db)
) -> CloseConfirmOut:
    shift = _admin_get_shift(db, actor, shift_id)
    store = db.get(Store, shift.store_id)
    assert store is not None
    result = service.close_administrative(db, actor=actor, shift=shift, store=store, reason=payload.reason)
    return CloseConfirmOut(**result)


@router.post("/admin/shifts/{shift_id}/reopen")
def admin_reopen(
    shift_id: int, payload: AdminReopenIn, actor: Actor = Depends(current_admin), db: Session = Depends(get_db)
) -> ShiftSummaryOut:
    shift = _admin_get_shift(db, actor, shift_id)
    service.reopen_shift(db, actor=actor, shift=shift, reason=payload.reason)
    return _shift_summary(db, shift, actor)


@router.delete("/admin/shifts/{shift_id}")
def admin_delete_shift(shift_id: int, actor: Actor = Depends(current_admin), db: Session = Depends(get_db)) -> dict[str, Any]:
    shift = _admin_get_shift(db, actor, shift_id)
    service.cancel_shift(db, actor=actor, shift=shift, reason="Cancelado por administrador (turno abierto por error)")
    return {"id": shift.id, "status": shift.status}


@router.post("/admin/shifts/{shift_id}/adjust-opening")
def admin_adjust_opening(
    shift_id: int, payload: AdminAdjustOpeningIn, actor: Actor = Depends(current_admin), db: Session = Depends(get_db)
) -> ShiftSummaryOut:
    shift = _admin_get_shift(db, actor, shift_id)
    service.adjust_opening(
        db, actor=actor, shift=shift, opening_cash=payload.opening_cash, cash_reserve=payload.cash_reserve, reason=payload.reason
    )
    return _shift_summary(db, shift, actor)


@router.get("/admin/business-days")
def admin_business_days(
    store_id: int,
    date_from: date | None = Query(None, alias="from"),
    date_to: date | None = Query(None, alias="to"),
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> list[BusinessDayListItem]:
    store = admin_store(db, actor, store_id)
    days = service.list_business_days(db, store_id=store.id, date_from=date_from, date_to=date_to)
    day_ids = [d.id for d in days]
    shifts_by_day: dict[int, list[Shift]] = {}
    if day_ids:
        for s in db.execute(select(Shift).where(Shift.business_day_id.in_(day_ids))).scalars():
            shifts_by_day.setdefault(s.business_day_id, []).append(s)
    return [
        BusinessDayListItem(
            business_date=d.business_date, status=d.status, shifts=[_admin_shift_item(db, s) for s in shifts_by_day.get(d.id, [])]
        )
        for d in days
    ]


@router.get("/admin/employees/{employee_id}/activity")
def admin_employee_activity(
    employee_id: int,
    request: Request,
    date_from: date | None = Query(None, alias="from"),
    date_to: date | None = Query(None, alias="to"),
    store_id: int | None = None,
    format: str | None = Query(None, description='"csv" exporta el resumen como CSV'),
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> Any:
    del format  # declarado sólo para el OpenAPI (deuda de 1b-2, pedido 2b la cierra); el valor real lo lee `wants_csv(request)`.
    if store_id is not None:
        admin_store(db, actor, store_id)
    data = service.employee_activity(
        db, organization_id=actor.organization_id, store_id=store_id, employee_id=employee_id, date_from=date_from, date_to=date_to
    )
    out = EmployeeActivityOut(**data)
    if wants_csv(request):
        # Un CSV de una sola fila: las listas anidadas (`shifts`,
        # `authorizations_given`) no entran en una tabla plana, así que se
        # exporta el resumen numérico (lo que "una sola tabla de saldos"
        # necesita para cuadrar, `docs/SPEC-NEGOCIO.md §9.3`).
        row: dict[str, Any] = {"employee_id": out.employee.id, "employee_name": out.employee.name, "difference_streak": out.difference_streak}
        if out.activity is not None:
            row.update(
                {
                    "sales_net": out.activity.sales.net,
                    "orders": out.activity.sales.orders,
                    "avg_ticket": out.activity.sales.avg_ticket,
                    "voids_n": out.activity.voids.n,
                    "voids_amount": out.activity.voids.amount,
                    "voids_pct_of_sales": out.activity.voids.pct_of_sales,
                    "voids_after_bill": out.activity.voids.after_bill,
                    "voids_on_cash": out.activity.voids.on_cash,
                    "walkouts": out.activity.voids.walkouts,
                    "discounts_n": out.activity.discounts.n,
                    "discounts_amount": out.activity.discounts.amount,
                    "courtesies_n": out.activity.courtesies.n,
                    "courtesies_amount": out.activity.courtesies.amount,
                    "reprints": out.activity.reprints,
                    "sent_at_payment_pct": out.activity.sent_at_payment_pct,
                    "tips_total": out.activity.tips.total,
                }
            )
        return csv_response([row], filename="employee_activity.csv")
    return out


# ---------------------------------------------------------------------------
# Reparto de propinas (1b-2)
# ---------------------------------------------------------------------------


@router.post("/admin/tips/payouts", status_code=201)
def admin_create_tip_payout(
    payload: TipPayoutIn,
    store_id: int,
    request: Request,
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> JSONResponse:
    store = admin_store(db, actor, store_id)

    def _do() -> tuple[int, dict[str, Any]]:
        payout = tips_service.register_tip_payout(
            db,
            actor=actor,
            organization_id=actor.organization_id,
            store_id=store.id,
            shift_ids=payload.shift_ids,
            distribution=payload.distribution,
            paid_at=payload.paid_at,
            method=payload.method,
            paid_from=payload.paid_from,
            now=clock.now_utc(),
        )
        out = tips_service.tip_payout_out(db, payout=payout)
        return 201, out.model_dump(mode="json")

    return _idempotent(
        db, organization_id=actor.organization_id, scope="tips.payouts", request=request, payload=payload, fn=_do
    )
