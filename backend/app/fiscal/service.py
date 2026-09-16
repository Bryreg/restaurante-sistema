"""Rangos de numeración DIAN, consecutivo, adaptador de proveedor, estados
ante la DIAN, notas y evidencia (`app.fiscal.service`; pedido 1b-2, sobre lo
que dejó `CONTRATO-INTERNO-1b-1.md §2.3`).

**Invariante que no se negocia**: un rechazo NO libera el número. El
consecutivo se reserva en `reserve_next_number` (dentro de la transacción del
cobro/nota) y nunca se revierte por lo que responda el `FiscalProvider`
después — sólo un `rollback` de TODA la transacción (un `AppError` de
validación anterior) lo devuelve, y eso pasa siempre ANTES de reservar
(`app.payments.service.pay_order` valida todo antes de escribir).
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core import clock, features
from app.core.errors import AppError
from app.core.modules import find_spec_safe
from app.fiscal.models import (
    DianStatus,
    FiscalCounter,
    FiscalDocument,
    FiscalDocumentType,
    FiscalRange,
)
from app.fiscal.provider import EmitResult, get_provider
from app.fiscal.schemas import (
    DocumentEvidenceOut,
    ExportBundleOut,
    ExportManifestEntry,
    FiscalRangeOut,
    FiscalRangeRefOut,
)
from app.notifications import service as notifications_service
from app.orders import hooks as orders_hooks
from app.orders.models import Order, OrderItem, OrderSubAccount
from app.orders.money import OrderTotals
from app.shifts.models import Shift
from app.stores import service as stores_service
from app.stores.models import Store, UvtValue

PREFIX = "POS"  # sólo para `internal_receipt` (FiscalCounter); todo lo demás usa FiscalRange.prefix

LEGEND_POS_EQUIVALENT_PENDING = "DOCUMENTO PENDIENTE DE TRANSMISIÓN A LA DIAN"
LEGEND_INVOICE_PENDING = "FACTURA ELECTRÓNICA PENDIENTE DE TRANSMISIÓN A LA DIAN"
LEGEND_INTERNAL_RECEIPT = "COMPROBANTE INTERNO — no es factura ni documento equivalente"
LEGEND_SENT = "DOCUMENTO ENVIADO A LA DIAN — a la espera de validación"
LEGEND_VALIDATED = "DOCUMENTO VALIDADO POR LA DIAN"
LEGEND_REJECTED = "DOCUMENTO RECHAZADO POR LA DIAN — corregí y reenviá, o anulalo por nota"
LEGEND_CONTINGENCY = "EXPEDIDO EN CONTINGENCIA — pendiente de transmisión a la DIAN (art. 616-1 ET)"
LEGEND_ADJUSTMENT_NOTE_PENDING = "NOTA DE AJUSTE AL DOCUMENTO EQUIVALENTE POS — pendiente de transmisión"
LEGEND_CREDIT_NOTE_PENDING = "NOTA CRÉDITO A LA FACTURA ELECTRÓNICA — pendiente de transmisión"
LEGEND_DEBIT_NOTE_PENDING = "NOTA DÉBITO A LA FACTURA ELECTRÓNICA — pendiente de transmisión"

DEFAULT_CUSTOMER_DOC_TYPE = "13"
DEFAULT_CUSTOMER_DOC_NUMBER = "222222222222"
DEFAULT_CUSTOMER_NAME = "Consumidor final"

CONTINGENCY_SLA_HOURS = 48
RANGE_ALERT_CONSUMED_PCT = 0.8
RANGE_ALERT_DAYS_LEFT = 30

# Tipos que reservan su número DENTRO de un `FiscalRange` vigente (decisión
# declarada en `app/fiscal/models.py`). `internal_receipt` queda afuera:
# sigue con `FiscalCounter`, sin exigir que el admin cargue un rango DIAN.
RANGE_BACKED_TYPES: frozenset[FiscalDocumentType] = frozenset(
    {
        FiscalDocumentType.POS_EQUIVALENT,
        FiscalDocumentType.INVOICE,
        FiscalDocumentType.ADJUSTMENT_NOTE,
        FiscalDocumentType.CREDIT_NOTE,
        FiscalDocumentType.DEBIT_NOTE,
    }
)

NOTE_TYPE_FOR_KIND: dict[str, FiscalDocumentType] = {
    "adjustment": FiscalDocumentType.ADJUSTMENT_NOTE,
    "credit": FiscalDocumentType.CREDIT_NOTE,
    "debit": FiscalDocumentType.DEBIT_NOTE,
}
# `adjustment_note` corrige un `pos_equivalent`; `credit_note`/`debit_note`
# corrigen una `invoice` (SPEC-NEGOCIO §8.3). El par equivocado es
# `400 NOTE_KIND_MISMATCH`.
ORIGINAL_TYPE_FOR_NOTE: dict[FiscalDocumentType, FiscalDocumentType] = {
    FiscalDocumentType.ADJUSTMENT_NOTE: FiscalDocumentType.POS_EQUIVALENT,
    FiscalDocumentType.CREDIT_NOTE: FiscalDocumentType.INVOICE,
    FiscalDocumentType.DEBIT_NOTE: FiscalDocumentType.INVOICE,
}
NOTE_TYPES: frozenset[FiscalDocumentType] = frozenset(NOTE_TYPE_FOR_KIND.values())


@dataclass(frozen=True)
class TipSnapshot:
    """Lo que se congela en el documento sobre la propina de este cobro
    (puede no haber propina: `amount=0`, `suggested_pct=None`)."""

    amount: int = 0
    suggested_pct: float | None = None
    accepted: bool | None = None
    modified: bool | None = None


@dataclass(frozen=True)
class CustomerSnapshot:
    """Lo que se congela en el documento sobre el adquirente. `id` es la FK
    (débil, ver `models.py`) a `customers.id`; `None` cuando la venta va a
    "Consumidor final" o cuando `app.customers` todavía no existe."""

    id: int | None
    doc_type: str
    doc_number: str
    name: str
    email: str | None = None
    address: str | None = None
    municipality_dane: str | None = None


CONSUMER_FINAL = CustomerSnapshot(
    id=None, doc_type=DEFAULT_CUSTOMER_DOC_TYPE, doc_number=DEFAULT_CUSTOMER_DOC_NUMBER, name=DEFAULT_CUSTOMER_NAME
)


# ---------------------------------------------------------------------------
# Rangos de numeración DIAN
# ---------------------------------------------------------------------------


def _range_consumed(range_row: FiscalRange) -> int:
    return range_row.next_number - range_row.from_number


def _range_total(range_row: FiscalRange) -> int:
    return range_row.to_number - range_row.from_number + 1


def _maybe_alert_range_low(db: Session, range_row: FiscalRange, *, business_date: date) -> None:
    """80 % consumido o a menos de 30 días de `valid_until` →
    `notify(type="fiscal_range_low")` con `dedupe_key` diario (el `notify`
    de `app.notifications.service` ya deduplica por día de Bogotá; acá basta
    con no repetir la key dentro del mismo día)."""
    total = _range_total(range_row)
    consumed = _range_consumed(range_row)
    pct = consumed / total if total > 0 else 1.0
    days_left = (range_row.valid_until - business_date).days
    if pct < RANGE_ALERT_CONSUMED_PCT and days_left > RANGE_ALERT_DAYS_LEFT:
        return
    reasons = []
    if pct >= RANGE_ALERT_CONSUMED_PCT:
        reasons.append(f"{consumed}/{total} números consumidos ({pct:.0%})")
    if days_left <= RANGE_ALERT_DAYS_LEFT:
        reasons.append("ya venció" if days_left < 0 else f"vence en {days_left} días")
    notifications_service.notify(
        db,
        organization_id=range_row.organization_id,
        store_id=range_row.store_id,
        type="fiscal_range_low",
        level="warning",
        title=f"Rango {range_row.prefix} ({range_row.document_type.value}) por agotarse",
        body="; ".join(reasons),
        payload={
            "range_id": range_row.id,
            "document_type": range_row.document_type.value,
            "prefix": range_row.prefix,
            "consumed": consumed,
            "total": total,
            "valid_until": range_row.valid_until.isoformat(),
        },
        dedupe_key=f"fiscal_range_low:{range_row.id}",
    )


def _no_range_error(candidates: list[FiscalRange]) -> AppError:
    if candidates:
        return AppError(
            "FISCAL_RANGE_EXHAUSTED",
            "El rango de numeración vigente se agotó: cargá un nuevo rango autorizado por la "
            "DIAN en Admin → Rangos de numeración",
            status=400,
        )
    return AppError(
        "NO_FISCAL_RANGE",
        "Cargá el rango de numeración autorizado por la DIAN en Admin → Rangos de numeración",
        status=400,
    )


def assert_range_available(
    db: Session, *, store_id: int, document_type: FiscalDocumentType, business_date: date
) -> None:
    """Chequeo PURO (sin `FOR UPDATE`, sin reservar nada): hay o no un rango
    vigente con números libres para `(store, document_type, business_date)`.
    Se llama ANTES de escribir nada (`app.payments.service.pay_order`, antes
    de `claim_payment`) — «validar antes de escribir» es una regla dura, y
    sin este chequeo temprano un `NO_FISCAL_RANGE` que sólo aparece dentro de
    `issue_document` (después de `claim_payment`) dejaría la comanda `paid`
    sin documento, porque el `AppError` no revierte lo que `claim_payment`
    ya escribió fuera del `SAVEPOINT` de `issue_document`.

    No reemplaza a `reserve_next_number`: entre este chequeo y la reserva
    real (dentro de la transacción de escritura, con `FOR UPDATE`) queda una
    ventana de carrera microscópica — si otra transacción agota el mismo
    rango justo en el medio, `reserve_next_number` la vuelve a cortar, y ESE
    caso sí puede dejar la comanda `paid` sin documento (mismo riesgo
    residual que backend-cobro ya aceptó en 1b-1 para `target_key` como
    backstop sin test dedicado — demasiado raro para forzarlo sin manipular
    la base a mano)."""
    if document_type not in RANGE_BACKED_TYPES:
        return
    candidates = _vigent_ranges(db, store_id=store_id, document_type=document_type, business_date=business_date)
    if next((r for r in candidates if r.next_number <= r.to_number), None) is None:
        raise _no_range_error(candidates)


def _vigent_ranges(
    db: Session, *, store_id: int, document_type: FiscalDocumentType, business_date: date, for_update: bool = False
) -> list[FiscalRange]:
    stmt = (
        select(FiscalRange)
        .where(
            FiscalRange.store_id == store_id,
            FiscalRange.document_type == document_type,
            FiscalRange.valid_from <= business_date,
            FiscalRange.valid_until >= business_date,
        )
        .order_by(FiscalRange.valid_from.desc(), FiscalRange.id.desc())
    )
    if for_update:
        stmt = stmt.with_for_update()
    return list(db.execute(stmt).scalars())


def reserve_next_number(
    db: Session, *, organization_id: int, store_id: int, document_type: FiscalDocumentType, business_date: date
) -> tuple[FiscalRange, int]:
    """Reserva el consecutivo DENTRO del rango vigente (SPEC-NEGOCIO §8.3):
    `SELECT ... FOR UPDATE` sobre `fiscal_ranges` de esa sede y ese tipo cuya
    vigencia cubre `business_date`, el de `valid_from` más reciente que
    todavía tenga números libres; sube `next_number` en la MISMA transacción
    (sin huecos: si el resto del cobro se revierte, el rollback también
    devuelve el número — nunca lo revierte un rechazo del proveedor, que
    llega después). Sólo para `document_type in RANGE_BACKED_TYPES`.

    Nunca `500`: `400 NO_FISCAL_RANGE` (nada vigente para esa sede/tipo/fecha)
    o `400 FISCAL_RANGE_EXHAUSTED` (hay uno vigente pero sin números), cada
    uno con la acción correctiva en el mensaje. Ver `assert_range_available`
    para el chequeo temprano (antes de escribir) que evita el caso común."""
    candidates = _vigent_ranges(
        db, store_id=store_id, document_type=document_type, business_date=business_date, for_update=True
    )
    usable = next((r for r in candidates if r.next_number <= r.to_number), None)
    if usable is None:
        raise _no_range_error(candidates)
    number = usable.next_number
    usable.next_number = number + 1
    db.flush()
    _maybe_alert_range_low(db, usable, business_date=business_date)
    return usable, number


def _reserve_internal_receipt_number(db: Session, *, store_id: int, prefix: str) -> int:
    """`internal_receipt` (org declarada no obligada, `fiscal.dee_pos`
    apagada) no es un documento DIAN: sigue con el contador simple de 1b-1
    (`FiscalCounter`), sin exigir que el admin cargue un rango."""
    stmt = (
        select(FiscalCounter)
        .where(
            FiscalCounter.store_id == store_id,
            FiscalCounter.document_type == FiscalDocumentType.INTERNAL_RECEIPT,
            FiscalCounter.prefix == prefix,
        )
        .with_for_update()
    )
    row = db.execute(stmt).scalar_one_or_none()
    if row is None:
        row = FiscalCounter(store_id=store_id, document_type=FiscalDocumentType.INTERNAL_RECEIPT, prefix=prefix, next_number=1)
        db.add(row)
        db.flush()
    number = row.next_number
    row.next_number = number + 1
    db.flush()
    return number


def create_range(
    db: Session,
    *,
    organization_id: int,
    store_id: int,
    document_type: FiscalDocumentType,
    prefix: str,
    from_number: int,
    to_number: int,
    resolution_number: str,
    resolution_date: date,
    valid_from: date,
    valid_until: date,
    technical_key: str | None,
    now: datetime,
) -> FiscalRange:
    if to_number < from_number:
        raise AppError("FISCAL_RANGE_INVALID", "El «hasta» del rango no puede ser menor que el «desde»", status=400)
    if valid_until < valid_from:
        raise AppError("FISCAL_RANGE_INVALID", "La vigencia no puede terminar antes de empezar", status=400)
    row = FiscalRange(
        organization_id=organization_id,
        store_id=store_id,
        document_type=document_type,
        prefix=prefix,
        from_number=from_number,
        to_number=to_number,
        next_number=from_number,
        resolution_number=resolution_number,
        resolution_date=resolution_date,
        valid_from=valid_from,
        valid_until=valid_until,
        technical_key=technical_key,
        created_at=now,
    )
    db.add(row)
    db.flush()
    return row


def list_ranges(db: Session, *, store_id: int) -> list[FiscalRange]:
    stmt = (
        select(FiscalRange)
        .where(FiscalRange.store_id == store_id)
        .order_by(FiscalRange.document_type, FiscalRange.valid_from.desc())
    )
    return list(db.execute(stmt).scalars())


def range_out(row: FiscalRange) -> FiscalRangeOut:
    return FiscalRangeOut(
        id=row.id,
        store_id=row.store_id,
        document_type=row.document_type.value,  # type: ignore[arg-type]
        prefix=row.prefix,
        from_number=row.from_number,
        to_number=row.to_number,
        resolution_number=row.resolution_number,
        resolution_date=row.resolution_date,
        valid_from=row.valid_from,
        valid_until=row.valid_until,
        technical_key=row.technical_key,
        consumed=_range_consumed(row),
    )


# ---------------------------------------------------------------------------
# Adaptador de proveedor: aplicar el resultado de `emit`/`retry`
# ---------------------------------------------------------------------------


def _initial_dian_status(document_type: FiscalDocumentType) -> DianStatus | None:
    if document_type == FiscalDocumentType.INTERNAL_RECEIPT:
        return None
    return DianStatus.PENDING


def _legend_for(document_type: FiscalDocumentType, dian_status: DianStatus | None) -> str:
    if document_type == FiscalDocumentType.INTERNAL_RECEIPT:
        return LEGEND_INTERNAL_RECEIPT
    if dian_status == DianStatus.VALIDATED:
        return LEGEND_VALIDATED
    if dian_status == DianStatus.REJECTED:
        return LEGEND_REJECTED
    if dian_status == DianStatus.CONTINGENCY:
        return LEGEND_CONTINGENCY
    if dian_status == DianStatus.SENT:
        return LEGEND_SENT
    # pending
    if document_type == FiscalDocumentType.INVOICE:
        return LEGEND_INVOICE_PENDING
    if document_type == FiscalDocumentType.ADJUSTMENT_NOTE:
        return LEGEND_ADJUSTMENT_NOTE_PENDING
    if document_type == FiscalDocumentType.CREDIT_NOTE:
        return LEGEND_CREDIT_NOTE_PENDING
    if document_type == FiscalDocumentType.DEBIT_NOTE:
        return LEGEND_DEBIT_NOTE_PENDING
    return LEGEND_POS_EQUIVALENT_PENDING


def _apply_emit_result(db: Session, document: FiscalDocument, result: EmitResult) -> None:
    new_status = DianStatus(result.status)
    document.dian_status = new_status
    if result.cude is not None:
        document.cude = result.cude
    if result.qr_url is not None:
        document.qr_url = result.qr_url
    if result.xml_ref is not None:
        document.xml_ref = result.xml_ref
    document.provider_response = result.response
    document.legend = _legend_for(document.document_type, new_status)
    if new_status == DianStatus.VALIDATED:
        document.validated_at = clock.now_utc()
    db.flush()
    if new_status == DianStatus.REJECTED:
        notifications_service.notify(
            db,
            organization_id=document.organization_id,
            store_id=document.store_id,
            type="fiscal_rejected",
            level="critical",
            title=f"Documento {document.prefix}-{document.number:06d} rechazado por la DIAN",
            body=str(result.response.get("reason", "La DIAN rechazó el documento; corregí y reenviá, o anulalo por nota")),
            payload={"document_id": document.id, "response": result.response},
            dedupe_key=f"fiscal_rejected:{document.id}",
        )


def emit_and_apply(db: Session, *, document: FiscalDocument, store: Store) -> FiscalDocument:
    """Llama al `FiscalProvider` de la sede (`app.fiscal.provider.get_provider`)
    y aplica el resultado. `internal_receipt` nunca se transmite (no es un
    documento DIAN): queda como se creó, sin tocar el proveedor."""
    if document.document_type == FiscalDocumentType.INTERNAL_RECEIPT:
        return document
    provider = get_provider(db, store)
    result = provider.emit(document)
    _apply_emit_result(db, document, result)
    return document


def retry_document(db: Session, *, document: FiscalDocument, store: Store, now: datetime) -> FiscalDocument:
    del now
    if document.document_type == FiscalDocumentType.INTERNAL_RECEIPT:
        raise AppError(
            "FISCAL_RETRY_NOT_APPLICABLE", "Un comprobante interno no se transmite a la DIAN: no hay nada que reintentar",
            status=400,
        )
    if document.status != "issued":
        raise AppError(
            "DOCUMENT_ALREADY_REVERSED", "Este documento ya fue reversado por una nota; no se reintenta", status=400
        )
    provider = get_provider(db, store)
    result = provider.retry(document)
    _apply_emit_result(db, document, result)
    return document


# ---------------------------------------------------------------------------
# Contingencia: 48 h vencidas dispara `fiscal_contingency_overdue`
# ---------------------------------------------------------------------------


def sweep_contingency_overdue(db: Session, *, store_id: int) -> int:
    """Documentos en `contingency` hace más de 48 h, contadas desde
    `issued_at` ("su fecha de generación", SPEC-NEGOCIO §8.3) — nunca con
    `sleep`: compara contra `app.core.clock.now_utc()`, testeable con la
    fixture `clock` (`advance(hours=49)`). No hay scheduler en este proyecto
    (ninguna dependencia nueva permitida, `CONTRATO-INTERNO-1b-1.md §1`): se
    barre al entrar a `GET /admin/fiscal/documents` y `GET /admin/fiscal/export`
    (`app.fiscal.router`). Devuelve cuántas notificaciones nuevas disparó."""
    now = clock.now_utc()
    threshold = now - timedelta(hours=CONTINGENCY_SLA_HOURS)
    stmt = select(FiscalDocument).where(
        FiscalDocument.store_id == store_id,
        FiscalDocument.dian_status == DianStatus.CONTINGENCY,
        FiscalDocument.issued_at <= threshold,
    )
    rows = list(db.execute(stmt).scalars())
    fired = 0
    for row in rows:
        notified = notifications_service.notify(
            db,
            organization_id=row.organization_id,
            store_id=row.store_id,
            type="fiscal_contingency_overdue",
            level="critical",
            title=f"Documento {row.prefix}-{row.number:06d} en contingencia hace más de 48 horas",
            body="Venció el plazo legal del art. 616-1 ET sin poder transmitir a la DIAN; requiere atención.",
            payload={"document_id": row.id, "issued_at": row.issued_at.isoformat()},
            dedupe_key=f"fiscal_contingency_overdue:{row.id}",
        )
        if notified is not None:
            fired += 1
    return fired


# ---------------------------------------------------------------------------
# Cliente / factura electrónica
# ---------------------------------------------------------------------------


def customer_is_identified(customer_in: Any | None) -> bool:
    if customer_in is None:
        return False
    doc_number = (getattr(customer_in, "doc_number", "") or "").strip()
    return bool(doc_number) and doc_number != DEFAULT_CUSTOMER_DOC_NUMBER


def resolve_customer_snapshot(
    db: Session, *, organization_id: int, store_id: int, customer_in: Any | None, actor: Any, now: datetime
) -> CustomerSnapshot:
    """`customer?` de `POST /orders/{id}/payments` (SPEC-NEGOCIO §8.3, §8.4):
    el dispositivo sólo CREA clientes al cobrar, vía
    `app.customers.hooks.upsert_customer_with_consent` — protegido con
    `app.core.modules.find_spec_safe` (nunca `importlib.util.find_spec`
    crudo: `app.customers` puede no tener `hooks.py` todavía si se construye
    en paralelo, `docs/ESTADO.md`). Sin `customer` en el body, la venta va a
    "Consumidor final" (default DIAN, SPEC-NEGOCIO §8.3)."""
    if customer_in is None:
        return CONSUMER_FINAL

    customer_id: int | None = None
    if find_spec_safe("app.customers.hooks") is not None:
        from app.customers import hooks as customers_hooks  # type: ignore[import-not-found]

        consent_in = customers_hooks.ConsentInput(
            text_version=customer_in.consent.text_version, channel=customer_in.consent.channel
        )
        result = customers_hooks.upsert_customer_with_consent(
            db,
            organization_id=organization_id,
            store_id=store_id,
            doc_type=customer_in.doc_type,
            doc_number=customer_in.doc_number,
            dv=customer_in.dv,
            name=customer_in.name,
            email=customer_in.email,
            address=customer_in.address,
            municipality_dane=customer_in.municipality_dane,
            consent=consent_in,
            actor=actor,
            now=now,
        )
        customer_id = getattr(result, "id", None) if result is not None else None

    return CustomerSnapshot(
        id=customer_id,
        doc_type=customer_in.doc_type,
        doc_number=customer_in.doc_number,
        name=customer_in.name,
        email=customer_in.email,
        address=customer_in.address,
        municipality_dane=customer_in.municipality_dane,
    )


def _net_over_invoice_threshold(
    db: Session, *, organization_id: int, store_id: int, total_net: int, business_date: date
) -> bool:
    settings = stores_service.get_sales_settings(db, store_id)
    threshold_uvt = settings.invoice_threshold_uvt
    uvt = db.execute(
        select(UvtValue).where(UvtValue.organization_id == organization_id, UvtValue.year == business_date.year)
    ).scalars().first()
    if uvt is None:
        # Sin UVT del año cargada no se puede evaluar el umbral: no fuerza
        # factura por sí sola (el operador siempre puede pedirla a mano).
        return False
    return total_net > threshold_uvt * uvt.value


def resolve_document_type_for_payment(
    db: Session,
    *,
    organization_id: int,
    store_id: int,
    total_net: int,
    business_date: date,
    customer_identified: bool,
    requests_invoice: bool,
) -> FiscalDocumentType:
    """`pos_equivalent` por default; `invoice` cuando el cliente la pide
    (`requests_invoice`) o cuando el neto supera `invoice_threshold_uvt` ×
    UVT del año y el cliente está identificado (SPEC-NEGOCIO §8.3).
    `internal_receipt` si la sede no está obligada (`fiscal.dee_pos`
    apagada) — ahí ni el umbral ni `requests_invoice` aplican."""
    if not features.is_enabled(db, organization_id, store_id, "fiscal.dee_pos"):
        return FiscalDocumentType.INTERNAL_RECEIPT

    invoice_enabled = features.is_enabled(db, organization_id, store_id, "fiscal.invoice")
    if requests_invoice and not invoice_enabled:
        raise AppError(
            "FEATURE_DISABLED",
            'La función "fiscal.invoice" está apagada; habilitala en Admin → Funciones',
            extra={"feature": "fiscal.invoice"},
        )
    if not invoice_enabled:
        return FiscalDocumentType.POS_EQUIVALENT

    wants_invoice = requests_invoice or _net_over_invoice_threshold(
        db, organization_id=organization_id, store_id=store_id, total_net=total_net, business_date=business_date
    )
    if not wants_invoice:
        return FiscalDocumentType.POS_EQUIVALENT
    if not customer_identified:
        raise AppError(
            "CUSTOMER_REQUIRED_FOR_INVOICE",
            "Esta venta requiere factura electrónica: capturá el documento del cliente antes de cobrar",
            status=400,
        )
    return FiscalDocumentType.INVOICE


# ---------------------------------------------------------------------------
# Emisión del documento de una venta
# ---------------------------------------------------------------------------


def issue_document(
    db: Session,
    *,
    order: Order,
    sub_account: OrderSubAccount | None,
    shift: Shift,
    store: Store,
    actor: Any,
    document_type: FiscalDocumentType,
    totals: OrderTotals,
    tip: TipSnapshot,
    lines: list[dict[str, Any]],
    payments_snapshot: list[dict[str, Any]],
    tables_text: str | None,
    business_date: date,
    now: datetime,
    customer: CustomerSnapshot,
) -> FiscalDocument:
    """Arma, guarda y emite (`emit_and_apply`) el comprobante. El número se
    reserva ACÁ (dentro de la transacción del cobro que ya validó todo antes
    de escribir — `app.payments.service.pay_order`)."""
    document_type = FiscalDocumentType(document_type)
    target_key = f"order:{order.id}" if sub_account is None else f"sub:{sub_account.id}"
    fiscal_config = stores_service.current_fiscal(db, store.id, on=business_date)

    range_row: FiscalRange | None = None
    if document_type in RANGE_BACKED_TYPES:
        range_row, number = reserve_next_number(
            db,
            organization_id=order.organization_id,
            store_id=store.id,
            document_type=document_type,
            business_date=business_date,
        )
        prefix = range_row.prefix
    else:
        number = _reserve_internal_receipt_number(db, store_id=store.id, prefix=PREFIX)
        prefix = PREFIX

    initial_status = _initial_dian_status(document_type)
    row = FiscalDocument(
        organization_id=order.organization_id,
        store_id=store.id,
        order_id=order.id,
        sub_account_id=sub_account.id if sub_account is not None else None,
        shift_id=shift.id,
        target_key=target_key,
        document_type=document_type,
        prefix=prefix,
        number=number,
        dian_status=initial_status,
        legend=_legend_for(document_type, initial_status),
        business_date=business_date,
        issued_at=now,
        customer_id=customer.id,
        customer_doc_type=customer.doc_type,
        customer_doc_number=customer.doc_number,
        customer_name=customer.name,
        customer_email=customer.email,
        customer_address=customer.address,
        customer_municipality_dane=customer.municipality_dane,
        store_snapshot={
            "legal_name": store.legal_name,
            "nit": store.nit,
            "dv": store.dv,
            "address": store.address,
            "municipality_dane": store.municipality_dane,
            "regime": fiscal_config.regime if fiscal_config is not None else None,
            "person_type": fiscal_config.person_type if fiscal_config is not None else None,
        },
        lines=lines,
        subtotal=totals.subtotal,
        discount_total=totals.discount_total,
        tax_total=totals.tax_total,
        total=totals.total,
        tax_lines=[{"rate": t.rate, "base": t.base, "tax": t.tax} for t in totals.tax_lines],
        tip_amount=tip.amount,
        tip_suggested_pct=tip.suggested_pct,
        tip_accepted=tip.accepted,
        tip_modified=tip.modified,
        payments_snapshot=payments_snapshot,
        channel=order.channel.value,
        tables_text=tables_text,
        covers=order.covers,
        served_by_name=order.opened_by_employee_name,
        charged_by_employee_id=actor.employee_id,
        charged_by_employee_name=actor.employee_name,
        fiscal_range_id=range_row.id if range_row is not None else None,
        cude=None,
        qr_url=None,
        xml_ref=None,
        provider_response=None,
        validated_at=None,
        reverses_document_id=None,
        reason=None,
        status="issued",
        print_count=1,
        reprint_count=0,
        created_at=now,
    )
    db.add(row)
    db.flush()
    emit_and_apply(db, document=row, store=store)
    return row


# ---------------------------------------------------------------------------
# Notas (adjustment | credit | debit)
# ---------------------------------------------------------------------------


def issue_note(
    db: Session,
    *,
    original: FiscalDocument,
    kind: str,
    reason: str,
    lines_in: list[Any],
    actor: Any,
    store: Store,
    business_date: date,
    now: datetime,
) -> tuple[FiscalDocument, list[int]]:
    """`POST /admin/documents/{id}/notes` (SPEC-NEGOCIO §3.5, §6.3): consecutivo
    propio de SU propio rango; el original pasa a `status="reversed"`
    (nunca se edita ni se borra). `lines_in[].used=True` selecciona qué
    líneas del original entran en la nota — sus montos ya están congelados
    en `original.lines` (snapshot del ítem), así que la nota los SUMA, no
    los recalcula: sigue siendo la única matemática (`app.orders.money`) la
    que produjo esos números, acá sólo se agregan.

    Además, por línea con `used=True` **y** `returns_to_stock=True`
    (SPEC-NEGOCIO §3.5: «se usó» / «vuelve»), revierte el consumo teórico
    registrado al enviar ese ítem, llamando a
    `app.orders.hooks.reverse_item_consumption` — el espejo exacto leído del
    LIBRO (`StockMovement` con `ref_type="order_item"`), nunca recalculado
    con `expand_consumption`/la ficha de hoy: así la reversión es correcta
    aunque la ficha haya cambiado entre el envío y la nota. Ese hook ya se
    protege solo con `find_spec_safe` si `app.inventory` no está montado o
    `inventory.perpetual` está apagada — acá no hace falta guardia extra.

    **Regla de la nota débito**: una nota `kind="debit"` COBRA MÁS, nunca
    devuelve producto. Se fuerza `returns_to_stock=False` para TODAS sus
    líneas, ignorando lo que haya mandado el cliente (nunca se responde
    `400`: con el default `True` de `NoteLineIn`, rechazar rompería toda
    nota débito que no mande el campo).

    Devuelve `(documento, returned_to_stock_item_ids)` — la segunda lista
    sólo contiene los `item_id` cuya reversión escribió de verdad algún
    movimiento (vacía si no se revirtió nada: flag apagada, sin consumo
    original que revertir, o nota débito)."""
    note_type = NOTE_TYPE_FOR_KIND[kind]
    expected_original_type = ORIGINAL_TYPE_FOR_NOTE[note_type]
    if original.document_type != expected_original_type:
        raise AppError(
            "NOTE_KIND_MISMATCH",
            f'Una nota "{kind}" corrige un documento "{expected_original_type.value}"; '
            f'este documento es "{original.document_type.value}"',
            status=400,
        )
    if original.status != "issued":
        raise AppError(
            "DOCUMENT_ALREADY_REVERSED",
            "Este documento ya tiene una nota; un documento sólo se corrige una vez",
            status=400,
        )

    original_lines_by_id = {int(row["item_id"]): row for row in original.lines}
    used_ids = [line.item_id for line in lines_in if line.used]
    note_lines_raw = [original_lines_by_id[i] for i in used_ids if i in original_lines_by_id]
    if not note_lines_raw:
        raise AppError("NOTE_EMPTY", "Seleccioná al menos un ítem del documento original para la nota", status=400)

    subtotal = sum(int(line["gross"]) for line in note_lines_raw)
    discount_total = sum(int(line["discount"]) for line in note_lines_raw)
    tax_total = sum(int(line["tax"]) for line in note_lines_raw)
    total = sum(int(line["net"]) for line in note_lines_raw)
    tax_buckets: dict[int, list[int]] = {}
    for line in note_lines_raw:
        bucket = tax_buckets.setdefault(int(line["tax_rate"]), [0, 0])
        bucket[0] += int(line["base"])
        bucket[1] += int(line["tax"])
    tax_lines = [{"rate": rate, "base": b, "tax": t} for rate, (b, t) in sorted(tax_buckets.items())]

    range_row, number = reserve_next_number(
        db,
        organization_id=original.organization_id,
        store_id=store.id,
        document_type=note_type,
        business_date=business_date,
    )

    initial_status = DianStatus.PENDING
    row = FiscalDocument(
        organization_id=original.organization_id,
        store_id=store.id,
        order_id=original.order_id,
        sub_account_id=original.sub_account_id,
        shift_id=original.shift_id,
        target_key=f"note:{original.id}",
        document_type=note_type,
        prefix=range_row.prefix,
        number=number,
        dian_status=initial_status,
        legend=_legend_for(note_type, initial_status),
        business_date=business_date,
        issued_at=now,
        customer_id=original.customer_id,
        customer_doc_type=original.customer_doc_type,
        customer_doc_number=original.customer_doc_number,
        customer_name=original.customer_name,
        customer_email=original.customer_email,
        customer_address=original.customer_address,
        customer_municipality_dane=original.customer_municipality_dane,
        store_snapshot=original.store_snapshot,
        lines=note_lines_raw,
        subtotal=subtotal,
        discount_total=discount_total,
        tax_total=tax_total,
        total=total,
        tax_lines=tax_lines,
        tip_amount=0,
        tip_suggested_pct=None,
        tip_accepted=None,
        tip_modified=None,
        payments_snapshot=[],
        channel=original.channel,
        tables_text=original.tables_text,
        covers=original.covers,
        served_by_name=original.served_by_name,
        charged_by_employee_id=actor.employee_id,
        charged_by_employee_name=actor.employee_name,
        fiscal_range_id=range_row.id,
        cude=None,
        qr_url=None,
        xml_ref=None,
        provider_response=None,
        validated_at=None,
        reverses_document_id=original.id,
        reason=reason,
        status="issued",
        print_count=1,
        reprint_count=0,
        created_at=now,
    )
    db.add(row)
    db.flush()
    emit_and_apply(db, document=row, store=store)

    # Reversión de inventario ("vuelve"): nota débito nunca revierte (cobra
    # más, no devuelve producto); las demás respetan `returns_to_stock` por
    # línea, default `True`.
    if kind == "debit":
        reverting_item_ids: set[int] = set()
    else:
        reverting_item_ids = {line.item_id for line in lines_in if line.used and line.returns_to_stock}

    returned_to_stock_item_ids: list[int] = []
    if reverting_item_ids:
        order_items = list(
            db.execute(
                select(OrderItem).where(
                    OrderItem.order_id == original.order_id,
                    OrderItem.id.in_(reverting_item_ids),
                )
            ).scalars()
        )
        for item in order_items:
            reverted_rows = orders_hooks.reverse_item_consumption(db, item=item, actor=actor, now=now)
            if reverted_rows:
                returned_to_stock_item_ids.append(item.id)

    original.status = "reversed"
    db.flush()
    return row, returned_to_stock_item_ids


def settle_or_queue_refund_for_note(
    db: Session, *, note: FiscalDocument, refund_in: Any | None, actor: Any, now: datetime
) -> str | None:
    """`refund?: {method, amount}` de la nota (SPEC-NEGOCIO §3.5, §6.3): la
    devolución de plata la decide `app.refunds.hooks.settle_or_queue_refund`
    (egreso `refund` en el turno abierto, **devolución pendiente** si no hay
    uno, o `settled_externally` si el medio no es efectivo) — lo construye
    otro agente del equipo 1b-2 (`app.refunds`), protegido acá con
    `find_spec_safe`. Devuelve el `status` del `RefundOutcome`, o `None` si
    no había `refund` que saldar o el gancho todavía no existe. El test de
    punta a punta del COMPORTAMIENTO del gancho (qué turno recibe el egreso,
    cuándo queda pendiente) es de SU dueño — acá sólo se prueba que se
    invocó con los datos de la nota."""
    if refund_in is None:
        return None
    if find_spec_safe("app.refunds.hooks") is None:
        return None
    from app.refunds import hooks as refunds_hooks  # type: ignore[import-not-found]

    outcome = refunds_hooks.settle_or_queue_refund(
        db,
        organization_id=note.organization_id,
        store_id=note.store_id,
        document_id=note.id,
        method=refund_in.method,
        amount=refund_in.amount,
        actor=actor,
        now=now,
    )
    return str(outcome.status)


# ---------------------------------------------------------------------------
# Evidencia y exportación
# ---------------------------------------------------------------------------


def _content_hash(document: FiscalDocument) -> str:
    """Hash de lo que este sistema conserva del documento (conservación
    mínima 5 años, SPEC-NEGOCIO §8.3: «no depender sólo del proveedor»). No
    reemplaza la firma/hash que dé el proveedor tecnológico real cuando el
    dueño elija uno — es la evidencia de integridad LOCAL."""
    canonical = json.dumps(
        {
            "id": document.id,
            "document_type": document.document_type.value,
            "prefix": document.prefix,
            "number": document.number,
            "business_date": document.business_date.isoformat(),
            "issued_at": document.issued_at.isoformat(),
            "total": document.total,
            "tax_total": document.tax_total,
            "lines": document.lines,
            "cude": document.cude,
            "provider_response": document.provider_response,
        },
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def document_evidence(db: Session, *, document: FiscalDocument) -> DocumentEvidenceOut:
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
    return DocumentEvidenceOut(
        id=document.id,
        full_number=f"{document.prefix}-{document.number:06d}",
        document_type=document.document_type.value,  # type: ignore[arg-type]
        dian_status=document.dian_status.value if document.dian_status else None,  # type: ignore[union-attr]
        cude=document.cude,
        qr_url=document.qr_url,
        xml_ref=document.xml_ref,
        provider_response=document.provider_response,
        validated_at=document.validated_at,
        issued_at=document.issued_at,
        content_hash=_content_hash(document),
        range=range_ref,
    )


def export_bundle(db: Session, *, store_id: int, date_from: date, date_to: date) -> ExportBundleOut:
    """Paquete de evidencia con manifiesto y hashes (conservación 5 años,
    SPEC-NEGOCIO §8.3). No arma un ZIP con XML reales (no hay proveedor
    real todavía, `gaps` en el entregable): el manifiesto en sí, con el hash
    por documento y un hash del manifiesto entero, es la evidencia
    exportable de esta fase."""
    stmt = (
        select(FiscalDocument)
        .where(
            FiscalDocument.store_id == store_id,
            FiscalDocument.business_date >= date_from,
            FiscalDocument.business_date <= date_to,
        )
        .order_by(FiscalDocument.issued_at)
    )
    rows = list(db.execute(stmt).scalars())
    entries = [
        ExportManifestEntry(
            id=r.id,
            full_number=f"{r.prefix}-{r.number:06d}",
            document_type=r.document_type.value,  # type: ignore[arg-type]
            business_date=r.business_date,
            total=r.total,
            hash=_content_hash(r),
        )
        for r in rows
    ]
    manifest_hash = hashlib.sha256(
        json.dumps(
            [e.model_dump(mode="json") for e in entries], sort_keys=True, separators=(",", ":")
        ).encode("utf-8")
    ).hexdigest()
    return ExportBundleOut(
        generated_at=clock.now_utc(),
        store_id=store_id,
        date_from=date_from,
        date_to=date_to,
        document_count=len(entries),
        documents=entries,
        manifest_hash=manifest_hash,
    )


# ---------------------------------------------------------------------------
# Listados admin
# ---------------------------------------------------------------------------


def admin_list_fiscal_documents(db: Session, *, store_id: int, status: str | None) -> list[dict[str, Any]]:
    """`GET /admin/fiscal/documents?status=pending|sent|validated|rejected|contingency`
    (+ `format=csv`). Barre contingencias vencidas antes de listar (no hay
    scheduler; ver `sweep_contingency_overdue`)."""
    sweep_contingency_overdue(db, store_id=store_id)
    stmt = select(FiscalDocument).where(FiscalDocument.store_id == store_id, FiscalDocument.status == "issued")
    if status is not None:
        stmt = stmt.where(FiscalDocument.dian_status == DianStatus(status))
    stmt = stmt.order_by(FiscalDocument.issued_at.desc())
    rows = list(db.execute(stmt).scalars())
    now = clock.now_utc()
    threshold = now - timedelta(hours=CONTINGENCY_SLA_HOURS)
    return [
        {
            "id": d.id,
            "full_number": f"{d.prefix}-{d.number:06d}",
            "document_type": d.document_type.value,
            "dian_status": d.dian_status.value if d.dian_status else None,
            "contingency": d.dian_status == DianStatus.CONTINGENCY,
            "contingency_overdue": d.dian_status == DianStatus.CONTINGENCY and d.issued_at <= threshold,
            "business_date": d.business_date.isoformat(),
            "issued_at": d.issued_at.isoformat(),
            "order_id": d.order_id,
            "total": d.total,
            "tip_amount": d.tip_amount,
            "charged_by": d.charged_by_employee_name,
            "customer_name": d.customer_name,
            "reverses_document_id": d.reverses_document_id,
        }
        for d in rows
    ]


def admin_list_notes(db: Session, *, store_id: int, date_from: date | None, date_to: date | None) -> list[dict[str, Any]]:
    """`GET /admin/notes?from&to` (+ `format=csv`): sólo filas cuyo
    `document_type` es una nota (`reverses_document_id IS NOT NULL`)."""
    stmt = select(FiscalDocument).where(
        FiscalDocument.store_id == store_id, FiscalDocument.reverses_document_id.is_not(None)
    )
    if date_from is not None:
        stmt = stmt.where(FiscalDocument.business_date >= date_from)
    if date_to is not None:
        stmt = stmt.where(FiscalDocument.business_date <= date_to)
    stmt = stmt.order_by(FiscalDocument.issued_at.desc())
    rows = list(db.execute(stmt).scalars())
    return [
        {
            "id": d.id,
            "full_number": f"{d.prefix}-{d.number:06d}",
            "document_type": d.document_type.value,
            "reverses_document_id": d.reverses_document_id,
            "reason": d.reason or "",
            "total": d.total,
            "business_date": d.business_date.isoformat(),
            "issued_at": d.issued_at.isoformat(),
        }
        for d in rows
    ]
