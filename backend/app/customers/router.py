"""Endpoints admin del maestro de clientes (`/api/v1/admin/customers/...`).

El dispositivo nunca entra por acá (minimización, §8.4): sólo
`app.customers.hooks.upsert_customer_with_consent`, que llama `pay_order`.

Gate de la flag `customers`: se exige en el listado, la corrección y el
registro de un consentimiento nuevo (es la función de "llevar un CRM de
clientes", apagable). **`erase` y `requests` NUNCA se apagan** — son el
ejercicio de un derecho legal (habeas data, Ley 1581 de 2012), no una función
de producto; una organización que apagó `customers` después de haber creado
clientes no puede perder la vía para que alguien pida su supresión.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session

from app.auth.deps import Actor, current_admin
from app.core import clock, features
from app.core.csv import csv_response, wants_csv
from app.core.db import get_db
from app.customers import service
from app.customers.schemas import ConsentIn, ConsentOut, CustomerOut, CustomerPatchIn, DataRequestOut, EraseIn

router = APIRouter()


@router.get("/admin/customers")
def admin_list_customers(
    request: Request,
    doc_number: str | None = None,
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
    _feature: None = Depends(features.require_feature("customers")),
) -> Any:
    rows = service.list_customers(db, organization_id=actor.organization_id, doc_number=doc_number)
    out = [CustomerOut.model_validate(r) for r in rows]
    if wants_csv(request):
        return csv_response([r.model_dump(mode="json") for r in out], filename="customers.csv")
    return out


@router.patch("/admin/customers/{customer_id}")
def admin_patch_customer(
    customer_id: int,
    payload: CustomerPatchIn,
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
    _feature: None = Depends(features.require_feature("customers")),
) -> CustomerOut:
    customer = service.get_customer_or_404(db, organization_id=actor.organization_id, customer_id=customer_id)
    customer = service.patch_customer(db, actor=actor, customer=customer, payload=payload, now=clock.now_utc())
    return CustomerOut.model_validate(customer)


@router.post("/admin/customers/{customer_id}/consents", status_code=201)
def admin_add_consent(
    customer_id: int,
    payload: ConsentIn,
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
    _feature: None = Depends(features.require_feature("customers")),
) -> ConsentOut:
    customer = service.get_customer_or_404(db, organization_id=actor.organization_id, customer_id=customer_id)
    consent = service.add_consent(db, actor=actor, customer=customer, payload=payload, now=clock.now_utc())
    return ConsentOut.model_validate(consent)


@router.get("/admin/customers/{customer_id}/requests")
def admin_list_requests(
    customer_id: int,
    request: Request,
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> Any:
    customer = service.get_customer_or_404(db, organization_id=actor.organization_id, customer_id=customer_id)
    rows = [DataRequestOut.model_validate(r) for r in service.list_requests(db, customer=customer)]
    if wants_csv(request):
        return csv_response([r.model_dump(mode="json") for r in rows], filename="customer_requests.csv")
    return rows


@router.post("/admin/customers/{customer_id}/erase")
def admin_erase_customer(
    customer_id: int,
    payload: EraseIn,
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> CustomerOut:
    customer = service.get_customer_or_404(db, organization_id=actor.organization_id, customer_id=customer_id)
    customer = service.erase_customer(db, actor=actor, customer=customer, reason=payload.reason, now=clock.now_utc())
    return CustomerOut.model_validate(customer)
