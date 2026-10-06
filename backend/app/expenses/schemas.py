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
ExpenseSourceLiteral = Literal["cash_drawer", "bank", "owner_hand", "other"]
# Las que se cargan a mano (y en plantillas). `payroll` y `consumption_tax`
# sólo nacen por sus puertas propias (c5) y sólo aparecen en la salida.
ObligationCategoryLiteral = Literal["rent", "utilities", "taxes", "other"]
ObligationCategoryOutLiteral = Literal["rent", "utilities", "taxes", "other", "payroll", "consumption_tax"]
ObligationStatusLiteral = Literal["pending", "partial", "paid"]


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
    category: ObligationCategoryOutLiteral
    description: str
    amount: int
    due_date: date
    # `pending` sin abonos, `partial` con abonos y saldo, `paid` sin saldo.
    status: ObligationStatusLiteral
    # c5 · Suma de los abonos vivos y lo que falta (`amount − paid_amount`,
    # nunca negativo). Calculado acá, nunca en la pantalla.
    paid_amount: int
    pending_amount: int
    # Derivado, nunca almacenado (`AGENTS.md`, "derivar en vez de
    # almacenar"): vencida = tiene saldo, no está cancelada y `due_date` ya
    # pasó (fecha operativa de la sede).
    overdue: bool
    settled_at: datetime | None
    settled_by_employee_name: str | None
    settled_source: ExpenseSourceLiteral | None
    cash_movement_id: int | None
    created_by_employee_name: str
    created_at: datetime
    cancelled_at: datetime | None
    cancelled_reason: str | None
    # c5 · De dónde nació; todo `None` en una cargada a mano.
    template_id: int | None = None
    period_month: date | None = None
    payroll_run_id: int | None = None
    tax_year: int | None = None
    tax_bimester: int | None = None


class ObligationSettleIn(BaseModel):
    """Saldar = pagar TODO lo que falta en un solo abono (la puerta de antes
    de los abonos; sigue igual para quien paga de una)."""

    source: ExpenseSourceLiteral = "other"
    # Igual que en `ExpenseIn`: obligatorio con `source == "cash_drawer"`,
    # referencia a un movimiento que ya existe.
    cash_movement_id: int | None = None
    note: str | None = Field(default=None, max_length=300)


# ---------------------------------------------------------------------------
# c5 · Abonos.
# ---------------------------------------------------------------------------


class ObligationPaymentIn(BaseModel):
    amount: int = Field(gt=0)
    # Fecha operativa del pago; sin ella, la de hoy en la sede.
    paid_on: date | None = None
    source: ExpenseSourceLiteral = "bank"
    cash_movement_id: int | None = None
    note: str | None = Field(default=None, max_length=300)


class ObligationPaymentOut(OutModel):
    id: int
    obligation_id: int
    amount: int
    paid_on: date
    source: ExpenseSourceLiteral
    cash_movement_id: int | None
    note: str | None
    created_by_employee_name: str
    created_at: datetime
    voided_at: datetime | None
    voided_reason: str | None
    voided_by_employee_name: str | None


class ObligationPaymentVoidIn(BaseModel):
    reason: str = Field(min_length=1)


# ---------------------------------------------------------------------------
# c5 · Plantillas recurrentes y «armar el mes».
# ---------------------------------------------------------------------------


class ObligationTemplateIn(BaseModel):
    category: ObligationCategoryLiteral
    description: str = Field(min_length=1, max_length=300)
    amount: int = Field(gt=0)
    # 1 = mensual, 2 = bimestral, N = cada N meses.
    interval_months: int = Field(default=1, ge=1, le=12)
    # Día del mes en que vence; en un mes más corto, el último día real.
    due_day: int = Field(ge=1, le=31)
    # Cualquier día del primer mes en que vence (se guarda el día 1).
    start_month: date


class ObligationTemplateUpdateIn(BaseModel):
    """Sólo cambia lo que se genere de acá en adelante."""

    description: str | None = Field(default=None, min_length=1, max_length=300)
    amount: int | None = Field(default=None, gt=0)
    due_day: int | None = Field(default=None, ge=1, le=31)


class ObligationTemplateOut(OutModel):
    id: int
    store_id: int
    category: ObligationCategoryLiteral
    description: str
    amount: int
    interval_months: int
    due_day: int
    start_month: date
    active: bool
    created_by_employee_name: str
    created_at: datetime
    updated_at: datetime | None
    deactivated_at: datetime | None
    deactivated_reason: str | None


class ObligationTemplateDeactivateIn(BaseModel):
    reason: str = Field(min_length=1)


class MonthPlanLineOut(BaseModel):
    """Una copia de una plantilla en un mes: la que se va a crear
    (`obligation_id` nulo) o la que ya existe (cancelada o no)."""

    template_id: int
    description: str
    category: ObligationCategoryLiteral
    amount: int
    due_date: date
    period_month: date
    obligation_id: int | None
    cancelled: bool


