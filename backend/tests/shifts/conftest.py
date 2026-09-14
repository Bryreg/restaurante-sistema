"""Fixtures propias del dominio de caja.

Usa las fixtures compartidas de `tests/conftest.py` (`device_client`,
`identify`, `employees`, `store`, `clock`, `set_feature`, ...) — no las
redefine, solo agrega las que necesitan sus propios tests
(`features/fase-1a-cimientos/CONTRATO-INTERNO.md §3`).
"""

from __future__ import annotations

import uuid
from typing import Any, Callable

import pytest

DEFAULT_OPENING_TOTAL = 200_000  # == StoreCashSettings.opening_cash_fixed por defecto


def idem() -> dict[str, str]:
    return {"Idempotency-Key": str(uuid.uuid4())}


@pytest.fixture
def open_shift(device_client: Any, identify: Any, employees: dict) -> Callable[..., dict]:
    """Abre un turno en `store` y devuelve el JSON de `POST /shifts/open`.

    Por defecto la base contada coincide con `opening_cash_fixed` (200.000 en
    denominaciones de 50.000) para no necesitar causa; los tests que quieren
    una diferencia pasan `total`/`denominations`/`opening_cause` explícitos.
    """

    def _open(
        *,
        cash_responsible: Any = None,
        total: int = DEFAULT_OPENING_TOTAL,
        denominations: list[dict] | None = None,
        cash_reserve: int = 0,
        opening_cause: str | None = None,
        opening_note: str | None = None,
    ) -> dict:
        responsible = cash_responsible or employees["cashier"]
        identify(device_client, responsible)

        payload: dict[str, Any] = {
            "opening_cash": {
                "denominations": denominations or [{"value": 50000, "count": total // 50000}],
                "total": total,
            },
            "cash_reserve": cash_reserve,
            "cash_responsible_id": responsible.id,
        }
        if opening_cause is not None:
            payload["opening_cause"] = opening_cause
        if opening_note is not None:
            payload["opening_note"] = opening_note

        resp = device_client.post("/api/v1/shifts/open", json=payload, headers=idem())
        assert resp.status_code in (200, 201), resp.text
        return resp.json()

    return _open
