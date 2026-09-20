"""Modelos del turno de caja: día operativo, turno, roster, movimientos,
cambios, retiros, relevos y el conteo de cierre a ciegas.

Es la única unidad de responsabilidad sobre el dinero del efectivo: la
matemática vive en `service.compute_breakdown` y en las funciones que la
envuelven, nunca duplicada acá ni en el frontend (`docs/SPEC-NEGOCIO.md §6.1`).

Convenciones (vinculantes, `features/fase-1a-cimientos/CONTRATO-INTERNO.md §2`):
- Dinero en `Integer` (pesos enteros), nunca float.
- Enums no nativos (`sa.Enum(..., native_enum=False)`), comparados por valor
  (por eso subclasean `str` — `Shift.status == ShiftStatus.OPEN` y
  `Shift.status == "open"` son equivalentes).
- Todo modelo lleva `organization_id` y `store_id`; toda escritura de una
  persona guarda `employee_id` (FK real) + `employee_name` (copia congelada).
- Nada se borra físicamente: cancelaciones, reversas y reaperturas son
  columnas de estado, nunca un DELETE.
"""

from __future__ import annotations

import enum
import uuid
from datetime import date, datetime

import sqlalchemy as sa
from sqlalchemy import CheckConstraint, ForeignKey, Index, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base, UTCDateTime


def _uuid() -> str:
    return str(uuid.uuid4())


# ---------------------------------------------------------------------------
# Enums (valores en snake_case; son el texto que viaja en la API y en la DB)
# ---------------------------------------------------------------------------


class BusinessDayStatus(str, enum.Enum):
    OPEN = "open"
    CLOSED = "closed"


class ShiftStatus(str, enum.Enum):
    OPEN = "open"
    CLOSED = "closed"
    CANCELLED = "cancelled"


class RosterAction(str, enum.Enum):
    IN = "in"
    OUT = "out"
    PAUSE_START = "pause_start"
    PAUSE_END = "pause_end"


class CashMovementKind(str, enum.Enum):
    INCOME = "income"
    EXPENSE = "expense"


class CashMovementCause(str, enum.Enum):
    PETTY_EXPENSE = "petty_expense"
    EMERGENCY_PURCHASE = "emergency_purchase"
    REFUND = "refund"
    TIP_PAYOUT = "tip_payout"
    OTHER_INCOME = "other_income"
    OTHER_EXPENSE = "other_expense"
    # Pedido 2b (`features/fase-2-costo-inventario/spec.md § Alcance de 2b`):
    # el egreso que deja un pago en efectivo de una cuenta por pagar desde el
    # cajón (`app.shifts.hooks.register_supplier_payment_expense`, llamado
    # por `app.purchases.service.create_payment`). Causa tipada NUEVA,
    # nunca `OTHER_EXPENSE` reciclada — la migración `0011_purchases.py`
    # recrea el CHECK del enum en `cash_movements.cause` con
    # `batch_alter_table` para que este valor sea válido también en filas ya
    # escritas por 1a/1b.
    SUPPLIER_PAYMENT = "supplier_payment"
    # Pedido 2c (`features/fase-2c-canales-cocina/spec.md`): el efectivo de
    # domicilios se arquea APARTE del cajón (SPEC-NEGOCIO §3.3). Cuando el
    # domiciliario liquida, esa plata entra al turno ABIERTO como un
    # `INCOME` con esta causa tipada —nunca `OTHER_INCOME` reciclada—, y
    # deshacer la liquidación escribe el ESPEJO (`EXPENSE`, misma causa) en
    # el turno abierto al momento de deshacerla. Es el patrón exacto con que
    # 2b cerró H-1 (`SUPPLIER_PAYMENT` en los dos sentidos).
    # No requiere DDL: `_enum` no pide `create_constraint`, así que la
    # columna es un `VARCHAR(32)` pelado en los dos motores (ver la nota en
    # `alembic/versions/0011_purchases.py`, corregida contra Postgres real).
    DELIVERY_SETTLEMENT = "delivery_settlement"


