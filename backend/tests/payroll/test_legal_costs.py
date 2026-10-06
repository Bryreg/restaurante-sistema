"""Contrato, novedades y costo del empleador (`app/payroll/legal_costs.py`)."""

from __future__ import annotations

from datetime import date
from types import SimpleNamespace
from typing import Any

from app.payroll import legal_costs
from app.payroll.models import AbsenceKind, ContractKind, SalaryType

SMMLV_2026 = 1_750_905
AUX_2026 = 249_095


def _contract(**kw: Any) -> Any:
    base = dict(kind=ContractKind.INDEFINITE, salary_type=SalaryType.MONTHLY, monthly_salary_pesos=SMMLV_2026,
                start_date=date(2026, 1, 1), end_date=None, arl_risk_class=1)
    base.update(kw)
    return SimpleNamespace(**base)


def _absence(kind: AbsenceKind, a: date, b: date) -> Any:
    return SimpleNamespace(kind=kind, date_from=a, date_to=b)


def _params() -> legal_costs.LegalParams:
    p = legal_costs.params_for(date(2026, 6, 30), [])
    assert p is not None
    return p


def _run(contract: Any, absences: list[Any] = (), **kw: Any) -> legal_costs.LegalPay:  # type: ignore[assignment]
    args: dict[str, Any] = dict(
        contract=contract, params=_params(), date_from=date(2026, 6, 1), date_to=date(2026, 6, 30),
        hours_base_pay=0, surcharges=0, hourly_wage=None, weekly_ordinary_hours=42,
        absences=list(absences), worked_dates=set(), holidays=set(),
    )
    args.update(kw)
    return legal_costs.compute(**args)


def test_params_2026_are_the_decree_values() -> None:
    p = _params()
    assert (p.smmlv_pesos, p.transport_allowance_pesos) == (SMMLV_2026, AUX_2026)
    assert legal_costs.params_for(date(2025, 12, 31), []).smmlv_pesos == 1_423_500  # type: ignore[union-attr]


def test_commercial_days() -> None:
    assert legal_costs.commercial_days(date(2026, 1, 1), date(2026, 1, 31)) == 30
    assert legal_costs.commercial_days(date(2026, 2, 1), date(2026, 2, 28)) == 30
    assert legal_costs.commercial_days(date(2026, 1, 16), date(2026, 1, 31)) == 15
    assert legal_costs.commercial_days(date(2026, 1, 1), date(2026, 1, 15)) == 15


def test_a_minimum_wage_month() -> None:
    out = _run(_contract())
    assert out.base_pay == SMMLV_2026
    assert out.transport_allowance == AUX_2026
    # Exonerada (art. 114-1): pensión 12 % + ARL I 0,522 % + caja 4 %.
    assert out.employer_contributions == 210_109 + 9_140 + 70_036
    # Cesantías 8,333 % + intereses 1 % + prima 8,333 % sobre salario + auxilio;
    # vacaciones 4,1667 % sobre salario.
    assert out.benefits_provision == 166_666 + 20_000 + 166_666 + 72_955
    assert out.employee_total == SMMLV_2026 + AUX_2026
    assert out.employer_total == out.employee_total + out.employer_contributions + out.benefits_provision


def test_sick_leave_first_two_days_employer_then_eps() -> None:
    out = _run(_contract(), [_absence(AbsenceKind.SICK_LEAVE, date(2026, 6, 10), date(2026, 6, 13))])
    daily = 58_364  # 1.750.905 / 30
    assert out.absence_days == 4
    assert out.base_pay == SMMLV_2026 - 4 * daily
    # 2/3 del diario es menos que el mínimo diario: se paga el mínimo diario.
    assert out.absence_pay == 4 * daily
    assert out.recoverable == 2 * daily
    assert out.transport_allowance == round(AUX_2026 * 26 / 30)


def test_hourly_vacation_counts_business_days() -> None:
    # Del lunes 15 al domingo 21 de junio de 2026: 6 hábiles (sin domingo),
    # el 15 es festivo (Sagrado Corazón) → 5.
    out = _run(
        _contract(salary_type=SalaryType.HOURLY, monthly_salary_pesos=None),
        [_absence(AbsenceKind.VACATION, date(2026, 6, 15), date(2026, 6, 21))],
        hourly_wage=10_000, holidays={date(2026, 6, 15)},
    )
    assert out.absence_pay == 5 * 70_000  # 10.000 × 42 / 6


def test_unpaid_leave_discounts_monthly_salary() -> None:
    out = _run(_contract(), [_absence(AbsenceKind.UNPAID_LEAVE, date(2026, 6, 1), date(2026, 6, 3))])
    assert out.base_pay == SMMLV_2026 - 3 * 58_364
    assert out.absence_pay == 0


def test_services_contract_has_no_benefits() -> None:
    out = _run(_contract(kind=ContractKind.SERVICES, monthly_salary_pesos=3_000_000))
    assert out.transport_allowance == 0
    assert out.employer_contributions == 0 and out.benefits_provision == 0
    assert out.employer_total == 3_000_000


def test_above_two_minimums_no_transport() -> None:
    out = _run(_contract(monthly_salary_pesos=4_000_000))
    assert out.transport_allowance == 0
