"""Reglas de negocio de `channels` (pedido 2c, `backend-dinero-canales`).

Tres cosas y ninguna más, porque las tres son las que más fácil se rompen:

1. **La comisión se registra, no se resta.** `compute_commission` es la
   ÚNICA matemática de la comisión en todo el backend: aritmética entera,
   `base × commission_bp` con redondeo **half-up** por
   `app.orders.money.round_half_up` (la misma función que ya redondea la
   propina sugerida desde 1b) sobre denominador 10.000. Sin `float` en
   ningún punto. La venta que se reporta sigue siendo la venta completa.

2. **El medio `platform` no toca el cajón.** Acá se registra la cuenta por
   cobrar; `compute_breakdown` ni se entera, porque `get_sales_totals`
   manda `platform` a `.other` y `.other` no entra al esperado.

3. **El efectivo de domicilios se arquea aparte.** Entra al cajón por un
   único camino —`app.shifts.hooks.register_delivery_settlement_income`—
   y deshacerlo escribe el espejo, nunca borra. Ese camino mueve el
   esperado por la **venta sola**: la propina en efectivo de un domicilio
   se trata igual que cualquier otra propina en efectivo y no mueve el
   esperado (ronda 2, cierre de H-1). El espejo usa el mismo monto.

Módulos ajenos: siempre con `app.core.modules.find_spec_safe`, nunca
`import` directo de algo que otro agente esté escribiendo en paralelo.
"""

from __future__ import annotations

import importlib
from dataclasses import dataclass
from datetime import date, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.audit.service import record_audit
from app.auth.models import Employee
from app.channels.models import (
    DeliveryPlatform,
    DeliverySettlement,
    DeliverySettlementStatus,
    LedgerEntryKind,
    PlatformCommission,
    PlatformReceivable,
    PlatformReceivableStatus,
)
from app.channels.schemas import PlatformIn, PlatformUpdateIn
from app.core import clock, tz
from app.core.errors import AppError, ConflictError, NotFoundError
from app.core.modules import find_spec_safe
from app.orders.money import round_half_up
from app.shifts import hooks as shifts_hooks
from app.shifts.models import Shift, ShiftStatus
from app.stores import service as stores_service
from app.stores.models import Store

# Código del medio de pago de plataforma. Vive acá y no en
# `app.stores.service.DEFAULT_PAYMENT_METHODS` porque ese archivo es
# territorio ajeno: `channels` lo SIEMBRA en la configuración de la sede
# (dato, no código) y desde ahí `app.payments.service._payment_methods_by_code`
# lo valida como cualquier otro medio, sin ninguna excepción escrita a mano.
PLATFORM_PAYMENT_METHOD_CODE = "platform"
PLATFORM_PAYMENT_METHOD = {
    "code": PLATFORM_PAYMENT_METHOD_CODE,
    "label": "Cobro por plataforma",
    # UNCL4461 «ZZZ — Otro». No es efectivo (10), ni tarjeta (48), ni la
    # transferencia (20) que esta sede ya usa: la plataforma cobró al
    # cliente y nos liquida después. El mapeo definitivo lo fija quien
    # conecte el proveedor tecnológico real (fuera del alcance de 2c, y
    # declarado en el entregable).
    "dian_code": "ZZZ",
    "enabled": True,
    # El `external_id` del pedido viaja en la comanda, no en el pago: pedir
    # una referencia obligatoria acá cortaría el cobro por un dato que ya
    # está en otro lado.
    "requires_reference": False,
}


# ---------------------------------------------------------------------------
# La única matemática de la comisión
# ---------------------------------------------------------------------------


def compute_commission(base_amount: int, commission_bp: int) -> int:
    """Comisión en pesos enteros de `base_amount` al `commission_bp` ‰‰.

    `100 bp = 1 %`, así que la fórmula es `base × bp / 10.000` con redondeo
    **half-up** —declarado acá y probado en
    `tests/channels/test_commission.py`—, usando `app.orders.money.round_half_up`,
    que es la misma función que redondea la propina sugerida: una sola
    matemática, sin `float` en ningún paso intermedio.

    Ejemplo del contrato: `compute_commission(100_000, 1_800) == 18_000`, y
    la venta reportada sigue siendo `100_000`.
    """
    if base_amount < 0:
        raise ValueError("base_amount no puede ser negativo")
    if commission_bp < 0:
        raise ValueError("commission_bp no puede ser negativo")
    return round_half_up(base_amount * commission_bp, 10_000)


