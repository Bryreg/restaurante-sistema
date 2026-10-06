"""Proveedores, recepciones de compra, cuentas por pagar y pagos (pedido 2b,
`features/fase-2-costo-inventario/spec.md § Alcance de 2b`, `docs/SPEC-
NEGOCIO.md §5.6`).

Convenciones heredadas (`docs/ESTADO.md`, `AGENTS.md`, y el contrato numérico
de 2a en `app.core.quantity`):
- `app.core.db.UTCDateTime` en todo `Mapped[datetime]`.
- Dinero (`Payable.amount`, `Payment.amount`, `ReceptionLine.tax_base`/
  `.tax_amount`) en `Integer`, pesos enteros — igual que `shifts`/`orders`.
- Cantidades de insumo en `Integer`, milésimas de la unidad base
  (`app.core.quantity.QTY_SCALE`); costos por unidad base en `BigInteger`,
  millonésimas de peso (`app.core.quantity.COST_SCALE`) — mismo contrato que
  `app.inventory.models`. Nunca `float`.
- Enums `native_enum=False`, comparados por valor.
- Todo modelo lleva `organization_id` y `store_id`.
- **Nada financiero se borra**: `Supplier.active` es baja lógica;
  `Reception`/`Payable`/`Payment` nunca se hacen `DELETE` — se revierten o se
  anulan con motivo, siempre agregando una fila o un campo de estado nuevo.
- **El saldo de una cuenta por pagar NO es una columna**: `Payable` no tiene
  campo `balance`. Se deriva siempre de `Payment` vivos
  (`app.purchases.service.payable_balance`) — regla dura de `AGENTS.md`
  ("una sola matemática, en el backend"), la misma que ya rige el esperado de
  caja.
- `ReceptionLine.stock_batch_id` es `Integer` **sin FK dura**: `stock_batches`
  es tabla de `app.inventory` (territorio ajeno, construida en paralelo en
  este mismo pedido 2b) que puede no existir todavía cuando esta migración
  corre — mismo patrón que `StockMovement.preparation_id` en
  `0008_inventory.py`. `ReceptionLine.stock_movement_id`, en cambio, SÍ es FK
  real: `stock_movements` ya existe desde 2a.
"""

from __future__ import annotations

import enum
from datetime import date, datetime

import sqlalchemy as sa
from sqlalchemy import CheckConstraint, ForeignKey, Index
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base, UTCDateTime

ENUM_LENGTH = 32


def _enum(pyenum: type[enum.Enum], *, length: int = ENUM_LENGTH) -> sa.Enum:
    return sa.Enum(pyenum, native_enum=False, length=length, validate_strings=True)


# ---------------------------------------------------------------------------
# Enums publicados.
# ---------------------------------------------------------------------------


class ReceptionStatus(str, enum.Enum):
    CONFIRMED = "confirmed"
    REVERSED = "reversed"


class PayableStatus(str, enum.Enum):
    PENDING_REVIEW = "pending_review"
    APPROVED = "approved"
    # No está en el contrato de 2a/2b como estado nombrado, pero hace falta
    # uno para "esta cuenta ya no aplica" cuando su recepción se revierte
    # (`app.purchases.service.reverse_reception`) sin haber tenido pagos
    # vivos: nunca se borra la fila, y `pending_review`/`approved` mentirían
    # sobre una deuda que ya no existe. Decisión declarada en el entregable
    # §5 (no la pide el contrato explícitamente, pero "nada financiero se
    # borra" + "una recepción revertida no puede dejar una cuenta viva" la
    # exigen juntas).
    CANCELLED = "cancelled"


class PaymentMethod(str, enum.Enum):
    CASH = "cash"
    CARD = "card"
    TRANSFER = "transfer"
    OTHER = "other"


# ---------------------------------------------------------------------------
# Proveedores.
# ---------------------------------------------------------------------------


