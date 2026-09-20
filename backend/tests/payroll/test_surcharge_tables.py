"""`GET`/`POST /admin/payroll/surcharge-tables` — tablas legales con
vigencia (§7), nunca quemadas en código.
"""

from __future__ import annotations

from datetime import date
from typing import Any

from fastapi.testclient import TestClient

API = "/api/v1"


def test_create_and_list_surcharge_tables(admin_client: TestClient, store: Any, seed_surcharge_table: Any) -> None:
    seed_surcharge_table(admin_client, store_id=store.id, valid_from=date(2020, 1, 1))
    seed_surcharge_table(admin_client, store_id=store.id, valid_from=date(2026, 7, 1), weekly_ordinary_hours=42)

    resp = admin_client.get(f"{API}/admin/payroll/surcharge-tables", params={"store_id": store.id})
    assert resp.status_code == 200, resp.text
    rows = resp.json()
    assert [r["valid_from"] for r in rows] == ["2020-01-01", "2026-07-01"]
    assert rows[1]["weekly_ordinary_hours"] == 42


def test_duplicate_valid_from_conflicts(admin_client: TestClient, store: Any, seed_surcharge_table: Any) -> None:
    seed_surcharge_table(admin_client, store_id=store.id, valid_from=date(2020, 1, 1))
    resp = admin_client.post(
        f"{API}/admin/payroll/surcharge-tables",
        params={"store_id": store.id},
        json={
            "valid_from": "2020-01-01",
            "night_start_hour": 19,
            "night_end_hour": 6,
            "night_surcharge_bp": 3500,
            "sunday_holiday_surcharge_bp": 8000,
            "overtime_surcharge_bp": 2500,
            "weekly_ordinary_hours": 46,
        },
        headers={"Idempotency-Key": "dup-1"},
    )
    assert resp.status_code == 409, resp.text
    assert resp.json()["error"]["code"] == "SURCHARGE_TABLE_DUPLICATE"


def test_equal_night_start_and_end_is_rejected(admin_client: TestClient, store: Any) -> None:
    resp = admin_client.post(
        f"{API}/admin/payroll/surcharge-tables",
        params={"store_id": store.id},
        json={
            "valid_from": "2020-01-01",
            "night_start_hour": 19,
            "night_end_hour": 19,
            "night_surcharge_bp": 3500,
            "sunday_holiday_surcharge_bp": 8000,
            "overtime_surcharge_bp": 2500,
            "weekly_ordinary_hours": 46,
        },
        headers={"Idempotency-Key": "eq-1"},
    )
    assert resp.status_code == 400, resp.text


def test_foreign_store_is_404(admin_client: TestClient, store_b: Any) -> None:
    resp = admin_client.get(f"{API}/admin/payroll/surcharge-tables", params={"store_id": store_b.id})
    assert resp.status_code == 404, resp.text
