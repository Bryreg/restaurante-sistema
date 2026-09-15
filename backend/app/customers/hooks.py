"""Gancho que consume `app.payments.service.pay_order` (territorio ajeno) al
cobrar con datos de cliente (`customer?: {...}` del contrato de
«Payments & fiscal document»).

`upsert_customer_with_consent` es la ÚNICA puerta por la que el dispositivo
crea o toca un `Customer`: nunca lo lista, nunca lo exporta (minimización,
`docs/SPEC-NEGOCIO.md §8.4`). El test de punta a punta de este gancho
(cobrar con `customer` en el payload y verificar que el maestro quedó
correcto) es responsabilidad de quien lo llama — hoy
`app.fiscal.service.resolve_customer_snapshot`, llamado desde `pay_order`
(territorio ajeno); acá sólo se prueba la función directamente, más un test
que confirma que acepta la forma exacta con la que ya la están llamando
(`consent` como `dict` plano, ver `_consent_fields`).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any, Protocol

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core import features
from app.customers.models import ConsentPurpose, Customer, CustomerConsent


class ActorLike(Protocol):
    """Lo mínimo que este gancho necesita del actor que cobra: no se importa
    `app.auth.deps.Actor` directo para no atar la firma a un tipo concreto de
    otro dominio más de lo necesario — cualquier objeto con estos dos
    atributos sirve (así lo documenta la firma pública del contrato)."""

    employee_id: int | None
    employee_name: str | None


@dataclass(frozen=True)
class ConsentInput:
    """Lo que trae `customer.consent` en el payload de `POST
    /orders/{id}/payments` (§«Payments & fiscal document»): sólo texto y
    canal — la finalidad es siempre `invoice` (los datos que se piden en el
    cobro son, por definición, para facturar) y `granted=True` (proveer los
    datos para pedir la factura ES el acto de autorizar esa finalidad).

    `consent` acepta esta clase, cualquier objeto con esos dos atributos
    (un esquema Pydantic, por ejemplo) o un `dict` plano
    (`{"text_version": ..., "channel": ...}`, la forma que usa hoy
    `app.fiscal.service.resolve_customer_snapshot` con
    `customer_in.consent.model_dump()`): `_consent_fields` normaliza
    cualquiera de las tres antes de escribir."""

    text_version: str
    channel: str


def _consent_fields(consent: "ConsentInput | dict[str, Any] | Any") -> tuple[str, str]:
    if isinstance(consent, dict):
        return str(consent["text_version"]), str(consent["channel"])
    return str(consent.text_version), str(consent.channel)


def upsert_customer_with_consent(
    db: Session,
    *,
    organization_id: int,
    store_id: int,
    doc_type: str,
    doc_number: str,
    dv: str | None,
    name: str,
    email: str | None,
    address: str | None,
    municipality_dane: str | None,
    consent: "ConsentInput | dict[str, Any] | Any",
    actor: ActorLike | Any,
    now: datetime,
) -> Customer:
    """Busca un `Customer` de la organización por `(doc_type, doc_number)`; si
    existe lo actualiza con los datos más recientes (la persona reutiliza su
    documento en varias sedes de la misma cadena — SPEC-NEGOCIO §8.3), si no
    lo crea. Siempre agrega una fila nueva de `CustomerConsent` (prueba de que
    ESTE cobro recolectó los datos con autorización, no sólo el primero).

    `400 FEATURE_DISABLED` si la flag `customers` está apagada en la sede: es
    la única puerta de escritura del dispositivo hacia este dominio, así que
    el gate vive acá (no depende de que cada llamador lo repita).
    """

    features.assert_feature(db, organization_id, store_id, "customers")

    existing = db.execute(
        select(Customer).where(
            Customer.organization_id == organization_id,
            Customer.doc_type == doc_type,
            Customer.doc_number == doc_number,
        )
    ).scalar_one_or_none()

    if existing is None:
        customer = Customer(
            organization_id=organization_id,
            store_id=store_id,
            doc_type=doc_type,
            doc_number=doc_number,
            dv=dv,
            name=name,
            email=email,
            address=address,
            municipality_dane=municipality_dane,
            created_at=now,
            updated_at=now,
        )
        db.add(customer)
    else:
        customer = existing
        customer.store_id = store_id
        customer.dv = dv
        customer.name = name
        customer.email = email
        customer.address = address
        customer.municipality_dane = municipality_dane
        customer.updated_at = now
    db.flush()

    text_version, channel = _consent_fields(consent)
    db.add(
        CustomerConsent(
            customer_id=customer.id,
            organization_id=organization_id,
            store_id=store_id,
            purpose=ConsentPurpose.INVOICE,
            granted=True,
            channel=channel,
            text_version=text_version,
            registered_by_employee_id=getattr(actor, "employee_id", None),
            registered_by_employee_name=getattr(actor, "employee_name", None),
            at=now,
        )
    )
    db.flush()
    return customer
