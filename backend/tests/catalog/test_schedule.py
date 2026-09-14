"""`combo_active_now`/`validate_schedule` a nivel de función pura: franjas
normales, que cruzan medianoche, y validación de `days`/`from`/`to`."""

from __future__ import annotations

from datetime import date, datetime, timezone

import pytest

from app.catalog.service import combo_active_now, validate_schedule
from app.core.errors import AppError

MONDAY = date(2026, 1, 19)
FRIDAY = date(2026, 1, 23)
SATURDAY = date(2026, 1, 24)


def test_calendar_sanity() -> None:
    # Si esto falla, las fechas de referencia de este archivo están mal
    # elegidas (no es el comportamiento bajo prueba).
    assert MONDAY.weekday() == 0
    assert FRIDAY.weekday() == 4
    assert SATURDAY.weekday() == 5


def test_active_now_within_same_day_window() -> None:
    schedule = {"days": [0], "from": "11:30", "to": "15:00"}
    # Bogotá 12:00 lunes == UTC 17:00 lunes (Bogotá = UTC-5, sin horario de verano).
    inside = datetime(2026, 1, 19, 17, 0, tzinfo=timezone.utc)
    assert combo_active_now(schedule, inside) is True


def test_active_now_false_outside_window_same_day() -> None:
    schedule = {"days": [0], "from": "11:30", "to": "15:00"}
    after = datetime(2026, 1, 19, 21, 0, tzinfo=timezone.utc)  # Bogotá 16:00 lunes
    assert combo_active_now(schedule, after) is False


def test_active_now_false_on_a_day_not_listed() -> None:
    schedule = {"days": [0], "from": "11:30", "to": "15:00"}
    tuesday_same_hour = datetime(2026, 1, 20, 17, 0, tzinfo=timezone.utc)  # martes 12:00
    assert combo_active_now(schedule, tuesday_same_hour) is False


def test_active_now_crossing_midnight_before_midnight() -> None:
    schedule = {"days": [4], "from": "22:00", "to": "02:00"}  # viernes 22:00 a sábado 02:00
    friday_2300 = datetime(2026, 1, 24, 4, 0, tzinfo=timezone.utc)  # Bogotá viernes 23:00
    assert combo_active_now(schedule, friday_2300) is True


def test_active_now_crossing_midnight_after_midnight() -> None:
    schedule = {"days": [4], "from": "22:00", "to": "02:00"}
    saturday_0100 = datetime(2026, 1, 24, 6, 0, tzinfo=timezone.utc)  # Bogotá sábado 01:00
    assert combo_active_now(schedule, saturday_0100) is True


def test_active_now_crossing_midnight_outside_window() -> None:
    schedule = {"days": [4], "from": "22:00", "to": "02:00"}
    saturday_0300 = datetime(2026, 1, 24, 8, 0, tzinfo=timezone.utc)  # Bogotá sábado 03:00
    assert combo_active_now(schedule, saturday_0300) is False


def test_validate_schedule_rejects_bad_days() -> None:
    with pytest.raises(AppError) as excinfo:
        validate_schedule({"days": [7], "from": "10:00", "to": "12:00"})
    assert excinfo.value.code == "VALIDATION_ERROR"


def test_validate_schedule_rejects_bad_time_format() -> None:
    with pytest.raises(AppError):
        validate_schedule({"days": [0], "from": "10h00", "to": "12:00"})


def test_validate_schedule_normalizes_days() -> None:
    result = validate_schedule({"days": [2, 0, 2], "from": "10:00", "to": "12:00"})
    assert result["days"] == [0, 2]
