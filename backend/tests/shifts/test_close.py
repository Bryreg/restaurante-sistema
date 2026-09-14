"""Cierre a ciegas en tres pasos: count no revela el esperado, review sí,
confirm valida la diferencia vista y las tolerancias; foto exigida; y el
comportamiento con `cash.blind_close` y `cash.handovers` apagados.
"""

from __future__ import annotations

from sqlalchemy.orm import Session

from app.shifts.models import Shift
from tests.shifts.conftest import idem


def _open(db: Session) -> Shift:
    shift = db.query(Shift).filter(Shift.status == "open").order_by(Shift.id.desc()).first()
    assert shift is not None
    return shift


def _count(device_client, shift_id: int, *, total: int, photo: str | None = "foto.jpg") -> int:
    resp = device_client.post(
        f"/api/v1/shifts/{shift_id}/close/count",
        json={
            "counted_cash": {"denominations": [{"value": 10000, "count": total // 10000}], "total": total},
            "tips_cash_out": 0,
            "photo": photo,
        },
        headers=idem(),
    )
    assert resp.status_code in (200, 201), resp.text
    return resp.json()["count_id"]


def test_close_count_hides_expected_and_review_reveals_it(device_client, open_shift, db: Session) -> None:
    open_shift(total=200_000, denominations=[{"value": 10000, "count": 20}])
    shift = _open(db)

    count_id = _count(device_client, shift.id, total=200_000)
    count_resp = device_client.post(
        f"/api/v1/shifts/{shift.id}/close/count",
        json={"counted_cash": {"denominations": [{"value": 10000, "count": 20}], "total": 200_000}, "tips_cash_out": 0, "photo": "x.jpg"},
        headers=idem(),
    )
    assert set(count_resp.json().keys()) == {"count_id"}

    review = device_client.get(f"/api/v1/shifts/{shift.id}/close/{count_id}/review")
    assert review.status_code == 200
    body = review.json()
    assert body["expected"] == 200_000
    assert body["difference"] == 0
    assert body["requires_cause"] is False
    assert body["requires_identified_cause"] is False
    assert body["is_critical"] is False


def test_confirm_with_stale_difference_seen_returns_difference_changed(device_client, open_shift, db: Session) -> None:
    open_shift(total=200_000, denominations=[{"value": 10000, "count": 20}])
    shift = _open(db)
    count_id = _count(device_client, shift.id, total=200_000)

    # Un movimiento concurrente cambia el esperado entre el conteo y la confirmación.
    device_client.post(
        f"/api/v1/shifts/{shift.id}/cash-movements",
        json={"kind": "income", "cause": "other_income", "amount": 5_000, "note": "venta tardía"},
        headers=idem(),
    )

    confirm = device_client.post(
        f"/api/v1/shifts/{shift.id}/close/{count_id}/confirm",
        json={"difference_seen": 0, "cause": "unknown", "closes_day": False},
    )
    assert confirm.status_code == 400
    body = confirm.json()
    assert body["error"]["code"] == "DIFFERENCE_CHANGED"
    assert "review" in body["error"].get("extra", body["error"])


def test_within_unknown_tolerance_closes_with_unknown_cause(device_client, open_shift, db: Session) -> None:
    open_shift(total=200_000, denominations=[{"value": 10000, "count": 20}])
    shift = _open(db)
    # Diferencia de 10.000: dentro de tolerance_unknown_cause (20.000 por defecto).
    count_id = _count(device_client, shift.id, total=210_000)

    review = device_client.get(f"/api/v1/shifts/{shift.id}/close/{count_id}/review").json()
    assert review["difference"] == 10_000
    assert review["requires_cause"] is True
    assert review["requires_identified_cause"] is False

    confirm = device_client.post(
        f"/api/v1/shifts/{shift.id}/close/{count_id}/confirm",
        json={"difference_seen": review["difference"], "cause": "unknown", "closes_day": False},
    )
    assert confirm.status_code in (200, 201), confirm.text


def test_between_tolerances_requires_identified_cause(device_client, open_shift, db: Session) -> None:
    open_shift(total=200_000, denominations=[{"value": 10000, "count": 20}])
    shift = _open(db)
    # Diferencia de 50.000: entre tolerance_unknown_cause (20.000) y
    # critical_difference (100.000) -> causa identificada obligatoria.
    count_id = _count(device_client, shift.id, total=250_000)

    review = device_client.get(f"/api/v1/shifts/{shift.id}/close/{count_id}/review").json()
    assert review["requires_identified_cause"] is True
    assert review["is_critical"] is False

    rejected = device_client.post(
        f"/api/v1/shifts/{shift.id}/close/{count_id}/confirm",
        json={"difference_seen": review["difference"], "cause": "unknown", "closes_day": False},
    )
    assert rejected.status_code == 400
    assert rejected.json()["error"]["code"] == "IDENTIFIED_CAUSE_REQUIRED"

    accepted = device_client.post(
        f"/api/v1/shifts/{shift.id}/close/{count_id}/confirm",
        json={"difference_seen": review["difference"], "cause": "counting_error", "closes_day": False},
    )
    assert accepted.status_code in (200, 201), accepted.text


def test_over_critical_still_closes_and_is_flagged(device_client, open_shift, db: Session) -> None:
    open_shift(total=200_000, denominations=[{"value": 10000, "count": 20}])
    shift = _open(db)
    # Diferencia de 150.000: sobre critical_difference (100.000) -> cierra
    # igual (nunca bloquea) y queda marcada como crítica.
    count_id = _count(device_client, shift.id, total=350_000)

    review = device_client.get(f"/api/v1/shifts/{shift.id}/close/{count_id}/review").json()
    assert review["is_critical"] is True

    confirm = device_client.post(
        f"/api/v1/shifts/{shift.id}/close/{count_id}/confirm",
        json={"difference_seen": review["difference"], "cause": "counting_error", "closes_day": False},
    )
    assert confirm.status_code in (200, 201), confirm.text


def test_close_photo_required_when_setting_and_flag_are_on(device_client, open_shift, db: Session, set_feature, store) -> None:
    set_feature("cash.photo_required", True, store_id=store.id)
    open_shift(total=200_000, denominations=[{"value": 10000, "count": 20}])
    shift = _open(db)

    resp = device_client.post(
        f"/api/v1/shifts/{shift.id}/close/count",
        json={"counted_cash": {"denominations": [{"value": 10000, "count": 20}], "total": 200_000}, "tips_cash_out": 0},
        headers=idem(),
    )
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "PHOTO_REQUIRED"


def test_handovers_disabled_returns_feature_disabled(device_client, employees, open_shift, db: Session, set_feature, store) -> None:
    set_feature("cash.handovers", False, store_id=store.id)
    open_shift()
    shift = _open(db)

    resp = device_client.post(
        f"/api/v1/shifts/{shift.id}/handovers",
        json={
            "kind": "handover",
            "counted_cash": {"denominations": [{"value": 50000, "count": 4}], "total": 200_000},
            "new_responsible_id": employees["operator"].id,
        },
        headers=idem(),
    )
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "FEATURE_DISABLED"


def test_blind_close_disabled_uses_single_step_and_locks_the_three_step_flow(
    device_client, open_shift, db: Session, set_feature, store
) -> None:
    set_feature("cash.blind_close", False, store_id=store.id)
    open_shift(total=200_000, denominations=[{"value": 10000, "count": 20}])
    shift = _open(db)

    blocked = device_client.get(f"/api/v1/shifts/{shift.id}/close/1/review")
    assert blocked.status_code == 400
    assert blocked.json()["error"]["code"] == "FEATURE_DISABLED"

    resp = device_client.post(
        f"/api/v1/shifts/{shift.id}/close",
        json={
            "counted_cash": {"denominations": [{"value": 10000, "count": 20}], "total": 200_000},
            "tips_cash_out": 0,
            "cause": None,
            "closes_day": False,
            "photo": "x.jpg",
        },
        headers=idem(),
    )
    assert resp.status_code in (200, 201), resp.text
    body = resp.json()
    assert body["difference"] == 0
    assert body["expected"] == 200_000
