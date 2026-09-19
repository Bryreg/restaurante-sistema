"""`GET /admin/payables/{id}/payments` — el historial de pagos.

Faltaba en el contrato de 2b, y sin él la cuenta por pagar estaba a medias:
se podía registrar un pago y anular uno por id, pero no VERLOS. Un
administrador que volvía al día siguiente no sabía qué se había pagado, y no
podía anular nada porque el `payment_id` sólo había existido en la respuesta
del `POST` que lo creó.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any
from uuid import uuid4

from fastapi.testclient import TestClient

from app.stores.models import Store


def _idem() -> dict[str, str]:
    return {"Idempotency-Key": str(uuid4())}


def _approve_and_pay(admin_client: TestClient, payable: dict[str, Any], amount: int, *, method: str = "transfer", at: str) -> int:
    resp = admin_client.post(
        f"/api/v1/admin/payables/{payable['id']}/payments",
        json={"amount": amount, "method": method, "paid_at": at, "from_cash_drawer": False, "authorizer_pin": "9999"},
        headers=_idem(),
    )
    assert resp.status_code == 201, resp.text
    return int(resp.json()["id"])


def test_a_payable_with_no_payments_lists_an_empty_history_not_a_404(
    admin_client: TestClient, create_payable: Callable[..., Any]
) -> None:
    """«Sin datos» se dice, no se dibuja como error (SPEC-NEGOCIO §9.3)."""
    payable = create_payable()
    resp = admin_client.get(f"/api/v1/admin/payables/{payable['id']}/payments")
    assert resp.status_code == 200, resp.text
    assert resp.json() == []


def test_the_history_lists_every_payment_oldest_first_with_its_id(
    admin_client: TestClient, create_payable: Callable[..., Any]
) -> None:
    """El `id` es lo que hace usable a `POST .../payments/{id}/void`: sin esta
    lectura, anular un pago de una sesión anterior era imposible."""
    payable = create_payable()
    admin_client.post(f"/api/v1/admin/payables/{payable['id']}/approve", json={"authorizer_pin": "9999"})

    tercio = payable["amount"] // 3
    # A propósito en desorden: el más nuevo se registra primero.
    segundo = _approve_and_pay(admin_client, payable, tercio, at="2026-01-08T10:00:00Z")
    primero = _approve_and_pay(admin_client, payable, tercio, at="2026-01-06T10:00:00Z")

    filas = admin_client.get(f"/api/v1/admin/payables/{payable['id']}/payments").json()
    assert [f["id"] for f in filas] == [primero, segundo], "el historial tiene que venir del más viejo al más nuevo"
    assert all(f["payable_id"] == payable["id"] for f in filas)
    assert all(f["authorized_by_employee_name"] for f in filas), "un pago sin autorizador no se puede auditar"


def test_a_voided_payment_stays_in_the_history_marked_and_with_who_voided_it(
    admin_client: TestClient, create_payable: Callable[..., Any]
) -> None:
    """Nada financiero se borra (regla dura). Y el historial tiene que decir
    QUIÉN anuló: anular un pago a proveedor devuelve plata al cajón, y eso
    tiene responsable."""
    payable = create_payable()
    admin_client.post(f"/api/v1/admin/payables/{payable['id']}/approve", json={"authorizer_pin": "9999"})
    pago = _approve_and_pay(admin_client, payable, payable["amount"] // 2, at="2026-01-06T10:00:00Z")

    void = admin_client.post(
        f"/api/v1/admin/payables/{payable['id']}/payments/{pago}/void",
        json={"reason": "Monto equivocado", "authorizer_pin": "9999"},
    )
    assert void.status_code == 200, void.text

    filas = admin_client.get(f"/api/v1/admin/payables/{payable['id']}/payments").json()
    assert len(filas) == 1, "el pago anulado NO desaparece del historial"
    fila = filas[0]
    assert fila["voided_at"] is not None
    assert fila["voided_reason"] == "Monto equivocado"
    assert fila["voided_by_employee_name"], "el historial dice que se anuló pero no quién"


def test_the_history_can_hide_the_voided_ones_and_then_it_reconciles_with_the_balance(
    admin_client: TestClient, create_payable: Callable[..., Any]
) -> None:
    """Los vivos del historial tienen que sumar exactamente lo que el saldo
    derivado dice que ya se pagó. Si no cierran, una de las dos lecturas
    miente — y el saldo es el que manda (`payable_balance`, sólo vivos)."""
    payable = create_payable()
    admin_client.post(f"/api/v1/admin/payables/{payable['id']}/approve", json={"authorizer_pin": "9999"})

    vivo = payable["amount"] // 4
    anulado = payable["amount"] // 4
    _approve_and_pay(admin_client, payable, vivo, at="2026-01-06T10:00:00Z")
    a_anular = _approve_and_pay(admin_client, payable, anulado, at="2026-01-07T10:00:00Z")
    admin_client.post(
        f"/api/v1/admin/payables/{payable['id']}/payments/{a_anular}/void",
        json={"reason": "Duplicado", "authorizer_pin": "9999"},
    )

    todos = admin_client.get(f"/api/v1/admin/payables/{payable['id']}/payments").json()
    solo_vivos = admin_client.get(f"/api/v1/admin/payables/{payable['id']}/payments?include_voided=false").json()
    assert len(todos) == 2
    assert len(solo_vivos) == 1

    fila = next(
        p for p in admin_client.get(f"/api/v1/admin/payables?store_id={payable['store_id']}").json() if p["id"] == payable["id"]
    )
    assert sum(p["amount"] for p in solo_vivos) == payable["amount"] - fila["balance"]


def test_the_history_of_another_organizations_payable_is_a_404_not_a_leak(
    admin_client: TestClient, create_payable: Callable[..., Any]
) -> None:
    payable = create_payable()
    resp = admin_client.get(f"/api/v1/admin/payables/{payable['id'] + 10_000}/payments")
    assert resp.status_code == 404, resp.text
    assert resp.json()["error"]["code"] == "NOT_FOUND"


def test_the_history_declares_csv_in_the_published_contract(admin_client: TestClient, create_payable: Callable[..., Any], store: Store) -> None:
    """Regla de 2b: todo listado nuevo DECLARA `format`, no lo lee de
    `request.query_params` — si no, el OpenAPI no lo publica y el cliente
    arma el CSV a mano."""
    from app.main import app

    op = app.openapi()["paths"]["/api/v1/admin/payables/{payable_id}/payments"]["get"]
    assert "format" in [q["name"] for q in op.get("parameters", [])]

    payable = create_payable()
    admin_client.post(f"/api/v1/admin/payables/{payable['id']}/approve", json={"authorizer_pin": "9999"})
    _approve_and_pay(admin_client, payable, payable["amount"] // 2, at="2026-01-06T10:00:00Z")

    resp = admin_client.get(f"/api/v1/admin/payables/{payable['id']}/payments?format=csv")
    assert resp.status_code == 200, resp.text
    assert "text/csv" in resp.headers["content-type"]
