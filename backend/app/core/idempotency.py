"""`Idempotency-Key` reservada dentro de la misma transacción de negocio.

"El guardián del front es cortesía, no garantía" (SPEC-NEGOCIO §3.3): toda
escritura que mueve plata o estado reserva su clave acá, ejecuta la lógica de
negocio, y guarda la respuesta original para que un reintento (doble toque,
reconexión) la repita sin duplicar nada.

Si `fn()` levanta `AppError` (una regla de negocio, no un bug), esa
**también** es la respuesta original: se guarda con su código y se vuelve a
levantar (nunca queda "en curso" para siempre — `app.core.db.get_db` hace
commit tanto en éxito como en `AppError`). Un replay con la misma clave
levanta el mismo `AppError`, no lo re-ejecuta.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Callable
from typing import Any

from fastapi import Request
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core import clock
from app.core.errors import AppError
from app.core.models import IdempotencyKey


def idempotency_key(request: Request) -> str | None:
    """Lee el encabezado `Idempotency-Key` (case-insensitive, como todo header HTTP)."""
    return request.headers.get("Idempotency-Key")


def hash_request_body(body: dict[str, Any]) -> str:
    """sha256 del JSON canónico del body (claves ordenadas, sin espacios)."""
    canonical = json.dumps(body, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _find(db: Session, organization_id: int, scope: str, key: str) -> IdempotencyKey | None:
    stmt = select(IdempotencyKey).where(
        IdempotencyKey.organization_id == organization_id,
        IdempotencyKey.scope == scope,
        IdempotencyKey.key == key,
    )
    return db.execute(stmt).scalar_one_or_none()


def _raise_stored_error(status: int, body: dict[str, Any]) -> None:
    error = body.get("error", {}) if isinstance(body, dict) else {}
    code = str(error.get("code", "CONFLICT"))
    message = str(error.get("message", "No se pudo completar la operación"))
    extra = {k: v for k, v in error.items() if k not in ("code", "message")}
    raise AppError(code=code, message=message, status=status, extra=extra or None)


def _replay_or_raise(existing: IdempotencyKey, request_hash: str) -> tuple[int, dict[str, Any]]:
    if existing.request_hash != request_hash:
        raise AppError(
            code="IDEMPOTENCY_MISMATCH",
            message="Esta Idempotency-Key ya se usó con datos distintos; generá una clave nueva",
        )
    if existing.response_status is None or existing.response_body is None:
        raise AppError(
            code="IDEMPOTENCY_IN_PROGRESS",
            message="Esta operación ya se está procesando; esperá un momento y consultá de nuevo",
            status=409,
        )
    if existing.response_status >= 400:
        _raise_stored_error(existing.response_status, existing.response_body)
    return existing.response_status, existing.response_body


def run_idempotent(
    db: Session,
    *,
    organization_id: int,
    scope: str,
    key: str | None,
    request_hash: str,
    fn: Callable[[], tuple[int, dict[str, Any]]],
) -> tuple[int, dict[str, Any]]:
    """Ejecuta `fn()` una sola vez por `(organization_id, scope, key)`.

    - `key` ausente -> `400 IDEMPOTENCY_KEY_REQUIRED`.
    - Clave ya usada con el mismo body -> devuelve la respuesta original (replay).
    - Clave ya usada con un body distinto -> `400 IDEMPOTENCY_MISMATCH`.
    - Clave reservada pero sin respuesta todavía (otra request en vuelo) ->
      `409 IDEMPOTENCY_IN_PROGRESS`.
    - Si no existe: la reserva, corre `fn()`, guarda `(status, body)` y los
      devuelve.
    """
    if key is None:
        raise AppError(
            code="IDEMPOTENCY_KEY_REQUIRED",
            message="Enviá el encabezado Idempotency-Key",
        )

    existing = _find(db, organization_id, scope, key)
    if existing is not None:
        return _replay_or_raise(existing, request_hash)

    row = IdempotencyKey(
        organization_id=organization_id,
        scope=scope,
        key=key,
        request_hash=request_hash,
        response_status=None,
        response_body=None,
        created_at=clock.now_utc(),
    )
    db.add(row)
    try:
        db.flush()
    except IntegrityError:
        # Carrera: otra request reservó la misma clave entre el SELECT y el INSERT.
        db.rollback()
        existing = _find(db, organization_id, scope, key)
        if existing is None:
            raise
        return _replay_or_raise(existing, request_hash)

    try:
        status, body = fn()
    except AppError as exc:
        row.response_status = exc.status
        row.response_body = exc.body()
        db.flush()
        raise
    row.response_status = status
    row.response_body = body
    db.flush()
    return status, body
