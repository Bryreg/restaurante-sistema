"""Modelos de `expenses`: lo que cuesta tener el restaurante abierto
(SPEC-NEGOCIO §6.4; `features/fase-3-dinero-control/spec.md § 2`, T2).

Convenciones heredadas (`docs/CONTEXTO-AGENTES.md §3/§4/§9`):
- Dinero en `Integer`, pesos enteros. Nunca `float`.
- Enums `native_enum=False` (`_enum`), comparados por valor: la columna es un
  `VARCHAR` plano en los dos motores, sin `CHECK` que recrear.
- Todo modelo lleva `organization_id` y `store_id`.
- Todo lo que registra una persona guarda `employee_id` (FK real) +
  `employee_name` (copia congelada).
- **Nada financiero se borra**: `voided_*`/`cancelled_*` son baja lógica —
  nunca `DELETE`.

**La llave anti doble conteo de este territorio** (diseñada acá, antes de
cualquier ruta — ver el docstring de `service.py` para la explicación
completa): `Expense`/`Obligation` **nunca** crean un `CashMovement`. Un gasto
que sale físicamente del cajón se registra PRIMERO por la puerta que ya
existe (`POST /shifts/{id}/cash-movements`, causa tipada
`PETTY_EXPENSE`/`EMERGENCY_PURCHASE`/`OTHER_EXPENSE`); acá sólo se puede
REFERENCIAR ese movimiento ya creado (`cash_movement_id`, FK real pero de
sólo lectura desde este dominio) para trazabilidad del período. Este dominio
jamás sale por `shifts.hooks` a escribir un movimiento nuevo, así que
`compute_breakdown` es estructuralmente imposible de tocar desde acá.
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
# Enums.
# ---------------------------------------------------------------------------


class ExpenseCategory(str, enum.Enum):
    SUPPLIES = "supplies"
    MAINTENANCE = "maintenance"
    UTILITIES = "utilities"
    MARKETING = "marketing"
    TRANSPORT = "transport"
    OTHER = "other"


class ExpenseSource(str, enum.Enum):
    """De dónde salió la plata, no una causa de movimiento de caja (esa ya
    existe en `app.shifts.models.CashMovementCause`). `CASH_DRAWER` exige
    `cash_movement_id` (ver docstring del módulo): la plata que sale del
    cajón entra PRIMERO por la puerta que shifts ya publica."""

    CASH_DRAWER = "cash_drawer"
    BANK = "bank"
    # c9: plata que el dueño pagó de su bolsillo, de lo que retiró del cajón
    # y todavía no consignó. Reduce la «mano del dueño»
    # (`app.expenses.hooks.owner_hand_spent`). Sin migración: la columna es
    # un `VARCHAR(16)` sin `CHECK` y guarda el NOMBRE del miembro
    # (`OWNER_HAND`, 10 caracteres).
    OWNER_HAND = "owner_hand"
    OTHER = "other"


class ObligationCategory(str, enum.Enum):
    RENT = "rent"
    UTILITIES = "utilities"
    TAXES = "taxes"
    OTHER = "other"
    # c5 · Sólo nacen por sus puertas propias (`POST /admin/obligations/
    # payroll/schedule` y `.../consumption-tax/schedule`), nunca a mano.
    # **No son costo fijo** (`NON_COST_OBLIGATION_CATEGORIES`): la nómina ya
    # entra a la utilidad por `app.payroll.hooks.period_payroll_cost`, y el
    # INC no es gasto — la venta neta ya se mide sin él. Contarlas otra vez
    # sería la misma plata dos veces.
    PAYROLL = "payroll"
    CONSUMPTION_TAX = "consumption_tax"


#: Categorías que se agendan y se pagan, pero que NO suman a los costos fijos
#: del período (`service.compute_fixed_costs`). Ver `ObligationCategory`.
NON_COST_OBLIGATION_CATEGORIES = frozenset({ObligationCategory.PAYROLL, ObligationCategory.CONSUMPTION_TAX})


class ObligationStatus(str, enum.Enum):
    """Persistido, pero siempre derivado de los pagos vivos
    (`service._refresh_status`): nadie lo escribe a mano. `partial` = hay
    abonos y todavía falta plata (c5)."""

    PENDING = "pending"
    PARTIAL = "partial"
    PAID = "paid"


# ---------------------------------------------------------------------------
# Gastos del período (ad hoc, sin vencimiento).
# ---------------------------------------------------------------------------


class Expense(Base):
    """Un gasto del período, para la utilidad (`GET /admin/profit`) — no una
    obligación agendada (`Obligation`, más abajo) ni una cuenta por pagar de
    compras (`app.purchases.models.Payable`, territorio ajeno salvo D-2).

    **Nunca crea un `CashMovement`** (ver docstring del módulo): `source` es
    informativo, y `cash_movement_id` sólo referencia uno que shifts ya
    escribió por su propia puerta."""

    __tablename__ = "expenses"

    id: Mapped[int] = mapped_column(primary_key=True)
    organization_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), index=True)
    store_id: Mapped[int] = mapped_column(ForeignKey("stores.id"), index=True)

    category: Mapped[ExpenseCategory] = mapped_column(_enum(ExpenseCategory))
    description: Mapped[str] = mapped_column(sa.String(300))
    amount: Mapped[int] = mapped_column(sa.Integer)
    business_date: Mapped[date] = mapped_column(sa.Date)

    source: Mapped[ExpenseSource] = mapped_column(_enum(ExpenseSource, length=16))
    # Sólo tiene sentido cuando `source == CASH_DRAWER`; el `CashMovement`
    # referenciado ya existe (creado por `POST /shifts/{id}/cash-movements`,
    # causa tipada) — este dominio nunca lo crea. FK real porque `shifts` es
    # un dominio anterior y siempre presente.
    cash_movement_id: Mapped[int | None] = mapped_column(ForeignKey("cash_movements.id"), nullable=True)

    created_by_employee_id: Mapped[int] = mapped_column(ForeignKey("employees.id"))
    created_by_employee_name: Mapped[str] = mapped_column(sa.String(200))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime())

    voided_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    voided_reason: Mapped[str | None] = mapped_column(sa.Text(), nullable=True)
    voided_by_employee_id: Mapped[int | None] = mapped_column(ForeignKey("employees.id"), nullable=True)
    voided_by_employee_name: Mapped[str | None] = mapped_column(sa.String(200), nullable=True)

    __table_args__ = (
        CheckConstraint("amount > 0", name="ck_expenses_amount_positive"),
        Index("ix_expenses_store_date", "store_id", "business_date"),
        Index("ix_expenses_store_category", "store_id", "category"),
    )


# ---------------------------------------------------------------------------
# Obligaciones agendadas (arriendo, servicios, impuestos): vencimiento +
# estado, saldadas explícitamente — nunca una transferencia automática.
# ---------------------------------------------------------------------------


class Obligation(Base):
    """Arriendo, servicios, impuestos: con `due_date` y `status`. `settle`
    la marca pagada; nunca mueve plata por sí sola — mismo criterio que
    `Expense.cash_movement_id` (referencia, no crea)."""

    __tablename__ = "obligations"

    id: Mapped[int] = mapped_column(primary_key=True)
    organization_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), index=True)
    store_id: Mapped[int] = mapped_column(ForeignKey("stores.id"), index=True)

    category: Mapped[ObligationCategory] = mapped_column(_enum(ObligationCategory))
    description: Mapped[str] = mapped_column(sa.String(300))
    amount: Mapped[int] = mapped_column(sa.Integer)
    due_date: Mapped[date] = mapped_column(sa.Date)
    status: Mapped[ObligationStatus] = mapped_column(
        _enum(ObligationStatus, length=16), default=ObligationStatus.PENDING
    )

    settled_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    settled_by_employee_id: Mapped[int | None] = mapped_column(ForeignKey("employees.id"), nullable=True)
    settled_by_employee_name: Mapped[str | None] = mapped_column(sa.String(200), nullable=True)
    settled_source: Mapped[ExpenseSource | None] = mapped_column(_enum(ExpenseSource, length=16), nullable=True)
    cash_movement_id: Mapped[int | None] = mapped_column(ForeignKey("cash_movements.id"), nullable=True)

    created_by_employee_id: Mapped[int] = mapped_column(ForeignKey("employees.id"))
    created_by_employee_name: Mapped[str] = mapped_column(sa.String(200))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime())

    # Baja lógica (nada financiero se borra): una obligación cargada por
    # error se cancela, nunca se hace DELETE.
    cancelled_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    cancelled_reason: Mapped[str | None] = mapped_column(sa.Text(), nullable=True)
    cancelled_by_employee_id: Mapped[int | None] = mapped_column(ForeignKey("employees.id"), nullable=True)
    cancelled_by_employee_name: Mapped[str | None] = mapped_column(sa.String(200), nullable=True)

    # c5 · De dónde nació (todas `NULL` en una obligación cargada a mano).
    # `template_id` + `period_month` (día 1 del mes al que pertenece) son la
    # llave de idempotencia de «armar el mes»: único sin filtro, así que una
    # copia cancelada también cuenta como «ya generada» — cancelar el
    # arriendo de un mes no lo hace renacer al volver a armarlo.
    template_id: Mapped[int | None] = mapped_column(ForeignKey("obligation_templates.id"), nullable=True)
    period_month: Mapped[date | None] = mapped_column(sa.Date, nullable=True)
    # La liquidación de nómina que la originó (única entre las vivas).
    payroll_run_id: Mapped[int | None] = mapped_column(ForeignKey("payroll_runs.id"), nullable=True)
    # El bimestre del INC que declara (único por sede entre las vivas).
    tax_year: Mapped[int | None] = mapped_column(sa.Integer, nullable=True)
    tax_bimester: Mapped[int | None] = mapped_column(sa.Integer, nullable=True)

    __table_args__ = (
        CheckConstraint("amount > 0", name="ck_obligations_amount_positive"),
        CheckConstraint(
            "tax_bimester IS NULL OR (tax_bimester >= 1 AND tax_bimester <= 6)", name="ck_obligations_tax_bimester"
        ),
        Index("ix_obligations_store_due", "store_id", "due_date"),
        Index("ix_obligations_store_status", "store_id", "status"),
        Index("uq_obligations_template_period", "template_id", "period_month", unique=True),
        Index(
            "uq_obligations_live_tax_bimester",
            "store_id",
            "tax_year",
            "tax_bimester",
            unique=True,
            postgresql_where=sa.text("cancelled_at IS NULL AND tax_year IS NOT NULL"),
            sqlite_where=sa.text("cancelled_at IS NULL AND tax_year IS NOT NULL"),
        ),
        Index(
            "uq_obligations_live_payroll_run",
            "payroll_run_id",
            unique=True,
            postgresql_where=sa.text("cancelled_at IS NULL AND payroll_run_id IS NOT NULL"),
            sqlite_where=sa.text("cancelled_at IS NULL AND payroll_run_id IS NOT NULL"),
        ),
    )


# ---------------------------------------------------------------------------
# c5 · Obligaciones recurrentes, abonos y configuración del INC.
# ---------------------------------------------------------------------------


class ObligationTemplate(Base):
    """Una obligación que se repite (arriendo mensual, un servicio
    bimestral, un seguro cada N meses). **No es un scheduler**: nada se crea
    solo. «Armar el mes» (`POST /admin/obligations/generate-month`) genera,
    a pedido, la copia del mes de cada plantilla que vence ese mes, y es
    idempotente por `(template_id, period_month)`.

    Vence en los meses `start_month + k · interval_months` (k ≥ 0), el día
    `due_day` (recortado al último día real del mes). Editar la plantilla
    sólo cambia lo que se genere después; lo ya generado no se toca. Nunca
    se borra: se desactiva con motivo."""

    __tablename__ = "obligation_templates"

    id: Mapped[int] = mapped_column(primary_key=True)
    organization_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), index=True)
    store_id: Mapped[int] = mapped_column(ForeignKey("stores.id"), index=True)

    category: Mapped[ObligationCategory] = mapped_column(_enum(ObligationCategory))
    description: Mapped[str] = mapped_column(sa.String(300))
    amount: Mapped[int] = mapped_column(sa.Integer)
    interval_months: Mapped[int] = mapped_column(sa.Integer, default=1)
    due_day: Mapped[int] = mapped_column(sa.Integer)
    # Día 1 del primer mes en que vence.
    start_month: Mapped[date] = mapped_column(sa.Date)

    created_by_employee_id: Mapped[int] = mapped_column(ForeignKey("employees.id"))
    created_by_employee_name: Mapped[str] = mapped_column(sa.String(200))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime())
    updated_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)

    deactivated_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    deactivated_reason: Mapped[str | None] = mapped_column(sa.Text(), nullable=True)
    deactivated_by_employee_id: Mapped[int | None] = mapped_column(ForeignKey("employees.id"), nullable=True)
    deactivated_by_employee_name: Mapped[str | None] = mapped_column(sa.String(200), nullable=True)

    __table_args__ = (
        CheckConstraint("amount > 0", name="ck_obligation_templates_amount_positive"),
        CheckConstraint("interval_months >= 1 AND interval_months <= 12", name="ck_obligation_templates_interval"),
        CheckConstraint("due_day >= 1 AND due_day <= 31", name="ck_obligation_templates_due_day"),
    )


class ObligationPayment(Base):
    """Un abono (o el pago entero) de una obligación, con de dónde salió la
    plata. Varios por obligación; el estado de la obligación se deriva de la
    suma de los vivos. **Nunca crea un `CashMovement`** (llave anti doble
    conteo del módulo): con `source == cash_drawer` sólo referencia el
    egreso que el turno ya registró. Nunca se borra: se anula con motivo."""

    __tablename__ = "obligation_payments"

    id: Mapped[int] = mapped_column(primary_key=True)
    organization_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), index=True)
    store_id: Mapped[int] = mapped_column(ForeignKey("stores.id"), index=True)
    obligation_id: Mapped[int] = mapped_column(ForeignKey("obligations.id"), index=True)

    amount: Mapped[int] = mapped_column(sa.Integer)
    paid_on: Mapped[date] = mapped_column(sa.Date)
    source: Mapped[ExpenseSource] = mapped_column(_enum(ExpenseSource, length=16))
    cash_movement_id: Mapped[int | None] = mapped_column(ForeignKey("cash_movements.id"), nullable=True)
    note: Mapped[str | None] = mapped_column(sa.String(300), nullable=True)

    created_by_employee_id: Mapped[int] = mapped_column(ForeignKey("employees.id"))
    created_by_employee_name: Mapped[str] = mapped_column(sa.String(200))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime())

    voided_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    voided_reason: Mapped[str | None] = mapped_column(sa.Text(), nullable=True)
    voided_by_employee_id: Mapped[int | None] = mapped_column(ForeignKey("employees.id"), nullable=True)
    voided_by_employee_name: Mapped[str | None] = mapped_column(sa.String(200), nullable=True)

    __table_args__ = (
        CheckConstraint("amount > 0", name="ck_obligation_payments_amount_positive"),
        Index(
            "uq_obligation_payments_live_cash_movement",
            "cash_movement_id",
            unique=True,
            postgresql_where=sa.text("voided_at IS NULL AND cash_movement_id IS NOT NULL"),
            sqlite_where=sa.text("voided_at IS NULL AND cash_movement_id IS NOT NULL"),
        ),
    )


class StoreObligationSettings(Base):
    """Configuración por sede de las obligaciones (c5). Hoy, el día del mes
    siguiente al bimestre en que se agenda el INC: la DIAN lo fija por el
    último dígito del NIT y el sistema no lo sabe, así que es decisión de la
    sede. `NULL` = `service.DEFAULT_CONSUMPTION_TAX_DUE_DAY`."""

    __tablename__ = "store_obligation_settings"

    store_id: Mapped[int] = mapped_column(ForeignKey("stores.id"), primary_key=True)
    consumption_tax_due_day: Mapped[int | None] = mapped_column(sa.Integer, nullable=True)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime())
    updated_by_employee_id: Mapped[int | None] = mapped_column(ForeignKey("employees.id"), nullable=True)
    updated_by_employee_name: Mapped[str | None] = mapped_column(sa.String(200), nullable=True)

    __table_args__ = (
        CheckConstraint(
            "consumption_tax_due_day IS NULL OR (consumption_tax_due_day >= 1 AND consumption_tax_due_day <= 28)",
            name="ck_store_obligation_settings_due_day",
        ),
    )


# ---------------------------------------------------------------------------
# Configuración por sede de este dominio (costos fijos para el punto de
# equilibrio). Vive ACÁ, no en `app.stores.models` — precedente de 2a/2b
# (`StoreInventorySettings` en `app.inventory`), y evita que cuatro agentes
# en paralelo se peleen `app/stores/`.
# ---------------------------------------------------------------------------


class StoreExpensesSettings(Base):
    """**LEGADO, sin uso.** Los costos fijos mensuales que la sede escribía
    a mano. El punto de equilibrio y la utilidad usan los costos fijos
    registrados (obligaciones + nómina + gastos del período,
    `service.compute_fixed_costs`), y `GET`/`PATCH /admin/expenses/settings`
    se quitaron. Nada lee ni escribe esta tabla; queda porque no se migra."""

    __tablename__ = "store_expenses_settings"

    store_id: Mapped[int] = mapped_column(ForeignKey("stores.id"), primary_key=True)
    fixed_costs: Mapped[int | None] = mapped_column(sa.Integer, nullable=True)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime())
    updated_by_employee_id: Mapped[int | None] = mapped_column(ForeignKey("employees.id"), nullable=True)

    __table_args__ = (
        CheckConstraint(
            "fixed_costs IS NULL OR fixed_costs >= 0", name="ck_store_expenses_settings_fixed_nonneg"
        ),
    )
