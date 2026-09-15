"""`/api/v1/admin/customers/*`."""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.core import clock as clock_module
from app.customers.hooks import ConsentInput, upsert_customer_with_consent
from app.stores.models import Organization, Store


class _FakeActor:
    def __init__(self, employee_id: int, employee_name: str) -> None:
        self.employee_id = employee_id
        self.employee_name = employee_name


def _make_customer(db: Session, org: Organization, store: Store, *, doc_number: str = "1001001001") -> int:
    customer = upsert_customer_with_consent(
        db,
        organization_id=org.id,
        store_id=store.id,
        doc_type="13",
        doc_number=doc_number,
        dv=None,
        name="Ana Pérez",
        email="ana@example.com",
        address="Cra 1 # 2-3",
        municipality_dane="11001",
        consent=ConsentInput(text_version="v1", channel="pos"),
        actor=_FakeActor(1, "Cajero"),
        now=clock_module.now_utc(),
    )
    db.commit()
    return customer.id


def test_admin_list_customers(admin_client: TestClient, db: Session, org: Organization, store: Store) -> None:
    _make_customer(db, org, store)
    resp = admin_client.get("/api/v1/admin/customers")
    assert resp.status_code == 200, resp.text
    rows = resp.json()
    assert len(rows) == 1
    assert rows[0]["doc_number"] == "1001001001"


def test_admin_list_customers_filters_by_doc_number(
    admin_client: TestClient, db: Session, org: Organization, store: Store
) -> None:
    _make_customer(db, org, store, doc_number="1001001001")
    _make_customer(db, org, store, doc_number="2002002002")

    resp = admin_client.get("/api/v1/admin/customers?doc_number=1001")
    assert resp.status_code == 200, resp.text
    rows = resp.json()
    assert len(rows) == 1
    assert rows[0]["doc_number"] == "1001001001"


def test_admin_list_customers_csv(admin_client: TestClient, db: Session, org: Organization, store: Store) -> None:
    _make_customer(db, org, store)
    resp = admin_client.get("/api/v1/admin/customers?format=csv")
    assert resp.status_code == 200, resp.text
    assert resp.headers["content-type"].startswith("text/csv")
    assert "doc_number" in resp.text


def test_admin_list_customers_disabled_flag_returns_feature_disabled(
    admin_client: TestClient, db: Session, org: Organization, store: Store, set_feature: Any
) -> None:
    set_feature("customers", False)
    resp = admin_client.get("/api/v1/admin/customers")
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "FEATURE_DISABLED"


def test_admin_patch_customer_rectifies_data_and_logs_a_request(
    admin_client: TestClient, db: Session, org: Organization, store: Store
) -> None:
    customer_id = _make_customer(db, org, store)

    resp = admin_client.patch(f"/api/v1/admin/customers/{customer_id}", json={"email": "nuevo@example.com"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["email"] == "nuevo@example.com"

    requests_resp = admin_client.get(f"/api/v1/admin/customers/{customer_id}/requests")
    assert requests_resp.status_code == 200, requests_resp.text
    kinds = [r["kind"] for r in requests_resp.json()]
    assert "rectify" in kinds


def test_admin_add_consent(admin_client: TestClient, db: Session, org: Organization, store: Store) -> None:
    customer_id = _make_customer(db, org, store)

    resp = admin_client.post(
        f"/api/v1/admin/customers/{customer_id}/consents",
        json={"purpose": "marketing", "granted": True, "channel": "whatsapp", "text_version": "v2"},
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["purpose"] == "marketing"
    assert body["granted"] is True


def test_revoking_a_consent_logs_a_revoke_request(
    admin_client: TestClient, db: Session, org: Organization, store: Store
) -> None:
    customer_id = _make_customer(db, org, store)

    resp = admin_client.post(
        f"/api/v1/admin/customers/{customer_id}/consents",
        json={"purpose": "marketing", "granted": False, "channel": "whatsapp", "text_version": "v2"},
    )
    assert resp.status_code == 201, resp.text

    requests_resp = admin_client.get(f"/api/v1/admin/customers/{customer_id}/requests")
    kinds = [r["kind"] for r in requests_resp.json()]
    assert "revoke" in kinds


def test_erase_works_even_with_the_feature_flag_disabled(
    admin_client: TestClient, db: Session, org: Organization, store: Store, set_feature: Any
) -> None:
    """`erase` y `requests` son un derecho legal, no una función apagable
    (`docs/SPEC-NEGOCIO.md §8.4`) — siguen funcionando aunque `customers`
    esté apagada."""

    customer_id = _make_customer(db, org, store)
    set_feature("customers", False)

    resp = admin_client.post(f"/api/v1/admin/customers/{customer_id}/erase", json={"reason": "El titular lo pidió"})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["name"] == "Cliente anonimizado"
    assert body["doc_type"] == "ERASED"
    assert body["erased_at"] is not None

    requests_resp = admin_client.get(f"/api/v1/admin/customers/{customer_id}/requests")
    assert requests_resp.status_code == 200, requests_resp.text
    kinds = [r["kind"] for r in requests_resp.json()]
    assert "erase" in kinds


def test_erase_is_idempotent(admin_client: TestClient, db: Session, org: Organization, store: Store) -> None:
    customer_id = _make_customer(db, org, store)

    first = admin_client.post(f"/api/v1/admin/customers/{customer_id}/erase", json={"reason": "Solicitud"})
    assert first.status_code == 200, first.text
    first_doc_number = first.json()["doc_number"]

    second = admin_client.post(f"/api/v1/admin/customers/{customer_id}/erase", json={"reason": "Solicitud repetida"})
    assert second.status_code == 200, second.text
    assert second.json()["doc_number"] == first_doc_number


def test_a_new_customer_can_reuse_the_original_document_number_after_erase(
    admin_client: TestClient, db: Session, org: Organization, store: Store
) -> None:
    customer_id = _make_customer(db, org, store, doc_number="3003003003")
    erase_resp = admin_client.post(f"/api/v1/admin/customers/{customer_id}/erase", json={"reason": "Solicitud"})
    assert erase_resp.status_code == 200, erase_resp.text

    new_customer = upsert_customer_with_consent(
        db,
        organization_id=org.id,
        store_id=store.id,
        doc_type="13",
        doc_number="3003003003",
        dv=None,
        name="Otra Persona",
        email=None,
        address=None,
        municipality_dane=None,
        consent=ConsentInput(text_version="v1", channel="pos"),
        actor=_FakeActor(1, "Cajero"),
        now=clock_module.now_utc(),
    )
    assert new_customer.id != customer_id
    assert new_customer.doc_number == "3003003003"
