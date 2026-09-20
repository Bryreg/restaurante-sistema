"""`GET`/`POST /admin/payroll/runs` — liquidación del período. La respuesta
**nombra qué tabla vigente usó** (`tables_used`), y una liquidación vieja
tiene que recalcular con las tablas que regían en SU época, no con las de
hoy — el ítem del checklist de la fase que este archivo prueba
explícitamente en `test_run_uses_the_vigente_table_of_its_own_period`.
"""

from __future__ import annotations

from datetime import date
from typing import Any

from fastapi.testclient import TestClient

from tests.conftest import KNOWN_PINS
from tests.payroll.conftest import bogota_utc

API = "/api/v1"


def test_run_uses_the_vigente_table_of_its_own_period(
    device_client: TestClient,
    admin_client: TestClient,
    open_shift: Any,
    employees: dict[str, Any],
    store: Any,
    clock: Any,
    seed_surcharge_table: Any,
    seed_wage: Any,
    roster_action: Any,
) -> None:
    """Dos vigencias: una "vieja" (2024, recargo dominical 75 %) y una
    "nueva" (2026-07, recargo dominical 90 %, jornada 42h). Un período de
    2025 (posterior a la vieja, anterior a la nueva) tiene que liquidarse
    con la vieja — aunque las dos ya existan en la base cuando se liquida.
    """
    seed_surcharge_table(
        admin_client,
        store_id=store.id,
        valid_from=date(2024, 1, 1),
        night_start_hour=21,
        night_end_hour=6,
        sunday_holiday_surcharge_bp=7500,
        weekly_ordinary_hours=46,
    )
    seed_surcharge_table(
        admin_client,
        store_id=store.id,
        valid_from=date(2026, 7, 1),
        night_start_hour=19,
        night_end_hour=6,
        sunday_holiday_surcharge_bp=9000,
        weekly_ordinary_hours=42,
    )

    operator = employees["operator"]
    cashier = employees["cashier"]
    # `open_shift()` identifica y agrega a la cajera (responsable de caja)
    # al roster automáticamente (`app.shifts.service.open_shift` ->
    # `hooks.on_employee_identified`) — no es una entrada que este test
    # capture a mano, así que también necesita tarifa para que el período
    # quede `available`; sus minutos exactos (desde que abre el turno hasta
    # que se liquida) no son lo que este test verifica, así que no se
    # hardcodean — se comprueba consistencia interna (el total de la corrida
    # es la suma de sus líneas), no un número adivinado.
    seed_wage(admin_client, store_id=store.id, employee_id=operator.id, hourly_wage_pesos=10_000, valid_from=date(2020, 1, 1))
    seed_wage(admin_client, store_id=store.id, employee_id=cashier.id, hourly_wage_pesos=10_000, valid_from=date(2020, 1, 1))

    # 2025-06-08 es domingo, y cae DESPUÉS de la vigencia vieja (2024-01-01)
    # y ANTES de la nueva (2026-07-01): tiene que liquidar con la vieja.
    clock.set(bogota_utc(2025, 6, 8, 8, 0))
    shift = open_shift()
    clock.set(bogota_utc(2025, 6, 8, 12, 0))
    roster_action(device_client, shift_id=shift["id"], employee_id=operator.id, action="in", pin=KNOWN_PINS["Operator"])
    clock.set(bogota_utc(2025, 6, 8, 14, 0))
    roster_action(device_client, shift_id=shift["id"], employee_id=operator.id, action="out", pin=KNOWN_PINS["Operator"])

    resp = admin_client.post(
        f"{API}/admin/payroll/runs",
        params={"store_id": store.id},
        json={"date_from": "2025-06-08", "date_to": "2025-06-08"},
        headers={"Idempotency-Key": "run-old-period"},
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()

    assert body["available"] is True
    assert [t["valid_from"] for t in body["tables_used"]] == ["2024-01-01"]
    assert body["tables_used"][0]["sunday_holiday_surcharge_bp"] == 7500

    lines = {line["employee_id"]: line for line in body["lines"]}
    line = lines[operator.id]
    assert line["sunday_minutes"] == 120
    assert line["night_minutes"] == 0
    assert line["base_pay"] == 20_000  # 120 min * 10_000/h / 60
    assert line["sunday_holiday_surcharge"] == 15_000  # 120*10_000*7500/(60*10_000)
    assert line["overtime_pay"] == 0
    assert line["total"] == 35_000

    cashier_line = lines[cashier.id]
    assert cashier_line["total"] is not None
    assert body["total_amount"] == sum(l["total"] for l in body["lines"])
    assert body["total_amount"] == line["total"] + cashier_line["total"]


def test_run_missing_wage_is_null_with_reason(
    device_client: TestClient,
    admin_client: TestClient,
    open_shift: Any,
    employees: dict[str, Any],
    store: Any,
    clock: Any,
    seed_surcharge_table: Any,
    roster_action: Any,
) -> None:
    seed_surcharge_table(admin_client, store_id=store.id, valid_from=date(2020, 1, 1))
    operator = employees["operator"]

    clock.set(bogota_utc(2026, 3, 10, 8, 0))
    shift = open_shift()
    clock.set(bogota_utc(2026, 3, 10, 9, 0))
    roster_action(device_client, shift_id=shift["id"], employee_id=operator.id, action="in", pin=KNOWN_PINS["Operator"])
    clock.set(bogota_utc(2026, 3, 10, 11, 0))
    roster_action(device_client, shift_id=shift["id"], employee_id=operator.id, action="out", pin=KNOWN_PINS["Operator"])

    resp = admin_client.post(
        f"{API}/admin/payroll/runs",
        params={"store_id": store.id},
        json={"date_from": "2026-03-10", "date_to": "2026-03-10"},
        headers={"Idempotency-Key": "run-missing-wage"},
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["available"] is False
    assert body["total_amount"] is None
    assert body["reason"]
    # Nadie tiene tarifa configurada (ni el operador, ni la cajera que
    # `open_shift()` agrega sola al roster): las dos líneas quedan sin
    # plata, pero CON horas — "null no es 0", nunca se inventa un total.
    lines = {line["employee_id"]: line for line in body["lines"]}
    operator_line = lines[operator.id]
    assert operator_line["ordinary_minutes"] == 120  # las horas SÍ se conocen
    assert operator_line["total"] is None
    assert operator_line["pay_reason"]
    for line in body["lines"]:
        assert line["total"] is None
        assert line["pay_reason"]


def test_run_requires_surcharge_table(admin_client: TestClient, store: Any) -> None:
    resp = admin_client.post(
        f"{API}/admin/payroll/runs",
        params={"store_id": store.id},
        json={"date_from": "2026-03-10", "date_to": "2026-03-10"},
        headers={"Idempotency-Key": "run-no-table"},
    )
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "SURCHARGE_TABLE_MISSING"


def test_run_list_and_detail(
    device_client: TestClient,
    admin_client: TestClient,
    open_shift: Any,
    employees: dict[str, Any],
    store: Any,
    clock: Any,
    seed_surcharge_table: Any,
    seed_wage: Any,
    roster_action: Any,
) -> None:
    seed_surcharge_table(admin_client, store_id=store.id, valid_from=date(2020, 1, 1))
    operator = employees["operator"]
    seed_wage(admin_client, store_id=store.id, employee_id=operator.id, hourly_wage_pesos=8_000, valid_from=date(2020, 1, 1))

    clock.set(bogota_utc(2026, 3, 10, 8, 0))
    shift = open_shift()
    clock.set(bogota_utc(2026, 3, 10, 9, 0))
    roster_action(device_client, shift_id=shift["id"], employee_id=operator.id, action="in", pin=KNOWN_PINS["Operator"])
    clock.set(bogota_utc(2026, 3, 10, 10, 0))
    roster_action(device_client, shift_id=shift["id"], employee_id=operator.id, action="out", pin=KNOWN_PINS["Operator"])

    create_resp = admin_client.post(
        f"{API}/admin/payroll/runs",
        params={"store_id": store.id},
        json={"date_from": "2026-03-10", "date_to": "2026-03-10"},
        headers={"Idempotency-Key": "run-detail"},
    )
    assert create_resp.status_code == 201, create_resp.text
    run_id = create_resp.json()["id"]

    list_resp = admin_client.get(f"{API}/admin/payroll/runs", params={"store_id": store.id})
    assert list_resp.status_code == 200, list_resp.text
    ids = [r["id"] for r in list_resp.json()]
    assert run_id in ids

    detail_resp = admin_client.get(f"{API}/admin/payroll/runs/{run_id}", params={"store_id": store.id})
    assert detail_resp.status_code == 200, detail_resp.text
    detail = detail_resp.json()
    assert detail["id"] == run_id
    # La cajera (responsable de caja) también queda en el roster —
    # `open_shift()` la agrega sola (ver el comentario del primer test de
    # este archivo) — así que la liquidación trae sus dos líneas.
    lines = {line["employee_id"]: line for line in detail["lines"]}
    assert operator.id in lines
    assert lines[operator.id]["ordinary_minutes"] == 60


def test_run_idempotent_replay_does_not_duplicate(
    device_client: TestClient,
    admin_client: TestClient,
    open_shift: Any,
    employees: dict[str, Any],
    store: Any,
    clock: Any,
    seed_surcharge_table: Any,
    seed_wage: Any,
    roster_action: Any,
) -> None:
    seed_surcharge_table(admin_client, store_id=store.id, valid_from=date(2020, 1, 1))
    operator = employees["operator"]
    seed_wage(admin_client, store_id=store.id, employee_id=operator.id, hourly_wage_pesos=8_000, valid_from=date(2020, 1, 1))

    clock.set(bogota_utc(2026, 3, 10, 8, 0))
    shift = open_shift()
    clock.set(bogota_utc(2026, 3, 10, 9, 0))
    roster_action(device_client, shift_id=shift["id"], employee_id=operator.id, action="in", pin=KNOWN_PINS["Operator"])
    clock.set(bogota_utc(2026, 3, 10, 10, 0))
    roster_action(device_client, shift_id=shift["id"], employee_id=operator.id, action="out", pin=KNOWN_PINS["Operator"])

    key = {"Idempotency-Key": "run-replay"}
    payload = {"date_from": "2026-03-10", "date_to": "2026-03-10"}
    first = admin_client.post(f"{API}/admin/payroll/runs", params={"store_id": store.id}, json=payload, headers=key)
    second = admin_client.post(f"{API}/admin/payroll/runs", params={"store_id": store.id}, json=payload, headers=key)
    assert first.status_code == 201
    assert second.status_code == 201
    assert first.json()["id"] == second.json()["id"]

    list_resp = admin_client.get(f"{API}/admin/payroll/runs", params={"store_id": store.id})
    assert len(list_resp.json()) == 1


def test_run_missing_idempotency_key_is_rejected(admin_client: TestClient, store: Any, seed_surcharge_table: Any) -> None:
    seed_surcharge_table(admin_client, store_id=store.id, valid_from=date(2020, 1, 1))
    resp = admin_client.post(
        f"{API}/admin/payroll/runs",
        params={"store_id": store.id},
        json={"date_from": "2026-03-10", "date_to": "2026-03-10"},
    )
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "IDEMPOTENCY_KEY_REQUIRED"


def test_foreign_store_run_is_404(admin_client: TestClient, store_b: Any) -> None:
    resp = admin_client.post(
        f"{API}/admin/payroll/runs",
        params={"store_id": store_b.id},
        json={"date_from": "2026-03-10", "date_to": "2026-03-10"},
        headers={"Idempotency-Key": "run-foreign"},
    )
    assert resp.status_code == 404, resp.text