class Supplier(Base):
    """Entidad canónica (SPEC-NEGOCIO §5.6): nunca texto libre en la
    recepción. Baja lógica únicamente."""

    __tablename__ = "suppliers"

    id: Mapped[int] = mapped_column(primary_key=True)
    organization_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), index=True)
    store_id: Mapped[int] = mapped_column(ForeignKey("stores.id"), index=True)

    name: Mapped[str] = mapped_column(sa.String(200))
    nit: Mapped[str | None] = mapped_column(sa.String(20), nullable=True)
    payment_term_days: Mapped[int] = mapped_column(sa.Integer, default=0)
    contact_name: Mapped[str | None] = mapped_column(sa.String(200), nullable=True)
    contact_phone: Mapped[str | None] = mapped_column(sa.String(40), nullable=True)
    invoices_required: Mapped[bool] = mapped_column(sa.Boolean, default=True)
    active: Mapped[bool] = mapped_column(sa.Boolean, default=True)

    created_at: Mapped[datetime] = mapped_column(UTCDateTime())
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime())

    __table_args__ = (
        CheckConstraint("payment_term_days >= 0", name="ck_suppliers_payment_term_nonneg"),
        Index("ix_suppliers_store_active", "store_id", "active"),
        Index(
            "uq_suppliers_store_nit",
            "store_id",
            "nit",
            unique=True,
            postgresql_where=sa.text("nit IS NOT NULL"),
            sqlite_where=sa.text("nit IS NOT NULL"),
        ),
    )


# ---------------------------------------------------------------------------
# Recepciones.
# ---------------------------------------------------------------------------


class Reception(Base):
    """Una recepción de compra confirmada (SPEC-NEGOCIO §5.6). Pantalla de
    **administrador**, nunca de dispositivo: lleva precios (`received_by_*`
    es atribución de quien recibió físicamente, verificada por PIN, no una
    sesión — `created_by_*` es quien operó la pantalla de Admin)."""

    __tablename__ = "receptions"

    id: Mapped[int] = mapped_column(primary_key=True)
    organization_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), index=True)
    store_id: Mapped[int] = mapped_column(ForeignKey("stores.id"), index=True)
    supplier_id: Mapped[int] = mapped_column(ForeignKey("suppliers.id"), index=True)

    invoice_number: Mapped[str | None] = mapped_column(sa.String(80), nullable=True)
    invoice_date: Mapped[date] = mapped_column(sa.Date)
    no_invoice: Mapped[bool] = mapped_column(sa.Boolean, default=False)
    photo: Mapped[str | None] = mapped_column(sa.String(500), nullable=True)
    # D-2 (`features/fase-3-dinero-control/spec.md § 1`, territorio de
    # `backend-obligaciones`): lo que dice el PAPEL de la factura, opcional
    # (una recepción `no_invoice=True` no tiene papel que copiar). NUNCA
    # sustituye a `Payable.amount` (el cálculo, que sigue costeando el
    # inventario) — las dos cifras se guardan y la diferencia se publica
    # como `invoice_discrepancy` en la salida de la cuenta por pagar,
    # derivada, nunca almacenada.
    invoice_total: Mapped[int | None] = mapped_column(sa.Integer, nullable=True)

    received_by_employee_id: Mapped[int] = mapped_column(ForeignKey("employees.id"))
    received_by_employee_name: Mapped[str] = mapped_column(sa.String(200))

    created_by_employee_id: Mapped[int] = mapped_column(ForeignKey("employees.id"))
    created_by_employee_name: Mapped[str] = mapped_column(sa.String(200))

    status: Mapped[ReceptionStatus] = mapped_column(_enum(ReceptionStatus, length=16), default=ReceptionStatus.CONFIRMED)

    # Guardas de tecleo (§4.1/§5.6): true si CUALQUIER línea necesitó
    # `confirm_price: true` para pasar. Queda registrado quién confirmó.
    price_confirmed: Mapped[bool] = mapped_column(sa.Boolean, default=False)
    price_confirmed_by_employee_id: Mapped[int | None] = mapped_column(ForeignKey("employees.id"), nullable=True)
    price_confirmed_by_employee_name: Mapped[str | None] = mapped_column(sa.String(200), nullable=True)

    at: Mapped[datetime] = mapped_column(UTCDateTime())
    # Fecha de negocio sellada con la hora de corte de la sede en el instante
    # de la confirmación (una recepción a las 00:30 queda con el día del
    # turno) — nunca derivada de `at` en una consulta.
    business_date: Mapped[date] = mapped_column(sa.Date)

    reversed_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    reversed_by_employee_id: Mapped[int | None] = mapped_column(ForeignKey("employees.id"), nullable=True)
    reversed_by_employee_name: Mapped[str | None] = mapped_column(sa.String(200), nullable=True)

    # Tanda 5 (i3): la orden de compra que esta recepción cubre, si hay una.
    # Al confirmar, cierra las líneas de la orden cuyos insumos llegaron.
    purchase_order_id: Mapped[int | None] = mapped_column(ForeignKey("purchase_orders.id"), nullable=True)

    __table_args__ = (
        Index("ix_receptions_store_status", "store_id", "status"),
        Index("ix_receptions_store_supplier", "store_id", "supplier_id"),
        Index("ix_receptions_store_date", "store_id", "business_date"),
    )


