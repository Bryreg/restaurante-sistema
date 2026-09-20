"""Esquemas Pydantic de `expenses`.

Dinero en `int` (pesos enteros), igual que el resto del proyecto — este
dominio no maneja cantidades de insumo ni costos por unidad base, así que no
hace falta el contrato decimal de `app.core.quantity`. Porcentajes en puntos
básicos (`_bp`). Todo indicador sin datos suficientes es `None` **con**
`reason` — nunca `0`, nunca una lista vacía muda sin explicación."""

from __future__ import annotations

from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

ExpenseCategoryLiteral = Literal["supplies", "maintenance", "utilities", "marketing", "transport", "other"]
ExpenseSourceLiteral = Literal["cash_drawer", "bank", "other"]
ObligationCategoryLiteral = Literal["rent", "utilities", "taxes", "other"]
ObligationStatusLiteral = Literal["pending", "paid"]


class OutModel(BaseModel):
    model_config = ConfigDict(from_attributes=True)


# ---------------------------------------------------------------------------
# Gastos.
# ---------------------------------------------------------------------------


class ExpenseIn(BaseModel):
    category: ExpenseCategoryLiteral
    description: str = Field(min_length=1, max_length=300)
    amount: int = Field(gt=0)
    business_date: date
    source: ExpenseSourceLiteral = "other"
    # Obligatorio cuando `source == "cash_drawer"`: el `CashMovement` YA
    # EXISTENTE (creado por `POST /shifts/{id}/cash-movements`) que sacó
    # esta plata del cajón. Este dominio nunca crea uno — ver `service.py`.
    cash_movement_id: int | None = None


class ExpenseOut(OutModel):
    id: int
    store_id: int
    category: ExpenseCategoryLiteral
    description: str
    amount: int
    business_date: date
    source: ExpenseSourceLiteral
    cash_movement_id: int | None
    created_by_employee_name: str
    created_at: datetime
    voided_at: datetime | None
    voided_reason: str | None
    voided_by_employee_name: str | None


class ExpenseVoidIn(BaseModel):
    reason: str = Field(min_length=1)


# ---------------------------------------------------------------------------
# Obligaciones agendadas.
# ---------------------------------------------------------------------------


class ObligationIn(BaseModel):
    category: ObligationCategoryLiteral
    description: str = Field(min_length=1, max_length=300)
    amount: int = Field(gt=0)
    due_date: date


class ObligationOut(OutModel):
    id: int
    store_id: int
    category: ObligationCategoryLiteral
    description: str
    amount: int
    due_date: date
    status: ObligationStatusLiteral
    # Derivado, nunca almacenado (`AGENTS.md`, "derivar en vez de
    # almacenar"): vencida = sigue `pending` y `due_date` ya pasó.
    overdue: bool
    settled_at: datetime | None
    settled_by_employee_name: str | None
    settled_source: ExpenseSourceLiteral | None
    cash_movement_id: int | None
    created_by_employee_name: str
    created_at: datetime
    cancelled_at: datetime | None
    cancelled_reason: str | None


class ObligationSettleIn(BaseModel):
    source: ExpenseSourceLiteral = "other"
    # Igual que en `ExpenseIn`: obligatorio con `source == "cash_drawer"`,
    # referencia a un movimiento que ya existe.
    cash_movement_id: int | None = None
    note: str | None = Field(default=None, max_length=300)


class ObligationCancelIn(BaseModel):
    reason: str = Field(min_length=1)


# ---------------------------------------------------------------------------
# Configuración (costos fijos) — TU tabla, no `app.stores.models`.
# ---------------------------------------------------------------------------


class ExpensesSettingsOut(OutModel):
    store_id: int
    fixed_costs: int | None
    updated_at: datetime | None


class ExpensesSettingsIn(BaseModel):
    fixed_costs: int | None = Field(default=None, ge=0)


# ---------------------------------------------------------------------------
# Punto de equilibrio y utilidad del período.
# ---------------------------------------------------------------------------


class BreakEvenOut(BaseModel):
    store_id: int
    date_from: date
    date_to: date
    fixed_costs: int | None
    contribution_margin_pct_bp: int | None
    break_even_amount: int | None
    available: bool
    reason: str | None


class ProfitOut(BaseModel):
    store_id: int
    date_from: date
    date_to: date
    net_sales: int
    cost: int | None
    expenses: int
    obligations: int
    payroll: int | None
    payroll_reason: str | None
    profit: int | None
    available: bool
    reason: str | None
