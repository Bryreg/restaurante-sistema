"""El invariante más delicado de este dominio (`docs/SPEC-NEGOCIO.md §8.4`):
`POST /admin/customers/{id}/erase` anonimiza el maestro (`Customer`) pero
**deja intacto** el snapshot de cliente que ya quedó congelado en un
`FiscalDocument` emitido (`customer_doc_type`/`customer_doc_number`/
`customer_name`) — un documento fiscal es evidencia inmutable (conservación
5 años, §8.3), y "suprimir" nunca puede tocarlo.

`PaymentIn` todavía no tiene un campo `customer` (eso es 1b-2/`backend-fiscal`,
ver `gaps`), así que este test simula lo que la integración futura hará: crea
un documento real (con el snapshot por defecto de "Consumidor final"), crea
un `Customer` con el gancho, y actualiza el snapshot del documento a mano
para que coincida con ese cliente — exactamente el mismo dato que
`pay_order` escribiría una vez conectado. Con eso emula
"emitir → borrar → verificar el snapshot" de punta a punta sin tocar
`app/payments` (fuera de mi territorio)."""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.core import clock as clock_module
from app.customers.hooks import ConsentInput, upsert_customer_with_consent
from app.fiscal.models import FiscalDocument
from app.stores.models import Organization, Store


class _FakeActor:
    def __init__(self, employee_id: int, employee_name: str) -> None:
        self.employee_id = employee_id
        self.employee_name = employee_name


def test_erase_anonymizes_the_master_but_the_document_snapshot_stays_exact(
    admin_client: TestClient, db: Session, org: Organization, store: Store, paid_order: Any
) -> None:
    # 1. Emitir: una venta real con su `FiscalDocument`.
    payment = paid_order()
    document_id = payment["document"]["id"]

    # 2. El cliente identificado en ESA venta (simulando la integración
    #    futura de `pay_order` con `app.customers.hooks`).
    customer = upsert_customer_with_consent(
        db,
        organization_id=org.id,
        store_id=store.id,
        doc_type="13",
        doc_number="1234567890",
        dv=None,
        name="Ana Pérez",
        email="ana@example.com",
        address="Cra 1 # 2-3",
        municipality_dane="11001",
        consent=ConsentInput(text_version="v1", channel="pos"),
        actor=_FakeActor(1, "Cajero"),
        now=clock_module.now_utc(),
    )
    document = db.get(FiscalDocument, document_id)
    assert document is not None
    document.customer_doc_type = "13"
    document.customer_doc_number = "1234567890"
    document.customer_name = "Ana Pérez"
    db.commit()

    snapshot_before = {
        "customer_doc_type": document.customer_doc_type,
        "customer_doc_number": document.customer_doc_number,
        "customer_name": document.customer_name,
        "total": document.total,
        "subtotal": document.subtotal,
        "tax_total": document.tax_total,
    }

    # 3. Borrar: `erase` del maestro.
    erase_resp = admin_client.post(f"/api/v1/admin/customers/{customer.id}/erase", json={"reason": "El titular lo pidió"})
    assert erase_resp.status_code == 200, erase_resp.text
    erased = erase_resp.json()
    assert erased["name"] == "Cliente anonimizado"
    assert erased["doc_type"] == "ERASED"
    assert erased["doc_number"] != "1234567890"
    assert erased["email"] is None
    assert erased["address"] is None

    # 4. Verificar: el snapshot del documento sigue EXACTO — ni una columna
    #    de `fiscal_documents` se tocó.
    db.refresh(document)
    assert document.customer_doc_type == snapshot_before["customer_doc_type"]
    assert document.customer_doc_number == snapshot_before["customer_doc_number"]
    assert document.customer_name == snapshot_before["customer_name"]
    assert document.total == snapshot_before["total"]
    assert document.subtotal == snapshot_before["subtotal"]
    assert document.tax_total == snapshot_before["tax_total"]
