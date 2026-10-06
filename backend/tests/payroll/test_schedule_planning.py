"""Turnos planeados y planeado contra real (auditoría e1, 0050).

`/admin/payroll/schedule`: el administrador planea por persona y por día,
copia la semana anterior, y la asistencia real (el primer PIN del día) se
compara contra lo planeado — a tiempo, tarde (con minutos), no ha llegado,
no vino, con novedad o sin turno. La tarjeta «Llegadas tarde» del celular
lee la misma cuenta. Nada se borra: cambiar o quitar un turno lo anula.

Sede de prueba: corte a las 6:00. Martes 10 de marzo de 2026.
"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.payroll.models import StaffScheduleShift
from tests.payroll.conftest import bogota_utc, idem_headers

API = "/api/v1"
DAY = "2026-03-10"


def _plan(
    admin_client: TestClient, store: Any, employee: Any, start: str, end: str, *, day: str = DAY, note: str | None = None,
    headers: dict[str, str] | None = None,
) -> Any:
    return admin_client.put(
        f"{API}/admin/payroll/schedule/shifts",
        params={"store_id": store.id},
        json={"employee_id": employee.id, "business_date": day, "start": start, "end": end, "note": note},
        headers=headers or idem_headers(),
    )


def _week(admin_client: TestClient, store: Any, week_of: str = DAY) -> dict[str, Any]:
    resp = admin_client.get(f"{API}/admin/payroll/schedule", params={"store_id": store.id, "week_of": week_of})
    assert resp.status_code == 200, resp.text
    return resp.json()  # type: ignore[no-any-return]


def _day(body: dict[str, Any], employee: Any, day: str = DAY) -> dict[str, Any]:
    person = {p["employee_id"]: p for p in body["people"]}[employee.id]
    return {d["business_date"]: d for d in person["days"]}[day]


def test_plan_a_shift_is_idempotent_and_shows_in_the_week(
    admin_client: TestClient, employees: dict[str, Any], store: Any, clock: Any
) -> None:
    clock.set(bogota_utc(2026, 3, 9, 9, 0))
    headers = idem_headers()
    first = _plan(admin_client, store, employees["operator"], "07:00", "15:00", note="Abre cocina", headers=headers)
    assert first.status_code == 200, first.text
    body = first.json()
    assert (body["start"], body["end"], body["planned_minutes"]) == ("07:00", "15:00", 480)
    assert body["note"] == "Abre cocina"
    replay = _plan(admin_client, store, employees["operator"], "07:00", "15:00", note="Abre cocina", headers=headers)
    assert replay.json() == body

    week = _week(admin_client, store)
    assert week["week_start"] == "2026-03-09" and week["week_end"] == "2026-03-15"
    day = _day(week, employees["operator"])
    assert day["planned"]["id"] == body["id"]
    assert day["status"] == "upcoming"
    # El administrador no trabaja turnos: no aparece en la planeación.
    assert employees["admin"].id not in {p["employee_id"] for p in week["people"]}
    person = {p["employee_id"]: p for p in week["people"]}[employees["operator"].id]
    assert person["planned_minutes"] == 480


def test_overnight_and_after_midnight_belong_to_the_same_business_day(
    admin_client: TestClient, employees: dict[str, Any], store: Any, clock: Any
) -> None:
    clock.set(bogota_utc(2026, 3, 9, 9, 0))
    night = _plan(admin_client, store, employees["operator"], "18:00", "02:00").json()
    assert (night["start_minute"], night["end_minute"], night["planned_minutes"]) == (1080, 1560, 480)
    assert (night["start"], night["end"]) == ("18:00", "02:00")
    # Con corte a las 6:00, entrar a la 1:00 es madrugada del MISMO día operativo.
    late_night = _plan(admin_client, store, employees["operator2"], "01:00", "05:00").json()
    assert (late_night["start_minute"], late_night["end_minute"]) == (1500, 1740)


def test_changing_a_shift_voids_the_old_row_and_removing_it_voids_it_too(
    admin_client: TestClient, employees: dict[str, Any], store: Any, clock: Any, db: Session
) -> None:
    clock.set(bogota_utc(2026, 3, 9, 9, 0))
    first = _plan(admin_client, store, employees["operator"], "07:00", "15:00").json()
    second = _plan(admin_client, store, employees["operator"], "08:00", "16:00").json()
    assert second["id"] != first["id"]
    rows = db.execute(select(StaffScheduleShift).where(StaffScheduleShift.employee_id == employees["operator"].id)).scalars().all()
    assert len(rows) == 2
    assert [r.voided_at is None for r in sorted(rows, key=lambda r: r.id)] == [False, True]

    resp = admin_client.post(
        f"{API}/admin/payroll/schedule/shifts/{second['id']}/void",
        params={"store_id": store.id},
        json={"reason": "Pidió el día"},
        headers=idem_headers(),
    )
    assert resp.status_code == 200, resp.text
    assert _day(_week(admin_client, store), employees["operator"])["planned"] is None
    # Nada se borró.
    assert len(db.execute(select(StaffScheduleShift)).scalars().all()) == 2


def test_planned_vs_actual_late_missing_no_show_excused_and_unplanned(
    admin_client: TestClient,
    device_client: TestClient,
    identify: Any,
    employees: dict[str, Any],
    store: Any,
    clock: Any,
) -> None:
    clock.set(bogota_utc(2026, 3, 9, 9, 0))
    on_time, late, missing, no_show, excused = (
        employees["supervisor"], employees["operator"], employees["operator2"], employees["operator3"], employees["cashier"],
    )
    _plan(admin_client, store, on_time, "07:00", "15:00")
    _plan(admin_client, store, late, "07:00", "15:00")
    _plan(admin_client, store, missing, "08:00", "16:00")
    _plan(admin_client, store, no_show, "06:00", "07:30")
    _plan(admin_client, store, excused, "07:00", "15:00")
    resp = admin_client.post(
        f"{API}/admin/payroll/absences",
        params={"store_id": store.id},
        json={"employee_id": excused.id, "kind": "sick_leave", "date_from": DAY, "date_to": DAY},
        headers=idem_headers(),
    )
    assert resp.status_code == 201, resp.text

    clock.set(bogota_utc(2026, 3, 10, 7, 4))  # dentro de la gracia de 5 min
    identify(device_client, on_time)
    clock.set(bogota_utc(2026, 3, 10, 7, 12))
    identify(device_client, late)

    clock.set(bogota_utc(2026, 3, 10, 9, 0))
    week = _week(admin_client, store)
    assert week["grace_minutes"] == 5
    assert _day(week, on_time)["status"] == "on_time"
    assert _day(week, on_time)["late_minutes"] is None
    late_day = _day(week, late)
    assert (late_day["status"], late_day["late_minutes"]) == ("late", 12)
    assert late_day["actual_in_at"] is not None
    assert _day(week, missing)["status"] == "missing"
    assert _day(week, no_show)["status"] == "no_show"
    assert _day(week, excused)["status"] == "excused"
    assert (week["late_count"], week["no_show_count"]) == (1, 1)

    # La tarjeta del celular lee la misma cuenta.
    cards = {
        c["key"]: c
        for c in admin_client.get(
            f"{API}/admin/panel/sections", params={"store_id": store.id, "section": "equipo"}
        ).json()["cards"]
    }
    card = cards["late"]
    assert card["available"] is True
    assert card["value"] == 3 and card["of"] == 5  # tarde + no vino + no ha llegado, de 5 planeados
    assert card["tone"] == "critical"
    notes = {r["label"].split(" · ")[0]: (r["note"], r["value"]) for r in card["rows"]}
    assert notes[late.name] == (None, 12)
    assert notes[missing.name] == ("No ha llegado", None)
    assert notes[no_show.name] == ("No vino", None)
    today_point = card["series"]["points"][-1]
    assert today_point["now"] is True and today_point["value"] == 3


def test_attendance_without_a_plan_is_unplanned(
    admin_client: TestClient, device_client: TestClient, identify: Any, employees: dict[str, Any], store: Any, clock: Any
) -> None:
    clock.set(bogota_utc(2026, 3, 10, 7, 0))
    identify(device_client, employees["operator"])
    day = _day(_week(admin_client, store), employees["operator"])
    assert day["planned"] is None and day["status"] == "unplanned"


def test_copy_previous_week_does_not_overwrite(
    admin_client: TestClient, employees: dict[str, Any], store: Any, clock: Any
) -> None:
    clock.set(bogota_utc(2026, 3, 9, 9, 0))
    _plan(admin_client, store, employees["operator"], "07:00", "15:00", day="2026-03-03")
    _plan(admin_client, store, employees["operator2"], "10:00", "18:00", day="2026-03-04")
    # La semana destino ya tiene a `operator2` el miércoles: no se pisa.
    _plan(admin_client, store, employees["operator2"], "12:00", "20:00", day="2026-03-11")

    resp = admin_client.post(
        f"{API}/admin/payroll/schedule/copy-previous-week",
        params={"store_id": store.id},
        json={"week_of": "2026-03-12"},
        headers=idem_headers(),
    )
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"week_start": "2026-03-09", "copied": 1, "skipped": 1}
    week = _week(admin_client, store)
    assert _day(week, employees["operator"], "2026-03-10")["planned"]["start"] == "07:00"
    assert _day(week, employees["operator2"], "2026-03-11")["planned"]["start"] == "12:00"


def test_admin_cannot_be_planned_and_bad_hours_are_rejected(
    admin_client: TestClient, employees: dict[str, Any], store: Any, clock: Any
) -> None:
    clock.set(bogota_utc(2026, 3, 9, 9, 0))
    resp = _plan(admin_client, store, employees["admin"], "07:00", "15:00")
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "SCHEDULE_ROLE_NOT_PLANNED"
    bad = _plan(admin_client, store, employees["operator"], "7:00", "25:00")
    assert bad.status_code in (400, 422)


def test_schedule_requires_payroll_and_the_card_says_why(
    admin_client: TestClient, employees: dict[str, Any], store: Any, set_feature: Any
) -> None:
    set_feature("payroll", False)
    resp = admin_client.get(f"{API}/admin/payroll/schedule", params={"store_id": store.id})
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "FEATURE_DISABLED"
    assert _plan(admin_client, store, employees["operator"], "07:00", "15:00").status_code == 400
    cards = {
        c["key"]: c
        for c in admin_client.get(
            f"{API}/admin/panel/sections", params={"store_id": store.id, "section": "equipo"}
        ).json()["cards"]
    }
    assert cards["late"]["available"] is False
    assert "Nómina" in cards["late"]["reason"]
