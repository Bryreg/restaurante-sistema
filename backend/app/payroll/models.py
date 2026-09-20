"""Modelos de `payroll`: jornada, tablas de recargos con vigencia,
liquidación de nómina y configuración del reparto de propinas
(SPEC-NEGOCIO §6.2 y §7; `features/fase-3-dinero-control/spec.md § 2`, T3).

Convenciones heredadas (`docs/CONTEXTO-AGENTES.md §3/§4/§9`):
- Dinero en `Integer`, pesos enteros. Nunca `float`.
- Horas en `Integer`, minutos enteros (`app.core.hours.HOURS_SCALE`). Nunca
  `float`.
- Enums `native_enum=False` (`_enum`), comparados por valor: la columna es un
  `VARCHAR` plano en los dos motores, sin `CHECK` que recrear.
- Todo modelo lleva `organization_id` y `store_id`.
- Todo lo que registra o cobra una persona guarda `employee_id` (FK real) +
  `employee_name` (copia congelada); los empleados se desactivan, nunca se
  borran (`AGENTS.md`).
- **Nada financiero se borra**: acá no hay ningún `DELETE` de negocio — una
  tabla de recargos vieja, una liquidación vieja o un reparto de propinas
  vivo (en `app.shifts.models.TipPayout`, que este dominio no toca) quedan
  para siempre; corregir un dato se hace agregando una versión nueva con
  `valid_from` más reciente, nunca pisando la anterior.

**LO QUE ESTE DOMINIO NUNCA MODELA (la línea que no se cruza, SPEC-NEGOCIO
§3.2 y §11.16; CST art. 149).** Ninguna tabla ni ningún campo de acá
representa una deuda del empleado ni un descuento de nómina por un faltante
de caja. `PayrollRunLine` no tiene, y no puede tener, una columna así — ver
`docs/CONTEXTO-AGENTES.md §14 (7)` y `tests/audit/test_cash_invariants.py`
(que ya barre las respuestas de TURNO) más
`tests/audit/test_payroll_invariants.py` (que barre las de nómina).

**LO QUE YA EXISTE Y NO SE REESCRIBE ACÁ** (`app.shifts.models`):
`ShiftRoster` (la jornada capturada: `in_at`/`out_at`/`pauses`) y
`TipPayout`/`TipPayoutDistribution` (el libro del reparto ya confirmado,
escrito exclusivamente por `app.shifts.tips.register_tip_payout`). Este
dominio sólo LEE el primero y NUNCA escribe en ninguno de los tres — ver
`service.py` para la llave anti doble conteo (propina vs venta).
"""

from __future__ import annotations

import enum
from datetime import date, datetime

import sqlalchemy as sa
from sqlalchemy import CheckConstraint, ForeignKey, Index, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base, UTCDateTime

ENUM_LENGTH = 32


def _enum(pyenum: type[enum.Enum], *, length: int = ENUM_LENGTH) -> sa.Enum:
    return sa.Enum(pyenum, native_enum=False, length=length, validate_strings=True)


# ---------------------------------------------------------------------------
# Enums.
# ---------------------------------------------------------------------------


class TipDistributionMethod(str, enum.Enum):
    """D-3 (`features/fase-3-dinero-control/spec.md § 1`): los tres criterios
    de §6.2, todos construidos, configurables por sede. `BY_HOURS` es el
    default — decisión ya tomada, no se renegocia."""

    EQUAL_SHARES = "equal_shares"
    BY_HOURS = "by_hours"
    BY_AREA = "by_area"


# ---------------------------------------------------------------------------
# Tablas legales con vigencia (§7): nunca quemadas en código. Rige la de
# mayor `valid_from` <= la fecha CONSULTADA (mismo patrón que
# `app.stores.models.StoreFiscalConfig`) — nunca la de hoy.
# ---------------------------------------------------------------------------


