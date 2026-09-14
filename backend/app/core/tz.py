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
