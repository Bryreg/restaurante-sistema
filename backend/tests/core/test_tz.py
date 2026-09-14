"""Fecha operativa: nunca derivada de un timestamp UTC sin pasar por la hora
de corte de la sede (SPEC-NEGOCIO §3.1, "el bug que este repo ya sufrió
cuatro veces")."""

from __future__ import annotations

from datetime import date, datetime, timezone

import pytest

from app.core.tz import business_date_for, to_bogota


def test_before_cutoff_belongs_to_previous_business_day() -> None:
    # 01:00 hora Bogotá (UTC-5) del 15 de enero -> 06:00 UTC del 15.
    instant = datetime(2026, 1, 15, 6, 0, tzinfo=timezone.utc)
    assert business_date_for(instant, cutoff_hour=6) == date(2026, 1, 14)


def test_after_cutoff_belongs_to_same_business_day() -> None:
    # 07:00 hora Bogotá del 15 -> 12:00 UTC del 15.
    instant = datetime(2026, 1, 15, 12, 0, tzinfo=timezone.utc)
    assert business_date_for(instant, cutoff_hour=6) == date(2026, 1, 15)


def test_exactly_at_cutoff_belongs_to_same_day() -> None:
    # 06:00 hora Bogotá del 15 -> 11:00 UTC del 15.
    instant = datetime(2026, 1, 15, 11, 0, tzinfo=timezone.utc)
    assert business_date_for(instant, cutoff_hour=6) == date(2026, 1, 15)


def test_to_bogota_requires_aware_datetime() -> None:
    with pytest.raises(ValueError):
        to_bogota(datetime(2026, 1, 1))
