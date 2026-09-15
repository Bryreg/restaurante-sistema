"""`app.customers.hooks.upsert_customer_with_consent` — firma exacta del
contrato:

    upsert_customer_with_consent(db, *, organization_id, store_id, doc_type,
        doc_number, dv, name, email, address, municipality_dane, consent,
        actor, now) -> Customer

El test de punta a punta de ESTE gancho (cobrar con `customer` en el payload
de `POST /orders/{id}/payments`) es responsabilidad de quien lo llama
(`app.payments.service.pay_order`, territorio ajeno — `PaymentIn` todavía no
tiene el campo `customer`, ver `gaps`). Acá se prueba la función misma."""

from __future__ import annotations

from typing import Any

import pytest
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.auth.models import Employee
from app.core import clock as clock_module
from app.core.errors import AppError
from app.customers.hooks import ConsentInput, upsert_customer_with_consent
from app.customers.models import Customer, CustomerConsent
from app.stores.models import Organization, Store


class _FakeActor:
    def __init__(self, employee_id: int, employee_name: str) -> None:
        self.employee_id = employee_id
        self.employee_name = employee_name


def test_creates_a_new_customer_and_a_consent_row(
    db: Session, org: Organization, store: Store, employees: dict[str, Employee]
) -> None:
    now = clock_module.now_utc()
    cashier = employees["cashier"]
    customer = upsert_customer_with_consent(
        db,
        organization_id=org.id,
        store_id=store.id,
        doc_type="13",
        doc_number="1001001001",
        dv=None,
        name="Ana Pérez",
        email="ana@example.com",
        address="Cra 1 # 2-3",
        municipality_dane="11001",
        consent=ConsentInput(text_version="v1", channel="pos"),
        actor=_FakeActor(cashier.id, cashier.name),
        now=now,
    )

    assert customer.id is not None
    assert customer.doc_type == "13"
    assert customer.doc_number == "1001001001"
    assert customer.name == "Ana Pérez"

    consents = list(db.execute(select(CustomerConsent).where(CustomerConsent.customer_id == customer.id)).scalars())
    assert len(consents) == 1
    assert consents[0].purpose == "invoice"
    assert consents[0].granted is True
    assert consents[0].channel == "pos"
    assert consents[0].text_version == "v1"
    assert consents[0].registered_by_employee_id == cashier.id


def test_accepts_a_plain_dict_consent_too(
    db: Session, org: Organization, store: Store, employees: dict[str, Employee]
) -> None:
    """`app.fiscal.service.resolve_customer_snapshot` (territorio ajeno) llama
    este gancho con `consent=customer_in.consent.model_dump(mode="json")` —
    un `dict` plano, no una instancia de `ConsentInput`. Tiene que funcionar
    igual (ver `_consent_fields` en `app.customers.hooks`)."""

    cashier = employees["cashier"]
    customer = upsert_customer_with_consent(
        db,
        organization_id=org.id,
        store_id=store.id,
        doc_type="13",
        doc_number="1001001002",
        dv=None,
        name="Beto Ruiz",
        email=None,
        address=None,
        municipality_dane=None,
        consent={"text_version": "v1", "channel": "pos"},
        actor=_FakeActor(cashier.id, cashier.name),
        now=clock_module.now_utc(),
    )
    assert customer.id is not None
    consent = db.execute(select(CustomerConsent).where(CustomerConsent.customer_id == customer.id)).scalars().one()
    assert consent.channel == "pos"
    assert consent.text_version == "v1"


