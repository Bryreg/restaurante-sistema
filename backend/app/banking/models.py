"""Modelos de `banking`: la plata **después** de salir del cajón
(`docs/SPEC-NEGOCIO.md §6.1`, `features/fase-3-dinero-control/spec.md § T1`).

**La llave anti doble conteo de este dominio es RETIRO vs CONSIGNACIÓN**: una
consignación (`BankDeposit`) se imputa a turnos concretos ya cerrados a
través de `BankDepositAllocation`, y el mismo peso no puede estar «en la
mano» (retirado, sin consignar) y «en el banco» (consignado) a la vez. Ver el
detalle completo del diseño en `features/fase-3-dinero-control/outputs/
backend-banco.md § 1`.

**Lo que este dominio NUNCA recalcula**: `Shift.to_deposit`
(`app/shifts/service.py::_finalize_close`, snapshot de cierre) y
`compute_breakdown` (el esperado del turno). Acá sólo se LEE ese número y se
deriva, sin guardarla, la porción que todavía no se consignó.

Cuatro tablas nuevas:

- `bank_deposits` — una consignación con comprobante. Nada financiero se
  borra: una consignación mal cargada se reversa (`status=reversed` +
  motivo + quién), nunca se edita ni se elimina.
- `bank_deposit_allocations` — la imputación de una consignación a turnos
  cerrados concretos (la llave anti doble conteo, en forma de tabla). Una
  consignación puede cubrir varios turnos (una sola vuelta al banco por
  varios días de caja) o ninguno (plata retirada que se consigna sin atar a
  un turno puntual — igual cuenta para la mano del dueño y el libro del
  banco).
- `card_settlements` — una liquidación del datáfono: lo que el banco/
  procesador pagó por las ventas con tarjeta de un día de negocio, con su
  rezago (`settled_business_date − sales_business_date`), su comisión y sus
  retenciones. Se concilia contra `Payment(method="card")`, que no es de
  este dominio y no se toca.
- `platform_settlements` — el pago que una plataforma (Rappi, Didi…) hizo
  por sus cuentas por cobrar. Se concilia contra
  `app.channels.models.PlatformReceivable`, que **tampoco** se toca: la
  conciliación vive enteramente acá, nunca escribe en `channels`.

Convenciones heredadas (`docs/CONTEXTO-AGENTES.md`, `AGENTS.md`):
- `app.core.db.UTCDateTime` en todo `Mapped[datetime]`.
- Dinero en `Integer` (pesos enteros); nunca `float`.
- Enums no nativos (`sa.Enum(..., native_enum=False, validate_strings=True)`,
  **sin** `create_constraint`): la columna es un `VARCHAR` plano en los dos
  motores y no hay CHECK que una migración futura tenga que recrear
  (`docs/CONTEXTO-AGENTES.md §12`).
- Todo modelo lleva `organization_id` y `store_id` — salvo las tablas de
  línea (`bank_deposit_allocations`), que sólo se consultan a través de su
  padre, igual que `ReceptionLine` en `app.purchases.models`.
- Nada financiero se borra: reversar es un cambio de estado con motivo y
  quién, nunca un `DELETE` ni una edición del monto original.
"""

from __future__ import annotations

import enum
from datetime import date, datetime

import sqlalchemy as sa
from sqlalchemy import CheckConstraint, ForeignKey, Index, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base, UTCDateTime

ENUM_LENGTH = 16


def _enum(pyenum: type[enum.Enum], *, length: int = ENUM_LENGTH) -> sa.Enum:
    return sa.Enum(pyenum, native_enum=False, length=length, validate_strings=True)


class BankDepositStatus(str, enum.Enum):
    LIVE = "live"
    REVERSED = "reversed"


