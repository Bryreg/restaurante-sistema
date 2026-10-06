"""Endpoints de `banking` (`/api/v1/admin/...`). Sólo borde HTTP: valida,
llama a `app.banking.service`, serializa — ninguna matemática vive acá
(`docs/CONTEXTO-AGENTES.md §3`).

Rutas del **contrato de API mínimo**
(`features/fase-3-dinero-control/spec.md § 2`, tabla T1 — vinculante, no se
renombran ni se cambian): `GET`/`POST /admin/deposits`,
`GET /admin/deposits/pending`, `GET /admin/bank/ledger`,
`GET /admin/bank/owner-hand`, `GET /admin/reconciliation/card`,
`GET /admin/reconciliation/platform`,
`POST /admin/reconciliation/card/{id}/settle`.

Rutas agregadas **más allá** del contrato (declaradas también en
`outputs/backend-banco.md § 3`): `POST /admin/deposits/{id}/reverse`;
`POST /admin/reconciliation/card` (registrar la liquidación cruda, paso
previo a conciliarla) y `.../card/settlements` (listado) y
`.../card/{id}/reverse`; los mismos cuatro para plataforma
(`.../platform`, `.../platform/settlements`, `.../platform/{id}/settle`,
`.../platform/{id}/reverse`). El contrato fija `GET .../card` y
`.../platform` (la conciliación en sí) y `POST .../card/{id}/settle`; sin un
`POST` que cree la liquidación no hay `{id}` que conciliar, así que hace
falta agregarlo — y, por simetría y para no dejar una liquidación de
plataforma mal cargada sin forma de corregirla, se agregan los mismos verbos
del lado de plataforma.

**`money.bank` depende de `money.deposits`** (`app/core/features.py`, que no
se toca). `require_feature` NO encadena `requires` por sí solo — sólo evalúa
la clave puntual que se le pasa —, así que las rutas bajo `/admin/bank/**` y
`/admin/reconciliation/**` usan `_require_bank()`, que valida
`money.deposits` ANTES que `money.bank`. Validar la dependencia antes que
cualquier otra cosa es la regla de `docs/CONTEXTO-AGENTES.md §6` («tu plan no
incluye esto» tiene que ganarle a cualquier otro motivo de rechazo) y el
error repetido nº6 de `§14`: una dependencia de función validada tarde
produce el mensaje equivocado. Como es un `dependencies=[Depends(...)]` de
la ruta, FastAPI la resuelve antes de que el cuerpo del endpoint llegue a
`admin_store` (el «gate de sede»), así que el orden queda garantizado por
construcción.
"""

from __future__ import annotations

from dataclasses import asdict
from datetime import date
from typing import Any

from fastapi import APIRouter, Depends, Query, Request, Response
from sqlalchemy.orm import Session

from app.core.csv import CsvFormat, csv_response
from app.auth.deps import Actor, admin_store, current_actor, current_admin, current_device, current_operator
from app.banking import book, service
from app.banking.models import (
    BankAccount,
    BankBalanceAnchor,
    BankDeposit,
    BankDepositStatus,
    BankMovement,
    CardSettlement,
    PlatformSettlement,
)
from app.banking.schemas import (
    BankAccountIn,
    BankAccountOut,
    BankAccountPatchIn,
    BankAccountPositionOut,
    BankAnchorIn,
    BankAnchorOut,
    BankAssignmentIn,
    BankAssignmentOut,
    BankMovementIn,
    BankMovementOut,
    BankPositionOut,
    BankProjectionMonthOut,
    BankProjectionOut,
    BankVoidIn,
    BankLedgerOut,
    BankLedgerTotalsOut,
    CardReconciliationOut,
    CardReconciliationRowOut,
    CardSettlementIn,
    CardSettlementOut,
    DepositAllocationOut,
    DepositIn,
    DepositOut,
    DepositReverseIn,
    DrawerDayOut,
    DrawerOut,
    LedgerEntryOut,
    OwnerHandOut,
    PendingDepositRowOut,
    PlatformReconciliationOut,
    PlatformReconciliationRowOut,
    PlatformSettlementIn,
    PlatformSettlementOut,
    PosDepositIn,
    SettleIn,
    SettlementReverseIn,
)
from app.core.db import get_db
from app.stores import service as stores_service
from app.core.features import require_feature
from app.core.idempotency import hash_request_body, idempotency_key, run_idempotent
from app.shifts import hooks as shifts_hooks

