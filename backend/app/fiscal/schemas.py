"""Esquemas Pydantic de rangos de numeración, estados DIAN, evidencia,
exportación y notas (pedido 1b-2). Ningún esquema de este módulo lleva
`cost`/`margin`/`unit_cost` (el operador no recibe costos, `AGENTS.md`) — de
todos modos ninguna de estas rutas es de dispositivo: todas son `admin`.

**Decisión declarada**: `features/fase-1b-venta/spec.md` («API contract →
Admin fiscal») nombra los extremos del rango `from`/`to`. Ninguno de los dos
puede ser un nombre de campo Python (`from` es palabra reservada); la salida
alternativa — `Field(alias="from")` + `populate_by_name=True` — exige el
plugin de mypy de Pydantic para que el `__init__` sintetizado acepte el
nombre del campo además del alias, y este proyecto no lo tiene configurado
(`pyproject.toml § [tool.mypy]`, fuera de mi territorio). Configurarlo a
mano habría cambiado el comportamiento de mypy para TODO el árbol, no sólo
este archivo. Se opta por `from_number`/`to_number` sin alias: la API
devuelve esas claves (no literalmente `from`/`to`) en JSON; el CSV de
`GET /admin/fiscal/ranges?format=csv` sí usa los encabezados `from`/`to`
literales (se arman a mano, no pasan por este esquema). Declarado también en
el entregable (`gaps`).
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Any, Literal

from pydantic import BaseModel, Field

DocumentTypeLiteral = Literal[
    "pos_equivalent", "invoice", "adjustment_note", "credit_note", "debit_note", "internal_receipt"
]
DianStatusLiteral = Literal["pending", "sent", "validated", "rejected", "contingency"]
NoteKindLiteral = Literal["adjustment", "credit", "debit"]


# ---------------------------------------------------------------------------
# Rangos de numeración (`GET/POST /admin/fiscal/ranges`)
# ---------------------------------------------------------------------------


class FiscalRangeIn(BaseModel):
    store_id: int
    document_type: DocumentTypeLiteral
    prefix: str = Field(min_length=1, max_length=10)
    from_number: int = Field(gt=0)
    to_number: int = Field(gt=0)
    resolution_number: str = Field(min_length=1, max_length=50)
    resolution_date: date
    valid_from: date
    valid_until: date
    technical_key: str | None = None


class FiscalRangeOut(BaseModel):
    id: int
    store_id: int
    document_type: DocumentTypeLiteral
    prefix: str
    from_number: int
    to_number: int
    resolution_number: str
    resolution_date: date
    valid_from: date
    valid_until: date
    technical_key: str | None
    consumed: int


# ---------------------------------------------------------------------------
# `GET /admin/fiscal/documents?status=`
# ---------------------------------------------------------------------------


class AdminFiscalDocumentOut(BaseModel):
    id: int
    full_number: str
    document_type: DocumentTypeLiteral
    dian_status: DianStatusLiteral | None
    contingency: bool
    contingency_overdue: bool
    business_date: date
    issued_at: datetime
    order_id: int
    total: int
    tip_amount: int
    charged_by: str
    customer_name: str
    reverses_document_id: int | None


# ---------------------------------------------------------------------------
# `POST /admin/fiscal/documents/{id}/retry`
# ---------------------------------------------------------------------------


class RetryDocumentOut(BaseModel):
    id: int
    full_number: str
    dian_status: DianStatusLiteral | None
    legend: str
    cude: str | None
    qr_url: str | None
    contingency: bool


# ---------------------------------------------------------------------------
# `GET /admin/fiscal/documents/{id}/evidence`
# ---------------------------------------------------------------------------


class FiscalRangeRefOut(BaseModel):
    id: int
    prefix: str
    from_number: int
    to_number: int
    resolution_number: str
    valid_until: date


class DocumentEvidenceOut(BaseModel):
    id: int
    full_number: str
    document_type: DocumentTypeLiteral
    dian_status: DianStatusLiteral | None
    cude: str | None
    qr_url: str | None
    xml_ref: str | None
    provider_response: dict[str, Any] | None
    validated_at: datetime | None
    issued_at: datetime
    content_hash: str
    range: FiscalRangeRefOut | None


# ---------------------------------------------------------------------------
# `GET /admin/fiscal/export`
# ---------------------------------------------------------------------------


class ExportManifestEntry(BaseModel):
    id: int
    full_number: str
    document_type: DocumentTypeLiteral
    business_date: date
    total: int
    hash: str


class ExportBundleOut(BaseModel):
    generated_at: datetime
    store_id: int
    date_from: date
    date_to: date
    document_count: int
    documents: list[ExportManifestEntry]
    manifest_hash: str


# ---------------------------------------------------------------------------
# Notas (`POST /admin/documents/{id}/notes`, `GET /admin/notes`)
# ---------------------------------------------------------------------------


class NoteLineIn(BaseModel):
    item_id: int
    used: bool
    # SPEC-NEGOCIO §3.5: «por línea "se usó" (no vuelve al inventario) o
    # "vuelve"». `True` = "vuelve" (revierte el consumo teórico registrado al
    # enviar); `False` = "se usó" (el plato se sirvió y no vuelve). El
    # DEFAULT es `True` porque §3.5 escribe "se usó" como la EXCEPCIÓN
    # marcada explícitamente entre paréntesis — "vuelve" es lo que pasa
    # cuando nadie dice lo contrario — y porque un campo requerido acá
    # rompería cualquier llamador que hoy manda `{"item_id": X, "used": true}`
    # sin conocer este campo nuevo (422, no el comportamiento que la spec
    # pide). Una nota `kind="debit"` ignora este campo por completo y fuerza
    # `False` en el servicio (ver `app.fiscal.service.issue_note`): una nota
    # débito cobra más, nunca devuelve producto.
    returns_to_stock: bool = True


class RefundIn(BaseModel):
    method: str
    amount: int = Field(ge=0)


class NoteCreateIn(BaseModel):
    kind: NoteKindLiteral
    reason: str = Field(min_length=1)
    lines: list[NoteLineIn] = Field(min_length=1)
    refund: RefundIn | None = None


class NoteLineOut(BaseModel):
    item_id: int
    qty: int
    description: str
    unit_price: int
    gross: int
    discount: int
    net: int
    tax_rate: int
    base: int
    tax: int
    courtesy: bool


class NoteOut(BaseModel):
    id: int
    document_type: DocumentTypeLiteral
    prefix: str
    number: int
    full_number: str
    reverses_document_id: int
    reason: str
    lines: list[NoteLineOut]
    subtotal: int
    discount_total: int
    tax_total: int
    total: int
    dian_status: DianStatusLiteral | None
    legend: str
    business_date: date
    issued_at: datetime
    # `RefundOutcome.status` de `app.refunds.hooks.settle_or_queue_refund`:
    # "settled_in_shift" | "pending" | "settled_externally"; `None` si la
    # nota no traía `refund` o el gancho todavía no existe (`gaps`).
    refund_status: str | None
    # Ítems cuyo consumo teórico se REVIRTIÓ de verdad contra el libro
    # (`app.orders.hooks.reverse_item_consumption`, espejo exacto). Vacía
    # cuando ninguna línea pedía `returns_to_stock=True`, cuando
    # `inventory.perpetual` está apagada, o cuando la nota es `debit` (nunca
    # revierte). Para que la pantalla pueda confirmar qué volvió al
    # inventario sin adivinar a partir de `lines[].used`.
    returned_to_stock_item_ids: list[int] = Field(default_factory=list)


class AdminNoteListItem(BaseModel):
    id: int
    full_number: str
    document_type: DocumentTypeLiteral
    reverses_document_id: int
    reason: str
    total: int
    business_date: date
    issued_at: datetime


class DeviceFiscalRangeOut(BaseModel):
    """Qué documento va a salir de este cobro, para la pantalla del salón.

    Es lo mínimo que el operador necesita antes de cerrar la cuenta: qué tipo
    de documento sale, con qué resolución, y si quedan números. **No es la
    máquina de estados DIAN** —eso sigue siendo del administrador— ni trae
    costos ni márgenes.

    `remaining` y `exhausted` los calcula el servidor. Restarlos en la
    pantalla obligaría a publicar `next_number`, que es estado interno de la
    reserva de consecutivos, y a que dos clientes coincidieran en la resta.
    """

    document_type: DocumentTypeLiteral
    #: La frase que la pantalla del salón muestra al pie, **tal cual**. La
    #: escribe el servidor por la misma razón que las leyendas impresas
    #: (`LEGEND_*`): nombra figuras de la DIAN, y una corrección legal no
    #: puede depender de desplegar el frontend. La pantalla la imprime, no la
    #: arma ni la completa.
    notice: str
    #: `None` cuando el tipo no se numera dentro de un rango DIAN (la sede no
    #: está obligada). La pantalla no inventa una resolución.
    prefix: str | None = None
    resolution_number: str | None = None
    from_number: int | None = None
    to_number: int | None = None
    valid_until: date | None = None
    remaining: int | None = None
    exhausted: bool = False