class MonthPlanOut(BaseModel):
    """Vista previa de «armar el mes»: no escribe nada. Los dos vacíos se
    distinguen: `active_templates == 0` es «no hay nada recurrente», y
    `to_create == []` con plantillas es «el mes ya está armado»."""

    store_id: int
    year: int
    month: int
    period_month: date
    active_templates: int
    to_create: list[MonthPlanLineOut]
    to_create_total: int
    already_generated: list[MonthPlanLineOut]


class GenerateMonthIn(BaseModel):
    year: int = Field(ge=2000, le=2100)
    month: int = Field(ge=1, le=12)


class GenerateMonthOut(BaseModel):
    year: int
    month: int
    created: list[ObligationOut]
    already_generated: list[MonthPlanLineOut]


# ---------------------------------------------------------------------------
# c5 · Agenda de vencimientos.
# ---------------------------------------------------------------------------


class AgendaItemOut(BaseModel):
    obligation_id: int
    description: str
    category: ObligationCategoryOutLiteral
    due_date: date
    amount: int
    paid_amount: int
    pending_amount: int
    status: ObligationStatusLiteral
    overdue: bool
    # Negativo si ya venció (días de atraso con signo).
    days_until_due: int


class AgendaOut(BaseModel):
    """Lo que hay que pagar de acá a `horizon` (hoy + `days`), más TODO lo
    vencido con saldo, sin importar cuán viejo. Los totales son de saldo
    (`pending_amount`), no del monto original."""

    store_id: int
    today: date
    days: int
    horizon: date
    items: list[AgendaItemOut]
    overdue_count: int
    overdue_total: int
    upcoming_total: int
    total_pending: int
    # Copias de plantillas que vencen en la ventana y todavía no se generaron
    # («armá el mes»): no suman a los totales porque todavía no existen.
    not_generated: list[MonthPlanLineOut]


# ---------------------------------------------------------------------------
# c5 · INC del bimestre y nómina como obligación.
# ---------------------------------------------------------------------------


class ConsumptionTaxRateOut(BaseModel):
    rate: int
    base: int
    tax: int


class ConsumptionTaxOut(BaseModel):
    """El INC de un bimestre, leído del informe del contador (mismas
    `tax_lines` de los documentos de venta). `tax_amount` es lo COBRADO de
    INC (tarifa 8 %), no la declaración: la arma el contador, y se puede
    agendar con otro monto. `None` con `reason` sin ventas en el bimestre."""

    store_id: int
    year: int
    bimester: int
    label: str
    date_from: date
    date_to: date
    closed: bool
    documents: int
    rates: list[ConsumptionTaxRateOut]
    base: int | None
    tax_amount: int | None
    reason: str | None
    due_day: int
    due_day_is_default: bool
    due_date: date
    scheduled: ObligationOut | None


class ConsumptionTaxScheduleIn(BaseModel):
    year: int = Field(ge=2000, le=2100)
    bimester: int = Field(ge=1, le=6)
    # Sin él, lo cobrado; con él, la cifra del contador.
    amount: int | None = Field(default=None, gt=0)
    # Sin ella, la de la sede (`due_day` del mes siguiente al bimestre).
    due_date: date | None = None


class ScheduledObligationOut(BaseModel):
    obligation: ObligationOut
    # `True` si ya había una viva para ese bimestre o esa liquidación: no se
    # creó otra (idempotente por período, además de por `Idempotency-Key`).
    already_existed: bool


class PayrollRunCandidateOut(BaseModel):
    payroll_run_id: int
    date_from: date
    date_to: date
    amount: int | None
    amount_source: Literal["employer_total", "total"] | None
    computed_at: datetime
    scheduled_obligation_id: int | None


class PayrollScheduleIn(BaseModel):
    payroll_run_id: int
    # Sin ella, el último día del período liquidado.
    due_date: date | None = None
    amount: int | None = Field(default=None, gt=0)


class ObligationSettingsOut(BaseModel):
    store_id: int
    # `None` = el de fábrica.
    consumption_tax_due_day: int | None
    default_consumption_tax_due_day: int
    effective_consumption_tax_due_day: int


class ObligationSettingsIn(BaseModel):
    consumption_tax_due_day: int | None = Field(default=None, ge=1, le=28)


class DrawerExpenseMovementOut(OutModel):
    """Un egreso del cajón que todavía no respalda ningún gasto ni
    obligación: lo que se elige al saldar con `source == "cash_drawer"`."""

    id: int
    shift_id: int
    cause: Literal["petty_expense", "emergency_purchase", "other_expense"]
    amount: int
    note: str | None
    employee_name: str
    at: datetime


class ObligationCancelIn(BaseModel):
    reason: str = Field(min_length=1)


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