# Causa tipada compartida por la diferencia de apertura y la de cierre
# (`docs/SPEC-NEGOCIO.md §3.2`: "justificación con causa tipada" en la
# apertura, y el mismo vocabulario de causas en el cierre a ciegas).
class CashDifferenceCause(str, enum.Enum):
    CHANGE_ERROR = "change_error"
    EXPENSE_WITHOUT_VOUCHER = "expense_without_voucher"
    TIPS_MIXED = "tips_mixed"
    UNRECORDED_SALE = "unrecorded_sale"
    COUNTING_ERROR = "counting_error"
    UNKNOWN = "unknown"


class HandoverKind(str, enum.Enum):
    HANDOVER = "handover"
    SPOT_CHECK = "spot_check"


ENUM_LENGTH = 32


def _enum(pyenum: type[enum.Enum], *, length: int = ENUM_LENGTH) -> sa.Enum:
    return sa.Enum(pyenum, native_enum=False, length=length, validate_strings=True)


# ---------------------------------------------------------------------------
# Día operativo
# ---------------------------------------------------------------------------


class BusinessDay(Base):
    """Un día operativo por sede y fecha de negocio (`docs/SPEC-NEGOCIO.md §3.1`).

    Se crea con get-or-create bajo savepoint al abrir el primer turno del día
    (`service.get_or_create_business_day`); puede tener varios turnos.
    """

    __tablename__ = "business_days"

    id: Mapped[int] = mapped_column(primary_key=True)
    organization_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), index=True)
    store_id: Mapped[int] = mapped_column(ForeignKey("stores.id"), index=True)

    business_date: Mapped[date] = mapped_column(sa.Date)
    status: Mapped[BusinessDayStatus] = mapped_column(
        _enum(BusinessDayStatus, length=16), default=BusinessDayStatus.OPEN
    )

    opened_at: Mapped[datetime] = mapped_column(UTCDateTime())
    closed_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)

    __table_args__ = (
        UniqueConstraint("store_id", "business_date", name="uq_business_days_store_date"),
        Index("ix_business_days_store_status", "store_id", "status"),
    )


# ---------------------------------------------------------------------------
# Turno de caja
# ---------------------------------------------------------------------------


