"""Endpoints de `channels` (`/api/v1/...`), pedido 2c.

**Dos flags, no una**, así que el gate va por endpoint y no en el router:
plataformas y comisiones detrás de `pos.platforms`; la liquidación del
efectivo de domicilios detrás de `pos.delivery`. Las dos cortan con
`400 FEATURE_DISABLED` antes de llegar al service (`require_feature` es la
única puerta, `AGENTS.md`).

Superficie de admin vs. superficie de dispositivo:

- Todo lo que muestra **comisión** es `/admin/**` con `current_admin`. La
  comisión es plata del negocio; el operador no la ve, igual que no ve
  costos ni márgenes.
- El POS sólo recibe `GET /device/platforms` (id, nombre, código — sin
  comisión) y las rutas de liquidación de domicilios, que son operativas.
"""

from __future__ import annotations

from datetime import date
from typing import Any

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy.orm import Session

from app.auth.deps import Actor, admin_store, current_admin, current_device, current_operator
from app.channels import service
from app.channels.models import DeliveryPlatform, DeliverySettlement
from app.channels.schemas import (
    CourierPendingOut,
    DeliveryPendingListOut,
    DeliverySettlementIn,
    DeliverySettlementOut,
    DeliverySettlementVoidIn,
    DevicePlatformOut,
    PlatformCancellationIn,
    PlatformCancellationOut,
    PlatformCommissionOut,
    PlatformIn,
    PlatformOut,
    PlatformReceivableOut,
    PlatformSummaryOut,
    PlatformUpdateIn,
)
from app.core import clock
from app.core.db import get_db
from app.core.errors import AppError, NotFoundError
from app.core.features import require_feature
from app.core.idempotency import hash_request_body, idempotency_key, run_idempotent
from app.shifts import hooks as shifts_hooks
from app.stores.models import Store

router = APIRouter()


def _store_of_device(db: Session, actor: Actor) -> Store:
    store = db.get(Store, actor.store_id) if actor.store_id is not None else None
    if store is None:
        raise NotFoundError("La sede del dispositivo no existe")
    return store