class SettlementStatus(str, enum.Enum):
    """Estado de una liquidación (datáfono o plataforma) registrada por el
    administrador. `RECORDED` es sólo el asiento de lo que el banco/la
    plataforma dice que pagó; `MATCHED` es la conciliación explícita contra
    lo esperado (`POST .../settle`); `REVERSED` es la baja lógica de un
    registro cargado por error."""

    RECORDED = "recorded"
    MATCHED = "matched"
    REVERSED = "reversed"


# ---------------------------------------------------------------------------
# Consignaciones y su imputación a turnos.
# ---------------------------------------------------------------------------


class BankDeposit(Base):
    """Una consignación al banco, con comprobante obligatorio.

    `business_date` es la fecha de negocio de la sede a la que corresponde
    la consignación (nunca derivada de un timestamp UTC al leer: la pone el
    servidor con `app.core.tz` a partir de la sede, o la elige
    explícitamente quien registra). `amount` es el total físicamente
    consignado; puede exceder lo imputado en `BankDepositAllocation` (plata
    de retiros que no se ató a un turno puntual) pero nunca ser menor —eso
    lo valida `app.banking.service.create_deposit` antes de escribir nada.
    """

    __tablename__ = "bank_deposits"

    id: Mapped[int] = mapped_column(primary_key=True)
    organization_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), index=True)
    store_id: Mapped[int] = mapped_column(ForeignKey("stores.id"), index=True)

    business_date: Mapped[date] = mapped_column(sa.Date)
    deposited_at: Mapped[datetime] = mapped_column(UTCDateTime())

    amount: Mapped[int] = mapped_column(sa.Integer)
    bank_name: Mapped[str | None] = mapped_column(sa.String(120), nullable=True)
    bank_reference: Mapped[str | None] = mapped_column(sa.String(120), nullable=True)
    # Comprobante: obligatorio (`app.banking.schemas.DepositIn.receipt_photo`
    # lo exige con `min_length=1`) — «consignaciones con comprobante»
    # (`features/fase-3-dinero-control/spec.md § T1`).
    receipt_photo: Mapped[str] = mapped_column(sa.String(500))
    note: Mapped[str | None] = mapped_column(sa.Text, nullable=True)

    employee_id: Mapped[int] = mapped_column(ForeignKey("employees.id"))
    employee_name: Mapped[str] = mapped_column(sa.String(200))

    status: Mapped[BankDepositStatus] = mapped_column(_enum(BankDepositStatus), default=BankDepositStatus.LIVE)

    # **Desde dónde salió la plata** (2026-09-24, consignar desde el POS).
    # `admin`: la registró el administrador; nace confirmada. `pos`: la
    # registró quien tiene la caja, con la plata de días anteriores que había
    # en el cajón del turno `from_shift_id` (`ShiftCarryIn`). Descuenta del
    # saldo por consignar desde que se registra —así otro cajero no consigna
    # el mismo día dos veces— y queda **por confirmar** (`confirmed_at` nulo)
    # hasta que el administrador la confirma o la rechaza (rechazar es
    # reversarla: el monto vuelve a quedar pendiente y al cajón).
    # Sin `CHECK` en la base a propósito: agregarlo obliga a recrear la tabla
    # en SQLite, y `bank_deposit_allocations` apunta acá (el problema de
    # `0011`). Los dos valores los escribe sólo `app.banking.service`.
    source: Mapped[str] = mapped_column(sa.String(8), default="admin", server_default="admin")
    from_shift_id: Mapped[int | None] = mapped_column(ForeignKey("shifts.id"), nullable=True, index=True)
    confirmed_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    confirmed_by_employee_id: Mapped[int | None] = mapped_column(ForeignKey("employees.id"), nullable=True)
    confirmed_by_employee_name: Mapped[str | None] = mapped_column(sa.String(200), nullable=True)

    reversed_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    reversed_reason: Mapped[str | None] = mapped_column(sa.Text, nullable=True)
    reversed_by_employee_id: Mapped[int | None] = mapped_column(ForeignKey("employees.id"), nullable=True)
    reversed_by_employee_name: Mapped[str | None] = mapped_column(sa.String(200), nullable=True)

    __table_args__ = (
        Index("ix_bank_deposits_store_business_date", "store_id", "business_date"),
        Index("ix_bank_deposits_store_status", "store_id", "status"),
        CheckConstraint("amount > 0", name="ck_bank_deposits_amount_positive"),
    )