class Shift(Base):
    """La unidad de responsabilidad sobre el dinero (`docs/SPEC-NEGOCIO.md §3.2`).

    Un solo turno abierto por sede, defendido con el índice único parcial
    `uq_shifts_one_open_per_store` (WHERE status='open'); la carrera entre dos
    aperturas concurrentes responde `409 SHIFT_OPEN_RACE` por `IntegrityError`.
    """

    __tablename__ = "shifts"

    id: Mapped[int] = mapped_column(primary_key=True)
    organization_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), index=True)
    store_id: Mapped[int] = mapped_column(ForeignKey("stores.id"), index=True)
    business_day_id: Mapped[int] = mapped_column(ForeignKey("business_days.id"), index=True)

    status: Mapped[ShiftStatus] = mapped_column(_enum(ShiftStatus, length=16), default=ShiftStatus.OPEN)

    opened_at: Mapped[datetime] = mapped_column(UTCDateTime())
    opened_by_employee_id: Mapped[int] = mapped_column(ForeignKey("employees.id"))
    opened_by_employee_name: Mapped[str] = mapped_column(sa.String(200))

    cash_responsible_id: Mapped[int] = mapped_column(ForeignKey("employees.id"), index=True)
    cash_responsible_name: Mapped[str] = mapped_column(sa.String(200))

    opening_cash_total: Mapped[int] = mapped_column(sa.Integer)
    opening_denominations: Mapped[list] = mapped_column(sa.JSON)
    cash_reserve: Mapped[int] = mapped_column(sa.Integer, default=0)
    opening_cause: Mapped[CashDifferenceCause | None] = mapped_column(_enum(CashDifferenceCause), nullable=True)
    opening_note: Mapped[str | None] = mapped_column(sa.Text, nullable=True)

    # Marca por defecto el turno cuya hora de cierre es la última del horario
    # de la sede; lo decide quien confirma el cierre (`close/confirm`).
    closes_day: Mapped[bool] = mapped_column(sa.Boolean, default=False)

    closed_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    closed_by_employee_id: Mapped[int | None] = mapped_column(ForeignKey("employees.id"), nullable=True)
    closed_by_employee_name: Mapped[str | None] = mapped_column(sa.String(200), nullable=True)
    # True solo en el rescate "cierre administrativo" (turno abandonado, sin conteo).
    closed_without_count: Mapped[bool] = mapped_column(sa.Boolean, default=False)

    # Resultado del cierre (lo escribe `service._finalize_close`, una sola vez).
    expected_cash: Mapped[int | None] = mapped_column(sa.Integer, nullable=True)
    counted_cash: Mapped[int | None] = mapped_column(sa.Integer, nullable=True)
    difference: Mapped[int | None] = mapped_column(sa.Integer, nullable=True)
    close_cause: Mapped[CashDifferenceCause | None] = mapped_column(_enum(CashDifferenceCause), nullable=True)
    close_note: Mapped[str | None] = mapped_column(sa.Text, nullable=True)
    to_deposit: Mapped[int | None] = mapped_column(sa.Integer, nullable=True)
    # No hay FK a `shift_close_counts` acá a propósito: crearía un ciclo entre
    # las dos tablas (`shift_close_counts.shift_id -> shifts.id`) que SQLite
    # no puede resolver con `ALTER TABLE ADD CONSTRAINT`. El conteo "activo"
    # (el más reciente no superado) se busca con
    # `service._get_active_close_count`, no se guarda un puntero.

    reviewed_by_employee_id: Mapped[int | None] = mapped_column(ForeignKey("employees.id"), nullable=True)
    reviewed_by_employee_name: Mapped[str | None] = mapped_column(sa.String(200), nullable=True)
    reviewed_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)

    # Rescate "reabrir": el conteo previo queda histórico en shift_close_counts
    # (no se borra); acá solo queda la traza de la última reapertura.
    reopen_reason: Mapped[str | None] = mapped_column(sa.Text, nullable=True)
    reopened_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    reopened_by_employee_id: Mapped[int | None] = mapped_column(ForeignKey("employees.id"), nullable=True)

    # Rescate "cancelar": baja lógica, solo si nunca tuvo actividad.
    cancelled_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    cancelled_reason: Mapped[str | None] = mapped_column(sa.Text, nullable=True)
    cancelled_by_employee_id: Mapped[int | None] = mapped_column(ForeignKey("employees.id"), nullable=True)

    # Rescate "ajustar apertura": historial de ajustes, nunca se pisa el anterior.
    # Cada entrada: {"at": iso, "by_employee_id": int, "by_employee_name": str,
    #   "reason": str, "before": {...}, "after": {...}}.
    adjustments: Mapped[list] = mapped_column(sa.JSON, default=list)

    __table_args__ = (
        Index("ix_shifts_store_status", "store_id", "status"),
        Index("ix_shifts_business_day", "business_day_id"),
        Index(
            "uq_shifts_one_open_per_store",
            "store_id",
            unique=True,
            postgresql_where=sa.text("status = 'open'"),
            sqlite_where=sa.text("status = 'open'"),
        ),
        CheckConstraint("opening_cash_total >= 0", name="ck_shifts_opening_cash_total_nonneg"),
    )


class ShiftRoster(Base):
    """Entradas, salidas y pausas de cada persona en el turno.

    La entrada se crea automáticamente al identificarse
    (`hooks.on_employee_identified`, llamado por `backend-core`) y también vía
    `POST /shifts/{id}/roster`. El responsable de caja NO sale por acá: usa
    `handovers` (`NOT_CASH_RESPONSIBLE`).
    """

    __tablename__ = "shift_roster"

    id: Mapped[int] = mapped_column(primary_key=True)
    organization_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), index=True)
    store_id: Mapped[int] = mapped_column(ForeignKey("stores.id"), index=True)
    shift_id: Mapped[int] = mapped_column(ForeignKey("shifts.id"), index=True)

    employee_id: Mapped[int] = mapped_column(ForeignKey("employees.id"), index=True)
    employee_name: Mapped[str] = mapped_column(sa.String(200))

    in_at: Mapped[datetime] = mapped_column(UTCDateTime())
    out_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)

    # [{"start": iso, "end": iso|None}, ...]
    pauses: Mapped[list] = mapped_column(sa.JSON, default=list)

    __table_args__ = (Index("ix_shift_roster_shift_employee", "shift_id", "employee_id"),)


# ---------------------------------------------------------------------------
# Movimientos, cambio y retiros
# ---------------------------------------------------------------------------