def _platform_out(row: DeliveryPlatform) -> PlatformOut:
    return PlatformOut(
        id=row.id,
        store_id=row.store_id,
        name=row.name,
        code=row.code,
        commission_bp=row.commission_bp,
        active=row.active,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


def _settlement_out(row: DeliverySettlement) -> DeliverySettlementOut:
    return DeliverySettlementOut(
        id=row.id,
        store_id=row.store_id,
        courier_employee_id=row.courier_employee_id,
        courier_employee_name=row.courier_employee_name,
        shift_id=row.shift_id,
        cash_movement_id=row.cash_movement_id,
        amount=row.amount,
        tip_amount=row.tip_amount,
        total=row.amount + row.tip_amount,
        payments_count=row.payments_count,
        status=row.status.value,  # type: ignore[arg-type]
        note=row.note,
        business_date=row.business_date,
        at=row.at,
        employee_name=row.employee_name,
        voided_at=row.voided_at,
        voided_reason=row.voided_reason,
        voided_by_employee_name=row.voided_by_employee_name,
        void_shift_id=row.void_shift_id,
        void_cash_movement_id=row.void_cash_movement_id,
    )


def _idempotent(
    db: Session, *, organization_id: int, scope: str, request: Request, payload: Any, fn: Any
) -> tuple[int, dict[str, Any]]:
    key = idempotency_key(request)
    request_hash = hash_request_body(payload.model_dump(mode="json"))
    return run_idempotent(
        db, organization_id=organization_id, scope=scope, key=key, request_hash=request_hash, fn=fn
    )


# ---------------------------------------------------------------------------
# Plataformas y comisiones (admin, §9.3) — `pos.platforms`
# ---------------------------------------------------------------------------


@router.get("/admin/platforms", dependencies=[Depends(require_feature("pos.platforms"))])
def list_platforms(
    store_id: int,
    active: bool | None = None,
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> list[PlatformOut]:
    store = admin_store(db, actor, store_id)
    return [_platform_out(r) for r in service.list_platforms(db, store_id=store.id, active=active)]


@router.post("/admin/platforms", status_code=201, dependencies=[Depends(require_feature("pos.platforms"))])
def create_platform(
    payload: PlatformIn,
    store_id: int,
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> PlatformOut:
    store = admin_store(db, actor, store_id)
    return _platform_out(service.create_platform(db, actor=actor, store=store, data=payload))


@router.patch("/admin/platforms/{platform_id}", dependencies=[Depends(require_feature("pos.platforms"))])
def update_platform(
    platform_id: int,
    payload: PlatformUpdateIn,
    store_id: int,
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> PlatformOut:
    admin_store(db, actor, store_id)
    platform = service.get_platform_or_404(db, organization_id=actor.organization_id, platform_id=platform_id)
    if platform.store_id != store_id:
        raise NotFoundError("La plataforma no existe en esta sede")
    return _platform_out(service.update_platform(db, actor=actor, platform=platform, data=payload))


@router.delete("/admin/platforms/{platform_id}", dependencies=[Depends(require_feature("pos.platforms"))])
def deactivate_platform(
    platform_id: int,
    store_id: int,
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> PlatformOut:
    """Baja **lógica**. Nada financiero se borra: la plataforma queda
    inactiva y sus comisiones y cuentas por cobrar siguen legibles."""
    admin_store(db, actor, store_id)
    platform = service.get_platform_or_404(db, organization_id=actor.organization_id, platform_id=platform_id)
    if platform.store_id != store_id:
        raise NotFoundError("La plataforma no existe en esta sede")
    return _platform_out(service.deactivate_platform(db, actor=actor, platform=platform))


@router.get(
    "/admin/platforms/{platform_id}/summary", dependencies=[Depends(require_feature("pos.platforms"))]
)
def platform_summary(
    platform_id: int,
    store_id: int,
    date_from: date = Query(..., alias="from"),
    date_to: date = Query(..., alias="to"),
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> PlatformSummaryOut:
    """Venta, propina y comisión del rango, **por separado**: `sales` nunca
    viene neteado de comisión."""
    store = admin_store(db, actor, store_id)
    platform = service.get_platform_or_404(db, organization_id=actor.organization_id, platform_id=platform_id)
    if platform.store_id != store.id:
        raise NotFoundError("La plataforma no existe en esta sede")
    data = service.platform_summary(
        db, store_id=store.id, platform=platform, date_from=date_from, date_to=date_to
    )
    return PlatformSummaryOut(
        platform_id=platform.id,
        platform_name=platform.name,
        date_from=date_from,
        date_to=date_to,
        **data,
    )


@router.get("/admin/platform-commissions", dependencies=[Depends(require_feature("pos.platforms"))])
def list_commissions(
    store_id: int,
    date_from: date = Query(..., alias="from"),
    date_to: date = Query(..., alias="to"),
    platform_id: int | None = None,
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> list[PlatformCommissionOut]:
    from sqlalchemy import select

    from app.channels.models import PlatformCommission

    store = admin_store(db, actor, store_id)
    stmt = select(PlatformCommission).where(
        PlatformCommission.store_id == store.id,
        PlatformCommission.business_date >= date_from,
        PlatformCommission.business_date <= date_to,
    )
    if platform_id is not None:
        stmt = stmt.where(PlatformCommission.platform_id == platform_id)
    rows = list(db.execute(stmt.order_by(PlatformCommission.at.desc())).scalars())
    return [
        PlatformCommissionOut(
            id=r.id,
            platform_id=r.platform_id,
            order_id=r.order_id,
            document_id=r.document_id,
            kind=r.kind.value,  # type: ignore[arg-type]
            base_amount=r.base_amount,
            commission_bp=r.commission_bp,
            amount=r.amount,
            business_date=r.business_date,
            at=r.at,
            reason=r.reason,
        )
        for r in rows
    ]


@router.get("/admin/platform-receivables", dependencies=[Depends(require_feature("pos.platforms"))])
def list_receivables(
    store_id: int,
    date_from: date = Query(..., alias="from"),
    date_to: date = Query(..., alias="to"),
    platform_id: int | None = None,
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> list[PlatformReceivableOut]:
    """Lo que las plataformas nos deben. **Su conciliación es fase 3**: acá
    sólo se registra y se lee, no se marca como cobrada."""
    from sqlalchemy import select

    from app.channels.models import PlatformReceivable

    store = admin_store(db, actor, store_id)
    stmt = select(PlatformReceivable).where(
        PlatformReceivable.store_id == store.id,
        PlatformReceivable.business_date >= date_from,
        PlatformReceivable.business_date <= date_to,
    )
    if platform_id is not None:
        stmt = stmt.where(PlatformReceivable.platform_id == platform_id)
    rows = list(db.execute(stmt.order_by(PlatformReceivable.at.desc())).scalars())
    return [
        PlatformReceivableOut(
            id=r.id,
            platform_id=r.platform_id,
            order_id=r.order_id,
            document_id=r.document_id,
            payment_id=r.payment_id,
            external_id=r.external_id,
            amount=r.amount,
            tip_amount=r.tip_amount,
            status=r.status.value,  # type: ignore[arg-type]
            business_date=r.business_date,
            at=r.at,
            reversed_at=r.reversed_at,
            reversed_reason=r.reversed_reason,
        )
        for r in rows
    ]


@router.get("/device/platforms", dependencies=[Depends(require_feature("pos.platforms"))])
def device_platforms(
    actor: Actor = Depends(current_device), db: Session = Depends(get_db)
) -> list[DevicePlatformOut]:
    """Las plataformas activas de la sede, para cargar a mano un pedido con
    su `external_id` (la integración por API es fase 3). **Sin comisión**:
    el operador no recibe plata del negocio."""
    from app.channels import hooks

    store = _store_of_device(db, actor)
    return [
        DevicePlatformOut(id=p.id, name=p.name, code=p.code)
        for p in hooks.list_active_platforms(db, store_id=store.id)
    ]


# ---------------------------------------------------------------------------
# Venta compensada de plataforma — `pos.platforms`
# ---------------------------------------------------------------------------


@router.post(
    "/admin/platform-cancellations",
    status_code=201,
    dependencies=[Depends(require_feature("pos.platforms"))],
)
def create_platform_cancellation(
    payload: PlatformCancellationIn,
    store_id: int,
    request: Request,
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> PlatformCancellationOut:
    """Cancelar una venta de plataforma **después de preparar**: compensa la
    VENTA y **no genera merma ni repone inventario**.

    Vive acá y no en el router de comandas a propósito: es una operación de
    dinero (nota fiscal, cuenta por cobrar, comisión), y la comanda la marca
    su propio dueño por el CONTRATO C4
    (`app.orders.hooks.mark_platform_order_cancelled`).
    """
    from app.orders.models import Order, OrderChannel

    store = admin_store(db, actor, store_id)
    order = db.get(Order, payload.order_id)
    if order is None or order.store_id != store.id:
        raise NotFoundError("La comanda no existe en esta sede")
    if order.channel != OrderChannel.PLATFORM:
        raise AppError(
            "NOT_A_PLATFORM_ORDER",
            "Esta comanda no es de plataforma; anulala por el camino normal de anulación de venta",
            status=400,
        )

    def _do() -> tuple[int, dict[str, Any]]:
        now = clock.now_utc()
        result = service.cancel_platform_sale(
            db, actor=actor, store=store, order=order, reason=payload.reason, now=now
        )
        return 201, PlatformCancellationOut(**result).model_dump(mode="json")

    _status, body = _idempotent(
        db,
        organization_id=actor.organization_id,
        scope="channels.platform_cancellation",
        request=request,
        payload=payload,
        fn=_do,
    )
    return PlatformCancellationOut.model_validate(body)


# ---------------------------------------------------------------------------
# Efectivo de domicilios: arqueo aparte — `pos.delivery`
# ---------------------------------------------------------------------------


@router.get("/delivery-settlements/pending", dependencies=[Depends(require_feature("pos.delivery"))])
def pending_delivery_cash(
    actor: Actor = Depends(current_device), db: Session = Depends(get_db)
) -> DeliveryPendingListOut:
    """Efectivo de domicilios por liquidar, agrupado por domiciliario.

    **No es deuda de ningún empleado** (CST art. 149): es plata de la sede
    que todavía no está en el cajón, y el sistema no calcula ni descuenta
    deudas de personas. Es la lista operativa que el responsable de caja
    necesita para recibir la plata; el renglón agregado del desglose del
    turno vive en `GET /shifts/current`, gateado por el esperado.
    """
    store = _store_of_device(db, actor)
    payments = service.pending_delivery_payments(db, store_id=store.id)

    by_courier: dict[int, dict[str, Any]] = {}
    for p in payments:
        entry = by_courier.setdefault(
            p.delivery_courier_employee_id,
            {
                "courier_employee_id": p.delivery_courier_employee_id,
                "courier_employee_name": p.delivery_courier_employee_name or "",
                "payments_count": 0,
                "amount": 0,
                "tip_amount": 0,
            },
        )
        entry["payments_count"] += 1
        entry["amount"] += int(p.amount or 0)
        entry["tip_amount"] += int(p.tip_amount or 0)

    couriers = [
        CourierPendingOut(total=e["amount"] + e["tip_amount"], **e)
        for e in sorted(by_courier.values(), key=lambda e: e["courier_employee_name"])
    ]
    amount = sum(c.amount for c in couriers)
    tip_amount = sum(c.tip_amount for c in couriers)
    return DeliveryPendingListOut(
        store_id=store.id,
        couriers=couriers,
        amount=amount,
        tip_amount=tip_amount,
        total=amount + tip_amount,
    )


@router.post(
    "/delivery-settlements", status_code=201, dependencies=[Depends(require_feature("pos.delivery"))]
)
def create_delivery_settlement(
    payload: DeliverySettlementIn,
    request: Request,
    actor: Actor = Depends(current_operator),
    db: Session = Depends(get_db),
) -> DeliverySettlementOut:
    """El domiciliario liquida: el efectivo entra al turno ABIERTO como un
    ingreso con causa tipada. Sin turno abierto, `409 NO_OPEN_SHIFT` y no
    queda nada a medias."""
    store = _store_of_device(db, actor)
    # La liquidación mete plata al cajón: sólo quien puede tocar la caja.
    shifts_hooks.require_cash_permission_for_store(db, actor=actor, store_id=store.id)

    def _do() -> tuple[int, dict[str, Any]]:
        now = clock.now_utc()
        settlement = service.settle_delivery_cash(
            db,
            actor=actor,
            store=store,
            courier_employee_id=payload.courier_employee_id,
            payment_ids=payload.payment_ids,
            note=payload.note,
            now=now,
        )
        return 201, _settlement_out(settlement).model_dump(mode="json")

    _status, body = _idempotent(
        db,
        organization_id=actor.organization_id,
        scope="channels.delivery_settlement",
        request=request,
        payload=payload,
        fn=_do,
    )
    return DeliverySettlementOut.model_validate(body)


@router.post(
    "/delivery-settlements/{settlement_id}/void",
    dependencies=[Depends(require_feature("pos.delivery"))],
)
def void_delivery_settlement(
    settlement_id: int,
    payload: DeliverySettlementVoidIn,
    request: Request,
    actor: Actor = Depends(current_operator),
    db: Session = Depends(get_db),
) -> DeliverySettlementOut:
    """Deshacer una liquidación. Escribe el movimiento ESPEJO en el turno
    abierto al momento de deshacerla; el movimiento original queda vivo, y
    los cobros vuelven a estar pendientes. Sin turno abierto, `409` y la
    anulación entera se rechaza."""
    store = _store_of_device(db, actor)
    settlement = service.get_settlement_or_404(
        db, organization_id=actor.organization_id, settlement_id=settlement_id
    )
    if settlement.store_id != store.id:
        raise NotFoundError("La liquidación no existe en esta sede")
    shifts_hooks.require_cash_permission_for_store(db, actor=actor, store_id=store.id)

    def _do() -> tuple[int, dict[str, Any]]:
        now = clock.now_utc()
        row = service.void_delivery_settlement(
            db, actor=actor, store=store, settlement=settlement, reason=payload.reason, now=now
        )
        return 200, _settlement_out(row).model_dump(mode="json")

    _status, body = _idempotent(
        db,
        organization_id=actor.organization_id,
        scope=f"channels.delivery_settlement_void:{settlement_id}",
        request=request,
        payload=payload,
        fn=_do,
    )
    return DeliverySettlementOut.model_validate(body)


@router.get("/admin/delivery-settlements", dependencies=[Depends(require_feature("pos.delivery"))])
def list_delivery_settlements(
    store_id: int,
    date_from: date | None = Query(None, alias="from"),
    date_to: date | None = Query(None, alias="to"),
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> list[DeliverySettlementOut]:
    store = admin_store(db, actor, store_id)
    rows = service.list_settlements(db, store_id=store.id, date_from=date_from, date_to=date_to)
    return [_settlement_out(r) for r in rows]
