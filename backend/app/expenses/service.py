"""Reglas de negocio de `expenses` — lo que cuesta tener el restaurante
abierto y el resultado del período (SPEC-NEGOCIO §6.4;
`features/fase-3-dinero-control/spec.md § 2`, T2).

**LA LLAVE ANTI DOBLE CONTEO DE ESTE TERRITORIO** (diseñada acá, antes de la
primera ruta de consulta, como pide §6.1/§3 de la spec del pedido):

    PAGO (proveedor, vía `app.purchases`) vs MOVIMIENTO DE BANCO (vía
    `app.banking`, territorio de T1) vs EGRESO DE CAJA (vía
    `app.shifts.hooks`) vs GASTO/OBLIGACIÓN DE ESTE DOMINIO.

Un mismo peso NUNCA puede contarse dos veces entre esas cuatro bolsas:

1. **La plata de una compra a proveedor** (recepción → cuenta por pagar →
   pago) ya entra al costo del inventario (`app.purchases`, y de ahí a
   `OrderItem.unit_cost_micros` cuando el insumo se vende). Este dominio
   **nunca** suma un `Payable`/`Payment` como gasto u obligación propia: si
   lo hiciera, la misma compra pagaría el food cost Y la utilidad del
   período. `Expense`/`Obligation` son estrictamente gastos que NO son
   compra de inventario (arriendo, servicios, impuestos, mantenimiento,
   mercadeo…).
2. **La mayor parte de la plata de este territorio nunca pasó por el
   cajón** (una transferencia de arriendo). Por eso `Expense`/`Obligation`
   **nunca crean un `CashMovement`** — no hay ninguna llamada a
   `app.shifts.hooks` en este módulo que escriba un movimiento nuevo. El
   esperado del turno (`app.shifts.service.compute_breakdown`) es
   estructuralmente imposible de tocar desde acá.
3. **Cuando un gasto SÍ sale del cajón** (`source == "cash_drawer"`), la
   plata entra primero por la puerta que `app.shifts` YA publica (`POST
   /shifts/{id}/cash-movements`, con causa tipada `petty_expense` /
   `emergency_purchase` / `other_expense`, ya existentes en
   `CashMovementCause` — no se inventa una causa nueva). Este dominio sólo
   puede REFERENCIAR ese movimiento ya creado (`cash_movement_id`), nunca
   crear uno: así el mismo peso no puede aparecer una vez en el esperado del
   turno (por el `CashMovement` real) y otra vez como si este dominio lo
   hubiera generado.
4. **El banco** (consignaciones, mano del dueño) es de T1
   (`app.banking`) — este dominio no lo lee ni lo escribe.

**Ventas netas y costo teórico NO se vuelven a sumar acá**: `compute_profit`
y `compute_break_even` pasan por `_sales_and_cost`, que lee
`app.reports.hooks.period_sales` (el total de `aggregate_sales`, la única
agregación de documentos de venta: `net`, `theoretical_cost`, `costed_pct`)
tal cual — nunca vuelven a iterar `FiscalDocument`/`OrderItem`.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.audit.service import record_audit
from app.auth.deps import Actor
from app.core import clock, features, tz
from app.core.errors import AppError, NotFoundError
from app.core.modules import find_spec_safe
from app.core.percent import format_pct_bp
from app.expenses.models import (
    Expense,
    ExpenseCategory,
    ExpenseSource,
    Obligation,
    ObligationCategory,
    ObligationStatus,
    StoreExpensesSettings,
)
from app.expenses.schemas import (
    BreakEvenOut,
    ExpenseIn,
    FixedCostLineOut,
    ObligationIn,
    ObligationSettleIn,
    ProfitLineOut,
    ProfitOut,
    ProfitPeriodOut,
)
from app.orders import money
from app.stores.models import Store

_EXPENSE_CASH_MOVEMENT_CAUSES = {"petty_expense", "emergency_purchase", "other_expense"}


def _validate_range(date_from: date, date_to: date) -> None:
    if date_from > date_to:
        raise AppError("VALIDATION_ERROR", "from: tiene que ser anterior o igual a to", status=400)


def _actor_identity(actor: Actor) -> tuple[int, str]:
    if actor.employee_id is None:
        raise AppError(code="NOT_AUTHENTICATED", message="La sesión no tiene una persona asociada", status=401)
    return actor.employee_id, actor.employee_name or ""


def _validate_cash_movement_reference(db: Session, *, store_id: int, cash_movement_id: int) -> None:
    """El `CashMovement` referenciado tiene que existir YA, en esta sede, y
    ser un egreso con una de las tres causas de gasto (ver docstring del
    módulo — punto 3 de la llave anti doble conteo). Import perezoso de
    `app.shifts.models`: lectura directa de otro dominio (mismo patrón que
    `app.reports.service` lee `Shift`/`FiscalDocument`), nunca una escritura."""
    from app.shifts.models import CashMovement, CashMovementKind

    movement = db.get(CashMovement, cash_movement_id)
    if movement is None or movement.store_id != store_id:
        raise NotFoundError(
            "El movimiento de caja no existe en esta sede; registrá primero el egreso en el turno, "
            "desde el POS, y volvé con ese movimiento"
        )
    cause_value = movement.cause.value if hasattr(movement.cause, "value") else str(movement.cause)
    if movement.kind != CashMovementKind.EXPENSE or cause_value not in _EXPENSE_CASH_MOVEMENT_CAUSES:
        raise AppError(
            code="VALIDATION_ERROR",
            message=(
                "cash_movement_id: tiene que ser un egreso de caja con causa petty_expense, "
                "emergency_purchase u other_expense"
            ),
            status=400,
        )


def _validate_source(*, source: str, cash_movement_id: int | None, db: Session, store_id: int) -> None:
    if source == ExpenseSource.CASH_DRAWER.value:
        if cash_movement_id is None:
            raise AppError(
                code="VALIDATION_ERROR",
                message=(
                    "Un gasto pagado del cajón tiene que apuntar al egreso de caja que lo respalda: "
                    "registralo primero en el turno, desde el POS"
                ),
                status=400,
            )
        _validate_cash_movement_reference(db, store_id=store_id, cash_movement_id=cash_movement_id)
    elif cash_movement_id is not None:
        raise AppError(
            code="VALIDATION_ERROR",
            message="cash_movement_id: sólo aplica cuando source es cash_drawer",
            status=400,
        )


logger = logging.getLogger("app.expenses")

# ---------------------------------------------------------------------------
# Gastos.
# ---------------------------------------------------------------------------


def get_expense_or_404(db: Session, *, organization_id: int, expense_id: int) -> Expense:
    row = db.get(Expense, expense_id)
    if row is None or row.organization_id != organization_id:
        raise NotFoundError("El gasto no existe en esta organización")
    return row


def list_expenses(
    db: Session,
    *,
    store_id: int,
    date_from: date | None,
    date_to: date | None,
    category: str | None,
    include_voided: bool = False,
) -> list[Expense]:
    if date_from is not None and date_to is not None:
        _validate_range(date_from, date_to)
    stmt = select(Expense).where(Expense.store_id == store_id)
    if not include_voided:
        stmt = stmt.where(Expense.voided_at.is_(None))
    if date_from is not None:
        stmt = stmt.where(Expense.business_date >= date_from)
    if date_to is not None:
        stmt = stmt.where(Expense.business_date <= date_to)
    if category is not None:
        stmt = stmt.where(Expense.category == category)
    return list(db.execute(stmt.order_by(Expense.business_date.desc(), Expense.id.desc())).scalars())


def create_expense(db: Session, *, actor: Actor, store: Store, payload: ExpenseIn) -> Expense:
    _validate_source(source=payload.source, cash_movement_id=payload.cash_movement_id, db=db, store_id=store.id)
    employee_id, employee_name = _actor_identity(actor)

    now = clock.now_utc()
    row = Expense(
        organization_id=store.organization_id,
        store_id=store.id,
        category=ExpenseCategory(payload.category),
        description=payload.description,
        amount=payload.amount,
        business_date=payload.business_date,
        source=ExpenseSource(payload.source),
        cash_movement_id=payload.cash_movement_id,
        created_by_employee_id=employee_id,
        created_by_employee_name=employee_name,
        created_at=now,
    )
    db.add(row)
    db.flush()
    record_audit(
        db,
        actor=actor,
        organization_id=store.organization_id,
        store_id=store.id,
        entity="expense",
        entity_id=row.id,
        action="create",
        before=None,
        after={
            "category": row.category.value,
            "amount": row.amount,
            "business_date": row.business_date.isoformat(),
            "source": row.source.value,
        },
    )
    return row


def void_expense(db: Session, *, actor: Actor, expense: Expense, reason: str) -> Expense:
    if expense.voided_at is not None:
        raise AppError(code="EXPENSE_ALREADY_VOIDED", message="Este gasto ya fue anulado", status=400)
    expense.voided_at = clock.now_utc()
    expense.voided_reason = reason
    employee_id, employee_name = _actor_identity(actor)
    expense.voided_by_employee_id = employee_id
    expense.voided_by_employee_name = employee_name
    db.flush()
    record_audit(
        db,
        actor=actor,
        organization_id=expense.organization_id,
        store_id=expense.store_id,
        entity="expense",
        entity_id=expense.id,
        action="void",
        before={"voided_at": None},
        after={"voided_at": expense.voided_at.isoformat()},
        reason=reason,
    )
    return expense


def _sum_expenses(db: Session, *, store_id: int, date_from: date, date_to: date) -> int:
    return int(
        db.execute(
            select(func.coalesce(func.sum(Expense.amount), 0)).where(
                Expense.store_id == store_id,
                Expense.voided_at.is_(None),
                Expense.business_date >= date_from,
                Expense.business_date <= date_to,
            )
        ).scalar_one()
    )


# ---------------------------------------------------------------------------
# Obligaciones agendadas.
# ---------------------------------------------------------------------------


def get_obligation_or_404(db: Session, *, organization_id: int, obligation_id: int) -> Obligation:
    row = db.get(Obligation, obligation_id)
    if row is None or row.organization_id != organization_id:
        raise NotFoundError("La obligación no existe en esta organización")
    return row


def list_obligations(
    db: Session,
    *,
    store_id: int,
    status: str | None,
    date_from: date | None,
    date_to: date | None,
    include_cancelled: bool = False,
) -> list[Obligation]:
    if date_from is not None and date_to is not None:
        _validate_range(date_from, date_to)
    stmt = select(Obligation).where(Obligation.store_id == store_id)
    if not include_cancelled:
        stmt = stmt.where(Obligation.cancelled_at.is_(None))
    if status is not None:
        stmt = stmt.where(Obligation.status == status)
    if date_from is not None:
        stmt = stmt.where(Obligation.due_date >= date_from)
    if date_to is not None:
        stmt = stmt.where(Obligation.due_date <= date_to)
    return list(db.execute(stmt.order_by(Obligation.due_date)).scalars())


def create_obligation(db: Session, *, actor: Actor, store: Store, payload: ObligationIn) -> Obligation:
    employee_id, employee_name = _actor_identity(actor)
    now = clock.now_utc()
    row = Obligation(
        organization_id=store.organization_id,
        store_id=store.id,
        category=ObligationCategory(payload.category),
        description=payload.description,
        amount=payload.amount,
        due_date=payload.due_date,
        status=ObligationStatus.PENDING,
        created_by_employee_id=employee_id,
        created_by_employee_name=employee_name,
        created_at=now,
    )
    db.add(row)
    db.flush()
    record_audit(
        db,
        actor=actor,
        organization_id=store.organization_id,
        store_id=store.id,
        entity="obligation",
        entity_id=row.id,
        action="create",
        before=None,
        after={
            "category": row.category.value,
            "amount": row.amount,
            "due_date": row.due_date.isoformat(),
        },
    )
    return row


def settle_obligation(db: Session, *, actor: Actor, obligation: Obligation, payload: ObligationSettleIn) -> Obligation:
    if obligation.cancelled_at is not None:
        raise AppError(code="OBLIGATION_CANCELLED", message="Esta obligación fue cancelada; no se puede saldar", status=400)
    if obligation.status == ObligationStatus.PAID:
        raise AppError(code="OBLIGATION_ALREADY_SETTLED", message="Esta obligación ya está saldada", status=400)

    _validate_source(source=payload.source, cash_movement_id=payload.cash_movement_id, db=db, store_id=obligation.store_id)
    employee_id, employee_name = _actor_identity(actor)

    obligation.status = ObligationStatus.PAID
    obligation.settled_at = clock.now_utc()
    obligation.settled_by_employee_id = employee_id
    obligation.settled_by_employee_name = employee_name
    obligation.settled_source = ExpenseSource(payload.source)
    obligation.cash_movement_id = payload.cash_movement_id
    db.flush()
    record_audit(
        db,
        actor=actor,
        organization_id=obligation.organization_id,
        store_id=obligation.store_id,
        entity="obligation",
        entity_id=obligation.id,
        action="settle",
        before={"status": "pending"},
        after={"status": "paid", "source": payload.source},
    )
    return obligation


def cancel_obligation(db: Session, *, actor: Actor, obligation: Obligation, reason: str) -> Obligation:
    if obligation.cancelled_at is not None:
        raise AppError(code="OBLIGATION_CANCELLED", message="Esta obligación ya fue cancelada", status=400)
    if obligation.status == ObligationStatus.PAID:
        raise AppError(code="OBLIGATION_ALREADY_SETTLED", message="Esta obligación ya está saldada; no se puede cancelar", status=400)
    employee_id, employee_name = _actor_identity(actor)
    obligation.cancelled_at = clock.now_utc()
    obligation.cancelled_reason = reason
    obligation.cancelled_by_employee_id = employee_id
    obligation.cancelled_by_employee_name = employee_name
    db.flush()
    record_audit(
        db,
        actor=actor,
        organization_id=obligation.organization_id,
        store_id=obligation.store_id,
        entity="obligation",
        entity_id=obligation.id,
        action="cancel",
        before={"cancelled_at": None},
        after={"cancelled_at": obligation.cancelled_at.isoformat()},
        reason=reason,
    )
    return obligation


def _sum_obligations(db: Session, *, store_id: int, date_from: date, date_to: date) -> int:
    """Accrual, no caja: una obligación cuenta para el período en el que
    **vence** (`due_date`), sin importar si ya se saldó o sigue pendiente —
    es "lo que cuesta tener el restaurante abierto ESE mes", no "lo que se
    pagó ese mes". Excluye las canceladas (baja lógica)."""
    return int(
        db.execute(
            select(func.coalesce(func.sum(Obligation.amount), 0)).where(
                Obligation.store_id == store_id,
                Obligation.cancelled_at.is_(None),
                Obligation.due_date >= date_from,
                Obligation.due_date <= date_to,
            )
        ).scalar_one()
    )


