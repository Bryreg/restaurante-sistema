"""Contrato, novedades y costo del empleador (auditoría 2026-10-06, e2/e3).

`service._compute_employee_pay` calcula las HORAS: base por hora, recargos y
extras. Este módulo pone encima lo que depende del contrato y de la ley:

- **Sueldo fijo mensual**: la base es el sueldo prorrateado en días de 30
  (convención comercial: cada mes vale 30 días), no los minutos trabajados.
  Los recargos y extras siguen saliendo de las horas, con el valor de la
  hora ordinaria = sueldo / (jornada semanal × 5) — 30 días de 6 jornadas.
- **Novedades** (`PayrollAbsence`):
  - Incapacidad por enfermedad general: los días 1 y 2 los paga el
    empleador; desde el 3 los paga la EPS (el empleador los adelanta y los
    recobra). Se reconocen las 2/3 partes del salario diario, nunca menos
    del mínimo diario (Decreto 1049 de 1999, art. 227 CST).
  - Incapacidad laboral: el día 1 lo paga el empleador; desde el 2 la ARL,
    al 100 % (recobrable).
  - Licencia de maternidad o paternidad: la EPS, al 100 % (recobrable).
  - Vacaciones: salario ordinario por cada día HÁBIL (lunes a sábado que no
    sea festivo). Licencia remunerada y luto: salario por día calendario.
  - Licencia no remunerada y suspensión: no se pagan.
- **Auxilio de transporte** a quien gane hasta 2 mínimos, por los días
  efectivamente trabajados (no corre en vacaciones ni incapacidades).
- **Aportes del empleador**: pensión 12 %, ARL según la clase de riesgo,
  caja 4 %; salud 8,5 %, ICBF 3 % y SENA 2 % salvo la exoneración del art.
  114-1 E.T. para quien gane menos de 10 mínimos.
- **Provisión de prestaciones**: cesantías 8,33 % e intereses 1 % (12 %
  anual) y prima 8,33 % sobre salario + auxilio; vacaciones 4,17 % sobre
  el salario.

Prestación de servicios no es contrato laboral: no lleva nada de esto.
Aprendiz SENA: sólo ARL y salud plena (12,5 %).

Sigue siendo una cifra de control, no un desprendible legal: no hace
retención en la fuente ni descuentos al trabajador (salud y pensión del
empleado), y no reemplaza la revisión del contador.
"""

from __future__ import annotations

import calendar
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Any

from app.payroll.models import AbsenceKind, ContractKind, PayrollAbsence, SalaryType

PPM = 1_000_000

# Clase de riesgo ARL → tarifa (Decreto 1772 de 1994).
ARL_RATES_PPM: dict[int, int] = {1: 5_220, 2: 10_440, 3: 24_360, 4: 43_500, 5: 69_600}
APPRENTICE_HEALTH_PPM = 125_000


@dataclass(frozen=True)
class LegalParams:
    valid_from: date
    smmlv_pesos: int
    transport_allowance_pesos: int
    health_employer_ppm: int = 85_000
    pension_employer_ppm: int = 120_000
    family_fund_ppm: int = 40_000
    icbf_ppm: int = 30_000
    sena_ppm: int = 20_000
    severance_ppm: int = 83_333
    severance_interest_ppm: int = 10_000
    service_bonus_ppm: int = 83_333
    vacation_ppm: int = 41_667
    exonerated_114_1: bool = True
    confirmed: bool = False


# Valores de ley (decretos de salario mínimo y auxilio de cada año). Una
# fila de `payroll_legal_params` con la misma fecha los reemplaza.
LEGAL_PARAMS: list[LegalParams] = [
    LegalParams(date(2024, 1, 1), smmlv_pesos=1_300_000, transport_allowance_pesos=162_000),
    LegalParams(date(2025, 1, 1), smmlv_pesos=1_423_500, transport_allowance_pesos=200_000),
    # Decretos 1469 y 1470 de 2025 (sostenidos por el Decreto 0159 de 2026).
    LegalParams(date(2026, 1, 1), smmlv_pesos=1_750_905, transport_allowance_pesos=249_095),
]