# ---------------------------------------------------------------------------
# Plataformas (CRUD de admin, §9.3)
# ---------------------------------------------------------------------------


def ensure_platform_payment_method(db: Session, *, store: Store) -> bool:
    """Deja el medio `platform` disponible en la configuración de ventas de
    la sede. **Idempotente**: si ya está (habilitado o no), no lo toca — el
    administrador puede deshabilitarlo desde Configuración y crear otra
    plataforma no se lo vuelve a encender.

    Devuelve `True` sólo si lo agregó. Escribe DATO en
    `StoreSalesSettings.payment_methods`, no código en `app/stores/**`
    (territorio ajeno): a partir de ahí `platform` es un medio de pago como
    cualquier otro y `app.payments.service._validate_and_allocate_splits`
    lo valida sin ninguna rama especial.
    """
    settings = stores_service.get_sales_settings(db, store.id)
    methods = [dict(m) for m in settings.payment_methods]
    if any(m.get("code") == PLATFORM_PAYMENT_METHOD_CODE for m in methods):
        return False
    methods.append(dict(PLATFORM_PAYMENT_METHOD))
    settings.payment_methods = methods
    settings.updated_at = clock.now_utc()
    db.flush()
    return True


def list_platforms(db: Session, *, store_id: int, active: bool | None = None) -> list[DeliveryPlatform]:
    stmt = select(DeliveryPlatform).where(DeliveryPlatform.store_id == store_id)
    if active is not None:
        stmt = stmt.where(DeliveryPlatform.active.is_(active))
    return list(db.execute(stmt.order_by(DeliveryPlatform.name)).scalars())


def get_platform_or_404(db: Session, *, organization_id: int, platform_id: int) -> DeliveryPlatform:
    row = db.get(DeliveryPlatform, platform_id)
    if row is None or row.organization_id != organization_id:
        raise NotFoundError("La plataforma no existe en esta organización")
    return row


def create_platform(db: Session, *, actor: Any, store: Store, data: PlatformIn) -> DeliveryPlatform:
    existing = db.execute(
        select(DeliveryPlatform).where(
            DeliveryPlatform.store_id == store.id,
            DeliveryPlatform.code == data.code,
            DeliveryPlatform.active.is_(True),
        )
    ).scalar_one_or_none()
    if existing is not None:
        raise ConflictError(
            f'Ya hay una plataforma activa con el código "{data.code}" en esta sede; '
            "editá la existente o desactivala antes de crear otra",
            code="PLATFORM_CODE_TAKEN",
        )

    now = clock.now_utc()
    row = DeliveryPlatform(
        organization_id=store.organization_id,
        store_id=store.id,
        name=data.name,
        code=data.code,
        commission_bp=data.commission_bp,
        active=True,
        created_at=now,
        updated_at=now,
    )
    db.add(row)
    db.flush()

    ensure_platform_payment_method(db, store=store)

    record_audit(
        db,
        actor=actor,
        organization_id=store.organization_id,
        store_id=store.id,
        entity="delivery_platform",
        entity_id=row.id,
        action="create",
        before=None,
        after={"name": row.name, "code": row.code, "commission_bp": row.commission_bp, "active": True},
    )
    return row


