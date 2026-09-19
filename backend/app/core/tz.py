"""Zona horaria de negocio y fecha operativa.

La fecha operativa (`business_date`) es un dato propio, **nunca** derivado con
`toISOString().slice(0, 10)` ni con `new Date("YYYY-MM-DD")` en el frontend, ni
con `datetime.utcnow().date()` acá: se calcula con la hora de corte de la sede.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from app.core import clock

BOGOTA = ZoneInfo("America/Bogota")


def to_bogota(instant_utc: datetime) -> datetime:
    """Convierte un instante aware (cualquier zona) a hora local de Bogotá."""
    if instant_utc.tzinfo is None:
        raise ValueError("instant_utc debe ser timezone-aware")
    return instant_utc.astimezone(BOGOTA)


def business_date_for(instant_utc: datetime, cutoff_hour: int) -> date:
    """Fecha de negocio de un instante, según la hora de corte de la sede.

    Si la hora local es anterior a `cutoff_hour`, el instante todavía
    pertenece al día operativo anterior (turno de madrugada / cruce de
    medianoche). Ej.: corte 06:00, venta a la 01:00 del 15 -> día operativo 14.
    """
    local = to_bogota(instant_utc)
    business_day = local.date()
    if local.hour < cutoff_hour:
        business_day = business_day - timedelta(days=1)
    return business_day


def today_business_date(cutoff_hour: int) -> date:
    """Fecha de negocio "ahora", según el reloj del sistema (mockeable en tests)."""
    return business_date_for(clock.now_utc(), cutoff_hour)


def from_bogota_wall_clock(local_naive: datetime) -> datetime:
    """Una hora de pared que escribió una persona -> instante aware en UTC.

    Es el inverso de `to_bogota`, y existe por un defecto real: un
    `<input type="datetime-local">` entrega `"2026-09-19T03:14"`, **sin
    zona**. Pydantic lo acepta como `datetime` naive, y `UTCDateTime`
    (`app/core/db.py`) lo rechaza al guardarlo — así que el usuario recibía
    un `500` y el dato no entraba. Pasaba en el pago a proveedor (2b) y en la
    hora prometida de un pedido para llevar (1b); ninguna suite lo vio porque
    los tests arman el JSON a mano y escriben la `Z`.

    La zona la pone el SERVIDOR, nunca el navegador: la regla dura de
    `AGENTS.md` sobre fecha de negocio existe precisamente porque el reloj y
    la zona del dispositivo no son confiables. Un `datetime` que ya viene
    aware se respeta tal cual.
    """
    if local_naive.tzinfo is not None:
        return local_naive.astimezone(ZoneInfo("UTC"))
    return local_naive.replace(tzinfo=BOGOTA).astimezone(ZoneInfo("UTC"))
