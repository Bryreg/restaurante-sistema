"""Administración del maestro de clientes (`app.customers.router`): listar,
corregir, consentimientos, bitácora de habeas data y `erase`.

El dispositivo NUNCA pasa por acá — sólo por `app.customers.hooks
.upsert_customer_with_consent` (creación/actualización al cobrar). Este
módulo es exclusivamente lo que el admin ve y hace desde PC.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.audit.service import record_audit
from app.core.errors import AppError, NotFoundError
from app.customers.models import (
    ERASED_DOC_TYPE,
    ERASED_NAME,
    ConsentPurpose,
    Customer,
    CustomerConsent,
    CustomerDataRequest,
    DataRequestKind,
)
from app.customers.schemas import ConsentIn, CustomerPatchIn


def _customer_audit_view(key: str, *fields: str) -> dict[str, list[str]]:
    """`before`/`after` de `record_audit(entity="customer")` (precedente **A-7**,
    `app/auth/router.py::_employee_audit_view`, ya resuelto en 1b-1 para
    empleados): `audit_logs` se conserva años y se exporta, así que nunca
    lleva el VALOR de un dato personal — sólo el NOMBRE de los campos que
    cambiaron o se limpiaron. La traza del hecho (quién, cuándo, por qué)
    queda en `record_audit` (actor/reason) y en `CustomerDataRequest`, que sí
    son la bitácora de habeas data que exige §8.4; lo que este helper evita
    es que el dato que el titular pidió corregir o suprimir sobreviva
    igual, sin querer, en la fila que prueba que se corrigió o se suprimió.
    Único punto del módulo que arma estos `dict`, para que ningún llamador
    futuro vuelva a colar un valor de PII ahí.
    """

    return {key: list(fields)}


def get_customer_or_404(db: Session, *, organization_id: int, customer_id: int) -> Customer:
    customer = db.get(Customer, customer_id)
    if customer is None or customer.organization_id != organization_id:
        raise NotFoundError("El cliente no existe en esta organización")
    return customer


def list_customers(
    db: Session, *, organization_id: int, doc_number: str | None = None
) -> list[Customer]:
    stmt = select(Customer).where(Customer.organization_id == organization_id)
    if doc_number:
        stmt = stmt.where(Customer.doc_number.contains(doc_number))
    stmt = stmt.order_by(Customer.name)
    return list(db.execute(stmt).scalars())


def patch_customer(
    db: Session,
    *,
    actor: Any,
    customer: Customer,
    payload: CustomerPatchIn,
    now: datetime,
) -> Customer:
    if customer.erased_at is not None:
        raise AppError(
            code="CUSTOMER_ERASED",
            message="Este cliente fue anonimizado por una solicitud de supresión; no se puede editar",
            status=400,
        )

    changed_fields: list[str] = []
    for field in ("name", "email", "address", "municipality_dane", "dv"):
        value = getattr(payload, field)
        if value is not None and value != getattr(customer, field):
            setattr(customer, field, value)
            changed_fields.append(field)
    if not changed_fields:
        return customer

    customer.updated_at = now
    db.flush()

    db.add(
        CustomerDataRequest(
            customer_id=customer.id,
            organization_id=customer.organization_id,
            store_id=customer.store_id,
            kind=DataRequestKind.RECTIFY,
            note="Corrección de datos por el administrador",
            response="Datos actualizados",
            requested_at=now,
            responded_at=now,
            employee_id=getattr(actor, "employee_id", None),
            employee_name=getattr(actor, "employee_name", None),
        )
    )
    # Ronda 2 — B-1: `before`/`after` NUNCA llevan el valor del dato personal,
    # sólo los nombres de los campos que cambiaron (ver `_customer_audit_view`);
    # el valor de quién/cuándo/por qué ya queda en `CustomerDataRequest` arriba.
    record_audit(
        db,
        actor=actor,
        organization_id=customer.organization_id,
        store_id=customer.store_id,
        entity="customer",
        entity_id=customer.id,
        action="rectify",
        before=None,
        after=_customer_audit_view("changed_fields", *changed_fields),
        reason="Rectificación (habeas data §8.4)",
    )
    db.flush()
    return customer


def add_consent(
    db: Session,
    *,
    actor: Any,
    customer: Customer,
    payload: ConsentIn,
    now: datetime,
) -> CustomerConsent:
    if customer.erased_at is not None:
        raise AppError(
            code="CUSTOMER_ERASED",
            message="Este cliente fue anonimizado por una solicitud de supresión; no se puede registrar un nuevo consentimiento",
            status=400,
        )

    row = CustomerConsent(
        customer_id=customer.id,
        organization_id=customer.organization_id,
        store_id=customer.store_id,
        purpose=ConsentPurpose(payload.purpose),
        granted=payload.granted,
        channel=payload.channel,
        text_version=payload.text_version,
        registered_by_employee_id=getattr(actor, "employee_id", None),
        registered_by_employee_name=getattr(actor, "employee_name", None),
        at=now,
    )
    db.add(row)

    if not payload.granted:
        db.add(
            CustomerDataRequest(
                customer_id=customer.id,
                organization_id=customer.organization_id,
                store_id=customer.store_id,
                kind=DataRequestKind.REVOKE,
                note=f"Revocación de consentimiento ({payload.purpose})",
                response="Consentimiento marcado como no otorgado",
                requested_at=now,
                responded_at=now,
                employee_id=getattr(actor, "employee_id", None),
                employee_name=getattr(actor, "employee_name", None),
            )
        )

    record_audit(
        db,
        actor=actor,
        organization_id=customer.organization_id,
        store_id=customer.store_id,
        entity="customer_consent",
        entity_id=customer.id,
        action="consent",
        before=None,
        after={"purpose": payload.purpose, "granted": payload.granted, "channel": payload.channel},
        reason=None,
    )
    db.flush()
    return row


def list_consents(db: Session, *, customer: Customer) -> list[CustomerConsent]:
    stmt = (
        select(CustomerConsent)
        .where(CustomerConsent.customer_id == customer.id)
        .order_by(CustomerConsent.at.desc())
    )
    return list(db.execute(stmt).scalars())


def list_requests(db: Session, *, customer: Customer) -> list[CustomerDataRequest]:
    stmt = (
        select(CustomerDataRequest)
        .where(CustomerDataRequest.customer_id == customer.id)
        .order_by(CustomerDataRequest.requested_at.desc())
    )
    return list(db.execute(stmt).scalars())


def erase_customer(
    db: Session,
    *,
    actor: Any,
    customer: Customer,
    reason: str,
    now: datetime,
) -> Customer:
    """Anonimiza el maestro (§8.4 "suprimir"): nombre, correo, dirección y
    documento del maestro pasan a un placeholder ÚNICO por fila (libera el
    documento original para una futura compra). **Nunca toca
    `fiscal_documents`**: no se importa ni se escribe ese modelo acá — el
    snapshot de cualquier documento ya emitido queda intacto porque este
    módulo, por diseño, no tiene ninguna escritura hacia ese dominio.

    Idempotente: volver a llamar sobre un cliente ya anonimizado no cambia
    nada (ni pisa `erased_at` original) y devuelve el mismo estado."""

    if customer.erased_at is not None:
        return customer

    customer.name = ERASED_NAME
    customer.email = None
    customer.address = None
    customer.municipality_dane = None
    customer.dv = None
    customer.doc_type = ERASED_DOC_TYPE
    customer.doc_number = f"ERASED-{customer.id}"
    customer.erased_at = now
    customer.erased_by_employee_id = getattr(actor, "employee_id", None)
    customer.erased_by_employee_name = getattr(actor, "employee_name", None)
    customer.updated_at = now
    db.flush()

    db.add(
        CustomerDataRequest(
            customer_id=customer.id,
            organization_id=customer.organization_id,
            store_id=customer.store_id,
            kind=DataRequestKind.ERASE,
            note=reason,
            response="Maestro anonimizado; los documentos fiscales ya emitidos conservan su snapshot intacto",
            requested_at=now,
            responded_at=now,
            employee_id=getattr(actor, "employee_id", None),
            employee_name=getattr(actor, "employee_name", None),
        )
    )
    # Ronda 2 — B-1: `before` NO copia el dato que el titular pidió suprimir
    # (nombre, correo, dirección, municipio, dv, documento) — eso dejaría
    # exactamente lo suprimido, intacto, en `audit_logs` (que se conserva
    # años y se exporta), en el mismo acto de borrarlo. `after` se queda con
    # los placeholders (`ERASED_NAME`/`ERASED_DOC_TYPE`/`ERASED-{id}`): no son
    # datos del titular, son la marca de que se anonimizó. La traza del
    # hecho (quién, cuándo, por qué) sigue completa en `record_audit`
    # (actor/reason) y en el `CustomerDataRequest(kind=ERASE)` de arriba.
    record_audit(
        db,
        actor=actor,
        organization_id=customer.organization_id,
        store_id=customer.store_id,
        entity="customer",
        entity_id=customer.id,
        action="erase",
        before=_customer_audit_view(
            "cleared_fields", "name", "email", "address", "municipality_dane", "dv", "doc_number"
        ),
        after={"name": ERASED_NAME, "doc_type": ERASED_DOC_TYPE, "doc_number": customer.doc_number},
        reason=reason,
    )
    db.flush()
    return customer
