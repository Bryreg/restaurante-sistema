"""`run_idempotent`: replay, mismatch y clave requerida (CONTRATO-INTERNO §2)."""

from __future__ import annotations

from typing import Any

import pytest
from sqlalchemy.orm import Session

from app.core import clock
from app.core.errors import AppError
from app.core.idempotency import hash_request_body, run_idempotent
from app.core.models import IdempotencyKey
from app.stores.models import Organization


def test_replay_returns_original_response_without_running_fn_again(
    db: Session, org: Organization
) -> None:
    calls = {"n": 0}

    def _fn() -> tuple[int, dict[str, Any]]:
        calls["n"] += 1
        return 200, {"ok": True, "n": calls["n"]}

    body = {"amount": 100}
    request_hash = hash_request_body(body)

    status1, resp1 = run_idempotent(
        db, organization_id=org.id, scope="test.scope", key="k1", request_hash=request_hash, fn=_fn
    )
    assert (status1, resp1) == (200, {"ok": True, "n": 1})
    assert calls["n"] == 1

    status2, resp2 = run_idempotent(
        db, organization_id=org.id, scope="test.scope", key="k1", request_hash=request_hash, fn=_fn
    )
    assert (status2, resp2) == (200, {"ok": True, "n": 1})
    assert calls["n"] == 1  # no se volvió a ejecutar


def test_same_key_different_body_is_mismatch(db: Session, org: Organization) -> None:
    body = {"amount": 100}
    request_hash = hash_request_body(body)
    run_idempotent(
        db,
        organization_id=org.id,
        scope="test.scope",
        key="k2",
        request_hash=request_hash,
        fn=lambda: (200, {"ok": True}),
    )

    other_hash = hash_request_body({"amount": 999})
    with pytest.raises(AppError) as exc_info:
        run_idempotent(
            db,
            organization_id=org.id,
            scope="test.scope",
            key="k2",
            request_hash=other_hash,
            fn=lambda: (200, {"ok": True}),
        )
    assert exc_info.value.code == "IDEMPOTENCY_MISMATCH"
    assert exc_info.value.status == 400


def test_missing_key_is_required(db: Session, org: Organization) -> None:
    with pytest.raises(AppError) as exc_info:
        run_idempotent(
            db, organization_id=org.id, scope="test.scope", key=None, request_hash="x", fn=lambda: (200, {})
        )
    assert exc_info.value.code == "IDEMPOTENCY_KEY_REQUIRED"


def test_key_reserved_without_response_is_in_progress(db: Session, org: Organization) -> None:
    row = IdempotencyKey(
        organization_id=org.id,
        scope="test.scope",
        key="in-flight",
        request_hash="h",
        response_status=None,
        response_body=None,
        created_at=clock.now_utc(),
    )
    db.add(row)
    db.flush()

    with pytest.raises(AppError) as exc_info:
        run_idempotent(
            db,
            organization_id=org.id,
            scope="test.scope",
            key="in-flight",
            request_hash="h",
            fn=lambda: (200, {}),
        )
    assert exc_info.value.code == "IDEMPOTENCY_IN_PROGRESS"
    assert exc_info.value.status == 409


def test_different_scope_is_independent(db: Session, org: Organization) -> None:
    request_hash = hash_request_body({"a": 1})
    run_idempotent(
        db, organization_id=org.id, scope="scope.a", key="same", request_hash=request_hash, fn=lambda: (200, {"s": "a"})
    )
    status2, resp2 = run_idempotent(
        db, organization_id=org.id, scope="scope.b", key="same", request_hash=request_hash, fn=lambda: (200, {"s": "b"})
    )
    assert resp2 == {"s": "b"}
