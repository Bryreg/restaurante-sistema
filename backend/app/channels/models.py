"""Modelos del dominio `channels` (pedido 2c, `backend-dinero-canales`).

Cuatro tablas, y las cuatro existen por una regla de plata, no por prolijidad:

- `delivery_platforms` — la plataforma por sede, con su **porcentaje de
  comisión en PUNTOS BÁSICOS ENTEROS** (`commission_bp`, 100 = 1 %). Nunca
  `float`: es el precedente que 2b ya dejó (`WasteKpiOut.ratio` pasó de
  `float` a `int` en basis points, y el cliente tiene `formatBasisPoints`).
  Baja **lógica**: una plataforma se desactiva, no se borra.

- `platform_receivables` — la CUENTA POR COBRAR contra la plataforma. Una
  venta cobrada con el medio `platform` no es plata en el cajón: la
  plataforma cobró y nos paga después. Su conciliación es fase 3; acá sólo
  se registra. Nunca entra a `compute_breakdown`.

- `platform_commissions` — el COSTO. **La comisión se registra, no se
  resta**: ninguna cifra de venta, impuesto, propina ni documento fiscal
  sale neteada. Por eso la comisión vive en su propia tabla y la venta en
  `payments`/`fiscal_documents` — los «dos lugares distintos» del contrato.

- `delivery_settlements` — la liquidación del domiciliario: el efectivo de
  domicilios se arquea APARTE del cajón (§3.3) y entra al turno abierto
  recién cuando el domiciliario liquida, como un `CashMovement(kind=INCOME,
  cause=DELIVERY_SETTLEMENT)`.

Convenciones heredadas que se cumplen acá:
- `app.core.db.UTCDateTime` en todo `Mapped[datetime]`.
- Dinero y porcentajes en `Integer`; **prohibido `float`** en este dominio.
- Nada financiero se borra: `voided_at` + motivo + quién, nunca `DELETE`.
- `kind` tipado (`charge`/`reversal`) en vez de montos negativos: el monto
  es siempre positivo y el signo lo da la causa, igual que `CashMovement`.
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


class LedgerEntryKind(str, enum.Enum):
    """Signo tipado del asiento. `amount` SIEMPRE positivo (mismo contrato
    que `CashMovement.amount`); el signo lo da esto. Un neto se lee como
    `Σ charge − Σ reversal`, nunca guardando negativos."""

    CHARGE = "charge"
    REVERSAL = "reversal"


class PlatformReceivableStatus(str, enum.Enum):
    """`pending` es el único estado que 2c produce: la conciliación con el
    pago real de la plataforma es fase 3 (`docs/SPEC-NEGOCIO.md §13`) y no
    se construye acá. `reversed` lo deja la venta compensada."""

    PENDING = "pending"
    REVERSED = "reversed"


class DeliverySettlementStatus(str, enum.Enum):
    SETTLED = "settled"
    VOIDED = "voided"


class DeliveryPlatform(Base):
    """Una plataforma (Rappi, Didi, iFood…) habilitada en una sede, con su
    comisión en puntos básicos enteros.

    `commission_bp`: 100 = 1 %, 1800 = 18 %. `Integer`, nunca `float` —
    un 18 % guardado como `0.18` arrastra el error de coma flotante a cada
    comisión calculada, y esto es plata.
    """

    __tablename__ = "delivery_platforms"

    id: Mapped[int] = mapped_column(primary_key=True)
    organization_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), index=True)
    store_id: Mapped[int] = mapped_column(ForeignKey("stores.id"), index=True)

    name: Mapped[str] = mapped_column(sa.String(120))
    code: Mapped[str] = mapped_column(sa.String(40))
    commission_bp: Mapped[int] = mapped_column(sa.Integer, default=0)
    active: Mapped[bool] = mapped_column(sa.Boolean, default=True)

    created_at: Mapped[datetime] = mapped_column(UTCDateTime())
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime())

    __table_args__ = (
        Index("ix_delivery_platforms_store_active", "store_id", "active"),
        # Un código por sede entre las ACTIVAS (índice único parcial): la
        # baja lógica tiene que permitir volver a dar de alta el mismo
        # código después de desactivarlo.
        Index(
            "uq_delivery_platforms_store_code",
            "store_id",
            "code",
            unique=True,
            sqlite_where=sa.text("active = 1"),
            postgresql_where=sa.text("active"),
        ),
        CheckConstraint("commission_bp >= 0", name="ck_delivery_platforms_commission_nonneg"),
        # 10000 bp = 100 %. Una comisión mayor al 100 % es un error de tecleo
        # (18 escrito como 1800 % pasa por acá), no un negocio.
        CheckConstraint("commission_bp <= 10000", name="ck_delivery_platforms_commission_max"),
    )


class PlatformReceivable(Base):
    """La cuenta por cobrar contra la plataforma por una venta cobrada con
    el medio `platform`.

    `amount` es la parte de la VENTA y `tip_amount` la propina que viajó por
    el mismo medio — separados como en `payments`, para que la propina nunca
    se confunda con venta. **Ninguno de los dos sale neteado de comisión**:
    la comisión vive en `platform_commissions`.
    """

    __tablename__ = "platform_receivables"

    id: Mapped[int] = mapped_column(primary_key=True)
    organization_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), index=True)
    store_id: Mapped[int] = mapped_column(ForeignKey("stores.id"), index=True)
    platform_id: Mapped[int] = mapped_column(ForeignKey("delivery_platforms.id"), index=True)

    order_id: Mapped[int] = mapped_column(ForeignKey("orders.id"), index=True)
    document_id: Mapped[int | None] = mapped_column(ForeignKey("fiscal_documents.id"), nullable=True, index=True)
    payment_id: Mapped[int | None] = mapped_column(ForeignKey("payments.id"), nullable=True, index=True)
    shift_id: Mapped[int | None] = mapped_column(ForeignKey("shifts.id"), nullable=True, index=True)

    # `external_id` del pedido en la plataforma. `None` (no un `""` mudo)
    # cuando la comanda no lo trae: `null` ≠ 0 y `null` ≠ "".
    external_id: Mapped[str | None] = mapped_column(sa.String(120), nullable=True)

    amount: Mapped[int] = mapped_column(sa.Integer)
    tip_amount: Mapped[int] = mapped_column(sa.Integer, default=0)
    status: Mapped[PlatformReceivableStatus] = mapped_column(
        _enum(PlatformReceivableStatus), default=PlatformReceivableStatus.PENDING
    )

    business_date: Mapped[date] = mapped_column(sa.Date, index=True)
    at: Mapped[datetime] = mapped_column(UTCDateTime())

    employee_id: Mapped[int | None] = mapped_column(ForeignKey("employees.id"), nullable=True)
    employee_name: Mapped[str | None] = mapped_column(sa.String(200), nullable=True)

    # La venta compensada no borra esta fila: la marca `reversed` y deja
    # quién y por qué. Nada financiero se borra.
    reversed_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    reversed_reason: Mapped[str | None] = mapped_column(sa.String(400), nullable=True)
    reversed_by_employee_id: Mapped[int | None] = mapped_column(ForeignKey("employees.id"), nullable=True)
    reversed_by_employee_name: Mapped[str | None] = mapped_column(sa.String(200), nullable=True)

    __table_args__ = (
        Index("ix_platform_receivables_store_status", "store_id", "status"),
        Index("ix_platform_receivables_platform_date", "platform_id", "business_date"),
        CheckConstraint("amount >= 0", name="ck_platform_receivables_amount_nonneg"),
        CheckConstraint("tip_amount >= 0", name="ck_platform_receivables_tip_nonneg"),
    )


class PlatformCommission(Base):
    """El COSTO de la comisión, por pedido y por plataforma.

    `commission_bp` se **congela** acá (snapshot, regla dura): cambiar el
    porcentaje de la plataforma mañana no puede reescribir la comisión de
    una venta de ayer. `base_amount × commission_bp` con redondeo half-up
    entero (`app.orders.money.round_half_up`) produce `amount`; no hay
    `float` en ningún punto del camino.

    Cancelar una venta de plataforma después de preparar escribe una fila
    `kind=REVERSAL` — nunca edita ni borra la original.
    """

    __tablename__ = "platform_commissions"

    id: Mapped[int] = mapped_column(primary_key=True)
    organization_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), index=True)
    store_id: Mapped[int] = mapped_column(ForeignKey("stores.id"), index=True)
    platform_id: Mapped[int] = mapped_column(ForeignKey("delivery_platforms.id"), index=True)

    order_id: Mapped[int] = mapped_column(ForeignKey("orders.id"), index=True)
    document_id: Mapped[int | None] = mapped_column(ForeignKey("fiscal_documents.id"), nullable=True, index=True)
    receivable_id: Mapped[int | None] = mapped_column(ForeignKey("platform_receivables.id"), nullable=True, index=True)

    kind: Mapped[LedgerEntryKind] = mapped_column(_enum(LedgerEntryKind), default=LedgerEntryKind.CHARGE)
    # La base sobre la que se calculó: la VENTA cobrada por la plataforma,
    # sin propina (la propina no es venta y la plataforma no comisiona sobre
    # plata que no es nuestra).
    base_amount: Mapped[int] = mapped_column(sa.Integer)
    commission_bp: Mapped[int] = mapped_column(sa.Integer)
    amount: Mapped[int] = mapped_column(sa.Integer)

    business_date: Mapped[date] = mapped_column(sa.Date, index=True)
    at: Mapped[datetime] = mapped_column(UTCDateTime())
    reason: Mapped[str | None] = mapped_column(sa.String(400), nullable=True)

    employee_id: Mapped[int | None] = mapped_column(ForeignKey("employees.id"), nullable=True)
    employee_name: Mapped[str | None] = mapped_column(sa.String(200), nullable=True)

    __table_args__ = (
        Index("ix_platform_commissions_platform_date", "platform_id", "business_date"),
        Index("ix_platform_commissions_store_date", "store_id", "business_date"),
        CheckConstraint("base_amount >= 0", name="ck_platform_commissions_base_nonneg"),
        CheckConstraint("commission_bp >= 0", name="ck_platform_commissions_bp_nonneg"),
        CheckConstraint("amount >= 0", name="ck_platform_commissions_amount_nonneg"),
    )


class DeliverySettlement(Base):
    """La liquidación del efectivo que trae el domiciliario.

    Mientras no existe, el efectivo de esos cobros NO está en el cajón y no
    puede entrar al esperado del turno. Al crearse, deja un
    `CashMovement(kind=INCOME, cause=DELIVERY_SETTLEMENT)` en el turno
    ABIERTO al momento de liquidar (`cash_movement_id`), que es lo que pasa
    físicamente: la plata entra al cajón hoy.

    Deshacerla NO borra nada: `status=VOIDED` + motivo + quién, el
    movimiento original queda vivo, y se escribe el movimiento ESPEJO
    (`kind=EXPENSE`, misma causa tipada) en el turno abierto al momento de
    deshacer (`void_cash_movement_id`). Sin turno abierto, la anulación
    entera se rechaza con `409` y no queda nada a medias.
    """

    __tablename__ = "delivery_settlements"

    id: Mapped[int] = mapped_column(primary_key=True)
    organization_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), index=True)
    store_id: Mapped[int] = mapped_column(ForeignKey("stores.id"), index=True)

    courier_employee_id: Mapped[int] = mapped_column(ForeignKey("employees.id"), index=True)
    courier_employee_name: Mapped[str] = mapped_column(sa.String(200))

    # Turno que RECIBE la plata (el abierto al liquidar), que puede no ser
    # el turno en que se vendió.
    shift_id: Mapped[int] = mapped_column(ForeignKey("shifts.id"), index=True)
    cash_movement_id: Mapped[int | None] = mapped_column(ForeignKey("cash_movements.id"), nullable=True, index=True)

    # Venta y propina liquidadas, separadas (la propina nunca se mezcla con
    # la venta). El efectivo entregado es la suma de las dos.
    amount: Mapped[int] = mapped_column(sa.Integer)
    tip_amount: Mapped[int] = mapped_column(sa.Integer, default=0)
    payments_count: Mapped[int] = mapped_column(sa.Integer, default=0)

    status: Mapped[DeliverySettlementStatus] = mapped_column(
        _enum(DeliverySettlementStatus), default=DeliverySettlementStatus.SETTLED
    )
    note: Mapped[str | None] = mapped_column(sa.String(400), nullable=True)

    business_date: Mapped[date] = mapped_column(sa.Date, index=True)
    at: Mapped[datetime] = mapped_column(UTCDateTime())

    employee_id: Mapped[int] = mapped_column(ForeignKey("employees.id"))
    employee_name: Mapped[str] = mapped_column(sa.String(200))

    voided_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    voided_reason: Mapped[str | None] = mapped_column(sa.String(400), nullable=True)
    voided_by_employee_id: Mapped[int | None] = mapped_column(ForeignKey("employees.id"), nullable=True)
    voided_by_employee_name: Mapped[str | None] = mapped_column(sa.String(200), nullable=True)
    void_shift_id: Mapped[int | None] = mapped_column(ForeignKey("shifts.id"), nullable=True)
    void_cash_movement_id: Mapped[int | None] = mapped_column(
        ForeignKey("cash_movements.id"), nullable=True, index=True
    )

    __table_args__ = (
        Index("ix_delivery_settlements_store_status", "store_id", "status"),
        Index("ix_delivery_settlements_courier", "courier_employee_id", "business_date"),
        CheckConstraint("amount >= 0", name="ck_delivery_settlements_amount_nonneg"),
        CheckConstraint("tip_amount >= 0", name="ck_delivery_settlements_tip_nonneg"),
        CheckConstraint("payments_count >= 0", name="ck_delivery_settlements_count_nonneg"),
    )
