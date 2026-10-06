"""Festivos de Colombia, calculados (Ley 51 de 1983, «Ley Emiliani»).

Tres grupos:

- **Fijos**, no se corren: 1 de enero, 1 de mayo, 20 de julio, 7 de agosto,
  8 y 25 de diciembre.
- **Trasladables al lunes siguiente** (si no caen lunes): Reyes (6-ene),
  San José (19-mar), San Pedro y San Pablo (29-jun), Asunción (15-ago),
  Día de la Raza (12-oct), Todos los Santos (1-nov), Independencia de
  Cartagena (11-nov).
- **Según la Pascua**: Jueves y Viernes Santo (no se corren), Ascensión
  (+43 días), Corpus Christi (+64) y Sagrado Corazón (+71), ya en lunes.

La Pascua sale del algoritmo anónimo gregoriano (Meeus/Jones/Butcher).
"""

from __future__ import annotations

from datetime import date, timedelta


def easter_sunday(year: int) -> date:
    a = year % 19
    b, c = divmod(year, 100)
    d, e = divmod(b, 4)
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i, k = divmod(c, 4)
    l = (32 + 2 * e + 2 * i - h - k) % 7  # noqa: E741
    m = (a + 11 * h + 22 * l) // 451
    month, day = divmod(h + l - 7 * m + 114, 31)
    return date(year, month, day + 1)


def _next_monday(d: date) -> date:
    return d + timedelta(days=(7 - d.weekday()) % 7)


_FIXED: list[tuple[int, int, str]] = [
    (1, 1, "Año Nuevo"),
    (5, 1, "Día del Trabajo"),
    (7, 20, "Día de la Independencia"),
    (8, 7, "Batalla de Boyacá"),
    (12, 8, "Inmaculada Concepción"),
    (12, 25, "Navidad"),
]

_MOVABLE: list[tuple[int, int, str]] = [
    (1, 6, "Reyes Magos"),
    (3, 19, "San José"),
    (6, 29, "San Pedro y San Pablo"),
    (8, 15, "Asunción de la Virgen"),
    (10, 12, "Día de la Raza"),
    (11, 1, "Todos los Santos"),
    (11, 11, "Independencia de Cartagena"),
]

_EASTER_BASED: list[tuple[int, str]] = [
    (-3, "Jueves Santo"),
    (-2, "Viernes Santo"),
    (43, "Ascensión del Señor"),
    (64, "Corpus Christi"),
    (71, "Sagrado Corazón"),
]


def colombian_holidays(year: int) -> dict[date, str]:
    """Fecha → nombre de los festivos del año (18, o 17 cuando dos caen el
    mismo lunes, como San Pedro y Sagrado Corazón en 2025)."""
    out: dict[date, str] = {}
    for month, day, name in _FIXED:
        out[date(year, month, day)] = name
    for month, day, name in _MOVABLE:
        out[_next_monday(date(year, month, day))] = name
    easter = easter_sunday(year)
    for offset, name in _EASTER_BASED:
        out[easter + timedelta(days=offset)] = name
    return dict(sorted(out.items()))