router = APIRouter()


def _require_bank() -> Any:
    deposits_dep = require_feature("money.deposits")
    bank_dep = require_feature("money.bank")

    def _dependency(request: Request, db: Session = Depends(get_db), actor: Actor = Depends(current_actor)) -> None:
        deposits_dep(request=request, db=db, actor=actor)
        bank_dep(request=request, db=db, actor=actor)

    return _dependency


def _idempotent(db: Session, *, organization_id: int, scope: str, request: Request, payload: Any, fn: Any) -> Any:
    key = idempotency_key(request)
    request_hash = hash_request_body(payload.model_dump(mode="json"))
    return run_idempotent(
        db, organization_id=organization_id, scope=scope, key=key, request_hash=request_hash, fn=fn
    )


# ---------------------------------------------------------------------------
# Presentación.
# ---------------------------------------------------------------------------


def _deposit_out(db: Session, deposit: BankDeposit) -> DepositOut:
    allocations = service.get_allocations(db, deposit_id=deposit.id)
    allocated_amount = sum(a.amount for a in allocations)
    return DepositOut(
        id=deposit.id,
        store_id=deposit.store_id,
        business_date=deposit.business_date,
        deposited_at=deposit.deposited_at,
        amount=deposit.amount,
        allocated_amount=allocated_amount,
        unallocated_amount=deposit.amount - allocated_amount,
        bank_name=deposit.bank_name,
        bank_reference=deposit.bank_reference,
        receipt_photo=deposit.receipt_photo,
        note=deposit.note,
        status=deposit.status.value,  # type: ignore[arg-type]
        employee_name=deposit.employee_name,
        allocations=[DepositAllocationOut(shift_id=a.shift_id, amount=a.amount) for a in allocations],
        reversed_at=deposit.reversed_at,
        reversed_reason=deposit.reversed_reason,
        reversed_by_employee_name=deposit.reversed_by_employee_name,
        source=deposit.source,  # type: ignore[arg-type]
        from_shift_id=deposit.from_shift_id,
        confirmed_at=deposit.confirmed_at,
        confirmed_by_employee_name=deposit.confirmed_by_employee_name,
        needs_confirmation=deposit.status == BankDepositStatus.LIVE and deposit.confirmed_at is None,
    )


def _card_settlement_out(s: CardSettlement) -> CardSettlementOut:
    return CardSettlementOut(
        id=s.id,
        store_id=s.store_id,
        sales_business_date=s.sales_business_date,
        settled_business_date=s.settled_business_date,
        lag_days=(s.settled_business_date - s.sales_business_date).days,
        gross_amount=s.gross_amount,
        commission_amount=s.commission_amount,
        retention_amount=s.retention_amount,
        net_amount=s.gross_amount - s.commission_amount - s.retention_amount,
        reference=s.reference,
        note=s.note,
        status=s.status.value,  # type: ignore[arg-type]
        employee_name=s.employee_name,
        created_at=s.created_at,
        matched_at=s.matched_at,
        matched_by_employee_name=s.matched_by_employee_name,
        reversed_at=s.reversed_at,
        reversed_reason=s.reversed_reason,
        reversed_by_employee_name=s.reversed_by_employee_name,
    )


def _platform_settlement_out(s: PlatformSettlement) -> PlatformSettlementOut:
    return PlatformSettlementOut(
        id=s.id,
        store_id=s.store_id,
        platform_id=s.platform_id,
        period_from=s.period_from,
        period_to=s.period_to,
        gross_amount=s.gross_amount,
        commission_amount=s.commission_amount,
        net_amount=s.gross_amount - s.commission_amount,
        reference=s.reference,
        note=s.note,
        status=s.status.value,  # type: ignore[arg-type]
        employee_name=s.employee_name,
        created_at=s.created_at,
        matched_at=s.matched_at,
        matched_by_employee_name=s.matched_by_employee_name,
        reversed_at=s.reversed_at,
        reversed_reason=s.reversed_reason,
        reversed_by_employee_name=s.reversed_by_employee_name,
    )


# ---------------------------------------------------------------------------
# Consignaciones.
# ---------------------------------------------------------------------------