class BankDepositAllocation(Base):
    """La imputación de una consignación a UN turno cerrado concreto.

    Es la llave anti doble conteo hecha tabla: `app.banking.service.
    create_deposit` valida, antes de escribir, que `Σ amount` de las
    imputaciones vivas de un turno (de ÉSTA y de cualquier otra
    consignación) nunca supere `Shift.to_deposit` — el mismo peso no puede
    imputarse dos veces. Una consignación puede tener cero imputaciones
    (plata retirada que se consigna sin atar a un turno puntual): en ese
    caso sigue contando para `GET /admin/bank/ledger` y para
    `GET /admin/bank/owner-hand`, pero no reduce el saldo por consignar de
    ningún turno en particular.
    """

    __tablename__ = "bank_deposit_allocations"

    id: Mapped[int] = mapped_column(primary_key=True)
    deposit_id: Mapped[int] = mapped_column(ForeignKey("bank_deposits.id"), index=True)
    shift_id: Mapped[int] = mapped_column(ForeignKey("shifts.id"), index=True)
    amount: Mapped[int] = mapped_column(sa.Integer)

    __table_args__ = (
        UniqueConstraint("deposit_id", "shift_id", name="uq_bank_deposit_allocations_deposit_shift"),
        CheckConstraint("amount > 0", name="ck_bank_deposit_allocations_amount_positive"),
    )


# ---------------------------------------------------------------------------
# Conciliación del datáfono.
# ---------------------------------------------------------------------------


class CardSettlement(Base):
    """Una liquidación del datáfono: lo que el banco/procesador pagó por las
    ventas con tarjeta de `sales_business_date`, recibido en
    `settled_business_date` (el rezago es la resta de las dos, derivada en
    la salida — nunca almacenada). `gross_amount` es lo liquidado antes de
    comisión y retenciones; el neto (`gross − commission − retention`) se
    deriva en `app.banking.schemas.CardSettlementOut`, no se guarda.

    Se concilia contra `Σ Payment.amount` (`method="card"`,
    `voided_at IS NULL`, `business_date == sales_business_date`) —
    `app.payments.models.Payment` no es territorio de este dominio y no se
    escribe.
    """

    __tablename__ = "card_settlements"

    id: Mapped[int] = mapped_column(primary_key=True)
    organization_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), index=True)
    store_id: Mapped[int] = mapped_column(ForeignKey("stores.id"), index=True)

    sales_business_date: Mapped[date] = mapped_column(sa.Date)
    settled_business_date: Mapped[date] = mapped_column(sa.Date)

    gross_amount: Mapped[int] = mapped_column(sa.Integer)
    commission_amount: Mapped[int] = mapped_column(sa.Integer, default=0)
    retention_amount: Mapped[int] = mapped_column(sa.Integer, default=0)

    reference: Mapped[str | None] = mapped_column(sa.String(120), nullable=True)
    note: Mapped[str | None] = mapped_column(sa.Text, nullable=True)

    status: Mapped[SettlementStatus] = mapped_column(_enum(SettlementStatus), default=SettlementStatus.RECORDED)

    employee_id: Mapped[int] = mapped_column(ForeignKey("employees.id"))
    employee_name: Mapped[str] = mapped_column(sa.String(200))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime())

    matched_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    matched_by_employee_id: Mapped[int | None] = mapped_column(ForeignKey("employees.id"), nullable=True)
    matched_by_employee_name: Mapped[str | None] = mapped_column(sa.String(200), nullable=True)

    reversed_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    reversed_reason: Mapped[str | None] = mapped_column(sa.Text, nullable=True)
    reversed_by_employee_id: Mapped[int | None] = mapped_column(ForeignKey("employees.id"), nullable=True)
    reversed_by_employee_name: Mapped[str | None] = mapped_column(sa.String(200), nullable=True)

    __table_args__ = (
        Index("ix_card_settlements_store_sales_date", "store_id", "sales_business_date"),
        Index("ix_card_settlements_store_status", "store_id", "status"),
        CheckConstraint("gross_amount >= 0", name="ck_card_settlements_gross_nonneg"),
        CheckConstraint("commission_amount >= 0", name="ck_card_settlements_commission_nonneg"),
        CheckConstraint("retention_amount >= 0", name="ck_card_settlements_retention_nonneg"),
    )