class ReceptionLine(Base):
    """Una línea de recepción: un insumo, un lote, un costo (SPEC-NEGOCIO
    §5.6/§5.7). `unit_cost_micros` es el costo PRE-impuesto por unidad base
    (convertido de `purchase_unit_price` con `purchase_factor`);
    `final_unit_cost_micros` es el que de verdad viaja al lote y al
    movimiento — con el IVA sumado cuando la sede es responsable de INC
    (§4.1: "el IVA bajo INC es mayor valor del costo"), igual al primero
    bajo IVA (franquicia), donde el impuesto es descontable y se reporta
    aparte (`tax_base`/`tax_rate`/`tax_amount`, nunca perdidos)."""

    __tablename__ = "reception_lines"

    id: Mapped[int] = mapped_column(primary_key=True)
    reception_id: Mapped[int] = mapped_column(ForeignKey("receptions.id"), index=True)
    ingredient_id: Mapped[int] = mapped_column(ForeignKey("ingredients.id"), index=True)

    qty_received_base: Mapped[int] = mapped_column(sa.Integer)
    qty_invoiced_base: Mapped[int] = mapped_column(sa.Integer)

    # Micros por UNA unidad de compra, tal como se tecleó (antes de dividir
    # por `purchase_factor`) — se conserva para poder mostrar "lo que se
    # tecleó" en pantalla, nunca sólo el resultado ya convertido.
    purchase_unit_price_micros: Mapped[int] = mapped_column(sa.BigInteger)

    unit_cost_micros: Mapped[int] = mapped_column(sa.BigInteger)
    final_unit_cost_micros: Mapped[int] = mapped_column(sa.BigInteger)

    tax_base: Mapped[int] = mapped_column(sa.Integer)
    tax_rate: Mapped[int] = mapped_column(sa.Integer)
    tax_amount: Mapped[int] = mapped_column(sa.Integer)

    lot_code: Mapped[str | None] = mapped_column(sa.String(80), nullable=True)
    expires_at: Mapped[date | None] = mapped_column(sa.Date, nullable=True)

    # Sin FK dura: `stock_batches` es tabla de `app.inventory` (ver docstring
    # del módulo).
    stock_batch_id: Mapped[int | None] = mapped_column(sa.Integer, nullable=True)
    stock_movement_id: Mapped[int | None] = mapped_column(ForeignKey("stock_movements.id"), nullable=True)

    __table_args__ = (
        CheckConstraint("qty_received_base > 0", name="ck_reception_lines_qty_received_positive"),
        CheckConstraint("qty_invoiced_base > 0", name="ck_reception_lines_qty_invoiced_positive"),
        CheckConstraint("tax_base >= 0", name="ck_reception_lines_tax_base_nonneg"),
        CheckConstraint("tax_amount >= 0", name="ck_reception_lines_tax_amount_nonneg"),
        CheckConstraint(
            "tax_rate >= 0 AND tax_rate <= 100", name="ck_reception_lines_tax_rate_range"
        ),
        Index("ix_reception_lines_reception", "reception_id"),
        Index("ix_reception_lines_ingredient", "ingredient_id"),
    )


