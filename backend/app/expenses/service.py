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
y `_contribution_margin_pct_bp` llaman a
`app.reports.service.aggregate_sales` (la única agregación de documentos de
venta) y leen sus totales (`net`, `theoretical_cost`, `gross_margin`) tal
cual — nunca vuelven a iterar `FiscalDocument`/`OrderItem`.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import date
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.audit.service import record_audit
from app.auth.deps import Actor
from app.core import clock, features
from app.core.errors import AppError, NotFoundError
from app.core.modules import find_spec_safe
from app.expenses.models import (
    Expense,
    ExpenseCategory,
    ExpenseSource,
    Obligation,
    ObligationCategory,
    ObligationStatus,
    StoreExpensesSettings,
)
from app.expenses.schemas import ExpenseIn, ObligationIn, ObligationSettleIn
from app.orders import money
from app.reports import service as reports_service
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
            "El movimiento de caja no existe en esta sede; registrá primero el egreso desde el turno "
            "(POST /shifts/{id}/cash-movements) y repetí con su id"
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
                    "cash_movement_id: obligatorio cuando source es cash_drawer; registrá primero el egreso "
                    "desde el turno (POST /shifts/{id}/cash-movements)"
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
# Margen de contribución del período (lee `app.reports.service.aggregate_sales`
# — no vuelve a sumar documentos de venta).
# ---------------------------------------------------------------------------


def _contribution_margin_pct_bp(db: Session, *, store_id: int, date_from: date, date_to: date) -> tuple[int | None, str | None]:
    _rows, total = reports_service.aggregate_sales(
        db, store_id=store_id, date_from=date_from, date_to=date_to, group_by=None
    )
    if total.orders == 0:
        return None, "No hay ventas registradas en el período para calcular el margen de contribución."
    if total.net <= 0:
        return None, "Las ventas netas del período no son positivas; no se puede calcular el margen de contribución."
    if total.theoretical_cost is None or total.gross_margin is None:
        return None, (
            "Hay ventas del período sin costo teórico calculado (productos sin ficha técnica o sin costo "
            "asignado); el margen de contribución no es confiable todavía."
        )
    gross_margin = total.gross_margin
    if gross_margin >= 0:
        margin_bp = money.round_half_up(gross_margin * 10_000, total.net)
    else:
        margin_bp = -money.round_half_up(-gross_margin * 10_000, total.net)
    return margin_bp, None


# ---------------------------------------------------------------------------
# Punto de equilibrio.
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class BreakEvenResult:
    fixed_costs: int | None
    contribution_margin_pct_bp: int | None
    break_even_amount: int | None
    available: bool
    reason: str | None


def compute_break_even(db: Session, *, store: Store, date_from: date, date_to: date) -> BreakEvenResult:
    _validate_range(date_from, date_to)
    settings = get_settings(db, store_id=store.id)
    fixed_costs = settings.fixed_costs if settings is not None else None

    margin_bp, margin_reason = _contribution_margin_pct_bp(db, store_id=store.id, date_from=date_from, date_to=date_to)

    if fixed_costs is None:
        return BreakEvenResult(
            fixed_costs=None,
            contribution_margin_pct_bp=margin_bp,
            break_even_amount=None,
            available=False,
            reason="Todavía no cargaste los costos fijos de esta sede (PATCH /admin/expenses/settings).",
        )
    if margin_bp is None:
        return BreakEvenResult(
            fixed_costs=fixed_costs, contribution_margin_pct_bp=None, break_even_amount=None, available=False, reason=margin_reason
        )
    if margin_bp <= 0:
        return BreakEvenResult(
            fixed_costs=fixed_costs,
            contribution_margin_pct_bp=margin_bp,
            break_even_amount=None,
            available=False,
            reason=(
                "El margen de contribución del período no es positivo (el costo de venta iguala o supera "
                "las ventas); el punto de equilibrio no se puede calcular así."
            ),
        )
    break_even_amount = money.round_half_up(fixed_costs * 10_000, margin_bp)
    return BreakEvenResult(
        fixed_costs=fixed_costs,
        contribution_margin_pct_bp=margin_bp,
        break_even_amount=break_even_amount,
        available=True,
        reason=None,
    )


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


@dataclass(frozen=True)
class ProfitResult:
    net_sales: int
    cost: int | None
    expenses: int
    obligations: int
    payroll: int | None
    payroll_reason: str | None
    profit: int | None
    available: bool
    reason: str | None


def compute_profit(db: Session, *, store: Store, date_from: date, date_to: date) -> ProfitResult:
    _validate_range(date_from, date_to)
    _rows, total = reports_service.aggregate_sales(
        db, store_id=store.id, date_from=date_from, date_to=date_to, group_by=None
    )
    net_sales = total.net

    cost: int | None
    cost_reason: str | None
    if total.orders == 0:
        # Sin ventas del período, el costo de lo vendido es legítimamente 0
        # (no "sin datos": no se vendió nada, así que no hay costo que
        # calcular) — distinto del caso de abajo, donde SÍ hubo ventas pero
        # sin costo teórico asignado.
        cost, cost_reason = 0, None
    else:
        cost = total.theoretical_cost
        cost_reason = None if cost is not None else (
            "Hay ventas del período sin costo teórico calculado (productos sin ficha técnica o sin costo "
            "asignado); la utilidad no se puede calcular con precisión todavía."
        )

    expenses_total = _sum_expenses(db, store_id=store.id, date_from=date_from, date_to=date_to)
    obligations_total = _sum_obligations(db, store_id=store.id, date_from=date_from, date_to=date_to)
    payroll, payroll_reason = _period_payroll_cost(db, store=store, date_from=date_from, date_to=date_to)

    if cost is None:
        return ProfitResult(
            net_sales=net_sales,
            cost=None,
            expenses=expenses_total,
            obligations=obligations_total,
            payroll=payroll,
            payroll_reason=payroll_reason,
            profit=None,
            available=False,
            reason=cost_reason,
        )
    if payroll is None:
        return ProfitResult(
            net_sales=net_sales,
            cost=cost,
            expenses=expenses_total,
            obligations=obligations_total,
            payroll=None,
            payroll_reason=payroll_reason,
            profit=None,
            available=False,
            reason=payroll_reason,
        )

    profit_value = net_sales - cost - expenses_total - obligations_total - payroll
    return ProfitResult(
        net_sales=net_sales,
        cost=cost,
        expenses=expenses_total,
        obligations=obligations_total,
        payroll=payroll,
        payroll_reason=None,
        profit=profit_value,
        available=True,
        reason=None,
    )