# ---------------------------------------------------------------------------
# Conciliación de plataformas.
# ---------------------------------------------------------------------------


class PlatformSettlement(Base):
    """El pago que una plataforma hizo por un período de sus cuentas por
    cobrar (`app.channels.models.PlatformReceivable`, sólo lectura). Un
    pago de plataforma suele cubrir varios días de negocio de una sola vez
    (liquidación semanal, típicamente), por eso es un RANGO
    (`period_from`..`period_to`) y no una fecha única como en el datáfono.

    `platform_id` referencia `app.channels.models.DeliveryPlatform` —
    lectura, nunca escritura: la conciliación entera vive en este dominio.
    """

    __tablename__ = "platform_settlements"

    id: Mapped[int] = mapped_column(primary_key=True)
    organization_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), index=True)
    store_id: Mapped[int] = mapped_column(ForeignKey("stores.id"), index=True)
    platform_id: Mapped[int] = mapped_column(ForeignKey("delivery_platforms.id"), index=True)

    period_from: Mapped[date] = mapped_column(sa.Date)
    period_to: Mapped[date] = mapped_column(sa.Date)

    gross_amount: Mapped[int] = mapped_column(sa.Integer)
    commission_amount: Mapped[int] = mapped_column(sa.Integer, default=0)

    reference: Mapped[str | None] = mapped_column(sa.String(120), nullable=True)
    note: Mapped[str | None] = mapped_column(sa.Text, nullable=True)

    status: Mapped[SettlementStatus] = mapped_column(_enum(SettlementStatus), default=SettlementStatus.RECORDED)

    employee_id: Mapped[int] = mapped_column(ForeignKey("employees.id"))
    employee_name: Mapped[str] = mapped_column(sa.String(200))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime())

    matched_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    matched_by_employee_id: Mapped[int | None] = mapped_column(ForeignKey("employees.id"), nullable=True)
    matched_by_employee_name: Mapped[str | None] = mapped_column(sa.String(200), nullable=True)

    reversed_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    reversed_reason: Mapped[str | None] = mapped_column(sa.Text, nullable=True)
    reversed_by_employee_id: Mapped[int | None] = mapped_column(ForeignKey("employees.id"), nullable=True)
    reversed_by_employee_name: Mapped[str | None] = mapped_column(sa.String(200), nullable=True)

    __table_args__ = (
        Index("ix_platform_settlements_store_platform", "store_id", "platform_id"),
        Index("ix_platform_settlements_store_status", "store_id", "status"),
        CheckConstraint("gross_amount >= 0", name="ck_platform_settlements_gross_nonneg"),
        CheckConstraint("commission_amount >= 0", name="ck_platform_settlements_commission_nonneg"),
        CheckConstraint("period_to >= period_from", name="ck_platform_settlements_period_order"),
    )


# ---------------------------------------------------------------------------
# 0046 · El libro del banco completo (c2, «igual que la Plata del café»):
# cuentas, saldo del extracto (ancla), movimientos tecleados por el dueño y
# a qué cuenta va cada renglón que el sistema ya conoce.
# ---------------------------------------------------------------------------


