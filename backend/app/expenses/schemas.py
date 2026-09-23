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
#
# **Obsoleta para el cálculo** (decisión del dueño, informe de visualización
# #2): el punto de equilibrio ya no usa este número escrito a mano, sino los
# costos fijos que el sistema registra (obligaciones + nómina + gastos del
# período, ver `service.compute_fixed_costs`). Un costo fijo escrito a mano
# ($14,5 M) contra los registrados ($19,6 M) hacía que «ya pasaste el
# equilibrio» conviviera con una pérdida en Utilidad. La tabla y la ruta
# quedan (sin migración, y la pantalla vieja todavía la lee), pero nada la
# suma: se lee, se guarda y se ignora.
# ---------------------------------------------------------------------------


class ExpensesSettingsOut(OutModel):
    store_id: int
    fixed_costs: int | None = Field(
        description="OBSOLETO: ya no entra al punto de equilibrio; los costos fijos se calculan solos."
    )
    updated_at: datetime | None


class ExpensesSettingsIn(BaseModel):
    fixed_costs: int | None = Field(
        default=None,
        ge=0,
        description="OBSOLETO: se guarda pero no entra a ningún cálculo; el punto de equilibrio usa los costos fijos registrados.",
    )


# ---------------------------------------------------------------------------
# Punto de equilibrio y utilidad del período.
#
# Los dos leen EXACTAMENTE los mismos costos fijos (`fixed_costs` +
# `fixed_costs_breakdown`, de `service.compute_fixed_costs`) y el mismo costo
# de venta (`service._sales_and_cost`), así que no pueden contar dos
# historias: ventas por debajo del equilibrio ⇔ utilidad negativa.
# ---------------------------------------------------------------------------

FixedCostSourceLiteral = Literal["obligations", "payroll", "expenses"]


class FixedCostLineOut(BaseModel):
    """Un renglón de los costos fijos del período, en pesos. `source` dice
    de qué registro sale: `obligations` (por `due_date` en el período),
    `payroll` (el mismo motor de `POST /admin/payroll/runs`) o `expenses`
    (gastos no anulados por `business_date`). Sólo se publican los
    renglones con plata: un renglón en $0 no es un costo."""

    label: str
    amount: int
    source: FixedCostSourceLiteral


class ProfitLineOut(BaseModel):
    """Un renglón del estado de resultados. `pct_of_sales_bp` es `amount /
    net_sales` en puntos básicos (10.000 = 100 %), con signo; `None` sin
    venta neta positiva o sin `amount`."""

    key: Literal["net_sales", "cost", "expenses", "obligations", "payroll", "profit"]
    label: str
    amount: int | None
    pct_of_sales_bp: int | None


class BreakEvenOut(BaseModel):
    store_id: int
    date_from: date
    date_to: date
    # Costos fijos AUTOMÁTICOS del período (obligaciones + nómina + gastos);
    # `None` sólo cuando la nómina no se puede calcular (motivo en `reason`).
    fixed_costs: int | None
    fixed_costs_source: Literal["automatic"] = "automatic"
    fixed_costs_breakdown: list[FixedCostLineOut]
    net_sales: int
    # Por ciento entero (0-100) de la venta neta con costo teórico, tal como
    # lo publica `GET /admin/sales`; `None` sin venta neta.
    costed_pct: int | None
    costed_pct_min: int
    contribution_margin_pct_bp: int | None
    break_even_amount: int | None
    # Ventas netas / equilibrio, en puntos básicos (puede pasar de 10.000).
    progress_bp: int | None
    # Lo que falta vender para el equilibrio; 0 si ya se pasó, nunca negativo.
    gap_amount: int | None
    # Días que faltan al ritmo de venta diario del período transcurrido;
    # 0 si ya se pasó; `None` si no hay equilibrio, no hubo ventas o el
    # período ya terminó (o no empezó).
    days_to_break_even_at_current_pace: int | None
    days_elapsed: int | None
    days_in_period: int
    available: bool
    reason: str | None


class ProfitPeriodOut(BaseModel):
    date_from: date
    date_to: date
    net_sales: int
    cost: int | None
    expenses: int
    obligations: int
    payroll: int | None
    payroll_reason: str | None
    fixed_costs: int | None
    fixed_costs_breakdown: list[FixedCostLineOut]
    costed_pct: int | None
    profit: int | None
    lines: list[ProfitLineOut]
    available: bool
    reason: str | None


class ProfitOut(ProfitPeriodOut):
    store_id: int
    costed_pct_min: int
    # El período inmediatamente anterior, de la misma cantidad de días, con
    # los mismos renglones y la misma matemática.
    previous_period: ProfitPeriodOut | None
