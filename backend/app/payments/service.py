"""`pay_order` y el comprobante impreso (`CONTRATO-INTERNO-1b-1.md §2.3`,
«Cobro y comprobante» §2.4).

Todo se **valida antes de escribir** (`app.core.db.get_db` commitea también
ante `AppError`, `AGENTS.md`): la asignación de propina por medio y el
cálculo de cambio (`TENDERED_TOO_LOW`) no dependen de ninguna escritura
previa, así que se resuelven junto con el resto de "medios" — antes de
`auto_send_pending_for_payment`/`claim_payment` — en vez de después como
sugiere la prosa del contrato (que describe la fórmula, no el orden de
ejecución). Documentado en el entregable (decisión declarada).

Todo o nada: un `AppError` a mitad de `pay_order` no dejó ninguna escritura
de negocio (ni turno, ni comanda, ni pago) porque todavía no se llegó a
escribir nada.
"""

from __future__ import annotations

import importlib
from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.audit.service import record_audit
from app.auth import service as auth_service
from app.auth.deps import Actor
from app.auth.models import Employee
from app.core import clock, features, modules
from app.core.errors import AppError, ConflictError, NotFoundError
from app.fiscal import service as fiscal_service
from app.fiscal.models import DianStatus, DocumentReprint, FiscalDocument, FiscalDocumentType, FiscalRange
from app.fiscal.schemas import FiscalRangeRefOut
from app.orders import money
from app.orders import service as orders_service
from app.orders.models import (
    Order,
    OrderChannel,
    OrderItem,
    OrderItemStatus,
    OrderSubAccount,
    OrderSubAccountItem,
    OrderTable,
)
from app.payments.models import Payment, OrderTip
from app.payments.schemas import (
    DevicePaymentMethodOut,
    DocumentCustomerOut,
    DocumentFiscalOut,
    DocumentLineOut,
    DocumentOrderRefOut,
    DocumentPaymentLineOut,
    DocumentPrintableOut,
    DocumentRefOut,
    DocumentReprintOut,
    DocumentStoreOut,
    DocumentTipOut,
    PaymentIn,
    PaymentOut,
    TipIn,
)
from app.shifts.models import Shift
from app.stores import service as stores_service
from app.stores.models import Store, Table

_TYPE_LABELS: dict[str, str] = {
    "pos_equivalent": "Documento equivalente POS",
    "invoice": "Factura electrónica",
    "adjustment_note": "Nota de ajuste",
    "credit_note": "Nota crédito",
    "debit_note": "Nota débito",
    "internal_receipt": "Comprobante interno",
}


def _full_number(prefix: str, number: int) -> str:
    return f"{prefix}-{number:06d}"


# ---------------------------------------------------------------------------
# pay_order: piezas de validación (todas ANTES de escribir nada)
# ---------------------------------------------------------------------------


def _check_version(db: Session, order: Order, expected_version: int | None) -> None:
    if expected_version is None:
        return
    if order.version != expected_version:
        raise ConflictError(
            "La comanda cambió en otra tablet: revisá y repetí la acción",
            code="STALE_VERSION",
            extra={"order": orders_service.order_out(db, order, for_device=True).model_dump(mode="json")},
        )


def _actor_employee_can_charge(db: Session, actor: Actor) -> Employee:
    employee = db.get(Employee, actor.employee_id) if actor.employee_id is not None else None
    if employee is None or not employee.active:
        raise AppError("CANNOT_CHARGE", "Pedí a alguien con permiso de cobro", status=400)
    if not employee.can_charge:
        raise AppError("CANNOT_CHARGE", "Pedí a alguien con permiso de cobro", status=400)
    return employee


def _verify_own_pin(db: Session, employee: Employee, pin: str) -> None:
    ok = auth_service.verify_pin(db, employee, pin)
    if ok:
        return
    now = clock.now_utc()
    if employee.pin_locked_until is not None and employee.pin_locked_until > now:
        raise AppError(
            code="PIN_LOCKED",
            message="Tu PIN está bloqueado por varios minutos tras intentos fallidos",
            status=400,
        )
    raise AppError(code="PIN_INVALID", message="PIN incorrecto; intentá de nuevo", status=400)


@dataclass(frozen=True)
class _TipResolution:
    asked: bool
    amount: int
    accepted: bool | None
    modified: bool | None
    suggested_pct: Decimal | None
    suggested_amount: int
    base: int


_NO_TIP = _TipResolution(asked=False, amount=0, accepted=None, modified=None, suggested_pct=None, suggested_amount=0, base=0)