def params_for(on: date, rows: list[Any]) -> LegalParams | None:
    """La vigencia de mayor `valid_from <= on` entre la ley (código) y las
    filas de la organización; en la misma fecha gana la fila."""
    candidates: dict[date, LegalParams] = {p.valid_from: p for p in LEGAL_PARAMS}
    for r in rows:
        candidates[r.valid_from] = LegalParams(
            valid_from=r.valid_from,
            smmlv_pesos=r.smmlv_pesos,
            transport_allowance_pesos=r.transport_allowance_pesos,
            health_employer_ppm=r.health_employer_ppm,
            pension_employer_ppm=r.pension_employer_ppm,
            family_fund_ppm=r.family_fund_ppm,
            icbf_ppm=r.icbf_ppm,
            sena_ppm=r.sena_ppm,
            severance_ppm=r.severance_ppm,
            severance_interest_ppm=r.severance_interest_ppm,
            service_bonus_ppm=r.service_bonus_ppm,
            vacation_ppm=r.vacation_ppm,
            exonerated_114_1=r.exonerated_114_1,
            confirmed=r.created_by_employee_id is not None,
        )
    best: LegalParams | None = None
    for d in sorted(candidates):
        if d <= on:
            best = candidates[d]
    return best


def _half_up(num: int, den: int) -> int:
    return (num + den // 2) // den if num >= 0 else -((-num + den // 2) // den)


def _rate(amount: int, ppm: int) -> int:
    return _half_up(amount * ppm, PPM)


def commercial_days(start: date, end: date) -> int:
    """Días entre `start` y `end` (inclusive) contando cada mes como de 30:
    el 31 no suma y el último día de febrero completa hasta 30."""
    if end < start:
        return 0
    total = 0
    cursor = start
    while cursor <= end:
        last = calendar.monthrange(cursor.year, cursor.month)[1]
        month_end = min(end, date(cursor.year, cursor.month, last))
        first = min(cursor.day, 30)
        until = min(month_end.day, 30)
        if month_end.day == last:
            until = 30
        total += max(until - first + 1, 0)
        cursor = month_end + timedelta(days=1)
    return total


def _clip(a_from: date, a_to: date, p_from: date, p_to: date) -> tuple[date, date] | None:
    lo, hi = max(a_from, p_from), min(a_to, p_to)
    return (lo, hi) if lo <= hi else None


def _business_days(lo: date, hi: date, holidays: set[date]) -> int:
    n, d = 0, lo
    while d <= hi:
        if d.weekday() != 6 and d not in holidays:
            n += 1
        d += timedelta(days=1)
    return n


@dataclass
class LegalPay:
    base_pay: int
    absence_days: int = 0
    absence_pay: int = 0
    transport_allowance: int = 0
    recoverable: int = 0
    employer_contributions: int = 0
    benefits_provision: int = 0
    employee_total: int = 0
    employer_total: int = 0
    notes: list[str] = field(default_factory=list)


def compute(
    *,
    contract: Any,
    params: LegalParams,
    date_from: date,
    date_to: date,
    hours_base_pay: int,
    surcharges: int,
    hourly_wage: int | None,
    weekly_ordinary_hours: int,
    absences: list[PayrollAbsence],
    worked_dates: set[date],
    holidays: set[date],
) -> LegalPay:
    """La plata de una persona en el período, con su contrato. `surcharges`
    = recargos + extras ya calculados por horas (con el valor de la hora que
    corresponda al contrato)."""
    c_from = max(date_from, contract.start_date)
    c_to = min(date_to, contract.end_date) if contract.end_date else date_to
    monthly = contract.salary_type == SalaryType.MONTHLY

    if monthly:
        salary = int(contract.monthly_salary_pesos)
        daily = _half_up(salary, 30)
        base = _half_up(salary * commercial_days(c_from, c_to), 30) if c_from <= c_to else 0
        reference_monthly = salary
    else:
        daily = _half_up((hourly_wage or 0) * weekly_ordinary_hours, 6)
        base = hours_base_pay
        reference_monthly = _half_up((hourly_wage or 0) * weekly_ordinary_hours * 30, 7)

    out = LegalPay(base_pay=base)
    min_daily = _half_up(params.smmlv_pesos, 30)
    sick_daily = max(_half_up(daily * 2, 3), min_daily)
    no_transport_days = 0

    for a in absences:
        clipped = _clip(a.date_from, a.date_to, c_from, c_to)
        if clipped is None:
            continue
        lo, hi = clipped
        days = (hi - lo).days + 1
        out.absence_days += days
        no_transport_days += days
        kind = a.kind
        if kind in (AbsenceKind.UNPAID_LEAVE, AbsenceKind.SUSPENSION):
            if monthly:
                out.base_pay -= daily * days
            continue
        if kind == AbsenceKind.VACATION:
            if not monthly:
                out.absence_pay += daily * _business_days(lo, hi, holidays)
            continue
        if kind in (AbsenceKind.PAID_LEAVE, AbsenceKind.BEREAVEMENT):
            if not monthly:
                out.absence_pay += daily * days
            continue
        # Incapacidades y licencias pagadas por EPS/ARL: el día deja de ser
        # salario y pasa a ser auxilio económico.
        if monthly:
            out.base_pay -= daily * days
        for i in range(days):
            n = (lo - a.date_from).days + i + 1  # día número n de la novedad
            if kind == AbsenceKind.SICK_LEAVE:
                out.absence_pay += sick_daily
                if n > 2:
                    out.recoverable += sick_daily
            elif kind == AbsenceKind.WORK_ACCIDENT:
                out.absence_pay += daily
                if n > 1:
                    out.recoverable += daily
            else:  # maternidad / paternidad
                out.absence_pay += daily
                out.recoverable += daily

    out.base_pay = max(out.base_pay, 0)
    earnings = out.base_pay + surcharges + out.absence_pay

    if contract.kind == ContractKind.SERVICES:
        out.employee_total = earnings
        out.employer_total = earnings
        out.notes.append("Prestación de servicios: sin aportes, prestaciones ni auxilio de transporte.")
        return out

    if contract.kind != ContractKind.APPRENTICE and reference_monthly <= 2 * params.smmlv_pesos:
        if monthly:
            transport_days = max(commercial_days(c_from, c_to) - no_transport_days, 0)
        else:
            transport_days = len({d for d in worked_dates if c_from <= d <= c_to})
        out.transport_allowance = _half_up(params.transport_allowance_pesos * transport_days, 30)

    arl = _rate(earnings, ARL_RATES_PPM.get(int(contract.arl_risk_class), ARL_RATES_PPM[1]))
    if contract.kind == ContractKind.APPRENTICE:
        out.employer_contributions = arl + _rate(earnings, APPRENTICE_HEALTH_PPM)
    else:
        exonerated = params.exonerated_114_1 and reference_monthly < 10 * params.smmlv_pesos
        out.employer_contributions = (
            _rate(earnings, params.pension_employer_ppm)
            + arl
            + _rate(earnings, params.family_fund_ppm)
            + (0 if exonerated else _rate(earnings, params.health_employer_ppm))
            + (0 if exonerated else _rate(earnings, params.icbf_ppm))
            + (0 if exonerated else _rate(earnings, params.sena_ppm))
        )
        with_transport = earnings + out.transport_allowance
        out.benefits_provision = (
            _rate(with_transport, params.severance_ppm)
            + _rate(with_transport, params.severance_interest_ppm)
            + _rate(with_transport, params.service_bonus_ppm)
            + _rate(earnings, params.vacation_ppm)
        )

    out.employee_total = earnings + out.transport_allowance
    out.employer_total = (
        out.employee_total + out.employer_contributions + out.benefits_provision - out.recoverable
    )
    if not params.confirmed:
        out.notes.append(
            f"Parámetros legales de ley vigentes desde {params.valid_from.isoformat()} sin confirmar por una persona."
        )
    return out
