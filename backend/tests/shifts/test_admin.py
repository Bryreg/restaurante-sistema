"""Rescates de administrador, aislamiento por organización y la racha de
diferencias. Usa `admin_client` (sesión admin de `org`/`store`).
"""

from __future__ import annotations

from sqlalchemy.orm import Session

from app.core import clock
from app.shifts.models import BusinessDay, BusinessDayStatus, Shift, ShiftCloseCount, ShiftStatus
from tests.shifts.conftest import idem


def _open(db: Session) -> Shift:
    shift = db.query(Shift).filter(Shift.status == "open").order_by(Shift.id.desc()).first()
    assert shift is not None
    return shift


def test_admin_from_other_organization_gets_404(admin_client, db: Session, store_b, org_b, employees) -> None:
    """Un turno de `org_b` no es visible para el admin de `org` (404, nunca 403)."""

    day = BusinessDay(
        organization_id=org_b.id,
        store_id=store_b.id,
        business_date=clock.now_utc().date(),
        status=BusinessDayStatus.OPEN,
        opened_at=clock.now_utc(),
    )
    db.add(day)
    db.flush()
    shift = Shift(
        organization_id=org_b.id,
        store_id=store_b.id,
        business_day_id=day.id,
        status=ShiftStatus.OPEN,
        opened_at=clock.now_utc(),
        opened_by_employee_id=employees["cashier"].id,
        opened_by_employee_name=employees["cashier"].name,
        cash_responsible_id=employees["cashier"].id,
        cash_responsible_name=employees["cashier"].name,
        opening_cash_total=200_000,
        opening_denominations=[],
        cash_reserve=0,
        adjustments=[],
    )
    db.add(shift)
    db.commit()

    resp = admin_client.get(f"/api/v1/admin/shifts/{shift.id}/timeline")
    assert resp.status_code == 404

    resp_list = admin_client.get(f"/api/v1/admin/shifts?store_id={store_b.id}")
    assert resp_list.status_code == 404


def test_close_administrative_only_when_stale(admin_client, open_shift, db: Session, clock) -> None:
    open_shift()
    shift = _open(db)

    not_stale = admin_client.post(f"/api/v1/admin/shifts/{shift.id}/close-administrative", json={"reason": "turno abandonado"})
    assert not_stale.status_code == 400
    assert not_stale.json()["error"]["code"] == "SHIFT_NOT_STALE"

    clock.advance(days=2)

    now_stale = admin_client.post(f"/api/v1/admin/shifts/{shift.id}/close-administrative", json={"reason": "turno abandonado"})
    assert now_stale.status_code in (200, 201), now_stale.text
    body = now_stale.json()
    assert body["closes_day"] is True

    db.refresh(shift)
    assert shift.status == ShiftStatus.CLOSED
    assert shift.closed_without_count is True
    assert shift.difference == 0


def test_reopen_keeps_the_previous_count_as_history(device_client, admin_client, open_shift, db: Session) -> None:
    open_shift(total=200_000, denominations=[{"value": 10000, "count": 20}])
    shift = _open(db)

    count_resp = device_client.post(
        f"/api/v1/shifts/{shift.id}/close/count",
        json={"counted_cash": {"denominations": [{"value": 10000, "count": 20}], "total": 200_000}, "tips_cash_out": 0, "photo": "x.jpg"},
        headers=idem(),
    )
    count_id = count_resp.json()["count_id"]
    device_client.post(
        f"/api/v1/shifts/{shift.id}/close/{count_id}/confirm",
        json={"difference_seen": 0, "cause": "unknown", "closes_day": True},
    )

    reopen = admin_client.post(f"/api/v1/admin/shifts/{shift.id}/reopen", json={"reason": "venta de último momento"})
    assert reopen.status_code == 200, reopen.text

    db.refresh(shift)
    assert shift.status == ShiftStatus.OPEN

    stored_count = db.get(ShiftCloseCount, count_id)
    assert stored_count is not None
    assert stored_count.counted_cash_total == 200_000  # el conteo previo no se toca
    assert stored_count.superseded is True


def test_cancel_shift_with_activity_is_rejected(device_client, admin_client, open_shift, db: Session) -> None:
    open_shift()
    shift = _open(db)
    device_client.post(
        f"/api/v1/shifts/{shift.id}/cash-movements",
        json={"kind": "income", "cause": "other_income", "amount": 5_000, "note": "venta"},
        headers=idem(),
    )

    resp = admin_client.delete(f"/api/v1/admin/shifts/{shift.id}")
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "SHIFT_HAS_ACTIVITY"


def test_adjust_opening_recomputes_expected_with_the_same_formula(admin_client, open_shift, db: Session) -> None:
    from app.shifts import service

    open_shift()
    shift = _open(db)

    resp = admin_client.post(
        f"/api/v1/admin/shifts/{shift.id}/adjust-opening",
        json={
            "opening_cash": {"denominations": [{"value": 50000, "count": 5}], "total": 250_000},
            "cash_reserve": 20_000,
            "reason": "se contó mal la base al abrir",
        },
    )
    assert resp.status_code == 200, resp.text

    db.refresh(shift)
    assert shift.opening_cash_total == 250_000
    assert shift.cash_reserve == 20_000
    assert service.compute_breakdown(db, shift)["expected"] == 250_000
    assert len(shift.adjustments) == 1


def test_difference_streak_of_three_notifies(device_client, employees, open_shift, db: Session, monkeypatch) -> None:
    import app.shifts.service as shifts_service

    notified_types: list[str] = []
    original_notify = shifts_service.notify

    def _spy(db_, **kwargs):  # type: ignore[no-untyped-def]
        notified_types.append(kwargs.get("type"))
        return original_notify(db_, **kwargs)

    monkeypatch.setattr(shifts_service, "notify", _spy)

    for _ in range(3):
        open_shift(cash_responsible=employees["cashier"], total=200_000, denominations=[{"value": 10000, "count": 20}])
        shift = _open(db)
        count_resp = device_client.post(
            f"/api/v1/shifts/{shift.id}/close/count",
            json={"counted_cash": {"denominations": [{"value": 10000, "count": 23}], "total": 230_000}, "tips_cash_out": 0, "photo": "x.jpg"},
            headers=idem(),
        )
        count_id = count_resp.json()["count_id"]
        confirm = device_client.post(
            f"/api/v1/shifts/{shift.id}/close/{count_id}/confirm",
            json={"difference_seen": 30_000, "cause": "counting_error", "closes_day": False},
        )
        assert confirm.status_code in (200, 201), confirm.text

    assert "difference_streak" in notified_types
