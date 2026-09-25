"""Una consignación con la foto real del comprobante se registra.

Antes el esquema la rechazaba (`max_length=500`) y, si no, lo hacía Postgres
por el largo de la columna. Ver `tests/photos/test_photos.py`.
"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from app.photos.hooks import PHOTO_URL_PREFIX, REFERENCE_MAX_CHARS
from tests.banking.conftest import idem, today_business_date
from tests.photos.test_photos import FOTO

API = "/api/v1"


def test_a_deposit_with_a_real_receipt_photo_is_registered(admin_client: TestClient, store: Any) -> None:
    resp = admin_client.post(
        f"{API}/admin/deposits",
        params={"store_id": store.id},
        json={"amount": 15_000, "receipt_photo": FOTO, "business_date": today_business_date(store).isoformat()},
        headers=idem(),
    )
    assert resp.status_code == 201, resp.text
    direccion = resp.json()["receipt_photo"]
    assert direccion.startswith(PHOTO_URL_PREFIX)
    assert len(direccion) <= REFERENCE_MAX_CHARS
    assert admin_client.get(direccion).status_code == 200