def _resolve_tip(db: Session, order: Order, totals: money.OrderTotals, tip_in: TipIn | None) -> _TipResolution:
    if order.channel == OrderChannel.STAFF_MEAL:
        return _NO_TIP
    if not features.is_enabled(db, order.organization_id, order.store_id, "pos.tips"):
        return _NO_TIP

    if tip_in is None or not tip_in.asked:
        raise AppError("TIP_NOT_ASKED", "Preguntá si la persona desea dejar propina antes de cobrar", status=400)
    if tip_in.amount < 0:
        raise AppError("TIP_INVALID", "La propina no puede ser negativa", status=400)

    settings = stores_service.get_sales_settings(db, order.store_id)
    pct = Decimal(str(settings.tip_suggested_pct))
    if pct > Decimal("10"):
        pct = Decimal("10")
    if pct < 0:
        pct = Decimal("0")
    tip_base = max(totals.tip_base, 0)
    basis_points = int((pct * 100).to_integral_value())
    suggested_amount = money.round_half_up(tip_base * basis_points, 10000)

    return _TipResolution(
        asked=True,
        amount=tip_in.amount,
        accepted=tip_in.accepted,
        modified=tip_in.modified,
        suggested_pct=pct,
        suggested_amount=suggested_amount,
        base=tip_base,
    )


def _payment_methods_by_code(db: Session, store_id: int) -> dict[str, dict[str, Any]]:
    settings = stores_service.get_sales_settings(db, store_id)
    return {m["code"]: m for m in settings.payment_methods if m.get("enabled")}


@dataclass(frozen=True)
class _SplitResult:
    method: str
    amount: int  # parte de la venta (nunca incluye propina)
    tip_amount: int  # propina que viaja en este pago
    tendered: int | None
    change: int
    reference: str | None


def cash_change(*, amount: int, tendered: int) -> int | None:
    """El vuelto de un pago en efectivo: lo recibido menos lo que se cobra con
    ese billete. `None` si lo recibido no alcanza (nunca un vuelto negativo).

    Es LA cuenta del vuelto: la usan el cobro (`_validate_and_allocate_splits`)
    y la vista previa que la caja pide mientras teclea lo recibido
    (`preview_change`), para que la cifra que se le dice al cliente antes de
    cobrar sea exactamente la que queda en el comprobante."""
    change = tendered - amount
    return change if change >= 0 else None


def preview_change(splits: list[Any]) -> dict[str, Any]:
    """Vista previa del vuelto, SIN escribir nada: por cada pago en efectivo
    con `tendered`, cuánto se devuelve (o cuánto falta si no alcanza)."""
    rows: list[dict[str, Any]] = []
    total = 0
    for split in splits:
        change = cash_change(amount=split.amount, tendered=split.tendered)
        rows.append(
            {
                "change": change,
                "short_by": None if change is not None else split.amount - split.tendered,
            }
        )
        total += change or 0
    return {"splits": rows, "change_total": total}


def _validate_and_allocate_splits(
    splits_in: list[Any], *, methods_by_code: dict[str, dict[str, Any]], total: int, tip_amount: int
) -> list[_SplitResult]:
    """Valida cada `split` (medio habilitado, referencia si aplica, `tendered`
    sólo en efectivo), exige que la suma cubra exactamente venta + propina, y
    reparte esa propina entre los medios recorriendo los `splits` en orden:
    cada uno cubre primero venta y el excedente es propina de ese medio."""
    received = sum(s.amount for s in splits_in)
    expected = total + tip_amount
    for split in splits_in:
        method_cfg = methods_by_code.get(split.method)
        if method_cfg is None:
            raise AppError(
                "PAYMENT_METHOD_INVALID", f'El medio de pago "{split.method}" no está habilitado', status=400
            )
        if method_cfg.get("requires_reference") and not split.reference:
            raise AppError(
                "PAYMENT_REFERENCE_REQUIRED", "Este medio de pago exige una referencia", status=400
            )
        if split.tendered is not None and split.method != "cash":
            raise AppError("CHANGE_ONLY_ON_CASH", "El cambio sólo aplica al pago en efectivo", status=400)

    if received != expected:
        raise AppError(
            "SPLITS_DO_NOT_MATCH",
            "La suma de los pagos no coincide con el total a cobrar",
            status=400,
            extra={"expected": expected, "received": received},
        )

    sale_remaining = total
    results: list[_SplitResult] = []
    for split in splits_in:
        sale_part = min(split.amount, sale_remaining)
        tip_part = split.amount - sale_part
        sale_remaining -= sale_part
        change = 0
        if split.method == "cash" and split.tendered is not None:
            cash = cash_change(amount=split.amount, tendered=split.tendered)
            if cash is None:
                raise AppError(
                    "TENDERED_TOO_LOW", "El efectivo recibido no alcanza para cubrir este pago", status=400
                )
            change = cash
        results.append(
            _SplitResult(
                method=split.method,
                amount=sale_part,
                tip_amount=tip_part,
                tendered=split.tendered,
                change=change,
                reference=split.reference,
            )
        )
    return results


# ---------------------------------------------------------------------------
# Snapshot del comprobante: líneas y mesas, leídas ANTES de que `claim_payment`
# libere las mesas.
# ---------------------------------------------------------------------------


