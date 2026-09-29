"""`GET /admin/payroll/week-schedule` — el horario de la semana que el dueño
pidió como vista principal de Nómina (2026-09-29): tramos de entrada a
salida por persona y día, pausas como hueco, la jornada en curso marcada,
la salida olvidada «a revisar» sin horas, el total con el motor de nómina,
sin el administrador, y la descarga en CSV para Excel en español.
"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from tests.conftest import KNOWN_PINS
from tests.payroll.conftest import bogota_utc

API = "/api/v1"


def _week(admin_client: TestClient, store: Any, week_of: str | None = None) -> dict[str, Any]:
    params: dict[str, Any] = {"store_id": store.id}
    if week_of:
        params["week_of"] = week_of
    resp = admin_client.get(f"{API}/admin/payroll/week-schedule", params=params)
    assert resp.status_code == 200, resp.text
    return resp.json()  # type: ignore[no-any-return]


def _person(body: dict[str, Any], employee_id: int) -> dict[str, Any]:
    return {p["employee_id"]: p for p in body["people"]}[employee_id]


def test_week_schedule_has_segments_pauses_totals_and_no_admin(
    device_client: TestClient,
    admin_client: TestClient,
    identify: Any,
    open_shift: Any,
    roster_action: Any,
    employees: dict[str, Any],
    store: Any,
    clock: Any,
) -> None:
    """Martes 10 de marzo de 2026: el cocinero entra a las 8:00, pausa de
    12:00 a 13:00 y sale a las 16:00 — dos tramos, 7 horas. El admin
    autoriza y no aparece. Sin tabla de recargos igual hay horario (no es la
    liquidación)."""
    cook = employees["operator2"]
    clock.set(bogota_utc(2026, 3, 10, 8, 0))
    identify(device_client, cook)
    shift = open_shift(responsible=employees["cashier"])
    identify(device_client, employees["admin"])
    clock.set(bogota_utc(2026, 3, 10, 12, 0))
    roster_action(device_client, shift_id=shift["id"], employee_id=cook.id, action="pause_start", pin=KNOWN_PINS["Operator2"])
    clock.set(bogota_utc(2026, 3, 10, 13, 0))
    roster_action(device_client, shift_id=shift["id"], employee_id=cook.id, action="pause_end", pin=KNOWN_PINS["Operator2"])
    clock.set(bogota_utc(2026, 3, 10, 16, 0))
    resp = device_client.post(f"{API}/attendance/out", json={"employee_id": cook.id, "pin": KNOWN_PINS["Operator2"]})
    assert resp.status_code == 200, resp.text

    clock.set(bogota_utc(2026, 3, 12, 9, 0))
    body = _week(admin_client, store)
    assert body["week_start"] == "2026-03-09"  # lunes
    assert body["week_end"] == "2026-03-15"
    assert len(body["days"]) == 7
    assert body["day_start_hour"] == store.cutoff_hour
    ids = {p["employee_id"] for p in body["people"]}
    assert employees["admin"].id not in ids

    person = _person(body, cook.id)
    assert person["total_minutes"] == 7 * 60
    assert person["total_hours"] == "7.00"
    [day] = person["days"]
    assert day["business_date"] == "2026-03-10"
    assert day["minutes"] == 7 * 60
    segments = day["segments"]
    assert [s["status"] for s in segments] == ["closed", "closed"]
    # Corte a las 6:00: las 8:00 son el minuto 120 del día operativo.
    assert [(s["start_offset_min"], s["end_offset_min"]) for s in segments] == [(120, 360), (420, 600)]
    assert [s["hours"] for s in segments] == ["4.00", "3.00"]


def test_open_and_forgotten_exits_are_marked(
    device_client: TestClient,
    admin_client: TestClient,
    identify: Any,
    employees: dict[str, Any],
    store: Any,
    clock: Any,
) -> None:
    """Una entrada sin salida de un día que ya pasó es «a revisar»: se dibuja
    su entrada, no suma horas. Una de hoy está en curso: su tramo llega a
    ahora."""
    cook = employees["operator2"]
    waiter = employees["operator"]
    clock.set(bogota_utc(2026, 3, 10, 7, 0))
    identify(device_client, cook)  # nunca marca salida
    clock.set(bogota_utc(2026, 3, 11, 9, 0))
    identify(device_client, waiter)
    clock.set(bogota_utc(2026, 3, 11, 11, 30))

    body = _week(admin_client, store, "2026-03-11")
    forgotten = _person(body, cook.id)
    assert forgotten["total_minutes"] == 0
    assert forgotten["review_count"] == 1
    [seg] = forgotten["days"][0]["segments"]
    assert seg["status"] == "review"
    assert seg["end"] is None and seg["minutes"] is None
    assert seg["start_offset_min"] == 60
    assert seg["attendance_id"] is not None

    working = _person(body, waiter.id)
    [open_seg] = working["days"][0]["segments"]
    assert open_seg["status"] == "open"
    assert (open_seg["start_offset_min"], open_seg["end_offset_min"]) == (180, 330)
    assert working["total_minutes"] == 150


def test_week_selector_and_csv_download(
    device_client: TestClient,
    admin_client: TestClient,
    identify: Any,
    employees: dict[str, Any],
    store: Any,
    clock: Any,
) -> None:
    waiter = employees["operator"]
    clock.set(bogota_utc(2026, 3, 10, 9, 0))
    identify(device_client, waiter)
    clock.set(bogota_utc(2026, 3, 10, 17, 30))
    resp = device_client.post(f"{API}/attendance/out", json={"employee_id": waiter.id, "pin": KNOWN_PINS["Operator"]})
    assert resp.status_code == 200, resp.text
    clock.set(bogota_utc(2026, 3, 18, 10, 0))

    # Semana anterior pedida por cualquier día de ella; la de hoy, vacía.
    assert _week(admin_client, store)["people"] == []
    previous = _week(admin_client, store, "2026-03-15")
    assert previous["week_start"] == "2026-03-09"
    assert _person(previous, waiter.id)["total_hours"] == "8.50"

    csv_resp = admin_client.get(
        f"{API}/admin/payroll/week-schedule",
        params={"store_id": store.id, "week_of": "2026-03-10", "format": "csv"},
    )
    assert csv_resp.status_code == 200, csv_resp.text
    assert csv_resp.headers["content-type"].startswith("text/csv")
    assert 'filename="horario-semana-2026-03-09.csv"' in csv_resp.headers["content-disposition"]
    text = csv_resp.content.decode("utf-8")
    assert text.startswith("﻿")
    lines = text.lstrip("﻿").splitlines()
    assert lines[0] == "Persona;Día;Entrada;Salida;Horas;Estado"
    assert lines[1] == f"{waiter.name};martes 2026-03-10;09:00;17:30;8,50;Cerrada"


def test_week_schedule_is_behind_payroll_and_scoped_to_the_org(
    admin_client: TestClient, store: Any, store_b: Any, set_feature: Any
) -> None:
    other = admin_client.get(f"{API}/admin/payroll/week-schedule", params={"store_id": store_b.id})
    assert other.status_code == 404, other.text
    set_feature("payroll", False)
    off = admin_client.get(f"{API}/admin/payroll/week-schedule", params={"store_id": store.id})
    assert off.status_code == 400, off.text
    assert off.json()["error"]["code"] == "FEATURE_DISABLED"