class SurchargeTable(Base):
    """Una vigencia completa de la tabla de recargos de una sede: ventana
    nocturna, recargo nocturno, recargo dominical/festivo, recargo de hora
    extra y jornada ordinaria semanal. Cada fila es una FOTO completa (no un
    delta por campo) — igual que `StoreFiscalConfig`: la vigente para una
    fecha es la de mayor `valid_from <= fecha`, y una liquidación vieja
    recalcula con la fila que regía en su época, nunca con la de hoy.

    Valores de la ley, citados en `features/fase-3-dinero-control/spec.md
    § 2` (T3): ventana nocturna 19:00-06:00 desde dic-2025; recargo
    dominical/festivo 80/90/100 % en 2025/2026/2027 (Ley 2466 de 2025);
    jornada ordinaria semanal 42 h desde jul-2026 (Ley 2101 de 2021). El
    recargo nocturno (35 %) y el de hora extra (25 %) no tienen una fecha de
    cambio citada en el pedido; quedan igual de parametrizados por si la ley
    cambia, con el valor vigente hoy como default de las vigencias
    sembradas por la migración (`0020_payroll.py`) — ver el entregable,
    sección `gaps`, para los valores HISTÓRICOS anteriores a los tres
    puntos de cambio citados, que el pedido no fijó y que acá se completan
    con un valor razonable, declarado como supuesto.
    """

    __tablename__ = "payroll_surcharge_tables"

    id: Mapped[int] = mapped_column(primary_key=True)
    organization_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), index=True)
    store_id: Mapped[int] = mapped_column(ForeignKey("stores.id"), index=True)

    valid_from: Mapped[date] = mapped_column(sa.Date)

    # Hora local de Bogotá (0-23). `night_end_hour < night_start_hour`
    # significa que la ventana cruza medianoche (el caso real: 19 -> 6).
    night_start_hour: Mapped[int] = mapped_column(sa.Integer)
    night_end_hour: Mapped[int] = mapped_column(sa.Integer)

    night_surcharge_bp: Mapped[int] = mapped_column(sa.Integer)
    sunday_holiday_surcharge_bp: Mapped[int] = mapped_column(sa.Integer)
    overtime_surcharge_bp: Mapped[int] = mapped_column(sa.Integer)

    # Horas enteras (no hace falta media hora acá: la jornada legal siempre
    # se fijó en un número entero de horas semanales).
    weekly_ordinary_hours: Mapped[int] = mapped_column(sa.Integer)

    created_at: Mapped[datetime] = mapped_column(UTCDateTime())
    created_by_employee_id: Mapped[int | None] = mapped_column(ForeignKey("employees.id"), nullable=True)
    created_by_employee_name: Mapped[str | None] = mapped_column(sa.String(200), nullable=True)

    __table_args__ = (
        UniqueConstraint("store_id", "valid_from", name="uq_payroll_surcharge_store_valid_from"),
        CheckConstraint("night_start_hour BETWEEN 0 AND 23", name="ck_payroll_surcharge_night_start_range"),
        CheckConstraint("night_end_hour BETWEEN 0 AND 23", name="ck_payroll_surcharge_night_end_range"),
        CheckConstraint("night_surcharge_bp >= 0", name="ck_payroll_surcharge_night_bp_nonneg"),
        CheckConstraint("sunday_holiday_surcharge_bp >= 0", name="ck_payroll_surcharge_sunday_bp_nonneg"),
        CheckConstraint("overtime_surcharge_bp >= 0", name="ck_payroll_surcharge_overtime_bp_nonneg"),
        CheckConstraint("weekly_ordinary_hours > 0", name="ck_payroll_surcharge_weekly_hours_positive"),
        Index("ix_payroll_surcharge_store_valid_from", "store_id", "valid_from"),
    )


class PayrollHoliday(Base):
    """Un festivo colombiano (Ley Emiliani incluida: las fechas ya vienen
    corridas al lunes cuando corresponde) declarado explícitamente por la
    sede — no hay calendario perpetuo calculable sin una librería de
    festivos que este pedido no trae, así que **se declara, no se
    adivina** (mismo espíritu que "nunca quemado en código": una fecha mal
    calculada sería peor que pedirla). No tiene vigencia: una fecha es un
    hecho, no una tasa que cambia con la lectura de la ley."""

    __tablename__ = "payroll_holidays"

    id: Mapped[int] = mapped_column(primary_key=True)
    organization_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), index=True)
    store_id: Mapped[int] = mapped_column(ForeignKey("stores.id"), index=True)

    holiday_date: Mapped[date] = mapped_column(sa.Date)
    name: Mapped[str] = mapped_column(sa.String(200))

    created_at: Mapped[datetime] = mapped_column(UTCDateTime())

    __table_args__ = (UniqueConstraint("store_id", "holiday_date", name="uq_payroll_holiday_store_date"),)


# ---------------------------------------------------------------------------
# Configuración de esta sede que NO es una tabla legal: tarifa por hora y
# área de cada persona. Vive ACÁ, no en `app.auth.models.Employee` (no es
# territorio de este pedido) ni en `app.stores.models` (precedente ya
# sentado por 2a/2b/T1/T2: la configuración de un dominio vive en su propio
# paquete).
# ---------------------------------------------------------------------------