def _order_document_lines(db: Session, order: Order, totals: money.OrderTotals) -> list[dict[str, Any]]:
    items = list(
        db.execute(
            select(OrderItem).where(OrderItem.order_id == order.id, OrderItem.status != OrderItemStatus.VOIDED)
        ).scalars()
    )
    items_by_id = {i.id: i for i in items}
    lines: list[dict[str, Any]] = []
    for lt in totals.lines:
        item = items_by_id.get(lt.item_id)
        if item is None:
            continue
        lines.append(
            {
                "item_id": lt.item_id,
                "qty": item.qty,
                "description": item.name,
                "unit_price": item.unit_price,
                "gross": lt.gross,
                "discount": lt.discount,
                "net": lt.net,
                "tax_rate": lt.tax_rate,
                "base": lt.base,
                "tax": lt.tax,
                "courtesy": item.courtesy_reason is not None,
            }
        )
    return lines


def _sub_account_document_lines(
    db: Session, order: Order, sub_account: OrderSubAccount, order_totals: money.OrderTotals
) -> list[dict[str, Any]]:
    """Prorratea cada línea de la comanda entre TODAS las sub-cuentas que
    comparten ese ítem (igual criterio que `orders.service._sub_account_item_allocations`,
    no expuesto: se replica acá con las mismas piezas públicas —
    `money.prorate` sobre `compute_order_totals` — para que la sub-cuenta que
    se está cobrando reciba exactamente su porción)."""
    line_by_item = {lt.item_id: lt for lt in order_totals.lines}
    rows = list(
        db.execute(
            select(OrderSubAccountItem, OrderSubAccount.id)
            .join(OrderSubAccount, OrderSubAccountItem.sub_account_id == OrderSubAccount.id)
            .where(OrderSubAccount.order_id == order.id)
            .order_by(OrderSubAccountItem.order_item_id, OrderSubAccount.seq, OrderSubAccountItem.id)
        ).all()
    )
    by_item: dict[int, list[tuple[OrderSubAccountItem, int]]] = {}
    for row, sa_id in rows:
        by_item.setdefault(row.order_item_id, []).append((row, sa_id))

    items_by_id = {i.id: i for i in db.execute(select(OrderItem).where(OrderItem.order_id == order.id)).scalars()}

    lines: list[dict[str, Any]] = []
    for item_id, entries in by_item.items():
        line = line_by_item.get(item_id)
        item = items_by_id.get(item_id)
        if line is None or item is None:
            continue
        weights = [entry.portions for entry, _sa_id in entries]
        gross_shares = money.prorate(line.gross, weights)
        discount_shares = money.prorate(line.discount, weights)
        base_shares = money.prorate(line.base, weights)
        net_shares = money.prorate(line.net, weights)
        for (entry, sa_id), gross, discount, base, net in zip(entries, gross_shares, discount_shares, base_shares, net_shares):
            if sa_id != sub_account.id:
                continue
            description = item.name if entry.of_portions <= 1 else f"{item.name} ({entry.portions}/{entry.of_portions})"
            lines.append(
                {
                    "item_id": item.id,
                    "qty": entry.portions,
                    "description": description,
                    "unit_price": item.unit_price,
                    "gross": gross,
                    "discount": discount,
                    "net": net,
                    "tax_rate": item.tax_rate,
                    "base": base,
                    "tax": net - base,
                    "courtesy": item.courtesy_reason is not None,
                }
            )
    return lines


def _tables_text(db: Session, order: Order) -> str | None:
    if order.channel != OrderChannel.DINE_IN:
        return None
    numbers = list(
        db.execute(
            select(Table.number)
            .join(OrderTable, OrderTable.table_id == Table.id)
            .where(OrderTable.order_id == order.id, OrderTable.released_at.is_(None))
            .order_by(Table.number)
        ).scalars()
    )
    return ", ".join(numbers) if numbers else None


def _payments_snapshot(splits: list[_SplitResult], methods_by_code: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {
            "method": s.method,
            "label": methods_by_code.get(s.method, {}).get("label", s.method),
            "dian_code": methods_by_code.get(s.method, {}).get("dian_code", ""),
            "amount": s.amount,
            "tip_amount": s.tip_amount,
            "tendered": s.tendered,
            "change": s.change,
            "reference": s.reference,
        }
        for s in splits
    ]


# ---------------------------------------------------------------------------
# Pedido 2c: los dos canales nuevos, validados ANTES de escribir.
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class _ChannelResolution:
    """Lo que 2c agrega al cobro, resuelto durante la VALIDACIÓN.

    `platform_id` sólo puede venir resuelto en una comanda de canal
    `platform`; `courier` sólo en una de canal `delivery`. Los dos son
    `None` en el resto de los casos, que es el 100 % de lo que 1b y 2a/2b
    ya hacían: sin `platform` en los `splits` y sin `delivery` en el body,
    esta resolución no cambia una coma del cobro de mesa.
    """

    platform_id: int | None = None
    courier: Employee | None = None
    external_id: str | None = None


