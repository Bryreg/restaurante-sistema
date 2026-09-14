"""Apertura de turno: base fija, causa de diferencia y la carrera de dos aperturas.

Corresponde al checklist de `features/fase-1a-cimientos/spec.md`:
- "Dos `POST /shifts/open` concurrentes: uno `200`, otro `409`."
- Apertura con total != base fija sin causa -> 400 con acción correctiva.
"""

from __future__ import annotations

import threading
import uuid

from sqlalchemy.orm import Session

from app.shifts.models import Shift, ShiftRoster
from tests.shifts.conftest import idem


def _open_payload(employee_id: int, *, total: int = 200_000, cause: str | None = None) -> dict:
    payload: dict = {
        "opening_cash": {"denominations": [{"value": 50000, "count": total // 50000}], "total": total},
        "cash_reserve": 0,
        "cash_responsible_id": employee_id,
    }
    if cause is not None:
        payload["opening_cause"] = cause
    return payload


def test_open_shift_creates_business_day_and_adds_opener_to_roster(device_client, identify, employees, db: Session) -> None:
    identify(device_client, employees["cashier"])
    resp = device_client.post("/api/v1/shifts/open", json=_open_payload(employees["cashier"].id), headers=idem())

    assert resp.status_code in (200, 201), resp.text
    body = resp.json()
    assert body["opening_cash_total"] == 200_000
    assert body["cash_responsible"]["id"] == employees["cashier"].id

    shift = db.get(Shift, body["id"])
    assert shift is not None
    assert shift.business_day_id is not None

    roster = db.query(ShiftRoster).filter(ShiftRoster.shift_id == shift.id).all()
    assert any(r.employee_id == employees["cashier"].id for r in roster)


def test_open_shift_already_open_returns_400(device_client, identify, employees) -> None:
    identify(device_client, employees["cashier"])
    payload = _open_payload(employees["cashier"].id)

    first = device_client.post("/api/v1/shifts/open", json=payload, headers=idem())
    assert first.status_code in (200, 201), first.text

    second = device_client.post("/api/v1/shifts/open", json=payload, headers=idem())
    assert second.status_code == 400
    body = second.json()
    assert body["error"]["code"] == "SHIFT_ALREADY_OPEN"
    assert body["error"]["message"]


def test_open_shift_difference_needs_cause_then_accepts_with_cause(device_client, identify, employees) -> None:
    identify(device_client, employees["cashier"])

    without_cause = device_client.post(
        "/api/v1/shifts/open", json=_open_payload(employees["cashier"].id, total=150_000), headers=idem()
    )
    assert without_cause.status_code == 400
    assert without_cause.json()["error"]["code"] == "OPENING_DIFFERENCE_NEEDS_CAUSE"

    with_cause = device_client.post(
        "/api/v1/shifts/open",
        json=_open_payload(employees["cashier"].id, total=150_000, cause="counting_error"),
        headers=idem(),
    )
    assert with_cause.status_code in (200, 201), with_cause.text
    assert with_cause.json()["opening_cash_total"] == 150_000


def test_two_concurrent_opens_one_wins_one_gets_409(device_client, identify, employees) -> None:
    identify(device_client, employees["cashier"])
    payload = _open_payload(employees["cashier"].id)

    results: list[int] = []

    def _attempt() -> None:
        resp = device_client.post("/api/v1/shifts/open", json=payload, headers={"Idempotency-Key": str(uuid.uuid4())})
        results.append(resp.status_code)

    threads = [threading.Thread(target=_attempt) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert 409 in results, f"se esperaba un 409 por la carrera, resultados: {results}"
    winners = [code for code in results if code in (200, 201)]
    assert len(winners) == 1, f"exactamente una apertura debía ganar, resultados: {results}"
