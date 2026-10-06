"""Lo único que otros dominios pueden importar de `payroll`.

**`period_payroll_cost`** es la costura hacia `app.expenses` (T2,
`backend-obligaciones`): `app/expenses/service.py::_period_payroll_cost` ya
declaró el contrato exacto, ANTES de que este dominio existiera, para que T2
pudiera arrancar en paralelo —

    period_payroll_cost(db, *, store_id: int, date_from: date, date_to: date) -> int | None

pesos enteros del período (suma de `PayrollRunLine.total` que
`_compute_employee_pay` calcularía **si se liquidara ahora mismo** — no lee
`PayrollRun`/`PayrollRunLine` ya guardadas, para que la utilidad del período
no dependa de que alguien haya apretado "liquidar" antes: usa exactamente el
mismo motor que `service.create_run`, así que el número que ve `GET
/admin/profit` y el que produciría `POST /admin/payroll/runs` para el mismo
período **siempre coinciden** — nunca dos matemáticas para la misma
pregunta), o `None` si no hay datos suficientes (sin tabla de recargos
configurada, o alguna persona sin tarifa por hora para el período: T2 no
inventa un `0` mudo en la utilidad por una nómina a medio configurar).

Otro dominio que necesite algo de `payroll` pide que se publique una función
nueva ACÁ — nunca importa `service.py`/`models.py` directo
(`docs/CONTEXTO-AGENTES.md §3`)."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime
from typing import Any, Literal

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.payroll import service
from app.payroll.models import PayrollRun
from app.stores.models import Store


# ---------------------------------------------------------------------------
# c5 · Agendar la nómina como obligación (`app.expenses`). Sólo lectura de
# las liquidaciones ya guardadas: el monto de una liquidación nunca se
# recalcula afuera de este dominio.
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class PayrollRunTotal:
    """Una liquidación guardada y lo que cuesta. `amount` es
    `employer_total_amount` (lo que la nómina le cuesta a la sede, 0043) si
    existe; si no, `total_amount` (lo pagado); `None` si ninguna de las dos
    se pudo calcular — nunca un `0` mudo. `amount_source` dice cuál fue."""

    id: int
    store_id: int
    date_from: date
    date_to: date
    amount: int | None
    amount_source: Literal["employer_total", "total"] | None
    computed_at: datetime


def _run_total(run: PayrollRun) -> PayrollRunTotal:
    amount: int | None
    source: Literal["employer_total", "total"] | None
    if run.employer_total_amount is not None:
        amount, source = int(run.employer_total_amount), "employer_total"
    elif run.total_amount is not None:
        amount, source = int(run.total_amount), "total"
    else:
        amount, source = None, None
    return PayrollRunTotal(
        id=run.id,
        store_id=run.store_id,
        date_from=run.date_from,
        date_to=run.date_to,
        amount=amount,
        amount_source=source,
        computed_at=run.computed_at,
    )


def get_run_total(db: Session, *, run_id: int) -> PayrollRunTotal | None:
    run = db.get(PayrollRun, run_id)
    return None if run is None else _run_total(run)


def list_run_totals(db: Session, *, store_id: int, limit: int = 24) -> list[PayrollRunTotal]:
    runs = db.execute(
        select(PayrollRun)
        .where(PayrollRun.store_id == store_id)
        .order_by(PayrollRun.date_to.desc(), PayrollRun.id.desc())
        .limit(limit)
    ).scalars()
    return [_run_total(r) for r in runs]


def period_payroll_cost(db: Session, *, store_id: int, date_from: date, date_to: date) -> int | None:
    """Lo que la nómina del período le cuesta a la sede (0043): lo pagado más
    aportes y provisión de prestaciones, menos lo que recobran EPS/ARL, con
    el mismo motor que `create_run` (`service.compute_period`). Quien no
    tiene contrato cargado aporta sólo sus horas."""
    store = db.get(Store, store_id)
    if store is None:
        return None

    if not service.list_surcharge_tables(db, store_id=store_id):
        return None

    lines, _ = service.compute_period(db, store=store, date_from=date_from, date_to=date_to)
    total = 0
    for line in lines:
        cost = line.employer_total
        if cost is None:
            return None
        total += cost
    return total


def worked_minutes_by_hour(db: Session, *, store_id: int, date_from: date, date_to: date) -> dict[int, int] | None:
    """Minutos trabajados por hora del reloj (0-23) en el período, con la
    jornada de la nómina (`service.worked_minutes_by_hour`). `None` si la
    sede no existe."""
    store = db.get(Store, store_id)
    if store is None:
        return None
    return service.worked_minutes_by_hour(db, store=store, date_from=date_from, date_to=date_to)


PayrollGaps = service.PayrollGaps


def payroll_gaps(db: Session, *, store_id: int, date_from: date, date_to: date) -> service.PayrollGaps | None:
    """Lo que le falta a la nómina del período para que su costo sea
    confiable: tablas de recargos (o sin confirmar), parámetros legales sin
    confirmar, gente sin tarifa y gente sin contrato."""
    store = db.get(Store, store_id)
    if store is None:
        return None
    return service.payroll_gaps(db, store=store, date_from=date_from, date_to=date_to)


def worked_minutes(entry: Any) -> int | None:
    """Minutos trabajados de una entrada de asistencia o de roster ya
    cerrada (`in_at`/`out_at`/`pauses`), con **el mismo** motor de jornada
    que liquida la nómina (`service._worked_intervals`: resta las pausas).
    `None` si la entrada no tiene salida: una jornada abierta o una salida
    olvidada no tiene duración todavía (nunca un 0 mudo). Redondeo half-up
    al minuto."""
    if entry.out_at is None:
        return None
    seconds = sum(
        int((end - start).total_seconds())
        for start, end in service._worked_intervals(entry, until=entry.out_at)
    )
    quotient, remainder = divmod(max(seconds, 0), 60)
    return quotient + (1 if remainder * 2 >= 60 else 0)