class CashMovement(Base):
    """Ingreso o egreso de caja con causa tipada (`docs/SPEC-NEGOCIO.md §3.2`).

    `amount` siempre positivo; el signo lo da `kind` al sumar en
    `service.compute_breakdown`.
    """

    __tablename__ = "cash_movements"

    id: Mapped[int] = mapped_column(primary_key=True)
    organization_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), index=True)
    store_id: Mapped[int] = mapped_column(ForeignKey("stores.id"), index=True)
    shift_id: Mapped[int] = mapped_column(ForeignKey("shifts.id"), index=True)

    kind: Mapped[CashMovementKind] = mapped_column(_enum(CashMovementKind, length=16))
    cause: Mapped[CashMovementCause] = mapped_column(_enum(CashMovementCause))
    amount: Mapped[int] = mapped_column(sa.Integer)
    note: Mapped[str | None] = mapped_column(sa.Text, nullable=True)
    receipt_photo: Mapped[str | None] = mapped_column(sa.String(500), nullable=True)

    employee_id: Mapped[int] = mapped_column(ForeignKey("employees.id"))
    employee_name: Mapped[str] = mapped_column(sa.String(200))
    authorized_by_employee_id: Mapped[int | None] = mapped_column(ForeignKey("employees.id"), nullable=True)
    authorized_by_employee_name: Mapped[str | None] = mapped_column(sa.String(200), nullable=True)

    at: Mapped[datetime] = mapped_column(UTCDateTime())

    __table_args__ = (
        Index("ix_cash_movements_shift_at", "shift_id", "at"),
        CheckConstraint("amount > 0", name="ck_cash_movements_amount_positive"),
    )


class CashSwap(Base):
    """Cambio de denominaciones (`cash_swap`): canje neto cero, nunca un egreso.

    No altera el esperado: no participa en `compute_breakdown`.
    """

    __tablename__ = "cash_swaps"

    id: Mapped[int] = mapped_column(primary_key=True)
    organization_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), index=True)
    store_id: Mapped[int] = mapped_column(ForeignKey("stores.id"), index=True)
    shift_id: Mapped[int] = mapped_column(ForeignKey("shifts.id"), index=True)

    out_denominations: Mapped[list] = mapped_column(sa.JSON)
    in_denominations: Mapped[list] = mapped_column(sa.JSON)
    amount: Mapped[int] = mapped_column(sa.Integer)

    employee_id: Mapped[int] = mapped_column(ForeignKey("employees.id"))
    employee_name: Mapped[str] = mapped_column(sa.String(200))

    at: Mapped[datetime] = mapped_column(UTCDateTime())

    __table_args__ = (
        Index("ix_cash_swaps_shift_at", "shift_id", "at"),
        CheckConstraint("amount >= 0", name="ck_cash_swaps_amount_nonneg"),
    )


class CashPickup(Base):
    """Retiro de efectivo con PIN de administrador y snapshot del esperado.

    Nunca se edita ni se borra: se reversa con motivo y ambos quedan
    (`reversed_at`/`reversed_reason`/`reversed_by_employee_id`).
    """

    __tablename__ = "cash_pickups"

    id: Mapped[int] = mapped_column(primary_key=True)
    organization_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), index=True)
    store_id: Mapped[int] = mapped_column(ForeignKey("stores.id"), index=True)
    shift_id: Mapped[int] = mapped_column(ForeignKey("shifts.id"), index=True)

    amount: Mapped[int] = mapped_column(sa.Integer)
    denominations: Mapped[list | None] = mapped_column(sa.JSON, nullable=True)
    envelope_ref: Mapped[str | None] = mapped_column(sa.String(120), nullable=True)
    note: Mapped[str | None] = mapped_column(sa.Text, nullable=True)
    photo: Mapped[str | None] = mapped_column(sa.String(500), nullable=True)

    # Esperado justo antes de restar este retiro: acota una diferencia a
    # "antes o después del retiro" (`docs/SPEC-NEGOCIO.md §3.2`).
    expected_at_pickup: Mapped[int] = mapped_column(sa.Integer)

    employee_id: Mapped[int] = mapped_column(ForeignKey("employees.id"))
    employee_name: Mapped[str] = mapped_column(sa.String(200))
    authorized_by_employee_id: Mapped[int] = mapped_column(ForeignKey("employees.id"))
    authorized_by_employee_name: Mapped[str] = mapped_column(sa.String(200))

    at: Mapped[datetime] = mapped_column(UTCDateTime())

    reversed_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    reversed_reason: Mapped[str | None] = mapped_column(sa.Text, nullable=True)
    reversed_by_employee_id: Mapped[int | None] = mapped_column(ForeignKey("employees.id"), nullable=True)
    reversed_by_employee_name: Mapped[str | None] = mapped_column(sa.String(200), nullable=True)

    __table_args__ = (
        Index("ix_cash_pickups_shift_at", "shift_id", "at"),
        CheckConstraint("amount > 0", name="ck_cash_pickups_amount_positive"),
    )


