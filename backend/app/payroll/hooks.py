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

from datetime import date
from typing import Any

from sqlalchemy.orm import Session

from app.core import clock
from app.payroll import service
from app.stores.models import Store


def period_payroll_cost(db: Session, *, store_id: int, date_from: date, date_to: date) -> int | None:
    store = db.get(Store, store_id)
    if store is None:
        return None

    if not service.list_surcharge_tables(db, store_id=store_id):
        return None

    by_employee, _ = service._employee_pieces(
        db, store=store, date_from=date_from, date_to=date_to, employee_id=None, until=clock.now_utc()
    )
    if not by_employee:
        # Nadie tiene jornada en el período: nómina legítima de $0 (no es
        # "sin datos" — es que efectivamente nadie trabajó).
        return 0

    wage_rates_by_employee = service._wage_rates_by_employee(db, store_id=store_id)
    total = 0
    for employee_id, pieces in by_employee.items():
        rates_sorted = wage_rates_by_employee.get(employee_id, [])
        pay = service._compute_employee_pay(pieces, rates_sorted)
        if pay.total is None:
            return None
        total += pay.total
    return total


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