# ---------------------------------------------------------------------------
# Configuración por sede (costos fijos) — TU tabla, no `app.stores.models`.
# ---------------------------------------------------------------------------


def get_settings(db: Session, *, store_id: int) -> StoreExpensesSettings | None:
    return db.get(StoreExpensesSettings, store_id)


def update_settings(db: Session, *, store: Store, actor: Actor, fixed_costs: int | None) -> StoreExpensesSettings:
    employee_id, _name = _actor_identity(actor)
    row = db.get(StoreExpensesSettings, store.id)
    now = clock.now_utc()
    before = {"fixed_costs": row.fixed_costs} if row is not None else None
    if row is None:
        row = StoreExpensesSettings(
            store_id=store.id, fixed_costs=fixed_costs, updated_at=now, updated_by_employee_id=employee_id
        )
        db.add(row)
    else:
        row.fixed_costs = fixed_costs
        row.updated_at = now
        row.updated_by_employee_id = employee_id
    db.flush()
    record_audit(
        db,
        actor=actor,
        organization_id=store.organization_id,
        store_id=store.id,
        entity="store_expenses_settings",
        entity_id=store.id,
        action="update",
        before=before,
        after={"fixed_costs": row.fixed_costs},
    )
    return row


# ---------------------------------------------------------------------------
# Costos fijos AUTOMÁTICOS del período (decisión del dueño, informe de
# visualización #2). Antes el punto de equilibrio usaba un número escrito a
# mano en `StoreExpensesSettings.fixed_costs` y Utilidad restaba lo
# registrado: con $14,5 M escritos contra $19,6 M registrados, la pantalla
# decía «ya pasaste el equilibrio» al lado de una pérdida. Ahora los dos leen
# ESTA función, y el número escrito a mano no entra a ninguna cuenta.
#
# Qué cuenta como fijo:
# - **Obligaciones** (arriendo, servicios, impuestos, otras), por `due_date`
#   en el período — el mismo criterio de devengo que ya usaba Utilidad.
# - **Nómina** del período (`app.payroll.hooks.period_payroll_cost`).
# - **Gastos** (`Expense`), TODAS las categorías. `Expense` no tiene marca de
#   fijo/variable, y por diseño nunca es compra de inventario (llave anti
#   doble conteo, punto 1 del docstring): lo que varía con cada plato
#   vendido ya está en el costo teórico. Mantenimiento, servicios, mercadeo,
#   transporte o insumos de operación son gastos de tener el local abierto,
#   no de vender un plato más. Contarlos como fijos es además lo que hace
#   que Utilidad y equilibrio cierren entre sí sin un tercer renglón.
# ---------------------------------------------------------------------------

