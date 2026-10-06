"""Esquemas Pydantic de `payroll`.

Dinero en `int` (pesos enteros). Horas en `str` (texto decimal de dos
decimales, vía `app.core.hours.format_hours`) para publicarlas — nunca un
`float` de JSON — más los minutos enteros crudos, por si un cliente
necesita sumarlos sin volver a parsear texto (ver `HoursRowOut`). Porcentajes
en puntos básicos (`_bp`). Todo indicador sin datos suficientes es `None`
**con** `reason` — nunca `0` mudo, nunca una lista vacía sin explicar.
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

TipMethodLiteral = Literal["equal_shares", "by_hours", "by_area"]


class OutModel(BaseModel):
    model_config = ConfigDict(from_attributes=True)


# ---------------------------------------------------------------------------
# Jornada del período — GET /admin/payroll/hours
# ---------------------------------------------------------------------------


class HoursRowOut(BaseModel):
    employee_id: int
    employee_name: str
    ordinary_minutes: int
    night_minutes: int
    sunday_minutes: int
    holiday_minutes: int
    overtime_minutes: int
    ordinary_hours: str
    night_hours: str
    sunday_hours: str
    holiday_hours: str
    overtime_hours: str


class PendingExitOut(BaseModel):
    """Una salida olvidada (asistencia sin salida en un día que ya pasó):
    sus horas NO están en `rows` hasta que el administrador corrija la hora."""

    attendance_id: int
    employee_id: int
    employee_name: str
    business_date: date
    in_at: datetime


class HoursOut(BaseModel):
    store_id: int
    date_from: date
    date_to: date
    rows: list[HoursRowOut]
    available: bool
    reason: str | None
    pending_review: list[PendingExitOut] = []


# ---------------------------------------------------------------------------
# Horario de la semana — GET /admin/payroll/week-schedule (decisión del
# dueño, 2026-09-29: la vista principal de Nómina).
# ---------------------------------------------------------------------------


class WeekSegmentOut(BaseModel):
    """Un tramo trabajado de una persona en un día operativo, ya sin pausas
    (una pausa es el hueco entre dos tramos). `start_offset_min`/
    `end_offset_min` = minutos desde el comienzo del día operativo (la hora
    de corte de la sede, reloj de Bogotá): la posición en el eje, sin que el
    navegador tenga que saber de zonas horarias.

    `status`: `closed` (entrada y salida), `open` (sigue trabajando: el
    tramo llega hasta `now`) o `review` (salida olvidada de un día que ya
    pasó: `end`/`minutes` son `None` y **no suma horas** hasta que el
    administrador corrija la salida en Nómina › Horas)."""

    start: datetime
    end: datetime | None
    start_offset_min: int
    end_offset_min: int | None
    status: Literal["closed", "open", "review"]
    minutes: int | None
    hours: str | None
    attendance_id: int | None = None


class WeekPersonDayOut(BaseModel):
    business_date: date
    segments: list[WeekSegmentOut]
    #: Minutos que el motor de nómina cuenta para ese día (0 si sólo hay una salida a revisar).
    minutes: int
    hours: str


class WeekPersonOut(BaseModel):
    employee_id: int
    employee_name: str
    #: El total de la semana, con el mismo motor que Nómina › Horas
    #: (unión de asistencia y roster, pausas fuera, salidas olvidadas fuera).
    total_minutes: int
    total_hours: str
    review_count: int
    days: list[WeekPersonDayOut]


class WeekScheduleOut(BaseModel):
    store_id: int
    week_start: date
    week_end: date
    days: list[date]
    #: Hora de reloj (0-23) en la que arranca cada día operativo de la sede.
    day_start_hour: int
    now: datetime
    #: Día operativo en curso (para marcar «hoy»), aunque no caiga en la semana pedida.
    today: date
    people: list[WeekPersonOut]


# ---------------------------------------------------------------------------
# Tablas de recargos con vigencia — GET/POST /admin/payroll/surcharge-tables
# ---------------------------------------------------------------------------


class SurchargeTableIn(BaseModel):
    valid_from: date
    night_start_hour: int = Field(ge=0, le=23)
    night_end_hour: int = Field(ge=0, le=23)
    night_surcharge_bp: int = Field(ge=0, le=10_000)
    sunday_holiday_surcharge_bp: int = Field(ge=0, le=10_000)
    overtime_surcharge_bp: int = Field(ge=0, le=10_000)
    night_overtime_surcharge_bp: int = Field(default=7500, ge=0, le=10_000)
    weekly_ordinary_hours: int = Field(gt=0, le=100)


class SurchargeTableOut(OutModel):
    id: int
    store_id: int
    valid_from: date
    night_start_hour: int
    night_end_hour: int
    night_surcharge_bp: int
    sunday_holiday_surcharge_bp: int
    overtime_surcharge_bp: int
    night_overtime_surcharge_bp: int
    weekly_ordinary_hours: int
    # A-4: una tabla SEMBRADA por la migración `0020` no tiene
    # `created_by_employee_id`; una que cargó una persona sí. Ese es el
    # marcador natural de «esto lo revisó alguien» y no hace falta una columna
    # nueva para tenerlo — se deriva.
    #
    # Importa decirlo: los valores sembrados son un **supuesto declarado**
    # (la spec cita tres cambios con su norma; el resto lo completó el equipo
    # con un valor razonable). Son editables por API sin tocar código, que es
    # lo que había que garantizar, pero hasta que alguien los confirme son
    # datos que nadie con firma revisó. Publicarlo es la diferencia entre un
    # riesgo anotado en un documento y un riesgo que se ve en la pantalla.
    confirmed_by_person: bool
    confirmed_by_name: str | None
    created_at: datetime


# ---------------------------------------------------------------------------
# Festivos — GET/POST /admin/payroll/holidays (agregada, fuera del contrato
# mínimo — ver el entregable § 3).
# ---------------------------------------------------------------------------


class HolidayIn(BaseModel):
    holiday_date: date
    name: str = Field(min_length=1, max_length=200)


class HolidayOut(OutModel):
    # `None` para los festivos de ley: se calculan, no son filas.
    id: int | None
    store_id: int
    holiday_date: date
    name: str
    # «ley» (calculado, Ley 51 de 1983) o «sede» (declarado a mano).
    source: Literal["ley", "sede"] = "sede"


# ---------------------------------------------------------------------------
# Tarifa por hora — GET/POST /admin/payroll/wages (agregada, fuera del
# contrato mínimo — ver el entregable § 3).
# ---------------------------------------------------------------------------


class WageRateIn(BaseModel):
    employee_id: int
    hourly_wage_pesos: int = Field(gt=0)
    valid_from: date


class WageRateOut(OutModel):
    id: int
    store_id: int
    employee_id: int
    employee_name: str
    hourly_wage_pesos: int
    valid_from: date
    created_at: datetime


# ---------------------------------------------------------------------------
# Área — GET/PATCH /admin/payroll/areas (agregada, fuera del contrato
# mínimo — ver el entregable § 3).
# ---------------------------------------------------------------------------


class AreaAssignmentIn(BaseModel):
    employee_id: int
    area: str = Field(min_length=1, max_length=100)


class AreaAssignmentOut(OutModel):
    employee_id: int
    employee_name: str
    area: str
    updated_at: datetime


# ---------------------------------------------------------------------------
# Liquidación del período — GET/POST /admin/payroll/runs
# ---------------------------------------------------------------------------


# A-5: cómo se calculó una liquidación. Hoy sólo existe la forma aditiva; el
# día que se implemente la fórmula legal completa del CST, esta lista crece y
# las liquidaciones viejas siguen diciendo con cuál se calcularon.
PayrollCalculationMethodLiteral = Literal["additive_surcharges", "cst_categories"]


class SurchargeTableUsedOut(BaseModel):
    valid_from: date
    night_start_hour: int
    night_end_hour: int
    night_surcharge_bp: int
    sunday_holiday_surcharge_bp: int
    overtime_surcharge_bp: int
    # `None` en las liquidaciones calculadas antes de existir la extra
    # nocturna propia (0041): esas pagaron extra + nocturno sumados.
    night_overtime_surcharge_bp: int | None = None
    weekly_ordinary_hours: int
    # A-4: si la liquidación se calculó con una tabla que nadie confirmó, la
    # liquidación lo dice. Una nómina es plata de una persona; que descanse
    # sobre un supuesto no puede quedar sólo en un documento.
    #
    # Default `False` para los snapshots guardados ANTES de este campo: no
    # sabemos si esa tabla estaba confirmada, y «no sabemos» se trata como «no
    # confirmada», que es el lado que avisa de más y no de menos.
    confirmed_by_person: bool = False


class PayrollRunLineOut(BaseModel):
    employee_id: int
    employee_name: str
    ordinary_minutes: int
    night_minutes: int
    sunday_minutes: int
    holiday_minutes: int
    overtime_minutes: int
    base_pay: int | None
    night_surcharge: int | None
    sunday_holiday_surcharge: int | None
    overtime_pay: int | None
    total: int | None
    pay_reason: str | None
    # 0043: contrato, novedades y costo del empleador. `None` sin contrato
    # cargado o en liquidaciones anteriores.
    absence_days: int | None = None
    absence_pay: int | None = None
    transport_allowance: int | None = None
    recoverable: int | None = None
    employer_contributions: int | None = None
    benefits_provision: int | None = None
    employer_total: int | None = None


class PayrollRunIn(BaseModel):
    date_from: date
    date_to: date


class PayrollRunOut(BaseModel):
    id: int
    store_id: int
    date_from: date
    date_to: date
    tables_used: list[SurchargeTableUsedOut]
    lines: list[PayrollRunLineOut]
    total_amount: int | None
    employer_total_amount: int | None = None
    available: bool
    reason: str | None
    computed_at: datetime
    computed_by_employee_name: str | None
    # Informe de visualización #14. `net_sales`: ventas netas del MISMO
    # período (pesos, sin impuesto ni propina). `payroll_pct_of_sales_bp`:
    # `total_amount / net_sales` en puntos básicos; `None` con motivo en
    # `payroll_pct_reason` si no hay total o no hubo venta. `previous_*`: la
    # liquidación más reciente cuyo período termina antes de éste;
    # `delta_bp` = (total − anterior) / anterior, con signo, `None` con motivo
    # en `previous_reason`.
    net_sales: int | None = None
    payroll_pct_of_sales_bp: int | None = None
    payroll_pct_reason: str | None = None
    previous_run_id: int | None = None
    previous_date_from: date | None = None
    previous_date_to: date | None = None
    previous_total: int | None = None
    delta_bp: int | None = None
    previous_reason: str | None = None
    # A-5: **qué fórmula se usó**, publicado en la respuesta y no sólo
    # anotado en un docstring.
    #
    # `cst_categories` (desde 0041): la extra nocturna tiene su propio 75 %
    # y el dominical/festivo se suma encima, lo que reproduce las ocho
    # categorías del CST. Sigue siendo una cifra de control: no incluye
    # prestaciones, aportes ni el límite diario de horas.
    #
    # `additive_surcharges` (liquidaciones viejas) paga, por cada minuto, la base más los recargos
    # que apliquen (nocturno, dominical/festivo, extra) de forma **aditiva e
    # independiente**. Es transparente y auditable recargo por recargo, y
    # sirve para control interno — pero **no es la liquidación legal**: la
    # fórmula del CST los combina en ocho categorías (HED/HEN/HEDD/HEND).
    #
    # Se publica porque el riesgo real no es que la cifra sea aproximada: es
    # que alguien le pague a su personal con ella creyendo que es la legal.
    # Un producto que no puede hacer algo tiene que decirlo donde se usa, no
    # donde se documenta.
    calculation_method: PayrollCalculationMethodLiteral = "additive_surcharges"


class PayrollRunSummaryOut(BaseModel):
    """Fila de `GET /admin/payroll/runs` (listado, sin líneas — para el
    detalle completo con líneas, `GET /admin/payroll/runs?id=` en el mismo
    endpoint, ver `router.py`)."""

    id: int
    store_id: int
    date_from: date
    date_to: date
    total_amount: int | None
    available: bool
    reason: str | None
    computed_at: datetime
    # Informe de visualización #14. `net_sales`: ventas netas del MISMO
    # período (pesos, sin impuesto ni propina). `payroll_pct_of_sales_bp`:
    # `total_amount / net_sales` en puntos básicos; `None` con motivo en
    # `payroll_pct_reason` si no hay total o no hubo venta. `previous_*`: la
    # liquidación más reciente cuyo período termina antes de éste;
    # `delta_bp` = (total − anterior) / anterior, con signo, `None` con motivo
    # en `previous_reason`.
    net_sales: int | None = None
    payroll_pct_of_sales_bp: int | None = None
    payroll_pct_reason: str | None = None
    previous_run_id: int | None = None
    previous_date_from: date | None = None
    previous_date_to: date | None = None
    previous_total: int | None = None
    delta_bp: int | None = None
    previous_reason: str | None = None


# ---------------------------------------------------------------------------
# Reparto de propinas — GET /admin/tips/distribution/proposal,
# GET/PATCH /admin/tips/settings
# ---------------------------------------------------------------------------


class TipProposalRowOut(BaseModel):
    employee_id: int
    employee_name: str
    basis: str
    amount: int


class TipProposalOut(BaseModel):
    store_id: int
    shift_ids: list[int]
    method: TipMethodLiteral
    rows: list[TipProposalRowOut]
    total: int
    available: bool
    reason: str | None


class TipSettingsOut(OutModel):
    store_id: int
    method: TipMethodLiteral
    updated_at: datetime | None


class TipSettingsIn(BaseModel):
    method: TipMethodLiteral



# ---------------------------------------------------------------------------
# 0043 · Contrato, novedades y parámetros legales (e2/e3).
# ---------------------------------------------------------------------------

ContractKindLiteral = Literal["indefinite", "fixed_term", "part_time", "apprentice", "services"]
SalaryTypeLiteral = Literal["monthly", "hourly"]
AbsenceKindLiteral = Literal[
    "sick_leave", "work_accident", "maternity", "paternity", "vacation",
    "paid_leave", "bereavement", "unpaid_leave", "suspension",
]


class ContractIn(BaseModel):
    employee_id: int
    kind: ContractKindLiteral
    salary_type: SalaryTypeLiteral
    monthly_salary_pesos: int | None = Field(default=None, gt=0)
    start_date: date
    end_date: date | None = None
    arl_risk_class: int = Field(default=1, ge=1, le=5)


class ContractOut(OutModel):
    id: int
    store_id: int
    employee_id: int
    employee_name: str
    kind: ContractKindLiteral
    salary_type: SalaryTypeLiteral
    monthly_salary_pesos: int | None
    start_date: date
    end_date: date | None
    arl_risk_class: int
    created_by_employee_name: str | None


class AbsenceIn(BaseModel):
    employee_id: int
    kind: AbsenceKindLiteral
    date_from: date
    date_to: date
    note: str | None = Field(default=None, max_length=2000)


class AbsenceOut(OutModel):
    id: int
    store_id: int
    employee_id: int
    employee_name: str
    kind: AbsenceKindLiteral
    date_from: date
    date_to: date
    days: int
    note: str | None
    created_by_employee_name: str | None
    voided_at: datetime | None
    voided_by_employee_name: str | None
    void_reason: str | None


class AbsenceVoidIn(BaseModel):
    reason: str = Field(min_length=5, max_length=500)


class LegalParamsIn(BaseModel):
    valid_from: date
    smmlv_pesos: int = Field(gt=0)
    transport_allowance_pesos: int = Field(ge=0)
    health_employer_ppm: int = Field(default=85_000, ge=0, le=1_000_000)
    pension_employer_ppm: int = Field(default=120_000, ge=0, le=1_000_000)
    family_fund_ppm: int = Field(default=40_000, ge=0, le=1_000_000)
    icbf_ppm: int = Field(default=30_000, ge=0, le=1_000_000)
    sena_ppm: int = Field(default=20_000, ge=0, le=1_000_000)
    severance_ppm: int = Field(default=83_333, ge=0, le=1_000_000)
    severance_interest_ppm: int = Field(default=10_000, ge=0, le=1_000_000)
    service_bonus_ppm: int = Field(default=83_333, ge=0, le=1_000_000)
    vacation_ppm: int = Field(default=41_667, ge=0, le=1_000_000)
    exonerated_114_1: bool = True


class LegalParamsOut(BaseModel):
    valid_from: date
    smmlv_pesos: int
    transport_allowance_pesos: int
    health_employer_ppm: int
    pension_employer_ppm: int
    family_fund_ppm: int
    icbf_ppm: int
    sena_ppm: int
    severance_ppm: int
    severance_interest_ppm: int
    service_bonus_ppm: int
    vacation_ppm: int
    exonerated_114_1: bool
    # «ley» = valor del decreto que trae el sistema; «organizacion» = una
    # fila cargada (o confirmada) por una persona.
    source: Literal["ley", "organizacion"]
    confirmed_by_name: str | None = None



class OrganizationPayrollStoreOut(BaseModel):
    store_id: int
    store_name: str
    people: int
    total: int | None
    employer_total: int | None
    reason: str | None


class OrganizationPayrollPersonOut(BaseModel):
    employee_id: int
    employee_name: str
    stores: list[str]
    total: int | None
    employer_total: int | None


class OrganizationPayrollOut(BaseModel):
    date_from: date
    date_to: date
    total: int | None
    employer_total: int | None
    stores: list[OrganizationPayrollStoreOut]
    people: list[OrganizationPayrollPersonOut]


# ---------------------------------------------------------------------------
# Turnos planeados — /admin/payroll/schedule (auditoría e1, 0050)
# ---------------------------------------------------------------------------

#: `on_time` llegó dentro de la gracia · `late` llegó después · `missing`
#: ya debería estar y no ha marcado entrada · `no_show` el turno terminó sin
#: entrada · `excused` tiene una novedad de nómina ese día · `upcoming`
#: todavía no empieza · `unplanned` marcó entrada sin turno planeado.
ScheduleStatusLiteral = Literal["on_time", "late", "missing", "no_show", "excused", "upcoming", "unplanned"]

_HHMM = r"^([01]\d|2[0-3]):[0-5]\d$"


class PlannedShiftIn(BaseModel):
    employee_id: int
    business_date: date
    # Hora de pared de Bogotá («07:00»). Una entrada antes de la hora de corte
    # es de madrugada del mismo día operativo; una salida igual o anterior a
    # la entrada es del día siguiente. La cuenta la hace el servidor.
    start: str = Field(pattern=_HHMM)
    end: str = Field(pattern=_HHMM)
    note: str | None = Field(default=None, max_length=300)


class PlannedShiftVoidIn(BaseModel):
    reason: str | None = Field(default=None, max_length=300)


class PlannedShiftOut(OutModel):
    id: int
    employee_id: int
    employee_name: str
    business_date: date
    start: str
    end: str
    start_minute: int
    end_minute: int
    planned_minutes: int
    note: str | None
    created_by_employee_name: str | None


class ScheduleDayOut(BaseModel):
    business_date: date
    planned: PlannedShiftOut | None
    # La primera entrada real del día (asistencia); `None` si no marcó.
    actual_in_at: datetime | None
    status: ScheduleStatusLiteral | None
    # Minutos tarde, sólo con `status == "late"`; si no, `None` (no un 0).
    late_minutes: int | None


class SchedulePersonOut(BaseModel):
    employee_id: int
    employee_name: str
    planned_minutes: int
    days: list[ScheduleDayOut]


class ScheduleWeekOut(BaseModel):
    store_id: int
    week_start: date
    week_end: date
    today: date
    grace_minutes: int
    late_count: int
    no_show_count: int
    people: list[SchedulePersonOut]


class ScheduleCopyIn(BaseModel):
    # Cualquier día de la semana DESTINO; se copia la semana anterior.
    week_of: date


class ScheduleCopyOut(BaseModel):
    week_start: date
    copied: int
    skipped: int
