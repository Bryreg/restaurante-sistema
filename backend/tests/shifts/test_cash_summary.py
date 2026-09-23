"""Resumen de caja del historial (`GET /admin/shifts/summary`, informe de
visualización #10) y la racha de diferencias sin `null → 0` y con la
tolerancia de la sede (informe científico #16)."""

from __future__ import annotations

from typing import Any

from sqlalchemy.orm import Session

from app.shifts.models import Shift
from app.shifts.service import difference_streak_from
from tests.shifts.conftest import idem


def _close_with(device_client: Any, db: Session, open_shift: Any, employee: Any, *, counted: int, cause: str | None) -> Shift:
    open_shift(cash_responsible=employee, total=200_000, denominations=[{"value": 10000, "count": 20}])
    shift = db.query(Shift).filter(Shift.status == "open").order_by(Shift.id.desc()).first()
    assert shift is not None
    count_resp = device_client.post(
        f"/api/v1/shifts/{shift.id}/close/count",
        json={
            "counted_cash": {"denominations": [{"value": 1000, "count": counted // 1000}], "total": counted},
            "tips_cash_out": 0,
            "photo": "x.jpg",
        },
        headers=idem(),
    )
    assert count_resp.status_code in (200, 201), count_resp.text
    body: dict[str, Any] = {"difference_seen": counted - 200_000, "closes_day": False}
    if cause is not None:
        body["cause"] = cause
    confirm = device_client.post(f"/api/v1/shifts/{shift.id}/close/{count_resp.json()['count_id']}/confirm", json=body)
    assert confirm.status_code in (200, 201), confirm.text
    db.refresh(shift)
    return shift


def test_streak_rule_skips_uncounted_closes_and_respects_the_tolerance() -> None:
    # Del más reciente hacia atrás; tolerancia $20.000.
    assert difference_streak_from([-30_000, None, 25_000, -21_000], 20_000) == 3
    # Antes `None or 0` cortaba la racha en 1: un cierre sin conteo no cuadró en cero.
    assert difference_streak_from([-30_000, None, -30_000], 20_000) == 2
    # Una diferencia dentro de la tolerancia corta la racha (y $20.000 justos están dentro).
    assert difference_streak_from([-30_000, -20_000, -30_000], 20_000) == 1
    assert difference_streak_from([-5_000, -3_000, -2_000], 20_000) == 0
    assert difference_streak_from([], 20_000) == 0


def test_small_differences_within_tolerance_never_raise_a_streak(
    device_client: Any, employees: dict, open_shift: Any, db: Session, monkeypatch: Any
) -> None:
    import app.shifts.service as shifts_service

    notified: list[str] = []
    original = shifts_service.notify

    def _spy(db_: Any, **kwargs: Any) -> Any:
        notified.append(kwargs.get("type", ""))
        return original(db_, **kwargs)

    monkeypatch.setattr(shifts_service, "notify", _spy)
    for _ in range(3):
        _close_with(device_client, db, open_shift, employees["cashier"], counted=210_000, cause="counting_error")
    assert "difference_streak" not in notified


def test_cash_summary_totals_signs_and_by_person(
    admin_client: Any, device_client: Any, employees: dict, open_shift: Any, db: Session, store: Any
) -> None:
    cashier = employees["cashier"]
    _close_with(device_client, db, open_shift, cashier, counted=230_000, cause="counting_error")  # +30.000
    _close_with(device_client, db, open_shift, cashier, counted=190_000, cause="counting_error")  # −10.000
    _close_with(device_client, db, open_shift, cashier, counted=175_000, cause="counting_error")  # −25.000
    _close_with(device_client, db, open_shift, cashier, counted=200_000, cause=None)  # cuadra
    # Un cierre sin conteo: no es $0, va aparte.
    uncounted = _close_with(device_client, db, open_shift, cashier, counted=200_000, cause=None)
    uncounted.closed_without_count = True
    uncounted.difference = None
    db.commit()

    resp = admin_client.get("/api/v1/admin/shifts/summary", params={"store_id": store.id})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["closed_count"] == 5
    assert body["counted_count"] == 4
    assert body["uncounted_count"] == 1
    assert body["diff_total"] == 30_000 - 10_000 - 25_000
    assert body["shortage_total"] == -35_000
    assert body["overage_total"] == 30_000
    assert body["shortage_count"] == 2
    assert body["overage_count"] == 1
    assert body["exact_count"] == 1
    assert body["tolerance"] == 20_000
    assert body["beyond_tolerance_count"] == 2
    assert len(body["by_day"]) == 1
    assert body["by_day"][0]["closes"] == 4
    assert body["by_day"][0]["diff_total"] == -5_000
    assert body["by_person"] == [
        {
            "employee_id": cashier.id,
            "name": cashier.name,
            "closes": 4,
            "diff_total": -5_000,
            "shortage_count": 2,
            "overage_count": 1,
            # El último contado cuadró: la racha actual es 0 (el sin conteo se salta).
            "current_streak": 0,
        }
    ]