#: Cobertura mínima de costo (por ciento de la venta neta con costo teórico,
#: `costed_pct` de `GET /admin/sales`) para confiar en el margen de
#: contribución. Por debajo, la venta sin ficha técnica entra con costo $0 y
#: el margen sale inflado: con 60 % de cobertura el punto de equilibrio salía
#: muy bajo (informe científico #4). Con 95 % el sesgo queda acotado a 5 % de
#: la venta, y se publica `costed_pct` al lado para que se vea.
COSTED_PCT_MIN = 95

_OBLIGATION_LABEL: dict[str, str] = {
    ObligationCategory.RENT.value: "Arriendo",
    ObligationCategory.UTILITIES.value: "Servicios públicos",
    ObligationCategory.TAXES.value: "Impuestos",
    ObligationCategory.OTHER.value: "Otras obligaciones",
}
_EXPENSE_LABEL: dict[str, str] = {
    ExpenseCategory.SUPPLIES.value: "Gastos de insumos de operación",
    ExpenseCategory.MAINTENANCE.value: "Gastos de mantenimiento",
    ExpenseCategory.UTILITIES.value: "Gastos de servicios",
    ExpenseCategory.MARKETING.value: "Gastos de mercadeo",
    ExpenseCategory.TRANSPORT.value: "Gastos de transporte",
    ExpenseCategory.OTHER.value: "Otros gastos",
}