def update_platform(db: Session, *, actor: Any, platform: DeliveryPlatform, data: PlatformUpdateIn) -> DeliveryPlatform:
    before = {
        "name": platform.name,
        "code": platform.code,
        "commission_bp": platform.commission_bp,
        "active": platform.active,
    }
    # El choque de código se comprueba ANTES de asignar nada: `get_db` hace
    # `commit()` al levantar un `ConflictError`, así que reactivar una
    # plataforma con el código tomado respondía 409 y dejaba guardados el
    # nombre y la comisión nuevos igual. La comisión mueve plata.
    if data.active is not None and data.active and not platform.active:
        clash = db.execute(
            select(DeliveryPlatform).where(
                DeliveryPlatform.store_id == platform.store_id,
                DeliveryPlatform.code == platform.code,
                DeliveryPlatform.active.is_(True),
                DeliveryPlatform.id != platform.id,
            )
        ).scalar_one_or_none()
        if clash is not None:
            raise ConflictError(
                f'Ya hay otra plataforma activa con el código "{platform.code}" en esta sede',
                code="PLATFORM_CODE_TAKEN",
            )

    if data.name is not None:
        platform.name = data.name
    if data.commission_bp is not None:
        platform.commission_bp = data.commission_bp
    if data.active is not None:
        platform.active = data.active
    platform.updated_at = clock.now_utc()
    db.flush()

    record_audit(
        db,
        actor=actor,
        organization_id=platform.organization_id,
        store_id=platform.store_id,
        entity="delivery_platform",
        entity_id=platform.id,
        action="update",
        before=before,
        after={
            "name": platform.name,
            "code": platform.code,
            "commission_bp": platform.commission_bp,
            "active": platform.active,
        },
    )
    return platform


def deactivate_platform(db: Session, *, actor: Any, platform: DeliveryPlatform) -> DeliveryPlatform:
    """Baja **lógica**: una plataforma se desactiva, nunca se borra — sus
    comisiones y cuentas por cobrar tienen que seguir siendo legibles."""
    return update_platform(db, actor=actor, platform=platform, data=PlatformUpdateIn(active=False))


# ---------------------------------------------------------------------------
# La venta cobrada por plataforma: cuenta por cobrar + comisión
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class PlatformSaleRecord:
    receivable_id: int
    commission_id: int
    amount: int
    tip_amount: int
    commission_bp: int
    commission_amount: int


def record_platform_sale(
    db: Session,
    *,
    organization_id: int,
    store_id: int,
    platform_id: int,
    order_id: int,
    document_id: int | None,
    payment_id: int | None,
    shift_id: int | None,
    external_id: str | None,
    amount: int,
    tip_amount: int,
    actor: Any,
    business_date: date,
    now: datetime,
) -> PlatformSaleRecord | None:
    """Registra la venta cobrada por plataforma: la CUENTA POR COBRAR y,
    aparte, la COMISIÓN.

    Lo llama `app.payments.service.pay_order` (mismo agente) después de
    escribir el pago. Devuelve `None` si la plataforma no existe o está
    inactiva — el cobro ya validó eso antes de escribir, así que en el
    camino real nunca pasa; acá es una guarda, no un gate.

    **Dos lugares distintos, a propósito**: el monto de la venta vive en
    `platform_receivables.amount` (y en `payments`/`fiscal_documents`), y
    la comisión en `platform_commissions.amount`. Ninguna de las dos
    contamina a la otra: una venta de $100.000 con 18 % deja `amount =
    100.000` y `commission = 18.000`, nunca un `82.000` en ningún lado.

    `commission_bp` se **congela** en la fila: cambiar el porcentaje de la
    plataforma mañana no reescribe la comisión de hoy (regla dura de
    snapshot).
    """
    platform = db.get(DeliveryPlatform, platform_id)
    if platform is None or platform.store_id != store_id:
        return None

    receivable = PlatformReceivable(
        organization_id=organization_id,
        store_id=store_id,
        platform_id=platform.id,
        order_id=order_id,
        document_id=document_id,
        payment_id=payment_id,
        shift_id=shift_id,
        external_id=external_id,
        amount=amount,
        tip_amount=tip_amount,
        status=PlatformReceivableStatus.PENDING,
        business_date=business_date,
        at=now,
        employee_id=getattr(actor, "employee_id", None),
        employee_name=getattr(actor, "employee_name", None),
    )
    db.add(receivable)
    db.flush()

    # La comisión se calcula sobre la VENTA, sin propina: la propina no es
    # venta del restaurante y la plataforma no comisiona plata ajena.
    commission_amount = compute_commission(amount, platform.commission_bp)
    commission = PlatformCommission(
        organization_id=organization_id,
        store_id=store_id,
        platform_id=platform.id,
        order_id=order_id,
        document_id=document_id,
        receivable_id=receivable.id,
        kind=LedgerEntryKind.CHARGE,
        base_amount=amount,
        commission_bp=platform.commission_bp,
        amount=commission_amount,
        business_date=business_date,
        at=now,
        reason=None,
        employee_id=getattr(actor, "employee_id", None),
        employee_name=getattr(actor, "employee_name", None),
    )
    db.add(commission)
    db.flush()

    return PlatformSaleRecord(
        receivable_id=receivable.id,
        commission_id=commission.id,
        amount=amount,
        tip_amount=tip_amount,
        commission_bp=platform.commission_bp,
        commission_amount=commission_amount,
    )