class BankMovementDirection(str, enum.Enum):
    IN = "in"
    OUT = "out"


class BankMovementCause(str, enum.Enum):
    """Causa tipada de un movimiento tecleado (nunca texto libre). Lo que el
    sistema ya registra en otro lado —consignaciones, datáfono,
    transferencias de clientes, gastos y obligaciones pagados del banco,
    pagos a proveedores— **no** se teclea acá: entra solo al libro."""

    PAYROLL = "payroll"
    BANK_FEE = "bank_fee"
    TAX = "tax"
    OWNER_WITHDRAWAL = "owner_withdrawal"
    OWNER_CONTRIBUTION = "owner_contribution"
    ACCOUNT_TRANSFER = "account_transfer"
    INTEREST = "interest"
    ADJUSTMENT = "adjustment"
    OTHER = "other"


class BankAccount(Base):
    """Una cuenta por donde entra y sale la plata de la sede (Bancolombia,
    Nequi…). Hay una **cuenta principal** (`is_default`) por sede: todo
    renglón que el sistema deriva y que nadie asignó a otra cuenta cae ahí.

    `gmf_exempt`: la cuenta está marcada exenta del 4×1000 ante el banco.
    Si no lo está, cada salida lleva su GMF derivado (nunca guardado).
    `receives_transfers`: las transferencias de clientes (medio de pago
    «transferencia») llegan a esta cuenta en vez de a la principal.

    Nunca se borra: se desactiva (`active = false`) y su historia sigue
    contando en el libro."""

    __tablename__ = "bank_accounts"

    id: Mapped[int] = mapped_column(primary_key=True)
    organization_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), index=True)
    store_id: Mapped[int] = mapped_column(ForeignKey("stores.id"), index=True)

    name: Mapped[str] = mapped_column(sa.String(80))
    is_default: Mapped[bool] = mapped_column(sa.Boolean, default=False)
    gmf_exempt: Mapped[bool] = mapped_column(sa.Boolean, default=False)
    receives_transfers: Mapped[bool] = mapped_column(sa.Boolean, default=False)
    active: Mapped[bool] = mapped_column(sa.Boolean, default=True)

    created_at: Mapped[datetime] = mapped_column(UTCDateTime())
    created_by_employee_id: Mapped[int | None] = mapped_column(ForeignKey("employees.id"), nullable=True)
    created_by_employee_name: Mapped[str | None] = mapped_column(sa.String(200), nullable=True)

    __table_args__ = (
        # Una sola cuenta principal por sede, defendido en la base: dos
        # «crear la principal» concurrentes chocan acá (409), no duplican.
        Index(
            "uq_bank_accounts_one_default_per_store",
            "store_id",
            unique=True,
            postgresql_where=sa.text("is_default"),
            sqlite_where=sa.text("is_default = 1"),
        ),
    )


class BankBalanceAnchor(Base):
    """El saldo del extracto que el dueño tecleó: **con cuánto cerró la
    cuenta el día `balance_date`**. El libro corre desde ahí: los renglones
    de días posteriores se suman encima. (El café lo toma como saldo de
    APERTURA; acá es de CIERRE, porque el dueño mira el banco a cualquier
    hora y un movimiento del mismo día que ya está en el extracto, contado
    otra vez, mostraría plata de más — el error tolerable es el que muestra
    menos.)

    Vale el ancla viva con la fecha más reciente. Nunca se edita ni se
    borra: una mal tecleada se anula con motivo, o se teclea una nueva."""

    __tablename__ = "bank_balance_anchors"

    id: Mapped[int] = mapped_column(primary_key=True)
    organization_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), index=True)
    store_id: Mapped[int] = mapped_column(ForeignKey("stores.id"), index=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("bank_accounts.id"), index=True)

    balance_date: Mapped[date] = mapped_column(sa.Date)
    balance: Mapped[int] = mapped_column(sa.Integer)
    note: Mapped[str | None] = mapped_column(sa.Text, nullable=True)

    employee_id: Mapped[int | None] = mapped_column(ForeignKey("employees.id"), nullable=True)
    employee_name: Mapped[str | None] = mapped_column(sa.String(200), nullable=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime())

    voided_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    voided_reason: Mapped[str | None] = mapped_column(sa.Text, nullable=True)
    voided_by_employee_id: Mapped[int | None] = mapped_column(ForeignKey("employees.id"), nullable=True)
    voided_by_employee_name: Mapped[str | None] = mapped_column(sa.String(200), nullable=True)

    __table_args__ = (Index("ix_bank_balance_anchors_account_date", "account_id", "balance_date"),)