def _resolve_channels(
    db: Session, *, order: Order, store: Store, payload: Any, split_results: list[_SplitResult]
) -> _ChannelResolution:
    """Valida plataforma y domiciliario **antes** del punto sin retorno.

    Las tres reglas que hace cumplir, y que el POS no puede sortear:

    1. El medio `platform` SÓLO se usa en una comanda de canal `platform`
       (`400 PLATFORM_METHOD_WRONG_CHANNEL`). Si no, cualquier venta de
       mesa podría salir del efectivo esperado del turno declarándose
       "cobrada por la plataforma".
    2. Una comanda de plataforma cobrada con ese medio necesita una
       plataforma **activa y de esta sede**: se resuelve por el CONTRATO
       C2 (`app.channels.hooks.get_platform`) y, ante `None`,
       `400 PLATFORM_NOT_FOUND`. Nunca se cae a un id "0".
    3. `delivery` en el body SÓLO en una comanda de canal `delivery`
       (`400 DELIVERY_ONLY_ON_DELIVERY_CHANNEL`) y con la función
       `pos.delivery` encendida.
    """
    platform_id: int | None = None
    external_id: str | None = None
    courier: Employee | None = None

    uses_platform_method = any(s.method == "platform" for s in split_results)
    channel_value = order.channel.value if hasattr(order.channel, "value") else str(order.channel)

    if uses_platform_method:
        if channel_value != "platform":
            raise AppError(
                "PLATFORM_METHOD_WRONG_CHANNEL",
                "El medio de pago por plataforma sólo se usa en una comanda de plataforma; "
                "cobrá esta comanda con un medio real",
                status=400,
            )
        features.assert_feature(db, order.organization_id, store.id, "pos.platforms")

        # La comanda manda; el body es el respaldo mientras
        # `backend-canales-comanda` termina de escribir la columna.
        #
        # Ronda 3, cierre de H-5: esto resolvía con `or`, que trata el `0`
        # como ausencia. Es la regla dura `null` ≠ 0 en el lugar donde se
        # decide QUÉ plataforma cobró una venta: un `platform_id = 0` de la
        # comanda habría caído silenciosamente al del body. Los dos
        # candidatos se chequean con `is not None`, la comanda primero.
        from_order = getattr(order, "platform_id", None)
        from_payload = getattr(payload, "platform_id", None)
        candidate = from_order if from_order is not None else from_payload
        if candidate is None:
            raise AppError(
                "PLATFORM_REQUIRED",
                "Indicá la plataforma que cobró este pedido antes de cerrarlo",
                status=400,
            )
        if modules.find_spec_safe("app.channels.hooks") is not None:
            channels_hooks = importlib.import_module("app.channels.hooks")
            platform_ref = channels_hooks.get_platform(db, store_id=store.id, platform_id=int(candidate))
            if platform_ref is None:
                raise AppError(
                    "PLATFORM_NOT_FOUND",
                    "La plataforma no existe en esta sede o está inactiva; revisá Configuración → Plataformas",
                    status=400,
                )
            platform_id = platform_ref.id
        else:  # pragma: no cover - `app.channels` es de este mismo agente
            platform_id = int(candidate)
        # `platform_external_id` es el número del pedido en la plataforma,
        # cargado a mano al abrir la comanda (la integración por API es
        # fase 3). Es el dato con el que se concilia después.
        external_id = getattr(order, "platform_external_id", None)

    delivery_in = getattr(payload, "delivery", None)
    if delivery_in is not None and channel_value != "delivery":
        raise AppError(
            "DELIVERY_ONLY_ON_DELIVERY_CHANNEL",
            "Sólo una comanda de domicilio puede dejar el efectivo en manos de un domiciliario",
            status=400,
        )

    if channel_value == "delivery":
        # **El domiciliario sale de la COMANDA por defecto**, no del body.
        # La comanda de domicilio ya lo lleva obligatorio desde que se crea
        # (`app.orders.service.create_order`), y §3.3 dice que ese efectivo
        # queda pendiente hasta que él liquida: hacerlo depender de que el
        # POS se acuerde de mandar un bloque extra convertiría la regla en
        # una opción, y el turno cuadraría de más justo cuando alguien se
        # olvidó. El body sólo sirve para CORREGIR quién entregó de verdad.
        #
        # Deliberadamente SIN `assert_feature` cuando se deriva de la
        # comanda: apagar `pos.delivery` con un domicilio abierto no puede
        # dejar esa venta sin poder cobrarse. El gate se exige sólo cuando
        # el cliente manda el bloque explícito, que es una acción nueva.
        candidate_courier_id = getattr(order, "courier_employee_id", None)
        if delivery_in is not None:
            features.assert_feature(db, order.organization_id, store.id, "pos.delivery")
            candidate_courier_id = delivery_in.courier_employee_id
        if candidate_courier_id is not None:
            courier = db.get(Employee, candidate_courier_id)
            if courier is None or courier.organization_id != order.organization_id or not courier.active:
                raise AppError(
                    "COURIER_NOT_FOUND",
                    "El domiciliario no existe (o está inactivo) en esta organización",
                    status=400,
                )

    return _ChannelResolution(platform_id=platform_id, courier=courier, external_id=external_id)