def _value(raw: Any) -> str:
    return raw.value if hasattr(raw, "value") else str(raw)


def _signed_bp(numerator: int, denominator: int) -> int:
    """`numerator / denominator` en puntos básicos, redondeo mitad hacia
    arriba sobre el valor absoluto, CON signo. `denominator > 0`."""
    magnitude = money.round_half_up(abs(numerator) * 10_000, denominator)
    return -magnitude if numerator < 0 else magnitude


@dataclass(frozen=True)
class FixedCosts:
    total: int | None
    breakdown: list[FixedCostLineOut]
    expenses: int
    obligations: int
    payroll: int | None
    payroll_reason: str | None


def compute_fixed_costs(db: Session, *, store: Store, date_from: date, date_to: date) -> FixedCosts:
    obligations_by_category = {
        _value(category): int(amount)
        for category, amount in db.execute(
            select(Obligation.category, func.sum(Obligation.amount))
            .where(
                Obligation.store_id == store.id,
                Obligation.cancelled_at.is_(None),
                Obligation.due_date >= date_from,
                Obligation.due_date <= date_to,
            )
            .group_by(Obligation.category)
        ).all()
    }
    expenses_by_category = {
        _value(category): int(amount)
        for category, amount in db.execute(
            select(Expense.category, func.sum(Expense.amount))
            .where(
                Expense.store_id == store.id,
                Expense.voided_at.is_(None),
                Expense.business_date >= date_from,
                Expense.business_date <= date_to,
            )
            .group_by(Expense.category)
        ).all()
    }
    payroll, payroll_reason = _period_payroll_cost(db, store=store, date_from=date_from, date_to=date_to)

    breakdown: list[FixedCostLineOut] = []
    for category in ObligationCategory:
        amount = obligations_by_category.get(category.value, 0)
        if amount:
            breakdown.append(FixedCostLineOut(label=_OBLIGATION_LABEL[category.value], amount=amount, source="obligations"))
    if payroll:
        breakdown.append(FixedCostLineOut(label="Nómina", amount=payroll, source="payroll"))
    for expense_category in ExpenseCategory:
        amount = expenses_by_category.get(expense_category.value, 0)
        if amount:
            breakdown.append(FixedCostLineOut(label=_EXPENSE_LABEL[expense_category.value], amount=amount, source="expenses"))

    obligations_total = sum(obligations_by_category.values())
    expenses_total = sum(expenses_by_category.values())
    total = None if payroll is None else obligations_total + expenses_total + payroll
    return FixedCosts(
        total=total,
        breakdown=breakdown,
        expenses=expenses_total,
        obligations=obligations_total,
        payroll=payroll,
        payroll_reason=payroll_reason,
    )