class BankMovement(Base):
    """Un movimiento del banco que el sistema no conoce por otro lado y el
    dueño teclea: la nómina pagada por transferencia, la cuota de manejo,
    un aporte o un retiro del dueño, un traslado entre cuentas propias.

    `amount` siempre positivo; el signo lo pone `direction`. Un traslado
    (`cause = account_transfer`) sale de `account_id` y entra a
    `counter_account_id`: un solo registro, dos renglones en el libro.
    Nunca se borra: se anula con motivo."""

    __tablename__ = "bank_movements"

    id: Mapped[int] = mapped_column(primary_key=True)
    organization_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), index=True)
    store_id: Mapped[int] = mapped_column(ForeignKey("stores.id"), index=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("bank_accounts.id"), index=True)
    counter_account_id: Mapped[int | None] = mapped_column(ForeignKey("bank_accounts.id"), nullable=True)

    direction: Mapped[BankMovementDirection] = mapped_column(_enum(BankMovementDirection, length=8))
    cause: Mapped[BankMovementCause] = mapped_column(_enum(BankMovementCause, length=24))
    business_date: Mapped[date] = mapped_column(sa.Date)
    amount: Mapped[int] = mapped_column(sa.Integer)
    description: Mapped[str] = mapped_column(sa.String(200))

    employee_id: Mapped[int | None] = mapped_column(ForeignKey("employees.id"), nullable=True)
    employee_name: Mapped[str | None] = mapped_column(sa.String(200), nullable=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime())

    voided_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    voided_reason: Mapped[str | None] = mapped_column(sa.Text, nullable=True)
    voided_by_employee_id: Mapped[int | None] = mapped_column(ForeignKey("employees.id"), nullable=True)
    voided_by_employee_name: Mapped[str | None] = mapped_column(sa.String(200), nullable=True)

    __table_args__ = (
        CheckConstraint("amount > 0", name="ck_bank_movements_amount_positive"),
        Index("ix_bank_movements_store_date", "store_id", "business_date"),
    )


class BankEntryAssignment(Base):
    """A qué cuenta va un renglón que el sistema deriva de otro dominio
    (una consignación, una liquidación, un gasto pagado del banco…). Sin
    fila acá, el renglón va a la cuenta principal. Una fila por renglón de
    origen; cambiarlo de cuenta actualiza la fila con auditoría (es un dato
    de clasificación, no un monto: el renglón de origen no se toca)."""

    __tablename__ = "bank_entry_assignments"

    id: Mapped[int] = mapped_column(primary_key=True)
    organization_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), index=True)
    store_id: Mapped[int] = mapped_column(ForeignKey("stores.id"), index=True)
    source_kind: Mapped[str] = mapped_column(sa.String(32))
    source_id: Mapped[int] = mapped_column(sa.Integer)
    account_id: Mapped[int] = mapped_column(ForeignKey("bank_accounts.id"), index=True)

    employee_id: Mapped[int | None] = mapped_column(ForeignKey("employees.id"), nullable=True)
    employee_name: Mapped[str | None] = mapped_column(sa.String(200), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime())

    __table_args__ = (
        UniqueConstraint("store_id", "source_kind", "source_id", name="uq_bank_entry_assignments_source"),
    )
