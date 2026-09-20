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


def test_a4_a_table_nobody_reviewed_says_so_and_one_a_person_loaded_says_who(
    admin_client: TestClient, store: Any, db: Any, seed_surcharge_table: Any
) -> None:
    """**A-4 del cierre de la fase 3.**

    Los valores de las tablas legales que siembra la migración `0020` son un
    **supuesto declarado**: la spec cita tres cambios con su norma y el resto
    lo completó el equipo con un valor razonable. Son editables por API sin
    tocar código —que es lo que había que garantizar— pero hasta que alguien
    con la norma adelante los revise, son **datos en la base que nadie con
    firma miró**. Mientras eso viviera sólo en un documento, nadie lo iba a
    ver a tiempo.

    No hace falta una columna nueva: una fila sembrada por la migración no
    tiene `created_by_employee_id` y una que cargó una persona sí. **Se
    deriva.** Y la liquidación lo guarda en su snapshot, para que confirmar la
    tabla mañana no reescriba la historia de una nómina vieja.
    """
    from app.core import clock
    from app.payroll.models import SurchargeTable

    # Una vigencia como la que siembra la migración: sin persona detrás.
    db.add(
        SurchargeTable(
            organization_id=store.organization_id,
            store_id=store.id,
            valid_from=date(2019, 1, 1),
            night_start_hour=21,
            night_end_hour=6,
            night_surcharge_bp=3500,
            sunday_holiday_surcharge_bp=7500,
            overtime_surcharge_bp=2500,
            weekly_ordinary_hours=48,
            created_at=clock.now_utc(),
            created_by_employee_id=None,
            created_by_employee_name=None,
        )
    )
    db.flush()

    # Y una que carga una persona por la puerta real.
    seed_surcharge_table(admin_client, store_id=store.id, valid_from=date(2026, 7, 1), weekly_ordinary_hours=42)

    resp = admin_client.get(f"{API}/admin/payroll/surcharge-tables", params={"store_id": store.id})
    assert resp.status_code == 200, resp.text
    por_fecha = {r["valid_from"]: r for r in resp.json()}

    sembrada = por_fecha["2019-01-01"]
    assert sembrada["confirmed_by_person"] is False, (
        "una vigencia que nadie revisó se está publicando como si alguien la hubiera confirmado"
    )
    assert sembrada["confirmed_by_name"] is None

    cargada = por_fecha["2026-07-01"]
    assert cargada["confirmed_by_person"] is True
    assert cargada["confirmed_by_name"], "la vigencia que cargó una persona queda a su nombre congelado"
