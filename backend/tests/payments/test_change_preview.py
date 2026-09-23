"""`POST /payments/change-preview`: el vuelto antes de cobrar.

La caja lo pide mientras teclea lo recibido, para decirle al cliente el
vuelto ANTES de cobrar (en la pantalla no se calcula plata). La cuenta es
`service.cash_change`, la misma del cobro: lo que se anuncia es lo que queda
en el comprobante.
"""

from __future__ import annotations

from typing import Any

from app.payments.service import cash_change


def test_the_change_is_what_was_tendered_minus_what_it_pays() -> None:
    assert cash_change(amount=41_800, tendered=50_000) == 8_200
    assert cash_change(amount=41_800, tendered=41_800) == 0
    # No alcanza: no hay vuelto, y no es cero.
    assert cash_change(amount=41_800, tendered=40_000) is None


def test_preview_over_http_needs_the_device_not_a_person(client: Any, device_client: Any) -> None:
    """Sin persona identificada responde igual: un 401 acá cerraría la sesión
    de la cajera en medio del cobro (y cada consulta la renovaría)."""
    body = {"splits": [{"amount": 41_800, "tendered": 50_000}, {"amount": 20_000, "tendered": 10_000}]}

    sin_dispositivo = client.post("/api/v1/payments/change-preview", json=body)
    assert sin_dispositivo.status_code == 401

    resp = device_client.post("/api/v1/payments/change-preview", json=body)
    assert resp.status_code == 200, resp.text
    assert resp.json() == {
        "splits": [{"change": 8_200, "short_by": None}, {"change": None, "short_by": 10_000}],
        "change_total": 8_200,
    }


def test_the_preview_matches_the_change_the_payment_records(
    device_client: Any, identify: Any, employees: Any, counter_order_with_items: Any
) -> None:
    """Lo anunciado y lo cobrado no pueden separarse: misma función."""
    order = counter_order_with_items()
    total = order["totals"]["total"]
    tendered = ((total // 10_000) + 1) * 10_000
    identify(device_client, employees["cashier"])
    preview = device_client.post(
        "/api/v1/payments/change-preview", json={"splits": [{"amount": total, "tendered": tendered}]}
    ).json()

    import uuid

    paid = device_client.post(
        f"/api/v1/orders/{order['id']}/payments",
        json={
            "pin": "1111",
            "tip": {"asked": True, "accepted": False, "modified": False, "amount": 0},
            "splits": [{"method": "cash", "amount": total, "tendered": tendered}],
        },
        headers={"Idempotency-Key": str(uuid.uuid4())},
    )
    assert paid.status_code == 201, paid.text
    assert paid.json()["change"] == preview["change_total"]