# ---------------------------------------------------------------------------
# Venta neta y costo de venta del período (lee `app.reports.hooks` — no
# vuelve a sumar documentos de venta). Una sola función para Utilidad y para
# el margen de contribución: si el costo no es confiable para una, no lo es
# para la otra.
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class SalesCost:
    net_sales: int
    orders: int
    cost: int | None
    costed_pct: int | None
    # `None` si `cost` se puede usar; si no, por qué.
    cost_reason: str | None


def _sales_and_cost(db: Session, *, store: Store, date_from: date, date_to: date) -> SalesCost:
    from app.reports import hooks as reports_hooks

    sales = reports_hooks.period_sales(db, store_id=store.id, date_from=date_from, date_to=date_to)
    if sales.orders == 0:
        # Sin ventas del período, el costo de lo vendido es legítimamente 0
        # (no "sin datos": no se vendió nada, así que no hay costo que
        # calcular) — distinto de los casos de abajo, donde SÍ hubo ventas
        # pero sin costo teórico suficiente.
        return SalesCost(net_sales=sales.net, orders=0, cost=0, costed_pct=sales.costed_pct, cost_reason=None)
    if sales.theoretical_cost is None:
        return SalesCost(
            net_sales=sales.net,
            orders=sales.orders,
            cost=None,
            costed_pct=sales.costed_pct,
            cost_reason=(
                "Hay ventas del período sin costo teórico calculado (productos sin ficha técnica o sin costo "
                "asignado); el costo de lo vendido no se puede calcular con precisión todavía."
            ),
        )
    if sales.costed_pct is not None and sales.costed_pct < COSTED_PCT_MIN:
        return SalesCost(
            net_sales=sales.net,
            orders=sales.orders,
            cost=sales.theoretical_cost,
            costed_pct=sales.costed_pct,
            cost_reason=(
                f"Sólo el {format_pct_bp(sales.costed_pct * 100, decimals=0)} de la venta neta del período tiene costo "
                f"teórico, y hace falta al menos el {format_pct_bp(COSTED_PCT_MIN * 100, decimals=0)}: la venta sin ficha "
                "técnica entra con costo cero e infla el margen. Cargá las fichas técnicas que faltan "
                "(Hoy → «Productos sin costo»)."
            ),
        )
    return SalesCost(
        net_sales=sales.net, orders=sales.orders, cost=sales.theoretical_cost, costed_pct=sales.costed_pct, cost_reason=None
    )


