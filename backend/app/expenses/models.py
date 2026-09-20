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
    OTHER = "other"


class ObligationCategory(str, enum.Enum):
    RENT = "rent"
    UTILITIES = "utilities"
    TAXES = "taxes"
    OTHER = "other"


class ObligationStatus(str, enum.Enum):
    PENDING = "pending"
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

    __table_args__ = (
        CheckConstraint("amount > 0", name="ck_obligations_amount_positive"),
        Index("ix_obligations_store_due", "store_id", "due_date"),
        Index("ix_obligations_store_status", "store_id", "status"),
    )


# ---------------------------------------------------------------------------
# Configuración por sede de este dominio (costos fijos para el punto de
# equilibrio). Vive ACÁ, no en `app.stores.models` — precedente de 2a/2b
# (`StoreInventorySettings` en `app.inventory`), y evita que cuatro agentes
# en paralelo se peleen `app/stores/`.
# ---------------------------------------------------------------------------


class StoreExpensesSettings(Base):
    """Costos fijos mensuales declarados por la sede, para `GET
    /admin/break-even`. `fixed_costs is None` (nunca cargados) es el caso
    explícito de "sin datos" — el endpoint responde `null` con motivo, jamás
    `0` (`AGENTS.md`, "null no es 0")."""

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
