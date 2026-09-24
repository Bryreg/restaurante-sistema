"""El único punto por donde otro dominio guarda una foto.

`store_photo` recibe lo que mandó la pantalla y devuelve lo que se guarda en
la columna del dominio:

- una *data URL* de imagen → la decodifica, la guarda en `photos` y devuelve
  `/api/v1/photos/<id>`;
- cualquier otro texto (una dirección que ya existía, `"c.jpg"` en los tests)
  → tal cual, siempre que quepa en la columna (500);
- `None` → `None`.

La foto se **valida al entrar** (`PhotoIn`, en el esquema de cada pedido):
una foto ilegible es un 422 antes de que el servicio escriba nada, así que
`store_photo` ya no tiene por qué rechazarla a mitad de una operación
(`tests/audit/test_write_before_reject.py`). Se llama justo antes de
construir el registro, después de las validaciones de negocio: una foto de un
retiro rechazado no queda guardada huérfana.
"""

from __future__ import annotations

import base64
import binascii
from typing import Annotated

from pydantic import AfterValidator, Field
from sqlalchemy.orm import Session

from app.core import clock
from app.core.errors import AppError
from app.photos.models import Photo

PHOTO_URL_PREFIX = "/api/v1/photos/"

#: Lo más grande que se acepta ya decodificado. La tablet la achica antes de
#: mandarla (~200 KB); esto es el techo para una foto que llegue sin achicar.
MAX_PHOTO_BYTES = 4_000_000

#: El largo máximo del campo en los esquemas de entrada: la *data URL* en
#: base64 ocupa 4/3 de los bytes, más el encabezado.
PHOTO_FIELD_MAX_CHARS = MAX_PHOTO_BYTES * 4 // 3 + 64

#: El largo de las columnas donde cada dominio guarda la dirección.
REFERENCE_MAX_CHARS = 500

ALLOWED_TYPES = frozenset({"image/jpeg", "image/png", "image/webp"})


def _decode(value: str) -> tuple[str, bytes]:
    """`(content_type, bytes)` de una *data URL* de imagen, o `ValueError` con
    el motivo en palabras."""
    header, sep, payload = value.partition(",")
    content_type = header[len("data:") :].split(";")[0].strip().lower()
    if not sep or ";base64" not in header or content_type not in ALLOWED_TYPES:
        raise ValueError("La foto tiene que ser una imagen JPG, PNG o WebP")
    try:
        data = base64.b64decode(payload, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ValueError("La foto no se pudo leer: volvé a tomarla") from exc
    if not data:
        raise ValueError("La foto está vacía: volvé a tomarla")
    if len(data) > MAX_PHOTO_BYTES:
        raise ValueError("La foto es demasiado grande (más de 4 MB): tomala de nuevo")
    return content_type, data


def _check(value: str | None) -> str | None:
    if value is None:
        return None
    if value.startswith("data:"):
        _decode(value)
    elif len(value) > REFERENCE_MAX_CHARS:
        raise ValueError("La foto no se pudo leer: volvé a tomarla")
    return value


#: El tipo de un campo de foto en un esquema de entrada.
PhotoIn = Annotated[str, Field(max_length=PHOTO_FIELD_MAX_CHARS), AfterValidator(_check)]


def store_photo(db: Session, value: str | None, *, organization_id: int, store_id: int | None) -> str | None:
    if value is None:
        return None
    if not value.startswith("data:"):
        return value
    try:
        content_type, data = _decode(value)
    except ValueError as exc:
        # No debería pasar: el esquema (`PhotoIn`) ya la validó al entrar.
        raise AppError("PHOTO_INVALID", str(exc), status=422) from exc

    photo = Photo(
        organization_id=organization_id,
        store_id=store_id,
        content_type=content_type,
        size_bytes=len(data),
        data=data,
        created_at=clock.now_utc(),
    )
    db.add(photo)
    db.flush()
    return f"{PHOTO_URL_PREFIX}{photo.id}"