# ---------------------------------------------------------------------------
# pay_order
# ---------------------------------------------------------------------------


def pay_order(
    db: Session,
    *,
    actor: Actor,
    store: Store,
    shift: Shift | None,
    order: Order,
    payload: PaymentIn,
    now: datetime,
) -> PaymentOut:
    del shift  # el turno real se resuelve por `order.shift_id`, ya validado por `assert_payable`

    _check_version(db, order, payload.expected_version)
    employee = _actor_employee_can_charge(db, actor)
    _verify_own_pin(db, employee, payload.pin)

    sub_account: OrderSubAccount | None = None
    if payload.sub_account_id is not None:
        sub_account = orders_service.get_sub_account_or_404(db, order, payload.sub_account_id)

    orders_service.assert_payable(db, order, sub_account=sub_account)

    totals = (
        orders_service.compute_sub_account_totals(db, sub_account)
        if sub_account is not None
        else orders_service.compute_order_totals(db, order)
    )

    tip = _resolve_tip(db, order, totals, payload.tip)
    methods_by_code = _payment_methods_by_code(db, store.id)
    split_results = _validate_and_allocate_splits(
        payload.splits, methods_by_code=methods_by_code, total=totals.total, tip_amount=tip.amount
    )
    # Pedido 2c: plataforma y domiciliario se resuelven ACÁ, entre las
    # validaciones, porque pueden levantar `400` y `get_db` comitea también
    # ante `AppError`. Validar antes de escribir.
    channels = _resolve_channels(
        db, order=order, store=store, payload=payload, split_results=split_results
    )

    # `business_date`/`shift_row` son lecturas puras (sin escritura): se
    # resuelven ACÁ, antes del punto sin retorno, porque
    # `resolve_document_type_for_payment` (abajo) también es validación —
    # puede levantar `CUSTOMER_REQUIRED_FOR_INVOICE`/`FEATURE_DISABLED` — y
    # tiene que pasar ANTES de escribir nada (`get_db` comitea también ante
    # `AppError`: validar antes de escribir).
    shift_row = db.get(Shift, order.shift_id)
    if shift_row is None:
        # Defensivo: `assert_payable` ya garantizó un turno abierto vigente.
        raise AppError("NO_OPEN_SHIFT", "Abrí un turno para poder cobrar esta comanda", status=400)
    business_date = orders_service.business_date_for_sale(db, shift_row, store, now)

    customer_identified = fiscal_service.customer_is_identified(payload.customer)
    document_type = fiscal_service.resolve_document_type_for_payment(
        db,
        organization_id=order.organization_id,
        store_id=store.id,
        total_net=totals.tip_base,
        business_date=business_date,
        customer_identified=customer_identified,
        requests_invoice=payload.requests_invoice,
    )
    # Chequeo temprano (sin reservar todavía): sin esto, un `NO_FISCAL_RANGE`
    # que sólo aparece dentro de `issue_document` (después de `claim_payment`,
    # más abajo) dejaría la comanda `paid` sin documento — `claim_payment` no
    # está dentro del SAVEPOINT que protege la emisión. «Validar antes de
    # escribir» exige cortar acá. Sólo cuando `splits` no está vacío: sin
    # splits (staff_meal / todo cortesía) nunca se emite documento.
    if split_results:
        fiscal_service.assert_range_available(
            db, store_id=store.id, document_type=document_type, business_date=business_date
        )

    # Ronda 2 — B-2 (Conciliador): mismo patrón que el chequeo de arriba.
    # `resolve_customer_snapshot` (más abajo, en la fase de escritura) es la
    # única puerta hacia `app.customers.hooks.upsert_customer_with_consent`,
    # que YA levanta `400 FEATURE_DISABLED` si la flag `customers` está
    # apagada (`app/customers/hooks.py:91`) — pero ese gate vive DESPUÉS de
    # `claim_payment` (línea de escritura, más abajo), dentro del mismo
    # `SAVEPOINT` que protege `issue_document`. `get_db` comitea también ante
    # `AppError`, y el `SAVEPOINT` de `issue_document` no revierte
    # `claim_payment`: sin este chequeo temprano, cobrar con `customer` en el
    # body y la flag apagada dejaba la comanda `paid` sin documento y sin
    # pago (mismo defecto de forma que el `NO_FISCAL_RANGE` de §5.1).
    # Misma condición bajo la que HOY se llega a `resolve_customer_snapshot`
    # (dentro de `if split_results:`, gancho sólo si `payload.customer` no es
    # `None`): no cambia el comportamiento de ningún caso que ya funciona —
    # una comanda 100% cortesía/staff_meal (sin `splits`) sigue sin tocar
    # `customers`, con o sin `customer` en el body.
    if split_results and payload.customer is not None:
        features.assert_feature(db, order.organization_id, store.id, "customers")

    # Snapshot del comprobante ANTES de escribir: `claim_payment` libera las
    # mesas al dejar la comanda `paid`, y después ya no se puede leer qué
    # mesas tenía.
    order_totals_for_lines = (
        orders_service.compute_order_totals(db, order) if sub_account is not None else totals
    )
    document_lines = (
        _sub_account_document_lines(db, order, sub_account, order_totals_for_lines)
        if sub_account is not None
        else _order_document_lines(db, order, totals)
    )
    tables_text = _tables_text(db, order)

    # -- A partir de acá, todo lo anterior ya validó: se escribe. ----------
    orders_service.auto_send_pending_for_payment(db, order, actor=actor, now=now)
    orders_service.claim_payment(db, order, sub_account=sub_account, actor=actor, now=now)

    document: FiscalDocument | None = None
    # Pedido 2c: `None` (no `0`) cuando no hubo cobro por plataforma ni
    # efectivo en manos de un domiciliario. `null` ≠ 0.
    platform_commission: int | None = None
    platform_receivable_id: int | None = None
    delivery_cash_pending = 0
    if split_results:
        payments_snapshot = _payments_snapshot(split_results, methods_by_code)
        tip_snapshot = fiscal_service.TipSnapshot(
            amount=tip.amount,
            suggested_pct=float(tip.suggested_pct) if tip.suggested_pct is not None else None,
            accepted=tip.accepted,
            modified=tip.modified,
        )
        customer_snapshot = fiscal_service.resolve_customer_snapshot(
            db,
            organization_id=order.organization_id,
            store_id=store.id,
            customer_in=payload.customer,
            actor=actor,
            now=now,
        )
        try:
            with db.begin_nested():
                document = fiscal_service.issue_document(
                    db,
                    order=order,
                    sub_account=sub_account,
                    shift=shift_row,
                    store=store,
                    actor=actor,
                    document_type=document_type,
                    totals=totals,
                    tip=tip_snapshot,
                    lines=document_lines,
                    payments_snapshot=payments_snapshot,
                    tables_text=tables_text,
                    business_date=business_date,
                    now=now,
                    customer=customer_snapshot,
                )
        except IntegrityError as exc:
            raise ConflictError(
                "Esta comanda ya fue cobrada; consultá el comprobante", code="ORDER_ALREADY_PAID"
            ) from exc

        if sub_account is not None:
            sub_account.document_id = document.id
            db.flush()

        if tip.asked:
            db.add(
                OrderTip(
                    order_id=order.id,
                    sub_account_id=sub_account.id if sub_account is not None else None,
                    asked=True,
                    accepted=bool(tip.accepted),
                    modified=bool(tip.modified),
                    amount=tip.amount,
                    suggested_pct=tip.suggested_pct if tip.suggested_pct is not None else Decimal("0"),
                    suggested_amount=tip.suggested_amount,
                    base=tip.base,
                    at=now,
                )
            )

        platform_amount = 0
        platform_tip = 0
        delivery_cash_pending = 0
        first_platform_payment: Payment | None = None
        for split in split_results:
            # Pedido 2c. Sólo el efectivo de un domicilio queda en manos del
            # domiciliario: una tarjeta cobrada en la puerta ya está en la
            # cuenta del negocio, y no tiene nada pendiente que liquidar.
            is_delivery_cash = channels.courier is not None and split.method == "cash"
            is_platform = split.method == "platform"
            row = Payment(
                organization_id=order.organization_id,
                store_id=store.id,
                shift_id=shift_row.id,
                order_id=order.id,
                sub_account_id=sub_account.id if sub_account is not None else None,
                document_id=document.id,
                method=split.method,
                amount=split.amount,
                tip_amount=split.tip_amount,
                tendered=split.tendered,
                change=split.change,
                reference=split.reference,
                employee_id=employee.id,
                employee_name=employee.name,
                business_date=business_date,
                at=now,
                voided_at=None,
                delivery_courier_employee_id=(
                    channels.courier.id if is_delivery_cash and channels.courier is not None else None
                ),
                delivery_courier_employee_name=(
                    channels.courier.name if is_delivery_cash and channels.courier is not None else None
                ),
                delivery_settlement_id=None,
                platform_id=channels.platform_id if is_platform else None,
            )
            db.add(row)
            if is_delivery_cash:
                delivery_cash_pending += split.amount + split.tip_amount
            if is_platform:
                platform_amount += split.amount
                platform_tip += split.tip_amount
                if first_platform_payment is None:
                    first_platform_payment = row
        db.flush()

        # La cuenta por cobrar y la COMISIÓN de la plataforma. La comisión
        # se REGISTRA, no se resta: ni `totals`, ni `tip`, ni el documento
        # fiscal, ni `amount_due` la conocen. Vive en `app.channels`.
        if channels.platform_id is not None and platform_amount + platform_tip > 0:
            if modules.find_spec_safe("app.channels.service") is not None:
                channels_service = importlib.import_module("app.channels.service")
                record = channels_service.record_platform_sale(
                    db,
                    organization_id=order.organization_id,
                    store_id=store.id,
                    platform_id=channels.platform_id,
                    order_id=order.id,
                    document_id=document.id,
                    payment_id=first_platform_payment.id if first_platform_payment is not None else None,
                    shift_id=shift_row.id,
                    external_id=channels.external_id,
                    amount=platform_amount,
                    tip_amount=platform_tip,
                    actor=actor,
                    business_date=business_date,
                    now=now,
                )
                if record is not None:
                    platform_commission = record.commission_amount
                    platform_receivable_id = record.receivable_id

    record_audit(
        db,
        actor=actor,
        organization_id=order.organization_id,
        store_id=order.store_id,
        entity="order",
        entity_id=order.id,
        action="pay",
        before=None,
        after={
            "document_id": document.id if document is not None else None,
            "sub_account_id": sub_account.id if sub_account is not None else None,
            "total": totals.total,
            "tip_amount": tip.amount,
            "splits": len(split_results),
        },
    )

    change_total = sum(s.change for s in split_results)
    document_ref = (
        DocumentRefOut(
            id=document.id,
            document_type=document.document_type.value,  # type: ignore[arg-type]
            prefix=document.prefix,
            number=document.number,
            full_number=_full_number(document.prefix, document.number),
            dian_status=document.dian_status.value if document.dian_status else None,  # type: ignore[union-attr]
            legend=document.legend,
            cude=document.cude,
            qr_url=document.qr_url,
            contingency=document.dian_status == DianStatus.CONTINGENCY,
        )
        if document is not None
        else None
    )

    return PaymentOut(
        order_id=order.id,
        sub_account_id=sub_account.id if sub_account is not None else None,
        document=document_ref,
        total=totals.total,
        tip_amount=tip.amount,
        # A-10: siempre sumado acá, presente siempre (nunca `?? 0` del cliente).
        amount_due=totals.total + tip.amount,
        requires_invoice=document is not None and document_type == FiscalDocumentType.INVOICE,
        change=change_total,
        paid_at=order.paid_at or now,
        order=orders_service.order_out(db, order, for_device=True),
        platform_commission=platform_commission,
        platform_receivable_id=platform_receivable_id,
        delivery_cash_pending=delivery_cash_pending or None,
    )