# ---------------------------------------------------------------------------
# Cuentas por pagar y pagos.
# ---------------------------------------------------------------------------


class Payable(Base):
    """Cuenta por pagar creada por una recepción confirmada (una por
    recepción). `amount` es el total original de la factura/recepción —
    snapshot inmutable, igual que un total de documento fiscal — **nunca**
    un campo `balance`: el saldo se deriva siempre de los pagos vivos
    (`app.purchases.service.payable_balance`)."""

    __tablename__ = "payables"

    id: Mapped[int] = mapped_column(primary_key=True)
    organization_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), index=True)
    store_id: Mapped[int] = mapped_column(ForeignKey("stores.id"), index=True)
    supplier_id: Mapped[int] = mapped_column(ForeignKey("suppliers.id"), index=True)
    reception_id: Mapped[int] = mapped_column(ForeignKey("receptions.id"), unique=True)

    amount: Mapped[int] = mapped_column(sa.Integer)
    status: Mapped[PayableStatus] = mapped_column(_enum(PayableStatus, length=16), default=PayableStatus.PENDING_REVIEW)
    due_date: Mapped[date] = mapped_column(sa.Date)

    approved_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    approved_by_employee_id: Mapped[int | None] = mapped_column(ForeignKey("employees.id"), nullable=True)
    approved_by_employee_name: Mapped[str | None] = mapped_column(sa.String(200), nullable=True)

    created_at: Mapped[datetime] = mapped_column(UTCDateTime())
    business_date: Mapped[date] = mapped_column(sa.Date)

    # D-2: queda registrado que alguien reconoció explícitamente una
    # diferencia entre `Reception.invoice_total` y `amount` al aprobar
    # (mismo patrón que `Reception.price_confirmed*` para `confirm_price`).
    # `False`/`None` cuando no hubo diferencia que confirmar.
    discrepancy_confirmed: Mapped[bool] = mapped_column(sa.Boolean, default=False)
    discrepancy_confirmed_by_employee_id: Mapped[int | None] = mapped_column(ForeignKey("employees.id"), nullable=True)
    discrepancy_confirmed_by_employee_name: Mapped[str | None] = mapped_column(sa.String(200), nullable=True)

    __table_args__ = (
        CheckConstraint("amount > 0", name="ck_payables_amount_positive"),
        Index("ix_payables_store_status", "store_id", "status"),
        Index("ix_payables_store_due_date", "store_id", "due_date"),
        Index("ix_payables_supplier", "supplier_id"),
    )


class Payment(Base):
    """Un pago contra una cuenta por pagar. Nunca se borra ni se edita:
    anular es un cambio de estado con motivo (`voided_*`), y el pago
    anulado deja de contar en `payable_balance` sin desaparecer del
    historial. Tabla propia (`purchase_payments`, no `payments`) para no
    chocar con `app.payments.models.Payment` (pagos de venta, dominio
    ajeno)."""

    __tablename__ = "purchase_payments"

    id: Mapped[int] = mapped_column(primary_key=True)
    organization_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), index=True)
    store_id: Mapped[int] = mapped_column(ForeignKey("stores.id"), index=True)
    payable_id: Mapped[int] = mapped_column(ForeignKey("payables.id"), index=True)

    amount: Mapped[int] = mapped_column(sa.Integer)
    method: Mapped[PaymentMethod] = mapped_column(_enum(PaymentMethod, length=16))
    paid_at: Mapped[datetime] = mapped_column(UTCDateTime())
    reference: Mapped[str | None] = mapped_column(sa.String(120), nullable=True)

    from_cash_drawer: Mapped[bool] = mapped_column(sa.Boolean, default=False)
    # FK real: `cash_movements` (app.shifts) ya existe desde 1a.
    cash_movement_id: Mapped[int | None] = mapped_column(ForeignKey("cash_movements.id"), nullable=True)

    employee_id: Mapped[int] = mapped_column(ForeignKey("employees.id"))
    employee_name: Mapped[str] = mapped_column(sa.String(200))
    authorized_by_employee_id: Mapped[int] = mapped_column(ForeignKey("employees.id"))
    authorized_by_employee_name: Mapped[str] = mapped_column(sa.String(200))

    created_at: Mapped[datetime] = mapped_column(UTCDateTime())

    voided_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    voided_reason: Mapped[str | None] = mapped_column(sa.Text(), nullable=True)
    voided_by_employee_id: Mapped[int | None] = mapped_column(ForeignKey("employees.id"), nullable=True)
    voided_by_employee_name: Mapped[str | None] = mapped_column(sa.String(200), nullable=True)

    __table_args__ = (
        CheckConstraint("amount > 0", name="ck_purchase_payments_amount_positive"),
        Index("ix_purchase_payments_payable", "payable_id"),
        Index("ix_purchase_payments_store_created", "store_id", "created_at"),
    )


