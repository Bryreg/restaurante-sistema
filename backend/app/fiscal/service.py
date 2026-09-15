"""`reserve_next_number` e `issue_document` (`CONTRATO-INTERNO-1b-1.md §2.3`,
«Cobro y comprobante» §2.4).

**Nada se emite ni se transmite en 1b-1.** No hay `FiscalProvider`, ni rangos
DIAN, ni CUDE: eso es 1b-2. Acá sólo se reserva un consecutivo sin huecos y se
arma el `FiscalDocument` con `dian_status="pending"` (documento equivalente)
o `NULL` (comprobante interno) y la leyenda correspondiente.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core import features
from app.fiscal.models import DianStatus, FiscalCounter, FiscalDocument, FiscalDocumentType
from app.orders.models import Order, OrderSubAccount
from app.orders.money import OrderTotals
from app.shifts.models import Shift
from app.stores import service as stores_service
from app.stores.models import Store

PREFIX = "POS"

LEGEND_POS_EQUIVALENT = "DOCUMENTO PENDIENTE DE TRANSMISIÓN A LA DIAN"
LEGEND_INTERNAL_RECEIPT = "COMPROBANTE INTERNO — no es factura ni documento equivalente"

DEFAULT_CUSTOMER_DOC_TYPE = "13"
DEFAULT_CUSTOMER_DOC_NUMBER = "222222222222"
DEFAULT_CUSTOMER_NAME = "Consumidor final"


@dataclass(frozen=True)
class TipSnapshot:
    """Lo que se congela en el documento sobre la propina de este cobro
    (puede no haber propina: `amount=0`, `suggested_pct=None`)."""

    amount: int = 0
    suggested_pct: float | None = None
    accepted: bool | None = None
    modified: bool | None = None


def reserve_next_number(db: Session, *, store_id: int, document_type: str, prefix: str) -> int:
    """`SELECT ... FOR UPDATE` sobre `fiscal_counters` (SQLite lo ignora y
    serializa igual por el lock de escritura de la base); crea la fila con
    `next_number=1` si no existe. Devuelve el número reservado y deja
    `next_number` en `n + 1`.

    Se llama DENTRO de la transacción del cobro, después de validar todo: si
    el cobro falla más adelante y la transacción entera se revierte, el
    rollback también devuelve el número (sin huecos); un `400` de validación
    nunca llega a llamar esta función."""
    stmt = (
        select(FiscalCounter)
        .where(
            FiscalCounter.store_id == store_id,
            FiscalCounter.document_type == document_type,
            FiscalCounter.prefix == prefix,
        )
        .with_for_update()
    )
    row = db.execute(stmt).scalar_one_or_none()
    if row is None:
        row = FiscalCounter(store_id=store_id, document_type=document_type, prefix=prefix, next_number=1)
        db.add(row)
        db.flush()
    number = row.next_number
    row.next_number = number + 1
    db.flush()
    return number


def _resolve_document_type(db: Session, *, organization_id: int, store_id: int) -> FiscalDocumentType:
    if features.is_enabled(db, organization_id, store_id, "fiscal.dee_pos"):
        return FiscalDocumentType.POS_EQUIVALENT
    return FiscalDocumentType.INTERNAL_RECEIPT


def _legend_for(document_type: FiscalDocumentType) -> str:
    if document_type == FiscalDocumentType.POS_EQUIVALENT:
        return LEGEND_POS_EQUIVALENT
    return LEGEND_INTERNAL_RECEIPT


def _dian_status_for(document_type: FiscalDocumentType) -> DianStatus | None:
    if document_type == FiscalDocumentType.POS_EQUIVALENT:
        return DianStatus.PENDING
    return None


def issue_document(
    db: Session,
    *,
    order: Order,
    sub_account: OrderSubAccount | None,
    shift: Shift,
    store: Store,
    actor: Any,
    totals: OrderTotals,
    tip: TipSnapshot,
    lines: list[dict[str, Any]],
    payments_snapshot: list[dict[str, Any]],
    tables_text: str | None,
    business_date: date,
    now: datetime,
) -> FiscalDocument:
    """Arma y guarda el comprobante. `number` se reserva ANTES de llamar acá
    (`app.payments.service.pay_order`, ya dentro de la transacción del
    cobro); esta función nunca reserva por su cuenta para que el llamador
    controle el orden con el resto de la escritura (`OrderTip`, `Payment`).
    """
    document_type = _resolve_document_type(db, organization_id=order.organization_id, store_id=store.id)
    number = reserve_next_number(db, store_id=store.id, document_type=document_type.value, prefix=PREFIX)

    target_key = f"order:{order.id}" if sub_account is None else f"sub:{sub_account.id}"
    fiscal_config = stores_service.current_fiscal(db, store.id, on=business_date)

    row = FiscalDocument(
        organization_id=order.organization_id,
        store_id=store.id,
        order_id=order.id,
        sub_account_id=sub_account.id if sub_account is not None else None,
        shift_id=shift.id,
        target_key=target_key,
        document_type=document_type,
        prefix=PREFIX,
        number=number,
        dian_status=_dian_status_for(document_type),
        legend=_legend_for(document_type),
        business_date=business_date,
        issued_at=now,
        customer_doc_type=DEFAULT_CUSTOMER_DOC_TYPE,
        customer_doc_number=DEFAULT_CUSTOMER_DOC_NUMBER,
        customer_name=DEFAULT_CUSTOMER_NAME,
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
        fiscal_range_id=None,
        cude=None,
        qr_url=None,
        xml_ref=None,
        provider_response=None,
        validated_at=None,
        status="issued",
        print_count=1,
        reprint_count=0,
        created_at=now,
    )
    db.add(row)
    db.flush()
    return row