# ---------------------------------------------------------------------------
# Documentos
# ---------------------------------------------------------------------------


def get_document_or_404(db: Session, *, actor: Actor, document_id: int) -> FiscalDocument:
    document = db.get(FiscalDocument, document_id)
    if document is None or document.organization_id != actor.organization_id:
        raise NotFoundError("El comprobante no existe")
    if actor.kind == "device" and document.store_id != actor.store_id:
        raise NotFoundError("El comprobante no existe")
    return document


def get_last_document(db: Session, *, store_id: int) -> FiscalDocument | None:
    stmt = (
        select(FiscalDocument)
        .where(FiscalDocument.store_id == store_id, FiscalDocument.status == "issued")
        .order_by(FiscalDocument.issued_at.desc(), FiscalDocument.id.desc())
        .limit(1)
    )
    return db.execute(stmt).scalars().first()


def reprint_document(db: Session, *, actor: Actor, document: FiscalDocument) -> FiscalDocument:
    document.reprint_count += 1
    db.add(
        DocumentReprint(
            document_id=document.id,
            employee_id=actor.employee_id,  # type: ignore[arg-type]
            employee_name=actor.employee_name or "",
            at=clock.now_utc(),
        )
    )
    db.flush()
    return document


def document_printable(db: Session, document: FiscalDocument) -> DocumentPrintableOut:
    reprints = list(
        db.execute(
            select(DocumentReprint).where(DocumentReprint.document_id == document.id).order_by(DocumentReprint.at)
        ).scalars()
    )
    tip_out: DocumentTipOut | None = None
    if document.tip_accepted is not None or document.tip_modified is not None:
        tip_out = DocumentTipOut(
            amount=document.tip_amount,
            suggested_pct=float(document.tip_suggested_pct) if document.tip_suggested_pct is not None else None,
            accepted=document.tip_accepted,
            modified=document.tip_modified,
        )

    tables = [t.strip() for t in document.tables_text.split(",")] if document.tables_text else []

    return DocumentPrintableOut(
        id=document.id,
        document_type=document.document_type.value,  # type: ignore[arg-type]
        type_label=_TYPE_LABELS.get(document.document_type.value, document.document_type.value),
        prefix=document.prefix,
        number=document.number,
        full_number=_full_number(document.prefix, document.number),
        dian_status=document.dian_status.value if document.dian_status else None,  # type: ignore[union-attr]
        legend=document.legend,
        business_date=document.business_date,
        issued_at=document.issued_at,
        store=DocumentStoreOut(
            legal_name=document.store_snapshot.get("legal_name"),
            nit=document.store_snapshot.get("nit"),
            dv=document.store_snapshot.get("dv"),
            address=document.store_snapshot.get("address"),
            municipality_dane=document.store_snapshot.get("municipality_dane"),
        ),
        customer=DocumentCustomerOut(
            doc_type=document.customer_doc_type,
            doc_number=document.customer_doc_number,
            name=document.customer_name,
            email=document.customer_email,
            address=document.customer_address,
            municipality_dane=document.customer_municipality_dane,
        ),
        order=DocumentOrderRefOut(
            id=document.order_id,
            channel=document.channel,
            tables=tables,
            covers=document.covers,
            served_by=document.served_by_name,
            charged_by=document.charged_by_employee_name,
        ),
        lines=[DocumentLineOut(**line) for line in document.lines],
        subtotal=document.subtotal,
        discount_total=document.discount_total,
        tax_lines=document.tax_lines,  # type: ignore[arg-type]
        tax_total=document.tax_total,
        total=document.total,
        tip=tip_out,
        payments=[DocumentPaymentLineOut(**p) for p in document.payments_snapshot],
        change=sum(p.get("change", 0) for p in document.payments_snapshot),
        print_count=document.print_count,
        reprint_count=document.reprint_count,
        reprints=[DocumentReprintOut(at=r.at, by=r.employee_name) for r in reprints],
        fiscal=_document_fiscal_out(db, document),
    )