# ---------------------------------------------------------------------------
# Recepciones por completar (recibir mercancía desde el POS, 2026-09-25).
# ---------------------------------------------------------------------------


class ReceptionDraftStatus(str, enum.Enum):
    PENDING = "pending"
    COMPLETED = "completed"
    REJECTED = "rejected"


class ReceptionDraft(Base):
    """Lo que registra en el POS quien está en el turno cuando llega un
    proveedor: proveedor, factura o «sin factura», foto obligatoria del papel
    y las líneas (insumo y cantidad en su unidad de compra). **Sin ningún
    precio**: la tablet no ve costos (`AGENTS.md`), y el costo lo pone el
    administrador al completarla, por el camino de siempre
    (`service.create_reception`), que es el que crea lotes, costo y la
    cuenta por pagar. Hasta entonces el stock NO sube: entra con un costo
    real o no entra.

    `cash_paid_amount` es la plata que el cajero entregó de contado desde el
    cajón, en pesos (`None` = no pagó del cajón, nunca 0). Esa salida se
    registra al crear el borrador como egreso del turno abierto
    (`cash_movement_id`, causa `SUPPLIER_PAYMENT`); al completar, la cuenta
    por pagar la refleja como un pago que apunta a ESE movimiento, sin sacar
    plata del cajón otra vez.

    Nunca se borra: `pending` → `completed` (con `reception_id`) o
    `rejected` (con motivo y quién)."""

    __tablename__ = "reception_drafts"

    id: Mapped[int] = mapped_column(primary_key=True)
    organization_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), index=True)
    store_id: Mapped[int] = mapped_column(ForeignKey("stores.id"), index=True)
    supplier_id: Mapped[int] = mapped_column(ForeignKey("suppliers.id"), index=True)

    invoice_number: Mapped[str | None] = mapped_column(sa.String(80), nullable=True)
    no_invoice: Mapped[bool] = mapped_column(sa.Boolean, default=False)
    photo: Mapped[str] = mapped_column(sa.String(500))

    status: Mapped[ReceptionDraftStatus] = mapped_column(
        _enum(ReceptionDraftStatus, length=16), default=ReceptionDraftStatus.PENDING
    )

    cash_paid_amount: Mapped[int | None] = mapped_column(sa.Integer, nullable=True)
    # FK real: `cash_movements` (app.shifts) existe desde 1a.
    cash_movement_id: Mapped[int | None] = mapped_column(ForeignKey("cash_movements.id"), nullable=True)

    created_by_employee_id: Mapped[int] = mapped_column(ForeignKey("employees.id"))
    created_by_employee_name: Mapped[str] = mapped_column(sa.String(200))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime())
    business_date: Mapped[date] = mapped_column(sa.Date)

    reception_id: Mapped[int | None] = mapped_column(ForeignKey("receptions.id"), nullable=True, unique=True)
    completed_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    completed_by_employee_id: Mapped[int | None] = mapped_column(ForeignKey("employees.id"), nullable=True)
    completed_by_employee_name: Mapped[str | None] = mapped_column(sa.String(200), nullable=True)

    rejected_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    rejected_reason: Mapped[str | None] = mapped_column(sa.Text(), nullable=True)
    rejected_by_employee_id: Mapped[int | None] = mapped_column(ForeignKey("employees.id"), nullable=True)
    rejected_by_employee_name: Mapped[str | None] = mapped_column(sa.String(200), nullable=True)

    __table_args__ = (
        CheckConstraint(
            "cash_paid_amount IS NULL OR cash_paid_amount > 0", name="ck_reception_drafts_cash_paid_positive"
        ),
        Index("ix_reception_drafts_store_status", "store_id", "status"),
        Index("ix_reception_drafts_store_date", "store_id", "business_date"),
    )