def platform_summary(
    db: Session, *, store_id: int, platform: DeliveryPlatform, date_from: date, date_to: date
) -> dict[str, int]:
    """Venta, propina y comisión de una plataforma en un rango.

    Los tres números salen **por separado**; `net_expected` está rotulado
    como lo que se espera cobrarle a la plataforma y nunca reemplaza a
    `sales`. Las filas revertidas (venta compensada) se descuentan por el
    `kind` del asiento, no borrando nada.
    """
    receivables = list(
        db.execute(
            select(PlatformReceivable).where(
                PlatformReceivable.store_id == store_id,
                PlatformReceivable.platform_id == platform.id,
                PlatformReceivable.business_date >= date_from,
                PlatformReceivable.business_date <= date_to,
                PlatformReceivable.status == PlatformReceivableStatus.PENDING,
            )
        ).scalars()
    )
    commissions = list(
        db.execute(
            select(PlatformCommission).where(
                PlatformCommission.store_id == store_id,
                PlatformCommission.platform_id == platform.id,
                PlatformCommission.business_date >= date_from,
                PlatformCommission.business_date <= date_to,
            )
        ).scalars()
    )
    sales = sum(r.amount for r in receivables)
    tips = sum(r.tip_amount for r in receivables)
    commission = sum(
        c.amount if c.kind == LedgerEntryKind.CHARGE else -c.amount for c in commissions
    )
    return {
        "orders": len({r.order_id for r in receivables}),
        "sales": sales,
        "tips": tips,
        "commission": commission,
        "net_expected": sales + tips - commission,
    }


# ---------------------------------------------------------------------------
# Domicilio propio: el efectivo que tiene el domiciliario
# ---------------------------------------------------------------------------


def _payment_model() -> Any:
    if find_spec_safe("app.payments.models") is None:
        return None
    return getattr(importlib.import_module("app.payments.models"), "Payment", None)


def pending_delivery_payments(
    db: Session, *, store_id: int, courier_employee_id: int | None = None, payment_ids: list[int] | None = None
) -> list[Any]:
    """Cobros en efectivo que todavía tiene un domiciliario (sin liquidar).

    No es deuda de nadie (CST art. 149): es plata de la sede que no está en
    el cajón.
    """
    payment_model = _payment_model()
    if payment_model is None:
        return []
    stmt = select(payment_model).where(
        payment_model.store_id == store_id,
        payment_model.voided_at.is_(None),
        payment_model.delivery_courier_employee_id.is_not(None),
        payment_model.delivery_settlement_id.is_(None),
    )
    if courier_employee_id is not None:
        stmt = stmt.where(payment_model.delivery_courier_employee_id == courier_employee_id)
    if payment_ids is not None:
        stmt = stmt.where(payment_model.id.in_(payment_ids))
    return list(db.execute(stmt.order_by(payment_model.id)).scalars())