def _contribution_margin_pct_bp(sc: SalesCost) -> tuple[int | None, str | None]:
    if sc.orders == 0:
        return None, "No hay ventas registradas en el período para calcular el margen de contribución."
    if sc.net_sales <= 0:
        return None, "Las ventas netas del período no son positivas; no se puede calcular el margen de contribución."
    if sc.cost is None or sc.cost_reason is not None:
        return None, sc.cost_reason
    return _signed_bp(sc.net_sales - sc.cost, sc.net_sales), None


# ---------------------------------------------------------------------------
# Punto de equilibrio.
# ---------------------------------------------------------------------------


def _pace_days(store: Store, *, date_from: date, date_to: date) -> int | None:
    """Días del período ya transcurridos (hoy incluido) si el período está
    en curso; `None` si ya terminó o todavía no empezó — «al ritmo actual»
    sólo tiene sentido mientras el período corre."""
    today = tz.today_business_date(store.cutoff_hour)
    if today < date_from or today > date_to:
        return None
    return (today - date_from).days + 1


def compute_break_even(db: Session, *, store: Store, date_from: date, date_to: date) -> BreakEvenOut:
    _validate_range(date_from, date_to)
    fc = compute_fixed_costs(db, store=store, date_from=date_from, date_to=date_to)
    sc = _sales_and_cost(db, store=store, date_from=date_from, date_to=date_to)
    margin_bp, margin_reason = _contribution_margin_pct_bp(sc)
    days_in_period = (date_to - date_from).days + 1
    elapsed = _pace_days(store, date_from=date_from, date_to=date_to)

    def _out(*, break_even: int | None, reason: str | None) -> BreakEvenOut:
        progress_bp = gap = days_to = None
        if break_even is not None:
            progress_bp = money.round_half_up(max(sc.net_sales, 0) * 10_000, break_even)
            gap = max(break_even - sc.net_sales, 0)
            if gap == 0:
                days_to = 0
            elif elapsed is not None and sc.net_sales > 0:
                # Ritmo = venta neta / días transcurridos; días = falta / ritmo,
                # redondeado hacia arriba (medio día que falta es un día más).
                days_to = -(-(gap * elapsed) // sc.net_sales)
        return BreakEvenOut(
            store_id=store.id,
            date_from=date_from,
            date_to=date_to,
            fixed_costs=fc.total,
            fixed_costs_breakdown=fc.breakdown,
            net_sales=sc.net_sales,
            costed_pct=sc.costed_pct,
            costed_pct_min=COSTED_PCT_MIN,
            contribution_margin_pct_bp=margin_bp,
            break_even_amount=break_even,
            progress_bp=progress_bp,
            gap_amount=gap,
            days_to_break_even_at_current_pace=days_to,
            days_elapsed=elapsed,
            days_in_period=days_in_period,
            available=break_even is not None,
            reason=reason,
        )

    if fc.total is None:
        return _out(break_even=None, reason=fc.payroll_reason)
    if fc.total == 0:
        # Un equilibrio de $0 le diría al dueño que ya está ganando plata:
        # sin ningún costo fijo registrado, es "sin datos", no cero.
        return _out(
            break_even=None,
            reason=(
                "No hay costos fijos registrados en el período: ni obligaciones (arriendo, servicios, "
                "impuestos), ni nómina, ni gastos. Cargalos en Gastos y obligaciones y el punto de "
                "equilibrio sale solo."
            ),
        )
    if margin_bp is None:
        return _out(break_even=None, reason=margin_reason)
    if margin_bp <= 0:
        return _out(
            break_even=None,
            reason=(
                "El margen de contribución del período no es positivo (el costo de venta iguala o supera "
                "las ventas); el punto de equilibrio no se puede calcular así."
            ),
        )
    assert sc.cost is not None
    # Equilibrio = fijos / margen, con el margen EXACTO (venta − costo) /
    # venta y no con el redondeado a puntos básicos: así «venta < equilibrio»
    # es exactamente «venta − costo < fijos», que es «utilidad < 0» en
    # `compute_profit` con los mismos números.
    break_even_amount = money.round_half_up(fc.total * sc.net_sales, sc.net_sales - sc.cost)
    return _out(break_even=break_even_amount, reason=None)


# ---------------------------------------------------------------------------
# Nómina del período — costura hacia `app.payroll.hooks` (T3, en
# construcción en paralelo en esta misma ronda). Contrato esperado, DECLARADO
# acá y en el entregable: `period_payroll_cost(db, *, store_id: int,
# date_from: date, date_to: date) -> int | None` (pesos enteros del período,
# `None` sólo si la función misma no tiene datos suficientes). Si el módulo
# o la función todavía no existen, este dominio NUNCA calcula una nómina
# propia — deja el punto de costura declarado y `payroll` sale `None` con
# motivo.
# ---------------------------------------------------------------------------


def _period_payroll_cost(db: Session, *, store: Store, date_from: date, date_to: date) -> tuple[int | None, str | None]:
    if not features.is_enabled(db, store.organization_id, store.id, "payroll"):
        # La función está apagada: no hay nómina que sumar. Legítimo 0, no
        # "sin datos" — la sede decidió no llevar nómina en el sistema.
        return 0, None

    if find_spec_safe("app.payroll.hooks") is None:
        return None, (
            "El dominio de nómina (app.payroll) todavía no está instalado en este despliegue; "
            "la utilidad del período no incluye nómina todavía."
        )

    import importlib

    module = importlib.import_module("app.payroll.hooks")
    fn = getattr(module, "period_payroll_cost", None)
    if fn is None:
        # Esto sólo puede pasar con el dominio a medio construir. Al usuario
        # se le dice lo único que puede hacer; el detalle técnico va al log.
        logger.warning("app.payroll.hooks no publica period_payroll_cost; la utilidad queda sin nómina")
        return None, (
            "La nómina del período no está disponible en este momento. "
            "Apagá «Nómina» en Admin → Funciones si no la usás, o avisá a soporte."
        )

    result: Any = fn(db, store_id=store.id, date_from=date_from, date_to=date_to)
    if result is None:
        # `period_payroll_cost` devuelve `None` por dos causas, y las dos se
        # arreglan desde la misma pantalla. No se inventa cuál es: se nombran
        # las dos, porque el mensaje tiene que servirle a quien lo lee.
        #
        # Antes acá decía "app.payroll.hooks.period_payroll_cost no tiene
        # datos suficientes para este período", que es el nombre de una
        # función de Python en la pantalla de un dueño de restaurante. Lo
        # encontró el recorrido en navegador real de la fase 3.
        return None, (
            "Falta un dato de nómina para calcular la utilidad: o no hay tablas de recargos "
            "cargadas, o alguien que trabajó en el período no tiene tarifa por hora. "
            "Las dos se cargan en Admin → Nómina y propinas."
        )
    return int(result), None


# ---------------------------------------------------------------------------
# Utilidad del período.
# ---------------------------------------------------------------------------


def _pct_of_sales(amount: int | None, net_sales: int) -> int | None:
    if amount is None or net_sales <= 0:
        return None
    return _signed_bp(amount, net_sales)


def _profit_period(db: Session, *, store: Store, date_from: date, date_to: date) -> ProfitPeriodOut:
    sc = _sales_and_cost(db, store=store, date_from=date_from, date_to=date_to)
    fc = compute_fixed_costs(db, store=store, date_from=date_from, date_to=date_to)

    reason: str | None = sc.cost_reason or (fc.payroll_reason if fc.payroll is None else None)
    profit: int | None = None
    if reason is None:
        assert sc.cost is not None and fc.total is not None
        profit = sc.net_sales - sc.cost - fc.total

    net = sc.net_sales
    lines = [
        ProfitLineOut(key="net_sales", label="Ventas netas", amount=net, pct_of_sales_bp=_pct_of_sales(net, net)),
        ProfitLineOut(key="cost", label="Costo de lo vendido", amount=sc.cost, pct_of_sales_bp=_pct_of_sales(sc.cost, net)),
        ProfitLineOut(key="payroll", label="Nómina", amount=fc.payroll, pct_of_sales_bp=_pct_of_sales(fc.payroll, net)),
        ProfitLineOut(
            key="obligations", label="Obligaciones", amount=fc.obligations, pct_of_sales_bp=_pct_of_sales(fc.obligations, net)
        ),
        ProfitLineOut(key="expenses", label="Gastos", amount=fc.expenses, pct_of_sales_bp=_pct_of_sales(fc.expenses, net)),
        ProfitLineOut(key="profit", label="Utilidad", amount=profit, pct_of_sales_bp=_pct_of_sales(profit, net)),
    ]
    return ProfitPeriodOut(
        date_from=date_from,
        date_to=date_to,
        net_sales=net,
        cost=sc.cost,
        expenses=fc.expenses,
        obligations=fc.obligations,
        payroll=fc.payroll,
        payroll_reason=fc.payroll_reason,
        fixed_costs=fc.total,
        fixed_costs_breakdown=fc.breakdown,
        costed_pct=sc.costed_pct,
        profit=profit,
        lines=lines,
        available=profit is not None,
        reason=reason,
    )


def compute_profit(db: Session, *, store: Store, date_from: date, date_to: date) -> ProfitOut:
    _validate_range(date_from, date_to)
    current = _profit_period(db, store=store, date_from=date_from, date_to=date_to)
    days = (date_to - date_from).days + 1
    prev_to = date_from - timedelta(days=1)
    prev_from = prev_to - timedelta(days=days - 1)
    previous = _profit_period(db, store=store, date_from=prev_from, date_to=prev_to)
    return ProfitOut(
        **current.model_dump(),
        store_id=store.id,
        costed_pct_min=COSTED_PCT_MIN,
        previous_period=previous,
    )
