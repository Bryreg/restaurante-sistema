"""Contrato numérico de horas trabajadas (jornada, recargos, nómina).

Las horas **no son pesos** (`app.core.money`) ni cantidades de insumo
(`app.core.quantity`): son una magnitud nueva que introduce
`features/fase-3-dinero-control/spec.md § 2` (T3, `backend-nomina-propinas`),
y por el mismo mandato que fijó `QTY_SCALE`/`COST_SCALE` ("un recargo
calculado con `float` es un error que nadie encuentra"), acá se fija su
escala entera, de una vez, para que ningún cálculo de jornada o de recargo
la reinvente.

Constante:
    HOURS_SCALE = 60   jornada: entero en MINUTOS (60 minutos = 1 hora)

**Por qué minutos y no décimas/centésimas de hora en base 10.** El dato de
origen (`app.shifts.models.ShiftRoster.in_at`/`.out_at`/`.pauses`) son
instantes reales de reloj de pared; la unidad en la que dos instantes se
restan sin perder nada ni inventar redondeo es el minuto — ningún turno se
abre o cierra a mitad de segundo en la práctica, y es la granularidad que
cualquier planilla de nómina colombiana ya usa. Toda la matemática de
jornada y de recargos (horas ordinarias, nocturnas, dominicales, festivas,
extras, y su valor en pesos) se acumula en minutos enteros — o en
"peso-minutos" enteros, ver `wage_minutes` — hasta el borde; nunca en
`float`, nunca en decimal de hora redondeado a mitad de cálculo.

**Cómo se publica una hora (mismo principio que separa `format_cost_micros`
de la matemática de `app.core.quantity`).** `format_hours` es la única
función que convierte minutos a un texto decimal, y es sólo para
MOSTRAR/publicar en la API — nunca se vuelve a leer ese texto para seguir
calculando. La matemática de plata de este dominio (`app.payroll.service`)
sigue en minutos enteros (o en peso-minutos) hasta que cierra un total, y
ahí usa `wage_minutes`/`minutes_pay_to_pesos`, el mismo patrón de
"acumular fino, redondear una sola vez al borde" que
`app.core.quantity.line_cost_micros`/`micros_to_pesos` ya usa para costos.
"""

from __future__ import annotations

from datetime import datetime
from decimal import ROUND_HALF_UP, Decimal

HOURS_SCALE = 60


def minutes_between(start: datetime, end: datetime) -> int:
    """Minutos enteros entre dos instantes aware (`end - start`).

    Trunca hacia abajo a segundos completos antes de dividir: una jornada
    nunca se infla por una fracción de segundo del reloj. `end` anterior o
    igual a `start` da `0` — nunca minutos negativos: un dato así es un bug
    de captura, no una jornada al revés, y corresponde tratarlo aparte, no
    dejarlo colarse como una resta negativa en un total.
    """
    if start.tzinfo is None or end.tzinfo is None:
        raise ValueError("start y end tienen que ser aware (usá clock.now_utc() / UTCDateTime)")
    if end <= start:
        return 0
    delta_seconds = int((end - start).total_seconds())
    return delta_seconds // 60


def format_hours(minutes: int) -> str:
    """Minutos -> texto decimal de horas, con dos decimales, SOLO para
    publicar/mostrar. `90 -> "1.50"`, `-30 -> "-0.50"`, `0 -> "0.00"`.

    Nunca se usa para volver a calcular: ver el docstring del módulo.
    """
    quant = (Decimal(minutes) / Decimal(HOURS_SCALE)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    return str(quant)


def wage_minutes(minutes: int, hourly_wage_pesos: int) -> int:
    """Pesos-minuto de pagar `minutes` minutos a `hourly_wage_pesos` por
    hora: `minutes * hourly_wage_pesos`, sin dividir todavía. Exacto, sin
    redondeo — el equivalente de `app.core.quantity.line_cost_micros` para
    esta escala: se sigue acumulando en esta unidad fina a lo largo de TODA
    una liquidación (varias piezas de jornada, varias categorías) y recién
    se redondea a pesos una sola vez, al cerrar cada total, con
    `minutes_pay_to_pesos`.
    """
    return minutes * hourly_wage_pesos


def minutes_pay_to_pesos(peso_minutes: int) -> int:
    """Redondeo half-up de peso-minutos (`wage_minutes`) a pesos enteros,
    dividiendo por `HOURS_SCALE`. Acotada a TOTALES ya cerrados de una
    liquidación (pago base, un recargo, el total de una línea) — nunca a
    mitad de una cadena de cálculo, el mismo criterio que
    `app.core.quantity.micros_to_pesos` documenta para costos.
    """
    if peso_minutes >= 0:
        return (peso_minutes + HOURS_SCALE // 2) // HOURS_SCALE
    return -((-peso_minutes + HOURS_SCALE // 2) // HOURS_SCALE)