def settle_delivery_cash(
    db: Session,
    *,
    actor: Any,
    store: Store,
    courier_employee_id: int,
    payment_ids: list[int] | None,
    note: str | None,
    now: datetime,
) -> DeliverySettlement:
    """IDA del contrato: el domiciliario entrega el efectivo.

    **Cuánto mueve el esperado del turno** (ronda 2, cierre de H-1): el
    `CashMovement(kind=INCOME, cause=DELIVERY_SETTLEMENT)` se escribe por
    `amount`, **la venta sola**, nunca por `amount + tip_amount`. El
    domiciliario entrega venta + propina y las dos quedan registradas
    (`DeliverySettlement.amount` y `.tip_amount`, y el `total` de la
    respuesta), pero el efectivo de domicilios entra al cajón por `incomes`
    **sólo por el monto de la venta**: la propina en efectivo de un
    domicilio se trata exactamente igual que la propina en efectivo de
    cualquier otra venta —no mueve el esperado (la fórmula heredada de 1b
    sólo lee `.cash`) y se salda al cierre por `tips_cash_out`/`to_deposit`
    (`app/shifts/service.py:1035`)—. Si el `INCOME` incluyera la propina, el
    mismo billete movería el esperado distinto según el canal por el que
    entró, y quien cuenta a ciegas tendría que justificar con causa tipada
    una diferencia que no existe.

    Orden deliberado —**validar antes de escribir**, porque `get_db`
    comitea también ante `AppError`—:

    1. El domiciliario existe y es de la organización.
    2. Hay cobros pendientes (si no, `400 NOTHING_TO_SETTLE`; nunca una
       liquidación de `0`, que sería un cero mudo).
    3. `register_delivery_settlement_income` busca el turno ABIERTO y
       levanta `409 NO_OPEN_SHIFT` **antes** de tocar los pagos.
    4. Recién entonces se escribe la liquidación y se marcan los pagos.

    Sin turno abierto no queda NADA a medias: ni movimiento, ni
    liquidación, ni `delivery_settlement_id` en los pagos.
    """
    courier = db.get(Employee, courier_employee_id)
    if courier is None or courier.organization_id != store.organization_id:
        raise NotFoundError("El domiciliario no existe en esta organización")

    if payment_ids is not None and not payment_ids:
        raise AppError(
            "NOTHING_TO_SETTLE",
            "Elegí al menos un cobro para liquidar, o no mandes la lista para liquidar todo lo pendiente",
            status=400,
        )

    payments = pending_delivery_payments(
        db, store_id=store.id, courier_employee_id=courier_employee_id, payment_ids=payment_ids
    )
    if payment_ids is not None and len(payments) != len(set(payment_ids)):
        raise AppError(
            "PAYMENT_NOT_PENDING",
            "Alguno de los cobros elegidos no está pendiente de liquidar para este domiciliario; "
            "recargá la lista",
            status=400,
        )
    if not payments:
        raise AppError(
            "NOTHING_TO_SETTLE",
            f"{courier.name} no tiene efectivo de domicilios pendiente de liquidar",
            status=400,
        )

    amount = sum(int(p.amount or 0) for p in payments)
    tip_amount = sum(int(p.tip_amount or 0) for p in payments)

    # Punto sin retorno: acá adentro se busca el turno abierto y, sin él,
    # se levanta 409 sin haber escrito nada todavía.
    #
    # El movimiento va por `amount` (la VENTA sola), NUNCA por
    # `amount + tip_amount`: ver el docstring de esta función y el de
    # `register_delivery_settlement_income`. El domiciliario entrega venta +
    # propina y las dos quedan registradas más abajo; lo único que se decide
    # acá es cuánto mueve el ESPERADO del turno.
    movement, shift = shifts_hooks.register_delivery_settlement_income(
        db,
        organization_id=store.organization_id,
        store_id=store.id,
        amount=amount,
        actor=actor,
        courier_name=courier.name,
        note=note,
    )

    settlement = DeliverySettlement(
        organization_id=store.organization_id,
        store_id=store.id,
        courier_employee_id=courier.id,
        courier_employee_name=courier.name,
        shift_id=shift.id,
        cash_movement_id=movement.id,
        amount=amount,
        tip_amount=tip_amount,
        payments_count=len(payments),
        status=DeliverySettlementStatus.SETTLED,
        note=note,
        business_date=tz.business_date_for(now, store.cutoff_hour),
        at=now,
        employee_id=actor.employee_id,
        employee_name=actor.employee_name,
    )
    db.add(settlement)
    db.flush()

    for payment in payments:
        payment.delivery_settlement_id = settlement.id
    db.flush()

    record_audit(
        db,
        actor=actor,
        organization_id=store.organization_id,
        store_id=store.id,
        entity="delivery_settlement",
        entity_id=settlement.id,
        action="settle",
        before=None,
        after={
            "courier_employee_id": courier.id,
            "amount": amount,
            "tip_amount": tip_amount,
            "payments": [p.id for p in payments],
            "shift_id": shift.id,
            "cash_movement_id": movement.id,
        },
    )
    return settlement


