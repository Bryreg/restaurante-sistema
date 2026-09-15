"""Fixtures propias del dominio de caja.

Usa las fixtures compartidas de `tests/conftest.py` (`device_client`,
`identify`, `employees`, `store`, `clock`, `set_feature`, ...) — no las
redefine, solo agrega las que necesitan sus propios tests
(`features/fase-1a-cimientos/CONTRATO-INTERNO.md §3`).
"""

from __future__ import annotations

import uuid
from datetime import date
from typing import Any, Callable

import pytest
from sqlalchemy.orm import Session

from app.core import clock as clock_module
from app.fiscal import service as fiscal_service
from app.fiscal.models import FiscalDocumentType
from app.stores.models import Store

DEFAULT_OPENING_TOTAL = 200_000  # == StoreCashSettings.opening_cash_fixed por defecto

# Prefijo corto por tipo (`fiscal_ranges.prefix` es `String(10)`). Duplicada a
# propósito de `tests/payments`, `tests/fiscal` y `tests/reports`: cada carpeta
# arma su propia base sin imports cruzados entre directorios hermanos.
_RANGE_PREFIX: dict[FiscalDocumentType, str] = {
    FiscalDocumentType.POS_EQUIVALENT: "POS",
    FiscalDocumentType.INVOICE: "FE",
    FiscalDocumentType.ADJUSTMENT_NOTE: "NA",
    FiscalDocumentType.CREDIT_NOTE: "NC",
    FiscalDocumentType.DEBIT_NOTE: "ND",
}


def idem() -> dict[str, str]:
    return {"Idempotency-Key": str(uuid.uuid4())}


@pytest.fixture(autouse=True)
def default_fiscal_range(db: Session, store: Store) -> None:
    """Desde 1b-2 cobrar exige un rango de numeración vigente: sin esto el E2E
    de `test_sales_totals_e2e.py` —que cobra de verdad por la API para probar
    el gancho hacia el esperado del turno— muere en `400 NO_FISCAL_RANGE`.
    Se carga el rango en vez de apagar `fiscal.dee_pos` para que el test siga
    ejercitando el camino real: cobro → documento emitido → totales del turno.
    """
    now = clock_module.now_utc()
    for document_type, prefix in _RANGE_PREFIX.items():
        fiscal_service.create_range(
            db,
            organization_id=store.organization_id,
            store_id=store.id,
            document_type=document_type,
            prefix=prefix,
            from_number=1,
            to_number=999_999_999,
            resolution_number="18760000001",
            resolution_date=date(2020, 1, 1),
            valid_from=date(2020, 1, 1),
            valid_until=date(2099, 12, 31),
            technical_key="fixture-technical-key",
            now=now,
        )
    db.commit()


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