class PayrollWageRate(Base):
    """Tarifa por hora de una persona, CON vigencia: mismo patrón que
    `SurchargeTable` — una liquidación vieja usa la tarifa que regía en su
    época, no la de hoy. `hourly_wage_pesos` es la ficha base (sin
    recargos); los recargos se calculan aparte en `service.py`."""

    __tablename__ = "payroll_wage_rates"

    id: Mapped[int] = mapped_column(primary_key=True)
    organization_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), index=True)
    store_id: Mapped[int] = mapped_column(ForeignKey("stores.id"), index=True)

    employee_id: Mapped[int] = mapped_column(ForeignKey("employees.id"), index=True)
    employee_name: Mapped[str] = mapped_column(sa.String(200))

    hourly_wage_pesos: Mapped[int] = mapped_column(sa.Integer)
    valid_from: Mapped[date] = mapped_column(sa.Date)

    created_at: Mapped[datetime] = mapped_column(UTCDateTime())
    created_by_employee_id: Mapped[int | None] = mapped_column(ForeignKey("employees.id"), nullable=True)
    created_by_employee_name: Mapped[str | None] = mapped_column(sa.String(200), nullable=True)

    __table_args__ = (
        UniqueConstraint("store_id", "employee_id", "valid_from", name="uq_payroll_wage_employee_valid_from"),
        CheckConstraint("hourly_wage_pesos > 0", name="ck_payroll_wage_positive"),
        Index("ix_payroll_wage_store_employee", "store_id", "employee_id"),
    )


class PayrollAreaAssignment(Base):
    """Área de una persona, para el reparto de propinas `by_area`. Sin
    vigencia a propósito (no es una tasa legal; es una clasificación
    operativa que se corrige pisando la última, con auditoría del cambio —
    ver `service.set_employee_area`), a diferencia de `PayrollWageRate`."""

    __tablename__ = "payroll_area_assignments"

    id: Mapped[int] = mapped_column(primary_key=True)
    organization_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), index=True)
    store_id: Mapped[int] = mapped_column(ForeignKey("stores.id"), index=True)

    employee_id: Mapped[int] = mapped_column(ForeignKey("employees.id"), index=True)
    employee_name: Mapped[str] = mapped_column(sa.String(200))
    area: Mapped[str] = mapped_column(sa.String(100))

    updated_at: Mapped[datetime] = mapped_column(UTCDateTime())
    updated_by_employee_id: Mapped[int | None] = mapped_column(ForeignKey("employees.id"), nullable=True)

    __table_args__ = (UniqueConstraint("store_id", "employee_id", name="uq_payroll_area_store_employee"),)


class TipDistributionSettings(Base):
    """`tip_distribution_method` de D-3 — vive ACÁ, no en
    `app.stores.models`, precisamente para que cuatro agentes en paralelo no
    se peleen ese archivo (`features/fase-3-dinero-control/spec.md § 3`).
    Una fila por sede; default `by_hours` si nunca se configuró (ver
    `service.get_tip_settings`, que devuelve el default sin necesitar fila
    creada de antemano)."""

    __tablename__ = "payroll_tip_distribution_settings"

    store_id: Mapped[int] = mapped_column(ForeignKey("stores.id"), primary_key=True)
    method: Mapped[TipDistributionMethod] = mapped_column(
        _enum(TipDistributionMethod, length=16), default=TipDistributionMethod.BY_HOURS
    )
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime())
    updated_by_employee_id: Mapped[int | None] = mapped_column(ForeignKey("employees.id"), nullable=True)


# ---------------------------------------------------------------------------
# Liquidación de nómina del período. Es un DOCUMENTO cerrado (como una
# recepción o un cierre de turno), no un saldo derivable: `POST
# /admin/payroll/runs` la calcula y la deja escrita de una vez —
# "derivar en vez de almacenar" (§6.1) aplica a saldos vivos (por
# consignar, esperado), no a la liquidación misma, que es precisamente el
# acto de cerrar un período con las tablas que regían.
# ---------------------------------------------------------------------------