def void_delivery_settlement(
    db: Session, *, actor: Any, store: Store, settlement: DeliverySettlement, reason: str, now: datetime
) -> DeliverySettlement:
    """VUELTA del contrato: se deshace una liquidación.

    - El movimiento ESPEJO (`EXPENSE`, misma causa tipada) se escribe en el
      turno abierto **al momento de deshacer**, que puede no ser el mismo en
      el que entró la plata: el turno original ya pudo cerrarse y un turno
      cerrado es inviolable (su conteo a ciegas ya ocurrió).
    - Sin turno abierto, `409 NO_OPEN_SHIFT` y **la anulación entera se
      rechaza**: no queda ni el movimiento espejo, ni el `voided_at`, ni
      los pagos liberados.
    - El `CashMovement` del ingreso original queda **vivo**: nada
      financiero se borra.
    - Los pagos vuelven a `delivery_settlement_id = NULL`, o sea a
      "pendiente de liquidar", que es exactamente lo que vuelven a ser.
    """
    if settlement.status != DeliverySettlementStatus.SETTLED:
        raise ConflictError(
            "Esta liquidación ya está anulada", code="SETTLEMENT_ALREADY_VOIDED"
        )

    # El espejo es EXACTAMENTE el espejo: el mismo monto que movió la ida,
    # o sea la VENTA sola (`settlement.amount`), sin la propina. Si la ida
    # movió el esperado por la venta, la vuelta lo devuelve por la venta.
    movement, void_shift = shifts_hooks.register_delivery_settlement_reversal(
        db,
        organization_id=store.organization_id,
        store_id=store.id,
        amount=settlement.amount,
        actor=actor,
        courier_name=settlement.courier_employee_name,
        note=f"Anulación de la liquidación #{settlement.id}: {reason}",
    )

    payment_model = _payment_model()
    released: list[int] = []
    if payment_model is not None:
        rows = list(
            db.execute(
                select(payment_model).where(payment_model.delivery_settlement_id == settlement.id)
            ).scalars()
        )
        for row in rows:
            row.delivery_settlement_id = None
            released.append(row.id)

    settlement.status = DeliverySettlementStatus.VOIDED
    settlement.voided_at = now
    settlement.voided_reason = reason
    settlement.voided_by_employee_id = actor.employee_id
    settlement.voided_by_employee_name = actor.employee_name
    settlement.void_shift_id = void_shift.id
    settlement.void_cash_movement_id = movement.id
    db.flush()

    record_audit(
        db,
        actor=actor,
        organization_id=store.organization_id,
        store_id=store.id,
        entity="delivery_settlement",
        entity_id=settlement.id,
        action="void",
        before={"status": "settled", "cash_movement_id": settlement.cash_movement_id},
        after={
            "status": "voided",
            "void_shift_id": void_shift.id,
            "void_cash_movement_id": movement.id,
            "payments_released": released,
        },
        reason=reason,
    )
    return settlement


def get_settlement_or_404(db: Session, *, organization_id: int, settlement_id: int) -> DeliverySettlement:
    row = db.get(DeliverySettlement, settlement_id)
    if row is None or row.organization_id != organization_id:
        raise NotFoundError("La liquidación no existe en esta organización")
    return row


def list_settlements(
    db: Session, *, store_id: int, date_from: date | None = None, date_to: date | None = None
) -> list[DeliverySettlement]:
    stmt = select(DeliverySettlement).where(DeliverySettlement.store_id == store_id)
    if date_from is not None:
        stmt = stmt.where(DeliverySettlement.business_date >= date_from)
    if date_to is not None:
        stmt = stmt.where(DeliverySettlement.business_date <= date_to)
    return list(db.execute(stmt.order_by(DeliverySettlement.at.desc())).scalars())


def open_shift_of(db: Session, *, store_id: int) -> Shift | None:
    return db.execute(
        select(Shift).where(Shift.store_id == store_id, Shift.status == ShiftStatus.OPEN)
    ).scalar_one_or_none()


# ---------------------------------------------------------------------------
# Venta compensada de plataforma (NUNCA una merma)
# ---------------------------------------------------------------------------


