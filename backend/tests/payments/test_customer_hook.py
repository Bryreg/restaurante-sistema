"""Dueño del test de punta a punta del gancho `pay_order ->
app.customers.hooks.upsert_customer_with_consent` (mandato del Maestro,
`features/fase-1b-venta/spec.md` §8.3/§8.4): `customer?` en el body de
`POST /orders/{id}/payments` crea o reutiliza el maestro por
`(doc_type, doc_number)`, registra el consentimiento, y el documento fiscal
congela el snapshot (incluye `customer_id`) — snapshot que
`app.customers.service.erase_customer` (de otro territorio, llamado acá
directo porque su router todavía no está montado, ver `gaps`) NUNCA toca.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import func, select

from tests.payments.conftest import idem_headers

NO_TIP = {"asked": True, "accepted": False, "modified": False, "amount": 0}
CONSENT = {"text_version": "v1", "channel": "pos"}


def _pay_with_customer(
    device_client: Any, identify: Any, employees: Any, open_shift: Any, drink_product: Any, *, doc_number: str,
    name: str = "Cliente de prueba", first_time: bool = True,
) -> Any:
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
    order = items_resp.json()
    return device_client.post(
        f"/api/v1/orders/{order['id']}/payments",
        json={
            "pin": "1111",
            "tip": NO_TIP,
            "splits": [{"method": "cash", "amount": order["totals"]["total"]}],
            "customer": {
                "doc_type": "13",
                "doc_number": doc_number,
                "name": name,
                "email": "cliente@test.local",
                "address": "Calle 10 # 20-30",
                "municipality_dane": "11001",
                "consent": CONSENT,
            },
        },
        headers=idem_headers(),
    )


def test_paying_with_customer_creates_the_master_and_freezes_the_snapshot(
    device_client: Any, identify: Any, employees: Any, open_shift: Any, drink_product: Any, db: Any
) -> None:
    resp = _pay_with_customer(
        device_client, identify, employees, open_shift, drink_product, doc_number="1010101010"
    )
    assert resp.status_code == 201, resp.text
    document_id = resp.json()["document"]["id"]

    from app.customers.models import Customer, CustomerConsent
    from app.fiscal.models import FiscalDocument

    customer = db.execute(select(Customer).where(Customer.doc_number == "1010101010")).scalar_one()
    assert customer.name == "Cliente de prueba"
    assert customer.email == "cliente@test.local"

    consents = db.execute(select(CustomerConsent).where(CustomerConsent.customer_id == customer.id)).scalars().all()
    assert len(consents) == 1
    assert consents[0].channel == "pos"
    assert consents[0].text_version == "v1"

    doc = db.get(FiscalDocument, document_id)
    assert doc.customer_id == customer.id
    assert doc.customer_doc_number == "1010101010"
    assert doc.customer_name == "Cliente de prueba"
    assert doc.customer_email == "cliente@test.local"
    assert doc.customer_address == "Calle 10 # 20-30"
    assert doc.customer_municipality_dane == "11001"

    printed = device_client.get(f"/api/v1/documents/{document_id}")
    assert printed.json()["customer"]["email"] == "cliente@test.local"
    assert printed.json()["customer"]["municipality_dane"] == "11001"


def test_same_doc_number_reuses_the_same_customer_row(
    device_client: Any, identify: Any, employees: Any, open_shift: Any, drink_product: Any, db: Any
) -> None:
    first = _pay_with_customer(
        device_client, identify, employees, open_shift, drink_product, doc_number="2020202020", first_time=True
    )
    assert first.status_code == 201, first.text
    second = _pay_with_customer(
        device_client, identify, employees, open_shift, drink_product, doc_number="2020202020", first_time=False
    )
    assert second.status_code == 201, second.text

    from app.customers.models import Customer

    rows = db.execute(select(Customer).where(Customer.doc_number == "2020202020")).scalars().all()
    assert len(rows) == 1

    doc1 = first.json()["document"]["id"]
    doc2 = second.json()["document"]["id"]
    from app.fiscal.models import FiscalDocument

    assert db.get(FiscalDocument, doc1).customer_id == db.get(FiscalDocument, doc2).customer_id


def test_customer_feature_disabled_blocks_the_payment(
    device_client: Any, identify: Any, employees: Any, open_shift: Any, drink_product: Any, set_feature: Any, db: Any
) -> None:
    """Ronda 2 — B-2 (Conciliador). Antes del arreglo, `resolve_customer_snapshot`
    (y con él el gate de la flag `customers`) corría DESPUÉS de
    `claim_payment` — `get_db` comitea también ante `AppError`, así que el
    `400 FEATURE_DISABLED` era correcto pero la comanda ya había quedado
    `paid`, sin documento y sin pago (la venta "se tragaba" entera). El
    arreglo (`app/payments/service.py`, gate temprano con
    `features.assert_feature`, mismo patrón que `assert_range_available`)
    tiene que dejar la comanda EXACTAMENTE como estaba antes de cobrar: las
    cuatro aserciones son las cuatro formas en que ese estado se puede
    romper. Réplica en `tests/payments` del rojo de B-2 que vive en
    `tests/audit/test_privacy_invariants.py
    ::test_charging_with_customer_data_while_the_feature_is_off_does_not_swallow_the_sale`
    (territorio ajeno, no lo edito; este test es el equivalente en MI
    territorio)."""
    set_feature("customers", False)
    open_shift()
    identify(device_client, employees["cashier"])
    order_resp = device_client.post("/api/v1/orders", json={"channel": "counter"}, headers=idem_headers())
    order = order_resp.json()
    items_resp = device_client.post(
        f"/api/v1/orders/{order['id']}/items",
        json={"expected_version": order["version"], "items": [{"product_id": drink_product.id, "qty": 1}]},
        headers=idem_headers(),
    )
    order = items_resp.json()

    resp = device_client.post(
        f"/api/v1/orders/{order['id']}/payments",
        json={
            "pin": "1111",
            "tip": NO_TIP,
            "splits": [{"method": "cash", "amount": order["totals"]["total"]}],
            "customer": {
                "doc_type": "13",
                "doc_number": "3030303030",
                "name": "Cliente de prueba",
                "email": "cliente@test.local",
                "address": "Calle 10 # 20-30",
                "municipality_dane": "11001",
                "consent": CONSENT,
            },
        },
        headers=idem_headers(),
    )

    # (1) 400 con el código exacto, sin mensaje inventado (reutiliza
    # `features.assert_feature`, el mismo que usa `app/customers/hooks.py`).
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "FEATURE_DISABLED"

    # (2) la comanda NO quedó cobrada: el gate cortó ANTES de `claim_payment`.
    db.expire_all()
    vigente = device_client.get(f"/api/v1/orders/{order['id']}")
    assert vigente.status_code == 200, vigente.text
    assert vigente.json()["status"] != "paid"

    # (3) y (4): ningún pago ni documento nació de este intento.
    from app.fiscal.models import FiscalDocument
    from app.payments.models import Payment

    assert db.execute(select(func.count()).select_from(Payment)).scalar_one() == 0
    assert db.execute(select(func.count()).select_from(FiscalDocument)).scalar_one() == 0


def test_customer_feature_disabled_without_customer_in_body_still_charges(
    device_client: Any, identify: Any, employees: Any, open_shift: Any, drink_product: Any, set_feature: Any
) -> None:
    """No regresión: la flag `customers` apagada NUNCA bloqueó (ni debe
    bloquear) un cobro que no manda `customer` en el body — ese es el caso
    que ya funcionaba hoy (`resolve_customer_snapshot(customer_in=None)` va
    directo a `CONSUMER_FINAL` sin tocar el gancho de `app.customers`) y que
    el gate nuevo, condicionado a `payload.customer is not None`, tiene que
    seguir dejando pasar sin cambios."""
    set_feature("customers", False)
    open_shift()
    identify(device_client, employees["cashier"])
    order_resp = device_client.post("/api/v1/orders", json={"channel": "counter"}, headers=idem_headers())
    order = order_resp.json()
    items_resp = device_client.post(
        f"/api/v1/orders/{order['id']}/items",
        json={"expected_version": order["version"], "items": [{"product_id": drink_product.id, "qty": 1}]},
        headers=idem_headers(),
    )
    order = items_resp.json()

    resp = device_client.post(
        f"/api/v1/orders/{order['id']}/payments",
        json={
            "pin": "1111",
            "tip": NO_TIP,
            "splits": [{"method": "cash", "amount": order["totals"]["total"]}],
        },
        headers=idem_headers(),
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["document"] is not None

    printed = device_client.get(f"/api/v1/documents/{body['document']['id']}")
    assert printed.json()["customer"]["name"] == "Consumidor final"


def test_erase_customer_anonymizes_the_master_and_keeps_the_document_snapshot_intact(
    device_client: Any, identify: Any, employees: Any, open_shift: Any, drink_product: Any, db: Any,
) -> None:
    """Checklist del pedido: «`customers/{id}/erase` anonimiza el maestro y
    deja intacto el snapshot del documento» — se llama a
    `app.customers.service.erase_customer` (función pública de otro
    territorio) directamente porque `app.customers.router` todavía no está
    montado en `app.main.DOMAINS` (gap declarado en el entregable, no
    depende de mí arreglarlo)."""
    resp = _pay_with_customer(
        device_client, identify, employees, open_shift, drink_product, doc_number="4040404040",
        name="Antes de anonimizar",
    )
    assert resp.status_code == 201, resp.text
    document_id = resp.json()["document"]["id"]

    from app.customers import service as customers_service
    from app.customers.models import Customer
    from app.fiscal.models import FiscalDocument
    from app.core import clock as clock_module
    from app.auth.deps import Actor

    customer = db.execute(select(Customer).where(Customer.doc_number == "4040404040")).scalar_one()
    admin_actor = Actor(
        kind="admin", organization_id=customer.organization_id, store_id=None, employee_id=None,
        employee_name="Admin de prueba", role="admin",
    )
    customers_service.erase_customer(
        db, actor=admin_actor, customer=customer, reason="Solicitud del titular", now=clock_module.now_utc()
    )
    db.commit()

    db.refresh(customer)
    assert customer.name != "Antes de anonimizar"
    assert customer.doc_number != "4040404040"
    assert customer.erased_at is not None

    doc = db.get(FiscalDocument, document_id)
    assert doc.customer_name == "Antes de anonimizar"
    assert doc.customer_doc_number == "4040404040"
    assert doc.customer_email == "cliente@test.local"