class ReceptionDraftLine(Base):
    """Una línea de la recepción por completar. La cantidad se captura en la
    unidad de COMPRA (lo que dice el papel: «2 bultos»), en milésimas
    (`qty_purchase_milli`); `purchase_unit` y `purchase_factor` se congelan
    al capturar, y `qty_base` (milésimas de la unidad base) es la conversión
    hecha una sola vez acá, en el backend — la que precarga el formulario del
    administrador."""

    __tablename__ = "reception_draft_lines"

    id: Mapped[int] = mapped_column(primary_key=True)
    draft_id: Mapped[int] = mapped_column(ForeignKey("reception_drafts.id"), index=True)
    ingredient_id: Mapped[int] = mapped_column(ForeignKey("ingredients.id"), index=True)

    qty_purchase_milli: Mapped[int] = mapped_column(sa.Integer)
    purchase_unit: Mapped[str] = mapped_column(sa.String(50))
    purchase_factor: Mapped[int] = mapped_column(sa.Integer)
    qty_base: Mapped[int] = mapped_column(sa.Integer)

    lot_code: Mapped[str | None] = mapped_column(sa.String(80), nullable=True)
    expires_at: Mapped[date | None] = mapped_column(sa.Date, nullable=True)

    __table_args__ = (
        CheckConstraint("qty_purchase_milli > 0", name="ck_reception_draft_lines_qty_positive"),
        CheckConstraint("purchase_factor > 0", name="ck_reception_draft_lines_factor_positive"),
        CheckConstraint("qty_base > 0", name="ck_reception_draft_lines_qty_base_positive"),
    )


# ---------------------------------------------------------------------------
# Órdenes de compra (tanda 5, i3).
# ---------------------------------------------------------------------------


class PurchaseOrderStatus(str, enum.Enum):
    DRAFT = "draft"
    SENT = "sent"
    PARTIALLY_RECEIVED = "partially_received"
    RECEIVED = "received"
    CANCELLED = "cancelled"


class PurchaseOrderSource(str, enum.Enum):
    MANUAL = "manual"
    REPLENISHMENT = "replenishment"


