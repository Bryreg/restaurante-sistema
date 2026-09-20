"""D-4: la supresión por habeas data alcanza a `pending_refunds`
(`features/fase-3-dinero-control/spec.md § 1`, territorio T1 — única
excepción autorizada a tocar `app/refunds/service.py` **y**, para el wiring
de este mismo punto, la única línea agregada a
`app/customers/service.py::erase_customer` (bloqueante C1/H-1 de la
iteración 2, ya cerrado).

`test_erase_customer_over_http_anonymizes_pending_refunds` es el test que
cierra ese bloqueante: entra por la puerta real
(`POST /api/v1/admin/customers/{id}/erase`), no por la función de servicio
directa — el hallazgo era exactamente que el camino HTTP no tocaba
`pending_refunds`.

**Excepción declarada, para el resto de los tests de este archivo**:
prueban `app.refunds.service.anonymize_pending_refunds_for_customer`
DIRECTO (no por HTTP) porque son tests de unidad de esa función — el
detalle fino de qué campo se anonimiza, la idempotencia, el `before` de la
auditoría — y no hay una ruta HTTP propia para exponer ese detalle (no hay
`GET .../pending-refunds/{id}` pensado para eso). El camino de integración
real ya lo cubre el primer test. `Customer`/`PendingRefund` se arman
DIRECTO por ORM en todos los casos: son precondiciones de OTRO dominio,
mismo criterio que `tests/banking/conftest.py` ya declara (docstring del
archivo, sobre `tests/channels/conftest.py`).
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.customers.models import Customer
from app.refunds import service as refunds_service
from app.refunds.models import PendingRefund, PendingRefundStatus, SettleFrom


class _Actor:
    def __init__(self, employee_id: int, employee_name: str) -> None:
        self.employee_id = employee_id
        self.employee_name = employee_name
        self.kind = "admin"


def _make_customer(db: Session, *, store: Any, doc_number: str) -> Customer:
    """`PendingRefund.customer_id` es FK real a `customers.id`: precondición
    de OTRO dominio, armada mínima por ORM directo (declarado)."""

    now = datetime.now(timezone.utc)
    customer = Customer(
        organization_id=store.organization_id,
        store_id=store.id,
        doc_type="13",
        doc_number=doc_number,
        dv=None,
        name="Juan Pérez",
        email=None,
        address=None,
        municipality_dane=None,
        created_at=now,
        updated_at=now,
    )
    db.add(customer)
    db.commit()
    db.refresh(customer)
    return customer


def _make_refund(db: Session, *, store: Any, document_id: int, customer_id: int | None) -> PendingRefund:
    now = datetime.now(timezone.utc)
    refund = PendingRefund(
        organization_id=store.organization_id,
        store_id=store.id,
        document_id=document_id,
        customer_id=customer_id,
        customer_name="Juan Pérez",
        customer_doc_number="1234567890",
        amount=15_000,
        method="cash",
        authorized_by_employee_id=1,
        authorized_by_employee_name="Admin",
        requested_at=now,
        status=PendingRefundStatus.PENDING,
    )
    db.add(refund)
    db.commit()
    db.refresh(refund)
    return refund


def test_anonymize_clears_name_keeps_doc_number_and_money(
    db: Session,
    make_payment: Any,
    open_shift: Any,
    store: Any,
) -> None:
    shift = open_shift(total=200_000)
    sale = make_payment(shift=shift, method="cash", amount=30_000)
    document_id = sale["document"]["id"]

    customer = _make_customer(db, store=store, doc_number="1111111111")
    refund = _make_refund(db, store=store, document_id=document_id, customer_id=customer.id)

    actor = _Actor(employee_id=1, employee_name="Admin")
    count = refunds_service.anonymize_pending_refunds_for_customer(
        db,
        actor=actor,
        organization_id=store.organization_id,
        customer_id=customer.id,
        reason="El titular ejerció su derecho de supresión (Ley 1581 de 2012)",
        now=datetime.now(timezone.utc),
    )
    db.commit()
    assert count == 1

    db.refresh(refund)
    assert refund.customer_name == refunds_service.ANONYMIZED_CUSTOMER_NAME
    assert refund.customer_name != "Juan Pérez"

    # Nada financiero se toca: el documento sigue siendo el mismo (pagadera
    # a quien aparezca con el documento), el monto, quién autorizó y el
    # estado no se movieron.
    assert refund.customer_doc_number == "1234567890"
    assert refund.amount == 15_000
    assert refund.document_id == document_id
    assert refund.authorized_by_employee_id == 1
    assert refund.status == PendingRefundStatus.PENDING


def test_anonymize_is_idempotent_and_does_not_duplicate_audit(
    db: Session,
    make_payment: Any,
    open_shift: Any,
    store: Any,
) -> None:
    from app.audit.models import AuditLog

    shift = open_shift(total=200_000)
    sale = make_payment(shift=shift, method="cash", amount=30_000)
    document_id = sale["document"]["id"]
    customer = _make_customer(db, store=store, doc_number="2222222222")
    refund = _make_refund(db, store=store, document_id=document_id, customer_id=customer.id)

    actor = _Actor(employee_id=1, employee_name="Admin")
    now = datetime.now(timezone.utc)

    first = refunds_service.anonymize_pending_refunds_for_customer(
        db, actor=actor, organization_id=store.organization_id, customer_id=customer.id, reason="Supresión", now=now
    )
    db.commit()
    second = refunds_service.anonymize_pending_refunds_for_customer(
        db, actor=actor, organization_id=store.organization_id, customer_id=customer.id, reason="Supresión otra vez", now=now
    )
    db.commit()

    assert first == 1
    assert second == 0  # ya estaba anonimizada: no vuelve a tocar nada

    logs = list(
        db.execute(
            select(AuditLog).where(AuditLog.entity == "pending_refund", AuditLog.entity_id == str(refund.id))
        ).scalars()
    )
    assert len(logs) == 1, "una segunda llamada idempotente no puede duplicar la auditoría"


def test_audit_before_never_carries_the_suppressed_value(
    db: Session,
    make_payment: Any,
    open_shift: Any,
    store: Any,
) -> None:
    """La lección del bloqueante B-1 de 1b-2: `before` guarda sólo NOMBRES
    de campo, nunca el dato personal suprimido."""

    from app.audit.models import AuditLog

    shift = open_shift(total=200_000)
    sale = make_payment(shift=shift, method="cash", amount=30_000)
    document_id = sale["document"]["id"]
    customer = _make_customer(db, store=store, doc_number="3333333333")
    refund = _make_refund(db, store=store, document_id=document_id, customer_id=customer.id)

    actor = _Actor(employee_id=1, employee_name="Admin")
    refunds_service.anonymize_pending_refunds_for_customer(
        db,
        actor=actor,
        organization_id=store.organization_id,
        customer_id=customer.id,
        reason="Supresión",
        now=datetime.now(timezone.utc),
    )
    db.commit()

    log = db.execute(
        select(AuditLog).where(AuditLog.entity == "pending_refund", AuditLog.entity_id == str(refund.id))
    ).scalar_one()
    assert log.before == {"cleared_fields": ["customer_name"]}
    assert "Juan Pérez" not in str(log.before)
    assert "Juan Pérez" not in str(log.after)


def test_anonymize_only_touches_the_named_customer(
    db: Session,
    make_payment: Any,
    open_shift: Any,
    store: Any,
) -> None:
    shift = open_shift(total=200_000)
    sale = make_payment(shift=shift, method="cash", amount=30_000)
    document_id = sale["document"]["id"]

    customer_a = _make_customer(db, store=store, doc_number="4444444444")
    customer_b = _make_customer(db, store=store, doc_number="5555555555")
    mine = _make_refund(db, store=store, document_id=document_id, customer_id=customer_a.id)
    other = _make_refund(db, store=store, document_id=document_id, customer_id=customer_b.id)

    actor = _Actor(employee_id=1, employee_name="Admin")
    refunds_service.anonymize_pending_refunds_for_customer(
        db,
        actor=actor,
        organization_id=store.organization_id,
        customer_id=customer_a.id,
        reason="Supresión",
        now=datetime.now(timezone.utc),
    )
    db.commit()

    db.refresh(mine)
    db.refresh(other)
    assert mine.customer_name == refunds_service.ANONYMIZED_CUSTOMER_NAME
    assert other.customer_name == "Juan Pérez"


def test_settle_from_owner_is_the_documented_no_cash_movement_path(
    db: Session,
    make_payment: Any,
    open_shift: Any,
    store: Any,
) -> None:
    """No es parte de D-4, pero es la costura que `owner_hand` lee
    (`app/banking/service.py::owner_hand`): confirma que saldar «de la mano
    del dueño» efectivamente no crea `CashMovement`, así como lo documenta
    `app.refunds.service.settle_pending_refund`."""

    from app.shifts.models import CashMovement

    shift = open_shift(total=200_000)
    sale = make_payment(shift=shift, method="cash", amount=30_000)
    document_id = sale["document"]["id"]
    refund = _make_refund(db, store=store, document_id=document_id, customer_id=None)

    actor = _Actor(employee_id=1, employee_name="Admin")
    before_count = db.execute(select(CashMovement)).scalars().all()

    refunds_service.settle_pending_refund(
        db, actor=actor, pending_refund=refund, settle_from="owner", shift_id=None, now=datetime.now(timezone.utc)
    )
    db.commit()

    after_count = db.execute(select(CashMovement)).scalars().all()
    assert len(after_count) == len(before_count), "settle_from=owner no puede crear un CashMovement"
    assert refund.settled_from == SettleFrom.OWNER


def test_erase_customer_over_http_anonymizes_pending_refunds(
    db: Session,
    admin_client: TestClient,
    make_payment: Any,
    open_shift: Any,
    store: Any,
) -> None:
    """Cierra el bloqueante C1/H-1 (iteración 2): antes de este wiring,
    `anonymize_pending_refunds_for_customer` no tenía ningún punto de
    llamada real — sólo la llamaban directo los propios tests de este
    archivo. Este test entra por la puerta real,
    `POST /api/v1/admin/customers/{id}/erase`, precisamente porque el
    hallazgo era que ESE camino no tocaba `pending_refunds`."""

    shift = open_shift(total=200_000)
    sale = make_payment(shift=shift, method="cash", amount=30_000)
    document_id = sale["document"]["id"]

    customer = _make_customer(db, store=store, doc_number="9999999999")
    refund = _make_refund(db, store=store, document_id=document_id, customer_id=customer.id)

    resp = admin_client.post(
        f"/api/v1/admin/customers/{customer.id}/erase",
        json={"reason": "El titular ejerció su derecho de supresión (Ley 1581 de 2012)"},
    )
    assert resp.status_code == 200, resp.text

    db.refresh(refund)
    assert refund.customer_name == refunds_service.ANONYMIZED_CUSTOMER_NAME
    assert refund.customer_name != "Juan Pérez"

    # D-4: nada financiero se toca por la supresión — mismo criterio que
    # el test de unidad de arriba, verificado ahora de punta a punta.
    assert refund.amount == 15_000
    assert refund.document_id == document_id
    assert refund.status == PendingRefundStatus.PENDING
    assert refund.customer_doc_number == "1234567890"


def test_erase_customer_over_http_is_idempotent_for_pending_refunds(
    db: Session,
    admin_client: TestClient,
    make_payment: Any,
    open_shift: Any,
    store: Any,
) -> None:
    """Llamar `erase` dos veces por HTTP no duplica auditoría ni rompe nada
    (el guard `customer.erased_at is not None: return customer` de
    `erase_customer` hace que la segunda llamada ni siquiera intente
    anonimizar `pending_refunds` de nuevo)."""

    from app.audit.models import AuditLog

    shift = open_shift(total=200_000)
    sale = make_payment(shift=shift, method="cash", amount=30_000)
    document_id = sale["document"]["id"]

    customer = _make_customer(db, store=store, doc_number="8888888888")
    refund = _make_refund(db, store=store, document_id=document_id, customer_id=customer.id)

    payload = {"reason": "El titular ejerció su derecho de supresión (Ley 1581 de 2012)"}
    first = admin_client.post(f"/api/v1/admin/customers/{customer.id}/erase", json=payload)
    assert first.status_code == 200, first.text
    second = admin_client.post(f"/api/v1/admin/customers/{customer.id}/erase", json=payload)
    assert second.status_code == 200, second.text

    db.refresh(refund)
    assert refund.customer_name == refunds_service.ANONYMIZED_CUSTOMER_NAME

    logs = list(
        db.execute(
            select(AuditLog).where(AuditLog.entity == "pending_refund", AuditLog.entity_id == str(refund.id))
        ).scalars()
    )
    assert len(logs) == 1, "la segunda llamada HTTP a erase no puede duplicar la auditoría de pending_refund"
