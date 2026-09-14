"""Denominaciones colombianas: dinero siempre entero, nunca flotante."""

from __future__ import annotations

import pytest

from app.core.errors import AppError
from app.core.money import Denomination, sum_denominations, validate_denominations


def test_sum_denominations() -> None:
    denoms = [Denomination(value=10000, count=2), Denomination(value=500, count=1)]
    assert sum_denominations(denoms) == 20_500


def test_validate_denominations_ok_returns_total() -> None:
    denoms = [Denomination(value=100000, count=2), Denomination(value=50000, count=0)]
    assert validate_denominations(denoms, 200_000) == 200_000


def test_validate_denominations_mismatch() -> None:
    denoms = [Denomination(value=1000, count=2)]
    with pytest.raises(AppError) as exc_info:
        validate_denominations(denoms, 2500)
    assert exc_info.value.code == "DENOMINATIONS_MISMATCH"


def test_validate_denominations_invalid_value() -> None:
    denoms = [Denomination(value=1234, count=1)]
    with pytest.raises(AppError) as exc_info:
        validate_denominations(denoms, 1234)
    assert exc_info.value.code == "DENOMINATION_INVALID"


def test_validate_denominations_negative_count() -> None:
    denoms = [Denomination(value=1000, count=-1)]
    with pytest.raises(AppError) as exc_info:
        validate_denominations(denoms, -1000)
    assert exc_info.value.code == "DENOMINATION_INVALID"