class ShiftHandover(Base):
    """Relevo del responsable de caja o arqueo sorpresa (`spot_check`).

    Congela el desglose completo en `breakdown`; `spot_check` no cambia de
    responsable, exige PIN de administrador y funciona como un relevo sin
    cambio de persona.
    """

    __tablename__ = "shift_handovers"

    id: Mapped[int] = mapped_column(primary_key=True)
    organization_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), index=True)
    store_id: Mapped[int] = mapped_column(ForeignKey("stores.id"), index=True)
    shift_id: Mapped[int] = mapped_column(ForeignKey("shifts.id"), index=True)

    kind: Mapped[HandoverKind] = mapped_column(_enum(HandoverKind, length=16))

    counted_cash: Mapped[int] = mapped_column(sa.Integer)
    counted_cash_denominations: Mapped[list] = mapped_column(sa.JSON)
    counted_card: Mapped[int | None] = mapped_column(sa.Integer, nullable=True)
    counted_transfer: Mapped[int | None] = mapped_column(sa.Integer, nullable=True)

    # {"base", "cash_sales", "incomes", "expenses", "pickups", "expected",
    #  "counted", "difference"} — congelado en el momento del relevo.
    breakdown: Mapped[dict] = mapped_column(sa.JSON)

    from_responsible_id: Mapped[int] = mapped_column(ForeignKey("employees.id"))
    from_responsible_name: Mapped[str] = mapped_column(sa.String(200))
    new_responsible_id: Mapped[int | None] = mapped_column(ForeignKey("employees.id"), nullable=True)
    new_responsible_name: Mapped[str | None] = mapped_column(sa.String(200), nullable=True)

    authorized_by_employee_id: Mapped[int | None] = mapped_column(ForeignKey("employees.id"), nullable=True)
    authorized_by_employee_name: Mapped[str | None] = mapped_column(sa.String(200), nullable=True)

    photo: Mapped[str | None] = mapped_column(sa.String(500), nullable=True)
    at: Mapped[datetime] = mapped_column(UTCDateTime())

    __table_args__ = (Index("ix_shift_handovers_shift_at", "shift_id", "at"),)


class ShiftCloseCount(Base):
    """Paso 1 del cierre a ciegas: lo contado, sin el esperado.

    Queda aunque el cierre se cancele o el turno se reabra: es el histórico
    congelado que `review` y `confirm` leen, y que el rescate "reabrir"
    conserva sin tocar.
    """

    __tablename__ = "shift_close_counts"

    id: Mapped[int] = mapped_column(primary_key=True)
    organization_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), index=True)
    store_id: Mapped[int] = mapped_column(ForeignKey("stores.id"), index=True)
    shift_id: Mapped[int] = mapped_column(ForeignKey("shifts.id"), index=True)

    counted_cash_total: Mapped[int] = mapped_column(sa.Integer)
    counted_cash_denominations: Mapped[list] = mapped_column(sa.JSON)
    counted_card: Mapped[int | None] = mapped_column(sa.Integer, nullable=True)
    counted_transfer: Mapped[int | None] = mapped_column(sa.Integer, nullable=True)
    tips_cash_out: Mapped[int] = mapped_column(sa.Integer, default=0)
    photo: Mapped[str | None] = mapped_column(sa.String(500), nullable=True)

    created_by_employee_id: Mapped[int] = mapped_column(ForeignKey("employees.id"))
    created_by_employee_name: Mapped[str] = mapped_column(sa.String(200))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime())

    # True cuando este conteo quedó superado por uno posterior (turno
    # reabierto y vuelto a cerrar): se conserva, nunca se borra.
    superseded: Mapped[bool] = mapped_column(sa.Boolean, default=False)

    __table_args__ = (
        Index("ix_shift_close_counts_shift", "shift_id"),
        CheckConstraint("counted_cash_total >= 0", name="ck_close_counts_cash_nonneg"),
        CheckConstraint("tips_cash_out >= 0", name="ck_close_counts_tips_nonneg"),
    )