class PurchaseOrder(Base):
    """Lo que se le pide a un proveedor, antes de que llegue. Nace en
    borrador (a mano o desde la reposición sugerida), se marca enviada y las
    recepciones que la nombran cierran sus líneas: `partially_received`
    mientras quede alguna abierta, `received` cuando no queda ninguna.
    Cancelar es un cambio de estado con motivo; nunca se borra.

    **Sin precios para nadie que no sea administración**: toda la entidad
    vive detrás de rutas de administrador. `number` es consecutivo por sede
    (`uq_purchase_orders_store_number`), el que lleva la hoja impresa."""

    __tablename__ = "purchase_orders"

    id: Mapped[int] = mapped_column(primary_key=True)
    organization_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), index=True)
    store_id: Mapped[int] = mapped_column(ForeignKey("stores.id"), index=True)
    supplier_id: Mapped[int] = mapped_column(ForeignKey("suppliers.id"), index=True)

    number: Mapped[int] = mapped_column(sa.Integer)
    status: Mapped[PurchaseOrderStatus] = mapped_column(
        _enum(PurchaseOrderStatus, length=24), default=PurchaseOrderStatus.DRAFT
    )
    source: Mapped[PurchaseOrderSource] = mapped_column(
        _enum(PurchaseOrderSource, length=16), default=PurchaseOrderSource.MANUAL
    )
    expected_date: Mapped[date | None] = mapped_column(sa.Date, nullable=True)
    notes: Mapped[str | None] = mapped_column(sa.Text(), nullable=True)

    created_by_employee_id: Mapped[int] = mapped_column(ForeignKey("employees.id"))
    created_by_employee_name: Mapped[str] = mapped_column(sa.String(200))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime())
    business_date: Mapped[date] = mapped_column(sa.Date)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime())

    sent_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    # Día operativo del envío, sellado al marcarla enviada: de acá se mide
    # cuánto tarda el proveedor en entregar (`prices.supplier_comparison`).
    sent_business_date: Mapped[date | None] = mapped_column(sa.Date, nullable=True)
    sent_by_employee_id: Mapped[int | None] = mapped_column(ForeignKey("employees.id"), nullable=True)
    sent_by_employee_name: Mapped[str | None] = mapped_column(sa.String(200), nullable=True)

    cancelled_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    cancelled_by_employee_id: Mapped[int | None] = mapped_column(ForeignKey("employees.id"), nullable=True)
    cancelled_by_employee_name: Mapped[str | None] = mapped_column(sa.String(200), nullable=True)
    cancel_reason: Mapped[str | None] = mapped_column(sa.Text(), nullable=True)

    __table_args__ = (
        sa.UniqueConstraint("store_id", "number", name="uq_purchase_orders_store_number"),
        Index("ix_purchase_orders_store_status", "store_id", "status"),
    )


class PurchaseOrderLine(Base):
    """Un insumo de la orden. La cantidad se pide en la UNIDAD DE COMPRA (lo
    que entiende el proveedor: «3 bultos»), en milésimas
    (`qty_purchase_milli`), con la unidad y el factor congelados al pedir y
    `qty_base` convertido una sola vez acá. `expected_unit_price_micros` es
    el precio esperado por UNA unidad de compra (opcional, para la hoja).

    `closed_reception_id`: la recepción que cubrió esta línea. Lo recibido
    no se guarda: se deriva de las líneas de las recepciones confirmadas de
    la orden. Si esa recepción se revierte, la línea vuelve a abrirse."""

    __tablename__ = "purchase_order_lines"

    id: Mapped[int] = mapped_column(primary_key=True)
    order_id: Mapped[int] = mapped_column(ForeignKey("purchase_orders.id"), index=True)
    ingredient_id: Mapped[int] = mapped_column(ForeignKey("ingredients.id"), index=True)
    position: Mapped[int] = mapped_column(sa.Integer, default=0)

    qty_purchase_milli: Mapped[int] = mapped_column(sa.Integer)
    purchase_unit: Mapped[str] = mapped_column(sa.String(50))
    purchase_factor: Mapped[int] = mapped_column(sa.Integer)
    qty_base: Mapped[int] = mapped_column(sa.Integer)
    expected_unit_price_micros: Mapped[int | None] = mapped_column(sa.BigInteger, nullable=True)

    closed_reception_id: Mapped[int | None] = mapped_column(ForeignKey("receptions.id"), nullable=True)
    closed_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    # Sacada del borrador al editarlo (nunca se borra la fila). Volver a
    # poner el insumo la reactiva.
    removed_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)

    __table_args__ = (
        sa.UniqueConstraint("order_id", "ingredient_id", name="uq_purchase_order_lines_order_ingredient"),
        CheckConstraint("qty_purchase_milli > 0", name="ck_purchase_order_lines_qty_positive"),
        CheckConstraint("purchase_factor > 0", name="ck_purchase_order_lines_factor_positive"),
        CheckConstraint("qty_base > 0", name="ck_purchase_order_lines_qty_base_positive"),
        CheckConstraint(
            "expected_unit_price_micros IS NULL OR expected_unit_price_micros >= 0",
            name="ck_purchase_order_lines_price_nonneg",
        ),
    )