@router.get("/admin/deposits", response_model=list[DepositOut], dependencies=[Depends(require_feature("money.deposits"))])
def list_deposits(
    store_id: int,
    date_from: date = Query(..., alias="from"),
    date_to: date = Query(..., alias="to"),
    format: CsvFormat = None,
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> list[DepositOut] | Response:
    store = admin_store(db, actor, store_id)
    rows = service.list_deposits(db, store=store, date_from=date_from, date_to=date_to)
    result = [_deposit_out(db, r) for r in rows]
    if format == "csv":
        return csv_response(result, "consignaciones.csv")
    return result


@router.post("/admin/deposits", status_code=201, dependencies=[Depends(require_feature("money.deposits"))])
def create_deposit(
    payload: DepositIn,
    store_id: int,
    request: Request,
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> DepositOut:
    store = admin_store(db, actor, store_id)

    def _do() -> tuple[int, dict[str, Any]]:
        deposit = service.create_deposit(db, actor=actor, store=store, payload=payload)
        return 201, _deposit_out(db, deposit).model_dump(mode="json")

    _status, body = _idempotent(
        db, organization_id=actor.organization_id, scope="banking.deposits", request=request, payload=payload, fn=_do
    )
    return DepositOut.model_validate(body)


@router.post("/admin/deposits/{deposit_id}/reverse", dependencies=[Depends(require_feature("money.deposits"))])
def reverse_deposit(
    deposit_id: int,
    payload: DepositReverseIn,
    request: Request,
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> DepositOut:
    deposit = service.get_deposit_or_404(db, organization_id=actor.organization_id, deposit_id=deposit_id)
    admin_store(db, actor, deposit.store_id)

    def _do() -> tuple[int, dict[str, Any]]:
        row = service.reverse_deposit(db, actor=actor, deposit=deposit, reason=payload.reason)
        return 200, _deposit_out(db, row).model_dump(mode="json")

    _status, body = _idempotent(
        db,
        organization_id=actor.organization_id,
        scope="banking.deposits.reverse",
        request=request,
        payload=payload,
        fn=_do,
    )
    return DepositOut.model_validate(body)


@router.post("/admin/deposits/{deposit_id}/unconfirm", dependencies=[Depends(require_feature("money.deposits"))])
def unconfirm_deposit(
    deposit_id: int,
    payload: DepositReverseIn,
    request: Request,
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> DepositOut:
    """Reversa la confirmación de una consignación, con motivo: vuelve a
    quedar por confirmar. No reversa la consignación (eso es `/reverse`)."""
    deposit = service.get_deposit_or_404(db, organization_id=actor.organization_id, deposit_id=deposit_id)
    admin_store(db, actor, deposit.store_id)

    def _do() -> tuple[int, dict[str, Any]]:
        row = service.unconfirm_deposit(db, actor=actor, deposit=deposit, reason=payload.reason)
        return 200, _deposit_out(db, row).model_dump(mode="json")

    _status, body = _idempotent(
        db,
        organization_id=actor.organization_id,
        scope="banking.deposits.unconfirm",
        request=request,
        payload=payload,
        fn=_do,
    )
    return DepositOut.model_validate(body)


@router.post("/admin/deposits/{deposit_id}/confirm", dependencies=[Depends(require_feature("money.deposits"))])
def confirm_deposit(
    deposit_id: int,
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> DepositOut:
    """El administrador confirma una consignación hecha desde el POS.
    Rechazarla es reversarla, con su motivo (`/reverse`)."""
    deposit = service.get_deposit_or_404(db, organization_id=actor.organization_id, deposit_id=deposit_id)
    admin_store(db, actor, deposit.store_id)
    row = service.confirm_deposit(db, actor=actor, deposit=deposit)
    return _deposit_out(db, row)


# ---------------------------------------------------------------------------
# Consignar desde el POS (2026-09-24): quien tiene la caja consigna la plata
# de días anteriores que está en el cajón; queda por confirmar.
# ---------------------------------------------------------------------------


@router.get("/deposits/drawer", dependencies=[Depends(require_feature("money.deposits"))])
def drawer(actor: Actor = Depends(current_device), db: Session = Depends(get_db)) -> DrawerOut:
    store = service.store_of_device(db, actor)
    open_shift, days = service.drawer_days(db, store=store)
    deposits = service.list_drawer_deposits(db, shift_id=open_shift.id) if open_shift is not None else []
    return DrawerOut(
        shift_id=open_shift.id if open_shift is not None else None,
        days=[DrawerDayOut(**asdict(d)) for d in days],
        deposits=[_deposit_out(db, d) for d in deposits],
        recent_banks=service.recent_bank_names(db, store=store),
    )


@router.post("/deposits", status_code=201, dependencies=[Depends(require_feature("money.deposits"))])
def create_pos_deposit(
    payload: PosDepositIn,
    request: Request,
    actor: Actor = Depends(current_operator),
    db: Session = Depends(get_db),
) -> DepositOut:
    store = service.store_of_device(db, actor)
    # Consignar saca plata del cajón: sólo quien puede tocar la caja.
    shifts_hooks.require_cash_permission_for_store(db, actor=actor, store_id=store.id)

    def _do() -> tuple[int, dict[str, Any]]:
        deposit = service.create_pos_deposit(db, actor=actor, store=store, payload=payload)
        return 201, _deposit_out(db, deposit).model_dump(mode="json")

    _status, body = _idempotent(
        db, organization_id=actor.organization_id, scope="banking.deposits.pos", request=request, payload=payload, fn=_do
    )
    return DepositOut.model_validate(body)


@router.get("/admin/deposits/pending", response_model=list[PendingDepositRowOut], dependencies=[Depends(require_feature("money.deposits"))])
def deposits_pending(
    store_id: int,
    date_from: date = Query(..., alias="from"),
    date_to: date = Query(..., alias="to"),
    format: CsvFormat = None,
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> list[PendingDepositRowOut] | Response:
    store = admin_store(db, actor, store_id)
    rows = service.pending_deposits(db, store=store, date_from=date_from, date_to=date_to)
    result = [PendingDepositRowOut(**asdict(r)) for r in rows]
    if format == "csv":
        return csv_response(result, "por-consignar.csv")
    return result


# ---------------------------------------------------------------------------
# Libro del banco y mano del dueño.
# ---------------------------------------------------------------------------


@router.get("/admin/bank/ledger", response_model=BankLedgerOut, dependencies=[Depends(_require_bank())])
def bank_ledger(
    store_id: int,
    date_from: date = Query(..., alias="from"),
    date_to: date = Query(..., alias="to"),
    account_id: int | None = None,
    format: CsvFormat = None,
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> BankLedgerOut | Response:
    store = admin_store(db, actor, store_id)
    entries, totals = book.bank_ledger(db, store=store, date_from=date_from, date_to=date_to, account_id=account_id)
    result = BankLedgerOut(
        date_from=date_from,
        date_to=date_to,
        account_id=account_id,
        entries=[LedgerEntryOut(**asdict(e)) for e in entries],
        totals=BankLedgerTotalsOut(**totals),
    )
    if format == "csv":
        return csv_response(result.entries, "libro-banco.csv")
    return result


# ---------------------------------------------------------------------------
# 0046 · Cuentas, saldo del extracto, movimientos tecleados, asignaciones,
# cuánto hay hoy y la proyección (`app.banking.book`).
# ---------------------------------------------------------------------------


def _account_out(view: book.AccountView | BankAccount) -> BankAccountOut:
    return BankAccountOut(
        id=view.id,
        name=view.name,
        is_default=view.is_default,
        gmf_exempt=view.gmf_exempt,
        receives_transfers=view.receives_transfers,
        active=view.active,
    )


def _account_names(db: Session, store: Any) -> dict[int | None, str]:
    return {a.id: a.name for a in book.list_accounts(db, store=store)}


def _anchor_out(db: Session, store: Any, row: BankBalanceAnchor) -> BankAnchorOut:
    return BankAnchorOut(
        id=row.id,
        account_id=row.account_id,
        account_name=_account_names(db, store).get(row.account_id, ""),
        balance_date=row.balance_date,
        balance=row.balance,
        note=row.note,
        employee_name=row.employee_name,
        created_at=row.created_at,
        voided_at=row.voided_at,
        voided_reason=row.voided_reason,
        voided_by_employee_name=row.voided_by_employee_name,
    )


def _movement_out(db: Session, store: Any, row: BankMovement) -> BankMovementOut:
    names = _account_names(db, store)
    return BankMovementOut(
        id=row.id,
        account_id=row.account_id,
        account_name=names.get(row.account_id, ""),
        counter_account_id=row.counter_account_id,
        counter_account_name=names.get(row.counter_account_id) if row.counter_account_id is not None else None,
        direction=row.direction.value,  # type: ignore[arg-type]
        cause=row.cause.value,  # type: ignore[arg-type]
        business_date=row.business_date,
        amount=row.amount,
        description=row.description,
        employee_name=row.employee_name,
        created_at=row.created_at,
        voided_at=row.voided_at,
        voided_reason=row.voided_reason,
        voided_by_employee_name=row.voided_by_employee_name,
    )


@router.get("/admin/bank/accounts", response_model=list[BankAccountOut], dependencies=[Depends(_require_bank())])
def list_bank_accounts(
    store_id: int, actor: Actor = Depends(current_admin), db: Session = Depends(get_db)
) -> list[BankAccountOut]:
    store = admin_store(db, actor, store_id)
    return [_account_out(a) for a in book.list_accounts(db, store=store)]


@router.post("/admin/bank/accounts", status_code=201, dependencies=[Depends(_require_bank())])
def create_bank_account(
    payload: BankAccountIn,
    store_id: int,
    request: Request,
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> BankAccountOut:
    store = admin_store(db, actor, store_id)

    def _do() -> tuple[int, dict[str, Any]]:
        row = book.create_account(db, actor=actor, store=store, payload=payload)
        return 201, _account_out(row).model_dump(mode="json")

    _status, body = _idempotent(
        db, organization_id=actor.organization_id, scope="banking.accounts", request=request, payload=payload, fn=_do
    )
    return BankAccountOut.model_validate(body)


@router.patch("/admin/bank/accounts/{account_id}", dependencies=[Depends(_require_bank())])
def update_bank_account(
    account_id: int,
    payload: BankAccountPatchIn,
    store_id: int,
    request: Request,
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> BankAccountOut:
    store = admin_store(db, actor, store_id)
    account = book.account_or_404(db, store=store, account_id=account_id)

    def _do() -> tuple[int, dict[str, Any]]:
        row = book.update_account(db, actor=actor, store=store, account=account, payload=payload)
        return 200, _account_out(row).model_dump(mode="json")

    _status, body = _idempotent(
        db,
        organization_id=actor.organization_id,
        scope="banking.accounts.update",
        request=request,
        payload=payload,
        fn=_do,
    )
    return BankAccountOut.model_validate(body)


@router.get("/admin/bank/anchors", response_model=list[BankAnchorOut], dependencies=[Depends(_require_bank())])
def list_bank_anchors(
    store_id: int,
    account_id: int | None = None,
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> list[BankAnchorOut]:
    store = admin_store(db, actor, store_id)
    return [_anchor_out(db, store, a) for a in book.list_anchors(db, store=store, account_id=account_id)]


@router.post("/admin/bank/anchors", status_code=201, dependencies=[Depends(_require_bank())])
def create_bank_anchor(
    payload: BankAnchorIn,
    store_id: int,
    request: Request,
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> BankAnchorOut:
    store = admin_store(db, actor, store_id)

    def _do() -> tuple[int, dict[str, Any]]:
        row = book.create_anchor(db, actor=actor, store=store, payload=payload)
        return 201, _anchor_out(db, store, row).model_dump(mode="json")

    _status, body = _idempotent(
        db, organization_id=actor.organization_id, scope="banking.anchors", request=request, payload=payload, fn=_do
    )
    return BankAnchorOut.model_validate(body)


@router.post("/admin/bank/anchors/{anchor_id}/void", dependencies=[Depends(_require_bank())])
def void_bank_anchor(
    anchor_id: int,
    payload: BankVoidIn,
    store_id: int,
    request: Request,
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> BankAnchorOut:
    store = admin_store(db, actor, store_id)
    anchor = book.anchor_or_404(db, store=store, anchor_id=anchor_id)

    def _do() -> tuple[int, dict[str, Any]]:
        row = book.void_anchor(db, actor=actor, store=store, anchor=anchor, reason=payload.reason)
        return 200, _anchor_out(db, store, row).model_dump(mode="json")

    _status, body = _idempotent(
        db, organization_id=actor.organization_id, scope="banking.anchors.void", request=request, payload=payload, fn=_do
    )
    return BankAnchorOut.model_validate(body)


@router.post("/admin/bank/movements", status_code=201, dependencies=[Depends(_require_bank())])
def create_bank_movement(
    payload: BankMovementIn,
    store_id: int,
    request: Request,
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> BankMovementOut:
    store = admin_store(db, actor, store_id)

    def _do() -> tuple[int, dict[str, Any]]:
        row = book.create_movement(db, actor=actor, store=store, payload=payload)
        return 201, _movement_out(db, store, row).model_dump(mode="json")

    _status, body = _idempotent(
        db, organization_id=actor.organization_id, scope="banking.movements", request=request, payload=payload, fn=_do
    )
    return BankMovementOut.model_validate(body)


@router.post("/admin/bank/movements/{movement_id}/void", dependencies=[Depends(_require_bank())])
def void_bank_movement(
    movement_id: int,
    payload: BankVoidIn,
    store_id: int,
    request: Request,
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> BankMovementOut:
    store = admin_store(db, actor, store_id)
    movement = book.movement_or_404(db, store=store, movement_id=movement_id)

    def _do() -> tuple[int, dict[str, Any]]:
        row = book.void_movement(db, actor=actor, store=store, movement=movement, reason=payload.reason)
        return 200, _movement_out(db, store, row).model_dump(mode="json")

    _status, body = _idempotent(
        db,
        organization_id=actor.organization_id,
        scope="banking.movements.void",
        request=request,
        payload=payload,
        fn=_do,
    )
    return BankMovementOut.model_validate(body)


@router.post("/admin/bank/assignments", dependencies=[Depends(_require_bank())])
def assign_bank_entry(
    payload: BankAssignmentIn,
    store_id: int,
    request: Request,
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> BankAssignmentOut:
    store = admin_store(db, actor, store_id)

    def _do() -> tuple[int, dict[str, Any]]:
        row, account = book.assign_entry(db, actor=actor, store=store, payload=payload)
        out = BankAssignmentOut(
            source_kind=row.source_kind,  # type: ignore[arg-type]
            source_id=row.source_id,
            account_id=account.id,
            account_name=account.name,
        )
        return 200, out.model_dump(mode="json")

    _status, body = _idempotent(
        db,
        organization_id=actor.organization_id,
        scope="banking.assignments",
        request=request,
        payload=payload,
        fn=_do,
    )
    return BankAssignmentOut.model_validate(body)


@router.get("/admin/bank/position", response_model=BankPositionOut, dependencies=[Depends(_require_bank())])
def bank_position(
    store_id: int,
    format: CsvFormat = None,
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> BankPositionOut | Response:
    store = admin_store(db, actor, store_id)
    data = book.bank_position(db, store=store)
    result = BankPositionOut(
        as_of=data["as_of"],
        accounts=[
            BankAccountPositionOut(**{**asdict(p), "account": _account_out(p.account)}) for p in data["accounts"]
        ],
        total=data["total"],
        total_reason=data["total_reason"],
        gmf_per_mille=book.GMF_PER_MILLE,
    )
    if format == "csv":
        return csv_response(result.accounts, "saldo-banco.csv")
    return result


@router.get("/admin/bank/projection", response_model=BankProjectionOut, dependencies=[Depends(_require_bank())])
def bank_projection(
    store_id: int,
    months: int = Query(3, ge=1, le=3),
    format: CsvFormat = None,
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> BankProjectionOut | Response:
    store = admin_store(db, actor, store_id)
    data = book.bank_projection(db, store=store, months=months)
    result = BankProjectionOut(**{**data, "months": [BankProjectionMonthOut(**m) for m in data["months"]]})
    if format == "csv":
        return csv_response(result.months, "proyeccion-banco.csv")
    return result


@router.get("/admin/bank/owner-hand", response_model=OwnerHandOut, dependencies=[Depends(_require_bank())])
def owner_hand(
    store_id: int,
    date_from: date = Query(..., alias="from"),
    date_to: date = Query(..., alias="to"),
    format: CsvFormat = None,
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> OwnerHandOut | Response:
    store = admin_store(db, actor, store_id)
    data = service.owner_hand(db, store=store, date_from=date_from, date_to=date_to)
    overdue_days = stores_service.get_cash_settings(db, store.id).deposit_overdue_days
    result = OwnerHandOut(date_from=date_from, date_to=date_to, overdue_days=overdue_days, **data)
    if format == "csv":
        return csv_response([result], "mano-del-dueno.csv")
    return result


# ---------------------------------------------------------------------------
# Conciliación de datáfono.
# ---------------------------------------------------------------------------


@router.get("/admin/reconciliation/card", response_model=CardReconciliationOut, dependencies=[Depends(_require_bank())])
def reconciliation_card(
    store_id: int,
    date_from: date = Query(..., alias="from"),
    date_to: date = Query(..., alias="to"),
    format: CsvFormat = None,
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> CardReconciliationOut | Response:
    store = admin_store(db, actor, store_id)
    rows = [CardReconciliationRowOut(**r) for r in service.card_reconciliation_rows(db, store=store, date_from=date_from, date_to=date_to)]
    result = CardReconciliationOut(
        date_from=date_from,
        date_to=date_to,
        rows=rows,
        unmatched_count=sum(1 for r in rows if not r.matched),
    )
    if format == "csv":
        return csv_response(result.rows, "conciliacion-datafono.csv")
    return result


@router.post("/admin/reconciliation/card", status_code=201, dependencies=[Depends(_require_bank())])
def create_card_settlement(
    payload: CardSettlementIn,
    store_id: int,
    request: Request,
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> CardSettlementOut:
    store = admin_store(db, actor, store_id)

    def _do() -> tuple[int, dict[str, Any]]:
        row = service.create_card_settlement(db, actor=actor, store=store, payload=payload)
        return 201, _card_settlement_out(row).model_dump(mode="json")

    _status, body = _idempotent(
        db,
        organization_id=actor.organization_id,
        scope="banking.card_settlements",
        request=request,
        payload=payload,
        fn=_do,
    )
    return CardSettlementOut.model_validate(body)


@router.get("/admin/reconciliation/card/settlements", response_model=list[CardSettlementOut], dependencies=[Depends(_require_bank())])
def list_card_settlements(
    store_id: int,
    date_from: date = Query(..., alias="from"),
    date_to: date = Query(..., alias="to"),
    status: str | None = None,
    format: CsvFormat = None,
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> list[CardSettlementOut] | Response:
    store = admin_store(db, actor, store_id)
    rows = service.list_card_settlements(db, store=store, date_from=date_from, date_to=date_to, status=status)
    result = [_card_settlement_out(r) for r in rows]
    if format == "csv":
        return csv_response(result, "liquidaciones-datafono.csv")
    return result


@router.post("/admin/reconciliation/card/{settlement_id}/settle", dependencies=[Depends(_require_bank())])
def settle_card_settlement(
    settlement_id: int,
    payload: SettleIn,
    request: Request,
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> CardSettlementOut:
    settlement = service.get_card_settlement_or_404(db, organization_id=actor.organization_id, settlement_id=settlement_id)
    admin_store(db, actor, settlement.store_id)

    def _do() -> tuple[int, dict[str, Any]]:
        row = service.match_card_settlement(db, actor=actor, settlement=settlement, note=payload.note)
        return 200, _card_settlement_out(row).model_dump(mode="json")

    _status, body = _idempotent(
        db,
        organization_id=actor.organization_id,
        scope="banking.card_settlements.settle",
        request=request,
        payload=payload,
        fn=_do,
    )
    return CardSettlementOut.model_validate(body)


@router.post("/admin/reconciliation/card/{settlement_id}/reverse", dependencies=[Depends(_require_bank())])
def reverse_card_settlement(
    settlement_id: int,
    payload: SettlementReverseIn,
    request: Request,
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> CardSettlementOut:
    settlement = service.get_card_settlement_or_404(db, organization_id=actor.organization_id, settlement_id=settlement_id)
    admin_store(db, actor, settlement.store_id)

    def _do() -> tuple[int, dict[str, Any]]:
        row = service.reverse_card_settlement(db, actor=actor, settlement=settlement, reason=payload.reason)
        return 200, _card_settlement_out(row).model_dump(mode="json")

    _status, body = _idempotent(
        db,
        organization_id=actor.organization_id,
        scope="banking.card_settlements.reverse",
        request=request,
        payload=payload,
        fn=_do,
    )
    return CardSettlementOut.model_validate(body)


# ---------------------------------------------------------------------------
# Conciliación de plataformas.
# ---------------------------------------------------------------------------


@router.get("/admin/reconciliation/platform", response_model=PlatformReconciliationOut, dependencies=[Depends(_require_bank())])
def reconciliation_platform(
    store_id: int,
    date_from: date = Query(..., alias="from"),
    date_to: date = Query(..., alias="to"),
    format: CsvFormat = None,
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> PlatformReconciliationOut | Response:
    store = admin_store(db, actor, store_id)
    rows = [
        PlatformReconciliationRowOut(**r)
        for r in service.platform_reconciliation_rows(db, store=store, date_from=date_from, date_to=date_to)
    ]
    result = PlatformReconciliationOut(
        date_from=date_from,
        date_to=date_to,
        rows=rows,
        unmatched_count=sum(1 for r in rows if not r.matched),
    )
    if format == "csv":
        return csv_response(result.rows, "conciliacion-plataformas.csv")
    return result


@router.post("/admin/reconciliation/platform", status_code=201, dependencies=[Depends(_require_bank())])
def create_platform_settlement(
    payload: PlatformSettlementIn,
    store_id: int,
    request: Request,
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> PlatformSettlementOut:
    store = admin_store(db, actor, store_id)

    def _do() -> tuple[int, dict[str, Any]]:
        row = service.create_platform_settlement(db, actor=actor, store=store, payload=payload)
        return 201, _platform_settlement_out(row).model_dump(mode="json")

    _status, body = _idempotent(
        db,
        organization_id=actor.organization_id,
        scope="banking.platform_settlements",
        request=request,
        payload=payload,
        fn=_do,
    )
    return PlatformSettlementOut.model_validate(body)


@router.get("/admin/reconciliation/platform/settlements", response_model=list[PlatformSettlementOut], dependencies=[Depends(_require_bank())])
def list_platform_settlements(
    store_id: int,
    date_from: date = Query(..., alias="from"),
    date_to: date = Query(..., alias="to"),
    status: str | None = None,
    format: CsvFormat = None,
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> list[PlatformSettlementOut] | Response:
    store = admin_store(db, actor, store_id)
    rows = service.list_platform_settlements(db, store=store, date_from=date_from, date_to=date_to, status=status)
    result = [_platform_settlement_out(r) for r in rows]
    if format == "csv":
        return csv_response(result, "liquidaciones-plataformas.csv")
    return result


@router.post("/admin/reconciliation/platform/{settlement_id}/settle", dependencies=[Depends(_require_bank())])
def settle_platform_settlement(
    settlement_id: int,
    payload: SettleIn,
    request: Request,
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> PlatformSettlementOut:
    settlement = service.get_platform_settlement_or_404(db, organization_id=actor.organization_id, settlement_id=settlement_id)
    admin_store(db, actor, settlement.store_id)

    def _do() -> tuple[int, dict[str, Any]]:
        row = service.match_platform_settlement(db, actor=actor, settlement=settlement, note=payload.note)
        return 200, _platform_settlement_out(row).model_dump(mode="json")

    _status, body = _idempotent(
        db,
        organization_id=actor.organization_id,
        scope="banking.platform_settlements.settle",
        request=request,
        payload=payload,
        fn=_do,
    )
    return PlatformSettlementOut.model_validate(body)


@router.post("/admin/reconciliation/platform/{settlement_id}/reverse", dependencies=[Depends(_require_bank())])
def reverse_platform_settlement(
    settlement_id: int,
    payload: SettlementReverseIn,
    request: Request,
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> PlatformSettlementOut:
    settlement = service.get_platform_settlement_or_404(db, organization_id=actor.organization_id, settlement_id=settlement_id)
    admin_store(db, actor, settlement.store_id)

    def _do() -> tuple[int, dict[str, Any]]:
        row = service.reverse_platform_settlement(db, actor=actor, settlement=settlement, reason=payload.reason)
        return 200, _platform_settlement_out(row).model_dump(mode="json")

    _status, body = _idempotent(
        db,
        organization_id=actor.organization_id,
        scope="banking.platform_settlements.reverse",
        request=request,
        payload=payload,
        fn=_do,
    )
    return PlatformSettlementOut.model_validate(body)