# ---------------------------------------------------------------------------
# Reparto de propinas (1b-2, `docs/SPEC-NEGOCIO.md §6.2`, Ley 1935 de 2018)
# ---------------------------------------------------------------------------


class TipPayoutSource(str, enum.Enum):
    """De dónde salió la plata de un reparto de propinas pagado en efectivo.

    **A-3 de la fase 3.** Sin este dato, `app.banking` no podía distinguir un
    reparto pagado DEL CAJÓN —que ya redujo el `to_deposit` de ese turno— de
    uno pagado DE LA MANO del dueño, así que restaba los dos de la mano: una
    doble resta sobre la misma plata.

    `UNKNOWN` existe para las filas anteriores a esta columna, y no se elige
    nunca desde la interfaz. **No se inventa una respuesta para el pasado**:
    quien registró esos repartos no declaró de dónde salió la plata, y
    adivinarlo sería peor que decir que no se sabe. Se tratan como
    `OWNER_HAND` —el sesgo que muestra MENOS plata, el único que este
    proyecto tolera— y su cantidad se publica aparte para que la exclusión no
    sea silenciosa.
    """

    DRAWER = "drawer"
    OWNER_HAND = "owner_hand"
    UNKNOWN = "unknown"


class TipPayout(Base):
    """Registro del reparto de propinas a la cadena de servicio. El cálculo
    del reparto es **manual** en esta fase (SPEC-NEGOCIO §6.2): esta tabla
    sólo deja constancia de quién, cuánto y cuándo — nunca lo calcula.

    Puede cubrir varias `shift_ids` (propinas acumuladas de varios turnos que
    se reparten juntas). Si el dueño lo paga del cajón, el egreso de caja
    (`CashMovement` con causa `tip_payout`, que ya existe desde 1b-1) se
    registra aparte por el endpoint genérico de movimientos de caja del
    turno que corresponda — este modelo es sólo el libro de reparto, no
    reemplaza ni crea ese movimiento (ver decisión declarada en el
    entregable de `backend-clientes-dinero`).

    `paid_from` (A-3, fase 3) dice de dónde salió la plata cuando el reparto
    fue en efectivo: es lo que le permite a `app.banking` no restar dos veces
    la misma plata de la mano del dueño."""

    __tablename__ = "tip_payouts"

    id: Mapped[int] = mapped_column(primary_key=True)
    organization_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), index=True)
    store_id: Mapped[int] = mapped_column(ForeignKey("stores.id"), index=True)

    shift_ids: Mapped[list] = mapped_column(sa.JSON)
    paid_at: Mapped[datetime] = mapped_column(UTCDateTime())
    method: Mapped[str] = mapped_column(sa.String(16))
    total_amount: Mapped[int] = mapped_column(sa.Integer)

    # A-3: sólo significa algo con `method == "cash"`. Un reparto por
    # transferencia no sale del cajón ni de la mano, y se guarda `owner_hand`
    # por defecto sin que nadie lo mire.
    paid_from: Mapped[TipPayoutSource] = mapped_column(
        _enum(TipPayoutSource, length=16), default=TipPayoutSource.OWNER_HAND
    )

    created_by_employee_id: Mapped[int] = mapped_column(ForeignKey("employees.id"))
    created_by_employee_name: Mapped[str] = mapped_column(sa.String(200))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime())

    __table_args__ = (CheckConstraint("total_amount >= 0", name="ck_tip_payouts_total_nonneg"),)


class TipPayoutDistribution(Base):
    """Una línea del reparto: cuánto le tocó a cada persona."""

    __tablename__ = "tip_payout_distributions"

    id: Mapped[int] = mapped_column(primary_key=True)
    payout_id: Mapped[int] = mapped_column(ForeignKey("tip_payouts.id"), index=True)
    employee_id: Mapped[int] = mapped_column(ForeignKey("employees.id"))
    employee_name: Mapped[str] = mapped_column(sa.String(200))
    amount: Mapped[int] = mapped_column(sa.Integer)

    __table_args__ = (CheckConstraint("amount >= 0", name="ck_tip_payout_distributions_amount_nonneg"),)