def _document_fiscal_out(db: Session, document: FiscalDocument) -> DocumentFiscalOut:
    """A-11: todo lo que hace variar la leyenda (estado DIAN, contingencia)
    más el rango vigente que amparó el consecutivo — nunca `None` a secas
    salvo el rango, cuando el documento no reserva uno (`internal_receipt`)."""
    range_ref: FiscalRangeRefOut | None = None
    if document.fiscal_range_id is not None:
        range_row = db.get(FiscalRange, document.fiscal_range_id)
        if range_row is not None:
            range_ref = FiscalRangeRefOut(
                id=range_row.id,
                prefix=range_row.prefix,
                from_number=range_row.from_number,
                to_number=range_row.to_number,
                resolution_number=range_row.resolution_number,
                valid_until=range_row.valid_until,
            )
    return DocumentFiscalOut(
        dian_status=document.dian_status.value if document.dian_status else None,  # type: ignore[union-attr]
        cude=document.cude,
        qr_url=document.qr_url,
        contingency=document.dian_status == DianStatus.CONTINGENCY,
        range=range_ref,
    )


# ---------------------------------------------------------------------------
# Admin
# ---------------------------------------------------------------------------


def admin_list_documents(
    db: Session,
    *,
    store_id: int,
    date_from: date | None,
    date_to: date | None,
    document_type: str | None = None,
    status: str | None = None,
) -> list[dict[str, Any]]:
    """`GET /admin/documents?from&to&type&status` (+ `format=csv`, pedido
    1b-2 punto 9: la ruta ya existía desde 1b-1 con `from`/`to`; acá se
    amplía con `type` (`document_type`) y `status` (`dian_status`)."""
    stmt = select(FiscalDocument).where(FiscalDocument.store_id == store_id, FiscalDocument.status == "issued")
    if date_from is not None:
        stmt = stmt.where(FiscalDocument.business_date >= date_from)
    if date_to is not None:
        stmt = stmt.where(FiscalDocument.business_date <= date_to)
    if document_type is not None:
        stmt = stmt.where(FiscalDocument.document_type == FiscalDocumentType(document_type))
    if status is not None:
        stmt = stmt.where(FiscalDocument.dian_status == DianStatus(status))
    stmt = stmt.order_by(FiscalDocument.issued_at.desc())
    rows = list(db.execute(stmt).scalars())
    return [
        {
            "id": d.id,
            "full_number": _full_number(d.prefix, d.number),
            "document_type": d.document_type.value,
            "dian_status": d.dian_status.value if d.dian_status else None,
            "business_date": d.business_date.isoformat(),
            "issued_at": d.issued_at.isoformat(),
            "order_id": d.order_id,
            "total": d.total,
            "tip_amount": d.tip_amount,
            "charged_by": d.charged_by_employee_name,
        }
        for d in rows
    ]


# ---------------------------------------------------------------------------
# Dispositivo: medios de pago habilitados de la sede
# ---------------------------------------------------------------------------


def device_payment_methods(db: Session, *, store_id: int) -> list[DevicePaymentMethodOut]:
    """`GET /device/payment-methods` (gap declarado en `outputs-1b-1/*.md`:
    el POS ofrecía siempre los mismos seis códigos fijos). Sólo los
    habilitados de `StoreSalesSettings.payment_methods`."""
    settings = stores_service.get_sales_settings(db, store_id)
    return [
        DevicePaymentMethodOut(
            code=m["code"],
            label=m["label"],
            dian_code=m.get("dian_code", ""),
            requires_reference=bool(m.get("requires_reference", False)),
        )
        for m in settings.payment_methods
        if m.get("enabled")
    ]