def test_reuses_the_customer_by_document_and_updates_its_data(
    db: Session, org: Organization, store: Store, employees: dict[str, Employee]
) -> None:
    now = clock_module.now_utc()
    cashier = employees["cashier"]
    operator = employees["operator"]
    first = upsert_customer_with_consent(
        db,
        organization_id=org.id,
        store_id=store.id,
        doc_type="13",
        doc_number="1001001001",
        dv=None,
        name="Ana Pérez",
        email=None,
        address=None,
        municipality_dane=None,
        consent=ConsentInput(text_version="v1", channel="pos"),
        actor=_FakeActor(cashier.id, cashier.name),
        now=now,
    )

    second = upsert_customer_with_consent(
        db,
        organization_id=org.id,
        store_id=store.id,
        doc_type="13",
        doc_number="1001001001",
        dv=None,
        name="Ana Pérez Gómez",
        email="ana@example.com",
        address="Cra 1 # 2-3",
        municipality_dane="11001",
        consent=ConsentInput(text_version="v1", channel="pos"),
        actor=_FakeActor(operator.id, operator.name),
        now=now,
    )

    assert second.id == first.id
    assert second.name == "Ana Pérez Gómez"
    assert second.email == "ana@example.com"

    all_customers = list(db.execute(select(Customer).where(Customer.organization_id == org.id)).scalars())
    assert len(all_customers) == 1

    consents = list(db.execute(select(CustomerConsent).where(CustomerConsent.customer_id == first.id)).scalars())
    assert len(consents) == 2  # una prueba de autorización por cada cobro, nunca se pisa la anterior


def test_disabled_feature_flag_returns_400_feature_disabled(
    db: Session, org: Organization, store: Store, employees: dict[str, Employee], set_feature: Any
) -> None:
    """Ronda 2 — B-2 (la parte de este territorio): el gate
    `features.assert_feature(db, organization_id, store_id, "customers")` en
    `app.customers.hooks.upsert_customer_with_consent` es la ÚNICA puerta de
    escritura del dispositivo hacia este dominio (defensa en profundidad; el
    orden dentro de `pay_order` es territorio de `backend-fiscal`, no de
    acá). Con la flag apagada, el gancho tiene que fallar con `400
    FEATURE_DISABLED` **antes de escribir una sola fila**: ni `Customer` ni
    `CustomerConsent` pueden quedar huérfanos de un cobro que el propio
    sistema rechazó."""

    set_feature("customers", False)
    cashier = employees["cashier"]

    customers_before = db.execute(select(func.count()).select_from(Customer)).scalar_one()
    consents_before = db.execute(select(func.count()).select_from(CustomerConsent)).scalar_one()

    with pytest.raises(AppError) as exc_info:
        upsert_customer_with_consent(
            db,
            organization_id=org.id,
            store_id=store.id,
            doc_type="13",
            doc_number="1001001001",
            dv=None,
            name="Ana Pérez",
            email=None,
            address=None,
            municipality_dane=None,
            consent=ConsentInput(text_version="v1", channel="pos"),
            actor=_FakeActor(cashier.id, cashier.name),
            now=clock_module.now_utc(),
        )
    assert exc_info.value.code == "FEATURE_DISABLED"
    assert exc_info.value.status == 400

    customers_after = db.execute(select(func.count()).select_from(Customer)).scalar_one()
    consents_after = db.execute(select(func.count()).select_from(CustomerConsent)).scalar_one()
    assert customers_after == customers_before, "el gate rechazó el cobro pero dejó un `Customer` escrito"
    assert consents_after == consents_before, "el gate rechazó el cobro pero dejó un `CustomerConsent` escrito"


def test_enabled_feature_flag_allows_creation(
    db: Session, org: Organization, store: Store, employees: dict[str, Employee], set_feature: Any
) -> None:
    set_feature("customers", True)
    cashier = employees["cashier"]
    customer = upsert_customer_with_consent(
        db,
        organization_id=org.id,
        store_id=store.id,
        doc_type="31",
        doc_number="900123456",
        dv="7",
        name="Restaurante Prueba SAS",
        email=None,
        address=None,
        municipality_dane=None,
        consent=ConsentInput(text_version="v1", channel="pos"),
        actor=_FakeActor(cashier.id, cashier.name),
        now=clock_module.now_utc(),
    )
    assert customer.id is not None
