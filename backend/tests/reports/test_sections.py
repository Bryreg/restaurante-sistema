"""Caja, Equipo e Informes en el celular (`GET /admin/panel/sections`).

Cada tarjeta trae su cifra y su serie ya hechas en el servidor. Lo que se
prueba es que la cifra es **la misma** que ya publica otra pantalla (Hoy,
el turno, la asistencia) y que `null` no se escribe como `0`.

Excepción declarada a «todo entra por HTTP» (`docs/CONTEXTO-AGENTES.md
§11`), la misma de `test_series.py`: para tener un cierre de AYER se corre
el día operativo de un turno ya cerrado y se escribe su diferencia. Es una
lectura de un libro: lo que se prueba es cómo se LEE.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, get_args
from uuid import uuid4

from fastapi.testclient import TestClient
from sqlalchemy import update
from sqlalchemy.orm import Session

from app.core import tz
from app.reports import schemas, series_schemas
from app.shifts.models import BusinessDay, Shift, ShiftStatus
from tests.conftest import KNOWN_PINS

API = "/api/v1"


def _section(admin_client: TestClient, store_id: int | str, section: str) -> dict[str, Any]:
    resp = admin_client.get(f"{API}/admin/panel/sections", params={"store_id": store_id, "section": section})
    assert resp.status_code == 200, resp.text
    body: dict[str, Any] = resp.json()
    return body


def _cards(body: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {c["key"]: c for c in body["cards"]}


def test_the_literal_mirror_for_the_client_says_the_same_as_the_sections() -> None:
    assert set(get_args(schemas.SectionToneLiteral)) == set(get_args(series_schemas.SectionTone))
    assert set(get_args(schemas.SectionChartLiteral)) == set(get_args(series_schemas.SectionChart))
    assert set(get_args(schemas.SectionKeyLiteral)) == set(get_args(series_schemas.SectionKey))


def test_caja_reads_pickups_expenses_and_the_threshold_like_the_shift_does(
    admin_client: TestClient,
    device_client: TestClient,
    open_shift: Any,
    identify: Any,
    employees: Any,
    store: Any,
    clock: Any,
) -> None:
    clock.set(datetime(2026, 9, 19, 13, 0, tzinfo=timezone.utc))  # 8:00 a. m.
    shift = open_shift()
    identify(device_client, employees["cashier"])
    pickup = device_client.post(
        f"{API}/shifts/{shift['id']}/pickups",
        json={"amount": 50_000, "authorizer_pin": KNOWN_PINS["Admin"], "note": "banco", "photo": "retiro.jpg"},
        headers={"Idempotency-Key": str(uuid4())},
    )
    assert pickup.status_code in (200, 201), pickup.text
    for body in (
        {"kind": "expense", "cause": "petty_expense", "amount": 12_000, "note": "Hielo", "receipt_photo": "hielo.jpg"},
        {"kind": "expense", "cause": "other_expense", "amount": 5_000, "note": "Bolsas"},
        # Un ingreso no es gasto: no entra.
        {"kind": "income", "cause": "other_income", "amount": 9_000, "note": "Sobró de ayer"},
    ):
        resp = device_client.post(
            f"{API}/shifts/{shift['id']}/cash-movements", json=body, headers={"Idempotency-Key": str(uuid4())}
        )
        assert resp.status_code in (200, 201), resp.text

    cards = _cards(_section(admin_client, store.id, "caja"))
    assert list(cards) == ["closes", "deposits", "pickups", "expenses"]

    pickups = cards["pickups"]
    assert pickups["value"] == 50_000
    assert pickups["series"]["points"][-1]["now"] is True
    assert pickups["series"]["points"][-1]["value"] == 50_000
    # Los días en que la sede no abrió son «sin dato», no $ 0.
    assert pickups["series"]["points"][0]["value"] is None
    assert [r["value"] for r in pickups["rows"]] == [50_000]

    expenses = cards["expenses"]
    assert expenses["value"] == 17_000
    assert expenses["tone"] == "warning"
    assert expenses["status"] == "1 gasto sin foto"
    # El que no tiene foto va primero, y dice que no la tiene.
    assert expenses["rows"][0]["note"] == "sin foto" and expenses["rows"][0]["value"] == 5_000

    # Ayer no abrió: el cuadre no es «0 de 0», es sin dato.
    closes = cards["closes"]
    assert closes["value"] is None and closes["of"] is None
    assert closes["rows"][0]["note"] == "No abrió"

    # Bajar el umbral de retiro vuelve sugerido el retiro: la misma lectura
    # que el semáforo de Hoy (`cash_over_threshold`).
    settings = admin_client.get(f"{API}/admin/stores/{store.id}/cash-settings").json()
    resp = admin_client.put(
        f"{API}/admin/stores/{store.id}/cash-settings", json={**settings, "cash_pickup_threshold": 100_000}
    )
    assert resp.status_code == 200, resp.text
    pickups = _cards(_section(admin_client, store.id, "caja"))["pickups"]
    assert pickups["tone"] == "warning"
    assert pickups["rows"][0]["note"] == "Sugerido"
    panel = admin_client.get(f"{API}/admin/panel", params={"store_id": store.id}).json()["stores"][0]
    assert panel["cash"]["cash_over_threshold"] is True


def test_caja_closes_of_yesterday_read_the_blind_close_difference(
    admin_client: TestClient,
    open_shift: Any,
    store: Any,
    db: Session,
    clock: Any,
) -> None:
    clock.set(datetime(2026, 9, 19, 13, 0, tzinfo=timezone.utc))
    shift = open_shift()
    yesterday = tz.today_business_date(store.cutoff_hour) - timedelta(days=1)
    row = db.get(Shift, shift["id"])
    assert row is not None
    db.execute(update(BusinessDay).where(BusinessDay.id == row.business_day_id).values(business_date=yesterday))
    db.execute(
        update(Shift)
        .where(Shift.id == row.id)
        .values(status=ShiftStatus.CLOSED, difference=-4_000, closed_by_employee_name="Diana Pérez")
    )
    db.commit()

    closes = _cards(_section(admin_client, store.id, "caja"))["closes"]
    assert (closes["value"], closes["of"]) == (0, 1)
    assert closes["tone"] == "critical"
    assert closes["status"] == "1 faltante"
    assert closes["chart"] == "diverging"
    [row_out] = closes["rows"]
    assert row_out["label"] == f"{store.name} · cerró Diana Pérez"
    assert row_out["value"] == -4_000
    last = closes["series"]["points"][-1]
    assert (last["label"], last["value"], last["outside"]) == ("ayer", -4_000, True)


def test_caja_deposits_card_is_unavailable_with_the_function_off(
    admin_client: TestClient, store: Any, set_feature: Any
) -> None:
    set_feature("money.deposits", False)
    deposits = _cards(_section(admin_client, store.id, "caja"))["deposits"]
    assert deposits["available"] is False and deposits["reason"]
    assert deposits["value"] is None


def test_equipo_reads_the_attendance(
    admin_client: TestClient,
    device_client: TestClient,
    open_shift: Any,
    store: Any,
    clock: Any,
) -> None:
    clock.set(datetime(2026, 9, 19, 13, 0, tzinfo=timezone.utc))  # 8:00 a. m.
    open_shift()
    clock.set(datetime(2026, 9, 19, 14, 30, tzinfo=timezone.utc))  # 9:30

    cards = _cards(_section(admin_client, store.id, "equipo"))
    # «Llegadas tarde» volvió con la planeación de turnos (auditoría e1):
    # sin turnos planeados dice por qué, no un 0.
    assert list(cards) == ["staff", "late", "exits", "hours"]
    assert cards["late"]["available"] is False and cards["late"]["value"] is None
    assert "Planeación" in cards["late"]["reason"]
    staff = cards["staff"]
    assert staff["value"] == 1
    panel = admin_client.get(f"{API}/admin/panel", params={"store_id": store.id}).json()["stores"][0]
    # La serie es la de «Quién trabaja» de Hoy: la misma cuenta.
    assert [p["value"] for p in staff["series"]["points"]] == [
        p["value"] for p in panel["bullets"]["staff_by_hour"]["points"]
    ]
    assert cards["exits"]["value"] == 0 and cards["exits"]["status"] == "Todas marcadas"
    hours = cards["hours"]
    assert hours["unit"] == "minutes"
    assert hours["value"] == 90  # 8:00 a 9:30, en curso
    assert hours["series"]["reference"] is None


def test_informes_is_the_same_sale_that_today_shows(
    admin_client: TestClient,
    device_client: TestClient,
    open_shift: Any,
    sell: Any,
    main_product: Any,
    store: Any,
    clock: Any,
) -> None:
    clock.set(datetime(2026, 9, 19, 17, 0, tzinfo=timezone.utc))  # 12:00 m.
    open_shift()
    sell(main_product, qty=2)
    clock.set(datetime(2026, 9, 19, 17, 20, tzinfo=timezone.utc))

    today = admin_client.get(f"{API}/admin/today", params={"store_id": store.id}).json()
    cards = _cards(_section(admin_client, store.id, "informes"))
    assert list(cards) == ["sales", "best_store", "load", "orders"]
    sales = cards["sales"]
    assert sales["value"] == today["net"]
    assert sales["chart"] == "dual"
    assert sales["series"]["points"][-1]["now"] is True
    assert sales["series"]["points"][-1]["value"] == today["net"]
    # La sede no operaba hace una semana: sin raya, y se dice.
    assert sales["series"]["points"][-1]["reference"] is None
    assert sales["status"] == "Sin comparación con la semana pasada"
    orders = cards["orders"]
    assert orders["value"] == today["orders"]
    assert f"ticket $ {today['avg_ticket']:,}".replace(",", ".") in orders["status"]
    assert cards["best_store"]["available"] is False
    assert cards["load"]["series"]["points"][0]["key"] == "11"


def test_sections_are_scoped_to_the_organization(admin_client: TestClient, store: Any) -> None:
    assert admin_client.get(
        f"{API}/admin/panel/sections", params={"store_id": 999_999, "section": "caja"}
    ).status_code == 404
    assert admin_client.get(
        f"{API}/admin/panel/sections", params={"store_id": store.id, "section": "nomina"}
    ).status_code in (400, 422)
    body = _section(admin_client, "all", "informes")
    assert body["scope"] == "all" and store.id in body["store_ids"]
