"""`app.fiscal.provider`: el adaptador. `FakeProvider` valida, RECHAZA y
simula contingencia; un rechazo NO libera el número (invariante que no se
negocia); `pay_order`/`issue_document` nunca mencionan una implementación
concreta (`PendingTransmissionProvider`/`FakeProvider`) — sólo
`get_provider`, que es el único punto que cambiaría el día que el dueño
elija un proveedor tecnológico real.
"""

from __future__ import annotations

import inspect
from pathlib import Path
from typing import Any

import pytest

from app.fiscal import provider as fiscal_provider
from tests.payments.conftest import idem_headers

NO_TIP = {"asked": True, "accepted": False, "modified": False, "amount": 0}


@pytest.fixture(autouse=True)
def _restore_provider() -> Any:
    yield
    fiscal_provider.set_provider_override(None)


def _pay(device_client: Any, order: dict[str, Any]) -> Any:
    return device_client.post(
        f"/api/v1/orders/{order['id']}/payments",
        json={"pin": "1111", "tip": NO_TIP, "splits": [{"method": "cash", "amount": order["totals"]["total"]}]},
        headers=idem_headers(),
    )


def _new_paid_order(
    device_client: Any, identify: Any, employees: Any, open_shift: Any, drink_product: Any, *, first_time: bool
) -> dict[str, Any]:
    if first_time:
        open_shift()
        identify(device_client, employees["cashier"])
    order_resp = device_client.post("/api/v1/orders", json={"channel": "counter"}, headers=idem_headers())
    order = order_resp.json()
    items_resp = device_client.post(
        f"/api/v1/orders/{order['id']}/items",
        json={"expected_version": order["version"], "items": [{"product_id": drink_product.id, "qty": 1}]},
        headers=idem_headers(),
    )
    return items_resp.json()


def test_fake_provider_validates_with_cude_and_qr(
    device_client: Any, identify: Any, employees: Any, open_shift: Any, drink_product: Any, db: Any
) -> None:
    fiscal_provider.set_provider_override(fiscal_provider.FakeProvider(outcome="validate"))
    order = _new_paid_order(device_client, identify, employees, open_shift, drink_product, first_time=True)
    resp = _pay(device_client, order)
    assert resp.status_code == 201, resp.text
    doc = resp.json()["document"]
    assert doc["dian_status"] == "validated"
    assert doc["cude"] is not None and doc["cude"].startswith("FAKE-CUDE-")
    assert doc["qr_url"] is not None


def test_fake_provider_rejects_and_does_not_release_the_number(
    device_client: Any, identify: Any, employees: Any, open_shift: Any, drink_product: Any, db: Any
) -> None:
    fiscal_provider.set_provider_override(fiscal_provider.FakeProvider(outcome="reject"))
    order1 = _new_paid_order(device_client, identify, employees, open_shift, drink_product, first_time=True)
    resp1 = _pay(device_client, order1)
    assert resp1.status_code == 201, resp1.text
    doc1 = resp1.json()["document"]
    assert doc1["dian_status"] == "rejected"
    number1 = doc1["number"]

    # Un segundo cobro (también rechazado) sigue el consecutivo: el rechazo
    # anterior NO liberó su número.
    order2 = _new_paid_order(device_client, identify, employees, open_shift, drink_product, first_time=False)
    resp2 = _pay(device_client, order2)
    assert resp2.status_code == 201, resp2.text
    doc2 = resp2.json()["document"]
    assert doc2["dian_status"] == "rejected"
    assert doc2["number"] == number1 + 1

    # Y un tercer cobro, ya validado (cambio de outcome en caliente): sigue
    # el mismo consecutivo — nada se reutiliza ni queda hueco.
    fiscal_provider.set_provider_override(fiscal_provider.FakeProvider(outcome="validate"))
    order3 = _new_paid_order(device_client, identify, employees, open_shift, drink_product, first_time=False)
    resp3 = _pay(device_client, order3)
    assert resp3.status_code == 201, resp3.text
    assert resp3.json()["document"]["number"] == number1 + 2


def test_fake_provider_simulates_contingency(
    device_client: Any, identify: Any, employees: Any, open_shift: Any, drink_product: Any, db: Any
) -> None:
    fiscal_provider.set_provider_override(fiscal_provider.FakeProvider(outcome="contingency"))
    order = _new_paid_order(device_client, identify, employees, open_shift, drink_product, first_time=True)
    resp = _pay(device_client, order)
    assert resp.status_code == 201, resp.text
    doc = resp.json()["document"]
    assert doc["dian_status"] == "contingency"
    assert doc["contingency"] is True

    printed = device_client.get(f"/api/v1/documents/{doc['id']}")
    assert printed.status_code == 200, printed.text
    assert "CONTINGENCIA" in printed.json()["legend"]


def test_pay_order_and_issue_document_never_mention_a_concrete_provider() -> None:
    """El punto entero del adaptador: elegir un proveedor real, el día de
    mañana, es escribir una clase nueva en `app/fiscal/provider.py` y
    cambiar `get_provider` — nunca tocar `pay_order` ni `issue_document`.
    Se prueba por inspección de fuente (mismo criterio que
    `frontend/src/audit/sales.test.ts` en 1b-1)."""
    backend_dir = Path(__file__).resolve().parents[2]
    for relative in ("app/payments/service.py", "app/fiscal/service.py"):
        source = (backend_dir / relative).read_text(encoding="utf-8")
        assert "PendingTransmissionProvider" not in source, f"{relative} menciona el proveedor concreto"
        assert "FakeProvider" not in source, f"{relative} menciona el proveedor de test"


def test_get_provider_signature_is_the_only_choice_point() -> None:
    """`get_provider` es la única función que decide la implementación:
    documenta la firma pública para que otro agente no tenga que leer el
    archivo entero."""
    sig = inspect.signature(fiscal_provider.get_provider)
    assert list(sig.parameters) == ["db", "store"]