# ---------------------------------------------------------------------------
# Devoluciones al proveedor / notas crédito (tanda 5, i4).
# ---------------------------------------------------------------------------


class SupplierReturn(Base):
    """Mercancía de una línea de recepción que se le devuelve al proveedor,
    con motivo. Saca stock (movimiento `RECEPTION_REVERSAL`, `ref_type=
    "supplier_return"`, del lote exacto de la línea) y vale plata:
    `amount` es lo devuelto a precio de la factura (cantidad × costo sin
    impuesto + la parte proporcional del impuesto de la línea), en pesos.

    De esa plata, `applied_to_payable` baja el saldo de la cuenta por pagar
    de la recepción (hasta lo que quedaba por pagar) y `credit_amount` es el
    resto: un saldo a favor con el proveedor (nota crédito), porque esa
    cuenta ya estaba pagada. Las dos se congelan al registrar. El saldo de
    la cuenta por pagar se sigue derivando (`service.payable_balance`):
    monto − pagos vivos − devoluciones aplicadas. Nunca se borra."""

    __tablename__ = "supplier_returns"

    id: Mapped[int] = mapped_column(primary_key=True)
    organization_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), index=True)
    store_id: Mapped[int] = mapped_column(ForeignKey("stores.id"), index=True)
    supplier_id: Mapped[int] = mapped_column(ForeignKey("suppliers.id"), index=True)
    reception_id: Mapped[int] = mapped_column(ForeignKey("receptions.id"), index=True)
    reception_line_id: Mapped[int] = mapped_column(ForeignKey("reception_lines.id"), index=True)
    ingredient_id: Mapped[int] = mapped_column(ForeignKey("ingredients.id"), index=True)
    payable_id: Mapped[int | None] = mapped_column(ForeignKey("payables.id"), nullable=True, index=True)

    qty_base: Mapped[int] = mapped_column(sa.Integer)
    # El costo con que sale del inventario: el final de la línea (el del lote).
    unit_cost_micros: Mapped[int] = mapped_column(sa.BigInteger)
    amount: Mapped[int] = mapped_column(sa.Integer)
    applied_to_payable: Mapped[int] = mapped_column(sa.Integer)
    credit_amount: Mapped[int] = mapped_column(sa.Integer)
    reason: Mapped[str] = mapped_column(sa.Text())

    # Sin FK dura, igual que `ReceptionLine.stock_batch_id`.
    stock_batch_id: Mapped[int | None] = mapped_column(sa.Integer, nullable=True)
    stock_movement_id: Mapped[int | None] = mapped_column(ForeignKey("stock_movements.id"), nullable=True)

    employee_id: Mapped[int] = mapped_column(ForeignKey("employees.id"))
    employee_name: Mapped[str] = mapped_column(sa.String(200))
    authorized_by_employee_id: Mapped[int] = mapped_column(ForeignKey("employees.id"))
    authorized_by_employee_name: Mapped[str] = mapped_column(sa.String(200))

    created_at: Mapped[datetime] = mapped_column(UTCDateTime())
    business_date: Mapped[date] = mapped_column(sa.Date)

    __table_args__ = (
        CheckConstraint("qty_base > 0", name="ck_supplier_returns_qty_positive"),
        CheckConstraint("amount >= 0", name="ck_supplier_returns_amount_nonneg"),
        CheckConstraint("applied_to_payable >= 0", name="ck_supplier_returns_applied_nonneg"),
        CheckConstraint("credit_amount >= 0", name="ck_supplier_returns_credit_nonneg"),
        CheckConstraint(
            "applied_to_payable + credit_amount = amount", name="ck_supplier_returns_amount_split"
        ),
        Index("ix_supplier_returns_store_date", "store_id", "business_date"),
    )
