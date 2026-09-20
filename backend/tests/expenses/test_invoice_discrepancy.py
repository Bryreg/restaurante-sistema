"""D-2 (`features/fase-3-dinero-control/spec.md § 1`): `Reception.
invoice_total` (lo que dice el papel), `PayableOut.invoice_discrepancy`
(derivado, `invoice_total - amount`) y el `409 INVOICE_DISCREPANCY` de
`POST /admin/payables/{id}/approve` — única excepción de territorio sobre
`app/purchases/`, acotada a exactamente lo que D-2 enumera."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any
from uuid import uuid4

from fastapi.testclient import TestClient

from app.stores.models import Store


def _idem() -> dict[str, str]:
    return {"Idempotency-Key": str(uuid4())}


def test_reception_without_invoice_total_has_no_discrepancy(
    admin_client: TestClient, create_reception_with_invoice: Callable[..., dict[str, Any]], store: Store
) -> None:
    reception = create_reception_with_invoice(invoice_total=None)
    assert reception["invoice_total"] is None

    payable = admin_client.get(f"/api/v1/admin/payables/{reception['payable_id']}")
    assert payable.status_code == 200, payable.text
    body = payable.json()
    assert body["invoice_total"] is None
    assert body["invoice_discrepancy"] is None
    assert body["amount"] == 14_500

    # Sin diferencia que confirmar, aprueba sin `confirm_discrepancy`.
    approved = admin_client.post(
        f"/api/v1/admin/payables/{reception['payable_id']}/approve", json={"authorizer_pin": "9999"}
    )
    assert approved.status_code == 200, approved.text
    assert approved.json()["discrepancy_confirmed"] is False


def test_reception_with_invoice_total_matching_amount_has_zero_discrepancy(
    admin_client: TestClient, create_reception_with_invoice: Callable[..., dict[str, Any]], store: Store
) -> None:
    reception = create_reception_with_invoice(invoice_total=14_500)
    payable = admin_client.get(f"/api/v1/admin/payables/{reception['payable_id']}").json()
    assert payable["invoice_total"] == 14_500
    assert payable["invoice_discrepancy"] == 0

    # Diferencia es 0: no hace falta confirmar nada para aprobar.
    approved = admin_client.post(
        f"/api/v1/admin/payables/{reception['payable_id']}/approve", json={"authorizer_pin": "9999"}
    )
    assert approved.status_code == 200, approved.text


def test_approve_with_discrepancy_blocks_without_confirmation_naming_both_figures(
    admin_client: TestClient, create_reception_with_invoice: Callable[..., dict[str, Any]], store: Store
) -> None:
    reception = create_reception_with_invoice(invoice_total=15_200)  # el papel dice más que el cálculo
    payable_id = reception["payable_id"]

    payable = admin_client.get(f"/api/v1/admin/payables/{payable_id}").json()
    assert payable["invoice_total"] == 15_200
    assert payable["invoice_discrepancy"] == 700  # 15200 - 14500

    blocked = admin_client.post(f"/api/v1/admin/payables/{payable_id}/approve", json={"authorizer_pin": "9999"})
    assert blocked.status_code == 409, blocked.text
    error = blocked.json()["error"]
    assert error["code"] == "INVOICE_DISCREPANCY"
    # El mensaje NOMBRA LAS DOS CIFRAS (literal, spec.md § 1 D-2).
    assert "15200" in error["message"]
    assert "14500" in error["message"]

    # Sigue sin aprobar: el estado no cambió con el intento bloqueado.
    still_pending = admin_client.get(f"/api/v1/admin/payables/{payable_id}").json()
    assert still_pending["status"] == "pending_review"

    confirmed = admin_client.post(
        f"/api/v1/admin/payables/{payable_id}/approve",
        json={"authorizer_pin": "9999", "confirm_discrepancy": True},
    )
    assert confirmed.status_code == 200, confirmed.text
    body = confirmed.json()
    assert body["status"] == "approved"
    assert body["discrepancy_confirmed"] is True
    assert body["discrepancy_confirmed_by_employee_name"]


def test_approve_with_negative_discrepancy_also_blocks(
    admin_client: TestClient, create_reception_with_invoice: Callable[..., dict[str, Any]], store: Store
) -> None:
    reception = create_reception_with_invoice(invoice_total=13_000)  # el papel dice MENOS que el cálculo
    payable_id = reception["payable_id"]
    payable = admin_client.get(f"/api/v1/admin/payables/{payable_id}").json()
    assert payable["invoice_discrepancy"] == -1_500

    blocked = admin_client.post(f"/api/v1/admin/payables/{payable_id}/approve", json={"authorizer_pin": "9999"})
    assert blocked.status_code == 409, blocked.text
    assert blocked.json()["error"]["code"] == "INVOICE_DISCREPANCY"


def test_payable_amount_never_changes_meaning_it_still_costs_inventory(
    admin_client: TestClient, create_reception_with_invoice: Callable[..., dict[str, Any]], store: Store
) -> None:
    """`Payable.amount` sigue siendo el cálculo (D-2: "no cambia de
    significado"); `invoice_total` no lo pisa aunque difieran."""
    reception = create_reception_with_invoice(invoice_total=999_999)
    payable = admin_client.get(f"/api/v1/admin/payables/{reception['payable_id']}").json()
    assert payable["amount"] == 14_500
