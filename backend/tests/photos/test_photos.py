"""Una foto de verdad se guarda, y en la columna del dominio queda su dirección.

El defecto: la pantalla manda la foto como *data URL* y cada dominio la
guardaba tal cual en una columna `String(500)`. En Postgres el `INSERT`
fallaba por largo; SQLite no hace cumplir el largo y los tests usaban
`"c.jpg"`, así que nada lo veía. Estos tests mandan una foto del tamaño de
una de tablet y miran el **largo** de lo que quedó en la columna: eso es lo
que Postgres rechaza y SQLite no.
"""

from __future__ import annotations

import base64
from typing import Any
from uuid import uuid4

from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.photos.hooks import PHOTO_URL_PREFIX, REFERENCE_MAX_CHARS
from app.photos.models import Photo
from app.shifts.models import CashMovement, Shift, ShiftStatus

API = "/api/v1"

#: Unos 300 KB, lo que pesa una foto de tablet ya achicada. Los primeros bytes
#: son la firma de un JPEG; el resto no importa: el servidor no la dibuja.
FOTO_BYTES = b"\xff\xd8\xff\xe0" + bytes(range(256)) * 1200
FOTO = "data:image/jpeg;base64," + base64.b64encode(FOTO_BYTES).decode()


def _idem() -> dict[str, str]:
    return {"Idempotency-Key": str(uuid4())}


def _open_shift_id(db: Session) -> int:
    return db.scalars(select(Shift.id).where(Shift.status == ShiftStatus.OPEN)).one()


def _movement(device_client: TestClient, shift_id: int, **extra: Any) -> Any:
    return device_client.post(
        f"{API}/shifts/{shift_id}/cash-movements",
        json={"kind": "expense", "cause": "petty_expense", "amount": 5_000, "note": "hielo", **extra},
        headers=_idem(),
    )


def test_a_real_photo_is_stored_and_the_column_keeps_only_its_address(
    device_client: TestClient, open_shift: Any, db: Session
) -> None:
    open_shift()
    shift_id = _open_shift_id(db)

    resp = _movement(device_client, shift_id, receipt_photo=FOTO)
    assert resp.status_code in (200, 201), resp.text

    guardada = db.scalars(select(CashMovement.receipt_photo).where(CashMovement.shift_id == shift_id)).one()
    assert guardada is not None
    assert guardada.startswith(PHOTO_URL_PREFIX)
    # Lo que Postgres hace cumplir y SQLite no: que quepa en la columna.
    assert len(guardada) <= REFERENCE_MAX_CHARS

    photo = db.get(Photo, int(guardada.removeprefix(PHOTO_URL_PREFIX)))
    assert photo is not None
    assert photo.data == FOTO_BYTES
    assert photo.content_type == "image/jpeg"


def test_the_photo_is_served_to_its_organization_and_to_no_other(
    device_client: TestClient, open_shift: Any, db: Session, admin_client: TestClient, org_b: Any
) -> None:
    open_shift()
    shift_id = _open_shift_id(db)
    assert _movement(device_client, shift_id, receipt_photo=FOTO).status_code in (200, 201)
    direccion = db.scalars(select(CashMovement.receipt_photo).where(CashMovement.shift_id == shift_id)).one()
    assert direccion is not None

    ver = admin_client.get(direccion)
    assert ver.status_code == 200, ver.text
    assert ver.headers["content-type"] == "image/jpeg"
    assert ver.content == FOTO_BYTES

    # La tablet que la sacó también la ve (el turno muestra lo que registró).
    assert device_client.get(direccion).status_code == 200

    # Otra organización: 404, igual que una foto que no existe.
    photo = db.get(Photo, int(direccion.removeprefix(PHOTO_URL_PREFIX)))
    assert photo is not None
    photo.organization_id = org_b.id
    photo.store_id = None
    db.flush()
    assert admin_client.get(direccion).status_code == 404


def test_an_unreadable_photo_is_rejected_before_anything_is_written(
    device_client: TestClient, open_shift: Any, db: Session
) -> None:
    open_shift()
    shift_id = _open_shift_id(db)

    for mala in ("data:image/jpeg;base64,esto no es base64 !!!", "data:application/pdf;base64,JVBERi0=", "x" * 600):
        resp = _movement(device_client, shift_id, receipt_photo=mala)
        # La app responde los errores de esquema como 400 `VALIDATION_ERROR`.
        assert resp.status_code == 400, resp.text
        assert resp.json()["error"]["code"] == "VALIDATION_ERROR"

    assert db.scalars(select(CashMovement).where(CashMovement.shift_id == shift_id)).all() == []
    assert db.scalars(select(Photo)).all() == []


def test_a_short_reference_passes_as_it_came(device_client: TestClient, open_shift: Any, db: Session) -> None:
    """Lo que ya era una dirección (o `"c.jpg"` en los tests de siempre) no se
    toca: sólo una *data URL* se muda a la tabla."""
    open_shift()
    shift_id = _open_shift_id(db)
    assert _movement(device_client, shift_id, receipt_photo="c.jpg").status_code in (200, 201)
    assert db.scalars(select(CashMovement.receipt_photo).where(CashMovement.shift_id == shift_id)).one() == "c.jpg"
    assert db.scalars(select(Photo)).all() == []