def cancel_platform_sale(
    db: Session, *, actor: Any, store: Store, order: Any, reason: str, now: datetime
) -> dict[str, Any]:
    """Cancelar una venta de plataforma **después de preparar** compensa la
    VENTA. No genera merma y no repone inventario.

    Por qué, escrito donde se lee: el insumo ya se descontó al enviar
    (`app.orders.service._apply_send` → `record_movement(cause=SALE)`, 2a) y
    **se queda descontado** — el plato se cocinó de verdad—. Lo que se
    deshace es el cobro, no el consumo. Meterlo en mermas falsearía el KPI
    de mermas ÷ compras que 2b construyó, que es justo el número con el que
    el dueño juzga si le están robando.

    Mecánica:

    1. Documento fiscal vivo de la comanda → se compensa con
       `app.fiscal.service.issue_note`, **forzando `returns_to_stock=False`
       en TODAS las líneas**. Ese flag es el que dispara
       `app.orders.hooks.reverse_item_consumption` (B-1 de 2a); acá NO debe
       revertir nada, y por eso se manda explícito en vez de confiar en el
       default (que es `True`).
       - `pos_equivalent` → nota de **ajuste**; `invoice` → nota **crédito**
         (`ORIGINAL_TYPE_FOR_NOTE`, SPEC-NEGOCIO §8.3).
       - `internal_receipt` (sede con `fiscal.dee_pos` apagada) **no es un
         documento fiscal** y no tiene rango de notas: la cancelación se
         registra igual y sin nota. No es un caso olvidado: emitir una nota
         contra algo que declara no ser factura sería peor.
    2. Sin documento todavía (la comanda nunca se cobró) la cancelación
       **tampoco** genera merma ni repone inventario. Está dicho acá y
       probado en `tests/channels/test_platform_cancellation.py`.
    3. La cuenta por cobrar pasa a `reversed` y la comisión recibe su
       asiento `kind=REVERSAL` — ninguna de las dos se borra.
    4. La comanda la marca su propio dueño: CONTRATO C4,
       `app.orders.hooks.mark_platform_order_cancelled`, llamado con
       `find_spec_safe` porque lo construye `backend-canales-comanda` en
       paralelo. Este agente **no escribe en `app/orders/**`**.
    """
    from app.fiscal.models import FiscalDocument, FiscalDocumentType
    from app.fiscal.schemas import NoteLineIn

    document = db.execute(
        select(FiscalDocument)
        .where(
            FiscalDocument.order_id == order.id,
            FiscalDocument.status == "issued",
            FiscalDocument.document_type.in_(
                [
                    FiscalDocumentType.POS_EQUIVALENT,
                    FiscalDocumentType.INVOICE,
                    FiscalDocumentType.INTERNAL_RECEIPT,
                ]
            ),
        )
        .order_by(FiscalDocument.id)
    ).scalars().first()

    note: FiscalDocument | None = None
    if document is not None and document.document_type in (
        FiscalDocumentType.POS_EQUIVALENT,
        FiscalDocumentType.INVOICE,
    ):
        kind = "adjustment" if document.document_type == FiscalDocumentType.POS_EQUIVALENT else "credit"
        lines_in = [
            # `returns_to_stock=False` EXPLÍCITO en todas: el default del
            # esquema es `True` ("vuelve"), y confiar en un default para no
            # reponer inventario es exactamente cómo se cuela un bug de
            # inventario que nadie ve hasta el conteo.
            NoteLineIn(item_id=int(line["item_id"]), used=True, returns_to_stock=False)
            for line in document.lines
        ]
        if lines_in:
            from app.fiscal import service as fiscal_service

            note, returned_ids = fiscal_service.issue_note(
                db,
                original=document,
                kind=kind,
                reason=reason,
                lines_in=lines_in,
                actor=actor,
                store=store,
                business_date=tz.business_date_for(now, store.cutoff_hour),
                now=now,
            )
            # Invariante del pedido, cobrado en el momento: si algo revirtió
            # inventario, `returns_to_stock=False` dejó de cumplirse y la
            # merma que este pedido existe para evitar ya está escrita.
            #
            # Ronda 3, cierre de H-6: esto era un `assert` pelado. Un
            # `assert` **desaparece con `python -O`** —que es como corre un
            # proceso de producción afinado— así que el invariante más caro
            # del pedido quedaba sin defensa justo donde importa; y si se
            # cumplía salía como `AssertionError` → `500`, no como la forma
            # de error del proyecto. Ahora es un `AppError` tipado.
            #
            # El `rollback()` va ANTES de levantarlo y no es decorativo:
            # `get_db` (app/core/db.py:122) comitea **también** ante
            # `AppError`, así que sin él se guardaría exactamente el
            # movimiento de inventario que este error existe para impedir —
            # la nota emitida y la reposición ya escrita en la sesión—.
            # Deshacer la transacción entera deja el sistema como estaba: no
            # queda nada a medias.
            if returned_ids:
                db.rollback()
                raise AppError(
                    "PLATFORM_CANCEL_WOULD_RESTOCK",
                    "La cancelación de esta venta de plataforma habría repuesto inventario "
                    f"(ítems {sorted(returned_ids)}) y no se registró nada. Una venta de "
                    "plataforma cancelada después de preparar se compensa como venta, nunca "
                    "como merma: el insumo ya se consumió. Revisá la ficha de esos ítems con "
                    "el administrador antes de reintentar",
                    status=409,
                )

    receivable_reversed_id: int | None = None
    commission_reversed_id: int | None = None
    receivable = db.execute(
        select(PlatformReceivable).where(
            PlatformReceivable.order_id == order.id,
            PlatformReceivable.status == PlatformReceivableStatus.PENDING,
        )
    ).scalars().first()
    if receivable is not None:
        receivable.status = PlatformReceivableStatus.REVERSED
        receivable.reversed_at = now
        receivable.reversed_reason = reason
        receivable.reversed_by_employee_id = getattr(actor, "employee_id", None)
        receivable.reversed_by_employee_name = getattr(actor, "employee_name", None)
        db.flush()
        receivable_reversed_id = receivable.id

        original_commission = db.execute(
            select(PlatformCommission).where(
                PlatformCommission.receivable_id == receivable.id,
                PlatformCommission.kind == LedgerEntryKind.CHARGE,
            )
        ).scalars().first()
        if original_commission is not None:
            reversal = PlatformCommission(
                organization_id=original_commission.organization_id,
                store_id=original_commission.store_id,
                platform_id=original_commission.platform_id,
                order_id=original_commission.order_id,
                document_id=note.id if note is not None else original_commission.document_id,
                receivable_id=receivable.id,
                kind=LedgerEntryKind.REVERSAL,
                base_amount=original_commission.base_amount,
                # El porcentaje CONGELADO del asiento original, no el de
                # hoy: compensar con otro porcentaje dejaría un residuo.
                commission_bp=original_commission.commission_bp,
                amount=original_commission.amount,
                business_date=tz.business_date_for(now, store.cutoff_hour),
                at=now,
                reason=reason,
                employee_id=getattr(actor, "employee_id", None),
                employee_name=getattr(actor, "employee_name", None),
            )
            db.add(reversal)
            db.flush()
            commission_reversed_id = reversal.id

    # CONTRATO C4 (lo publica `backend-canales-comanda`, acá sólo se llama).
    order_marked = False
    if find_spec_safe("app.orders.hooks") is not None:
        orders_hooks = importlib.import_module("app.orders.hooks")
        mark = getattr(orders_hooks, "mark_platform_order_cancelled", None)
        if mark is not None:
            mark(db, order=order, actor=actor, now=now, reason=reason)
            order_marked = True

    record_audit(
        db,
        actor=actor,
        organization_id=store.organization_id,
        store_id=store.id,
        entity="order",
        entity_id=order.id,
        action="platform_cancellation",
        before={"document_id": document.id if document is not None else None},
        after={
            "note_document_id": note.id if note is not None else None,
            "receivable_reversed_id": receivable_reversed_id,
            "commission_reversed_id": commission_reversed_id,
            # Los dos `False` quedan en la auditoría a propósito: son la
            # regla del pedido, no un detalle de implementación.
            "restocked": False,
            "waste_created": False,
        },
        reason=reason,
    )

    return {
        "order_id": order.id,
        "note_document_id": note.id if note is not None else None,
        "note_full_number": f"{note.prefix}-{note.number:06d}" if note is not None else None,
        "receivable_reversed_id": receivable_reversed_id,
        "commission_reversed_id": commission_reversed_id,
        "order_marked": order_marked,
        "restocked": False,
        "waste_created": False,
        "reason": reason,
    }