class PayrollRun(Base):
    """Una liquidación de nómina de un período `[date_from, date_to]`
    (fecha de negocio). `tables_used` congela, como snapshot, cada tabla de
    recargos efectivamente aplicada (una o más si el período cruza un
    cambio de vigencia) — así la respuesta siempre puede "nombrar qué tabla
    vigente usó" sin tener que volver a resolver la vigencia después. Nunca
    se borra ni se recalcula en el lugar: una corrección es una liquidación
    nueva."""

    __tablename__ = "payroll_runs"

    id: Mapped[int] = mapped_column(primary_key=True)
    organization_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), index=True)
    store_id: Mapped[int] = mapped_column(ForeignKey("stores.id"), index=True)

    date_from: Mapped[date] = mapped_column(sa.Date)
    date_to: Mapped[date] = mapped_column(sa.Date)

    # [{"valid_from": iso, "night_start_hour": int, "night_end_hour": int,
    #   "night_surcharge_bp": int, "sunday_holiday_surcharge_bp": int,
    #   "overtime_surcharge_bp": int, "weekly_ordinary_hours": int}, ...]
    tables_used: Mapped[list] = mapped_column(sa.JSON, default=list)

    total_amount: Mapped[int | None] = mapped_column(sa.Integer, nullable=True)
    all_available: Mapped[bool] = mapped_column(sa.Boolean, default=True)
    reason: Mapped[str | None] = mapped_column(sa.Text, nullable=True)

    computed_at: Mapped[datetime] = mapped_column(UTCDateTime())
    computed_by_employee_id: Mapped[int | None] = mapped_column(ForeignKey("employees.id"), nullable=True)
    computed_by_employee_name: Mapped[str | None] = mapped_column(sa.String(200), nullable=True)

    __table_args__ = (
        CheckConstraint("date_from <= date_to", name="ck_payroll_run_range"),
        CheckConstraint("total_amount IS NULL OR total_amount >= 0", name="ck_payroll_run_total_nonneg"),
        Index("ix_payroll_run_store_range", "store_id", "date_from", "date_to"),
    )


class PayrollRunLine(Base):
    """Una línea de la liquidación: la jornada y la plata de UNA persona.

    **Nunca** un renglón de deuda ni de descuento (ver el docstring del
    módulo): sólo horas trabajadas y lo que la sede le paga por ellas.
    `*_pay`/`*_surcharge`/`total` son `NULL` (nunca `0` mudo) cuando la
    persona no tiene `PayrollWageRate` vigente para parte o todo el
    período — `pay_reason` lo explica.
    """

    __tablename__ = "payroll_run_lines"

    id: Mapped[int] = mapped_column(primary_key=True)
    run_id: Mapped[int] = mapped_column(ForeignKey("payroll_runs.id"), index=True)

    employee_id: Mapped[int] = mapped_column(ForeignKey("employees.id"), index=True)
    employee_name: Mapped[str] = mapped_column(sa.String(200))

    ordinary_minutes: Mapped[int] = mapped_column(sa.Integer, default=0)
    night_minutes: Mapped[int] = mapped_column(sa.Integer, default=0)
    sunday_minutes: Mapped[int] = mapped_column(sa.Integer, default=0)
    holiday_minutes: Mapped[int] = mapped_column(sa.Integer, default=0)
    overtime_minutes: Mapped[int] = mapped_column(sa.Integer, default=0)

    base_pay: Mapped[int | None] = mapped_column(sa.Integer, nullable=True)
    night_surcharge: Mapped[int | None] = mapped_column(sa.Integer, nullable=True)
    sunday_holiday_surcharge: Mapped[int | None] = mapped_column(sa.Integer, nullable=True)
    overtime_pay: Mapped[int | None] = mapped_column(sa.Integer, nullable=True)
    total: Mapped[int | None] = mapped_column(sa.Integer, nullable=True)
    pay_reason: Mapped[str | None] = mapped_column(sa.Text, nullable=True)

    __table_args__ = (
        CheckConstraint("ordinary_minutes >= 0", name="ck_payroll_line_ordinary_nonneg"),
        CheckConstraint("night_minutes >= 0", name="ck_payroll_line_night_nonneg"),
        CheckConstraint("sunday_minutes >= 0", name="ck_payroll_line_sunday_nonneg"),
        CheckConstraint("holiday_minutes >= 0", name="ck_payroll_line_holiday_nonneg"),
        CheckConstraint("overtime_minutes >= 0", name="ck_payroll_line_overtime_nonneg"),
        CheckConstraint("total IS NULL OR total >= 0", name="ck_payroll_line_total_nonneg"),
        Index("ix_payroll_run_lines_run_employee", "run_id", "employee_id"),
    )
