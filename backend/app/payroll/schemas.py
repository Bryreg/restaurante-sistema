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


class HoursOut(BaseModel):
    store_id: int
    date_from: date
    date_to: date
    rows: list[HoursRowOut]
    available: bool
    reason: str | None


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
    id: int
    store_id: int
    holiday_date: date
    name: str


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
PayrollCalculationMethodLiteral = Literal["additive_surcharges"]


class SurchargeTableUsedOut(BaseModel):
    valid_from: date
    night_start_hour: int
    night_end_hour: int
    night_surcharge_bp: int
    sunday_holiday_surcharge_bp: int
    overtime_surcharge_bp: int
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
    # `additive_surcharges` paga, por cada minuto, la base más los recargos
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
