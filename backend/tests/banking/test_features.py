"""Toda capacidad detrás de su función, con `400 FEATURE_DISABLED`, probada
encendida y apagada; la dependencia (`money.bank` -> `money.deposits`) se
valida ANTES que el gate de sede (`docs/CONTEXTO-AGENTES.md §6`, error
repetido nº6).
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from fastapi.testclient import TestClient

from tests.banking.conftest import today_business_date

API = "/api/v1"


def test_deposits_endpoints_require_money_deposits_feature(
    admin_client: TestClient, set_feature: Callable[..., None], store: Any
) -> None:
    bd = today_business_date(store)
    set_feature("money.deposits", False, store_id=store.id)

    for resp in (
        admin_client.get(f"{API}/admin/deposits", params={"store_id": store.id, "from": bd.isoformat(), "to": bd.isoformat()}),
        admin_client.get(
            f"{API}/admin/deposits/pending", params={"store_id": store.id, "from": bd.isoformat(), "to": bd.isoformat()}
        ),
        admin_client.post(
            f"{API}/admin/deposits",
            params={"store_id": store.id},
            json={"amount": 1_000, "receipt_photo": "c.jpg"},
            headers={"Idempotency-Key": "x"},
        ),
    ):
        assert resp.status_code == 400, resp.text
        assert resp.json()["error"]["code"] == "FEATURE_DISABLED"
        assert resp.json()["error"]["feature"] == "money.deposits"

    set_feature("money.deposits", True, store_id=store.id)
    ok = admin_client.get(
        f"{API}/admin/deposits", params={"store_id": store.id, "from": bd.isoformat(), "to": bd.isoformat()}
    )
    assert ok.status_code == 200, ok.text


def test_bank_endpoints_require_money_bank_feature(
    admin_client: TestClient, set_feature: Callable[..., None], store: Any
) -> None:
    bd = today_business_date(store)
    set_feature("money.bank", False, store_id=store.id)

    for resp in (
        admin_client.get(f"{API}/admin/bank/ledger", params={"store_id": store.id, "from": bd.isoformat(), "to": bd.isoformat()}),
        admin_client.get(
            f"{API}/admin/bank/owner-hand", params={"store_id": store.id, "from": bd.isoformat(), "to": bd.isoformat()}
        ),
        admin_client.get(
            f"{API}/admin/reconciliation/card", params={"store_id": store.id, "from": bd.isoformat(), "to": bd.isoformat()}
        ),
        admin_client.get(
            f"{API}/admin/reconciliation/platform", params={"store_id": store.id, "from": bd.isoformat(), "to": bd.isoformat()}
        ),
    ):
        assert resp.status_code == 400, resp.text
        assert resp.json()["error"]["code"] == "FEATURE_DISABLED"
        assert resp.json()["error"]["feature"] == "money.bank"

    set_feature("money.bank", True, store_id=store.id)
    ok = admin_client.get(
        f"{API}/admin/bank/ledger", params={"store_id": store.id, "from": bd.isoformat(), "to": bd.isoformat()}
    )
    assert ok.status_code == 200, ok.text


def test_money_bank_dependency_on_money_deposits_is_validated_first(
    admin_client: TestClient, set_feature: Callable[..., None], store: Any
) -> None:
    """`money.bank requires money.deposits` (`app/core/features.py`).
    `require_feature` no encadena `requires` por sí solo, así que
    `_require_bank()` valida `money.deposits` ANTES que `money.bank` —
    y el mensaje tiene que nombrar la dependencia que falta (`money.deposits`),
    no `money.bank`, aunque los dos estén técnicamente involucrados."""

    bd = today_business_date(store)
    set_feature("money.deposits", False, store_id=store.id)
    # `money.bank` sigue "encendido" (el default de perfil `full`): si la
    # dependencia no se valida, este request pasaría igual.
    resp = admin_client.get(
        f"{API}/admin/bank/ledger", params={"store_id": store.id, "from": bd.isoformat(), "to": bd.isoformat()}
    )
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "FEATURE_DISABLED"
    assert resp.json()["error"]["feature"] == "money.deposits"


def test_feature_gate_wins_over_store_gate(admin_client: TestClient, set_feature: Callable[..., None]) -> None:
    """«tu plan no incluye esto» tiene que ganarle a «esta sede no existe /
    no la puedo ver» — si no, un administrador con la función apagada recibe
    un `404` que no puede arreglar (`docs/CONTEXTO-AGENTES.md §6`).
    `money.deposits` se apaga a nivel ORGANIZACIÓN (sin `store_id`, para que
    aplique a cualquier sede, incluida una que ni existe) y se pide con un
    `store_id` que no existe en absoluto: si el orden estuviera invertido,
    esto devolvería `404`, no `400`."""

    set_feature("money.deposits", False)  # a nivel organización, sin sede
    resp = admin_client.get(
        f"{API}/admin/deposits", params={"store_id": 999_999, "from": "2026-01-01", "to": "2026-01-01"}
    )
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "FEATURE_DISABLED"


def test_deposits_feature_off_by_default_on_basic_profile(admin_client_basic: TestClient, store_basic: Any) -> None:
    resp = admin_client_basic.get(
        f"{API}/admin/deposits", params={"store_id": store_basic.id, "from": "2026-01-01", "to": "2026-01-01"}
    )
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "FEATURE_DISABLED"
