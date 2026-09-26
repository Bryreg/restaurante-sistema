"""`GET /admin/panel` y las fichas `GET /admin/records/...` (panel de control
del administrador): cada número sale de la misma función que ya lo
calculaba para otra pantalla, así que el panel no puede contradecirlas.

Los tests cruzan pantallas a propósito: el esperado del panel contra el de
Hoy y el de Dinero › Operacional; las ventas de la ficha del turno contra
Ventas por turno; lo cobrado por una persona contra Informes › Por persona.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.core import tz
from tests.reports.conftest import idem_headers


def _panel(admin_client: TestClient, store_id: int | str) -> dict[str, Any]:
    resp = admin_client.get("/api/v1/admin/panel", params={"store_id": store_id})
    assert resp.status_code == 200, resp.text
    return resp.json()


def test_panel_without_shift_says_so_and_matches_today(admin_client: TestClient, store: Any) -> None:
    body = _panel(admin_client, store.id)
    assert body["scope"] == "store"
    [panel] = body["stores"]
    assert panel["cash"] is None
    assert panel["light"] == "red"
    assert [r["key"] for r in panel["reasons"]][:1] == ["no_shift"]
    assert panel["staff"]["clocked_in"] == []
    assert panel["staff"]["reason"]

    today = admin_client.get("/api/v1/admin/today", params={"store_id": store.id}).json()
    assert today["current_shift"] is None
    assert today["expected_cash"] is None


def test_panel_cash_is_the_same_figure_in_today_and_in_dinero(
    admin_client: TestClient, device_client: TestClient, identify: Any, employees: Any, open_shift: Any,
    sell: Any, main_product: Any, store: Any,
) -> None:
    shift = open_shift()
    identify(device_client, employees["cashier"])
    sell(main_product, qty=1)

    [panel] = _panel(admin_client, store.id)["stores"]
    today = admin_client.get("/api/v1/admin/today", params={"store_id": store.id}).json()
    business_date = today["business_date"]
    rows = admin_client.get(
        "/api/v1/admin/shifts", params={"store_id": store.id, "from": business_date, "to": business_date}
    ).json()

    assert panel["cash"]["shift_id"] == shift["id"]
    assert panel["cash"]["expected_cash"] == 200_000 + 25_000
    assert today["expected_cash"] == panel["cash"]["expected_cash"]
    assert today["current_shift"]["shift_id"] == shift["id"]
    # Dinero › Operacional publica el esperado vivo del turno abierto (antes «—»).
    [row] = [r for r in rows if r["id"] == shift["id"]]
    assert row["expected_cash"] == panel["cash"]["expected_cash"]
    assert row["cash_responsible_active"] is True
    assert panel["cash"]["responsible"] == {
        "id": employees["cashier"].id, "name": employees["cashier"].name, "active": True,
    }
    assert panel["cash"]["is_stale"] is False


def test_staff_separates_clocking_in_from_merely_identifying(
    admin_client: TestClient, device_client: TestClient, identify: Any, employees: Any, open_shift: Any, store: Any,
) -> None:
    shift = open_shift()
    # El supervisor sólo se identifica (p. ej. para autorizar algo): entra al
    # roster, pero no marcó entrada.
    identify(device_client, employees["supervisor"])
    # El mesero marca entrada con su PIN.
    resp = device_client.post(
        f"/api/v1/shifts/{shift['id']}/roster",
        json={"employee_id": employees["operator"].id, "action": "in", "pin": "2222"},
    )
    assert resp.status_code in (200, 201), resp.text

    [panel] = _panel(admin_client, store.id)["stores"]
    clocked = {p["employee_id"] for p in panel["staff"]["clocked_in"]}
    identified = {p["employee_id"] for p in panel["staff"]["identified_only"]}
    # El responsable de caja cuenta como presente: tiene el cajón.
    assert employees["cashier"].id in clocked
    assert employees["operator"].id in clocked
    assert employees["supervisor"].id in identified
    assert employees["supervisor"].id not in clocked

    record = admin_client.get(f"/api/v1/admin/records/shift/{shift['id']}").json()
    by_person = {a["employee_id"]: a["clocked_in"] for a in record["attendance"]}
    assert by_person[employees["supervisor"].id] is False
    assert by_person[employees["operator"].id] is True


def test_abandoned_shift_from_a_previous_day_shows_everywhere(
    admin_client: TestClient, device_client: TestClient, employees: Any, open_shift: Any, store: Any,
    clock: Any, db: Session,
) -> None:
    clock.set(datetime(2026, 9, 16, 15, 0, tzinfo=timezone.utc))
    shift = open_shift()
    # Diez días después nadie lo cerró, y el responsable ya no trabaja acá.
    clock.set(datetime(2026, 9, 26, 15, 0, tzinfo=timezone.utc))
    cashier = employees["cashier"]
    cashier.active = False
    db.commit()

    [panel] = _panel(admin_client, store.id)["stores"]
    assert panel["cash"]["shift_id"] == shift["id"]
    assert panel["cash"]["business_date"] == "2026-09-16"
    assert panel["cash"]["is_stale"] is True
    assert panel["cash"]["responsible"]["active"] is False
    assert panel["light"] == "red"
    keys = [r["key"] for r in panel["reasons"]]
    assert "shift_stale" in keys and "responsible_inactive" in keys
    # Su roster es del 16: no dice quién está hoy.
    assert panel["staff"]["clocked_in"] == []
    assert panel["staff"]["reason"] and "2026-09-16" in panel["staff"]["reason"]

    today = admin_client.get("/api/v1/admin/today", params={"store_id": store.id}).json()
    assert today["current_shift"]["is_stale"] is True
    assert today["current_shift"]["responsible"]["active"] is False
    # La campana lo sabe aunque ninguna tablet esté preguntando por el turno.
    assert any(a["type"] == "shift_stale" for a in today["alerts"])

    business_date = tz.today_business_date(store.cutoff_hour).isoformat()
    params = {"store_id": store.id, "from": business_date, "to": business_date}
    plain = admin_client.get("/api/v1/admin/shifts", params=params).json()
    assert [r["id"] for r in plain] == []
    with_open = admin_client.get("/api/v1/admin/shifts", params={**params, "include_open": "true"}).json()
    [row] = with_open
    assert row["id"] == shift["id"]
    assert row["is_stale"] is True
    assert row["cash_responsible_active"] is False


def test_panel_all_stores_only_lists_the_admins_organization(
    admin_client: TestClient, store: Any, store_b: Any,
) -> None:
    body = _panel(admin_client, "all")
    assert body["scope"] == "all"
    ids = [s["store_id"] for s in body["stores"]]
    assert store.id in ids
    assert store_b.id not in ids
    assert admin_client.get("/api/v1/admin/panel", params={"store_id": store_b.id}).status_code == 404
    assert admin_client.get("/api/v1/admin/panel", params={"store_id": "x"}).status_code == 400


def test_panel_is_admin_only(device_client: TestClient, store: Any) -> None:
    assert device_client.get("/api/v1/admin/panel", params={"store_id": store.id}).status_code in (401, 403)


def test_shift_record_sales_are_the_sales_report_by_shift(
    admin_client: TestClient, device_client: TestClient, identify: Any, employees: Any, open_shift: Any,
    sell: Any, main_product: Any, drink_product: Any, store: Any,
) -> None:
    shift = open_shift()
    identify(device_client, employees["cashier"])
    sell(main_product, qty=1)
    sell(drink_product, qty=2)

    record = admin_client.get(f"/api/v1/admin/records/shift/{shift['id']}")
    assert record.status_code == 200, record.text
    body = record.json()
    today = admin_client.get("/api/v1/admin/today", params={"store_id": store.id}).json()
    bd = today["business_date"]
    sales = admin_client.get(
        "/api/v1/admin/sales", params={"store_id": store.id, "from": bd, "to": bd, "group_by": "shift"}
    ).json()
    [row] = [r for r in sales["rows"] if r["key"] == str(shift["id"])]
    assert body["sales"]["net"] == row["net"] == today["net"]
    assert body["sales"]["orders"] == row["orders"] == 2
    assert body["responsible"]["active"] is True
    assert body["is_stale"] is False
    assert body["voids"] == [] and body["novelties"] == []


def test_shift_record_of_another_organization_is_404(admin_client: TestClient) -> None:
    assert admin_client.get("/api/v1/admin/records/shift/999999").status_code == 404


def test_employee_record_charged_is_the_informes_row(
    admin_client: TestClient, device_client: TestClient, identify: Any, employees: Any, open_shift: Any,
    sell: Any, main_product: Any, store: Any,
) -> None:
    shift = open_shift()
    identify(device_client, employees["cashier"])
    sell(main_product, qty=1)
    cashier = employees["cashier"]

    today = admin_client.get("/api/v1/admin/today", params={"store_id": store.id}).json()
    bd = today["business_date"]
    record = admin_client.get(
        f"/api/v1/admin/records/employee/{cashier.id}", params={"store_id": store.id, "from": bd, "to": bd}
    )
    assert record.status_code == 200, record.text
    body = record.json()
    overview = admin_client.get(
        "/api/v1/admin/reports/overview", params={"store_id": store.id, "from": bd, "to": bd}
    ).json()
    [row] = [r for r in overview["by_employee"] if r["key"] == str(cashier.id)]
    assert body["charged"]["net"] == row["net"]
    assert body["charged"]["orders"] == row["orders"]
    assert [s["shift_id"] for s in body["shifts_as_responsible"]] == [shift["id"]]
    assert body["employee"]["active"] is True

    # Sin fechas: los últimos 30 días operativos.
    default = admin_client.get(f"/api/v1/admin/records/employee/{cashier.id}", params={"store_id": store.id}).json()
    assert default["date_to"] == bd
    assert default["charged"]["net"] == row["net"]

    # Quien no cobró nada: `null`, no una fila en cero.
    nobody = admin_client.get(
        f"/api/v1/admin/records/employee/{employees['operator3'].id}", params={"store_id": store.id}
    ).json()
    assert nobody["charged"] is None


def test_employee_record_of_another_store_is_404(admin_client: TestClient, employees: Any, store_b: Any) -> None:
    resp = admin_client.get(
        f"/api/v1/admin/records/employee/{employees['cashier'].id}", params={"store_id": store_b.id}
    )
    assert resp.status_code == 404


def test_ingredient_record_reads_the_ledger(
    admin_client: TestClient, ingredient_seeded: Any, set_feature: Any, store: Any, db: Session,
) -> None:
    set_feature("inventory.perpetual", True)
    resp = admin_client.get(f"/api/v1/admin/records/ingredient/{ingredient_seeded.id}")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["ingredient_id"] == ingredient_seeded.id
    assert body["stock"] is not None
    assert isinstance(body["by_cause"], list)

    set_feature("inventory.perpetual", False)
    off = admin_client.get(f"/api/v1/admin/records/ingredient/{ingredient_seeded.id}").json()
    # Sin inventario perpetuo no hay libro: `null`, nunca «0».
    assert off["stock"] is None
    assert off["by_cause"] == []

    assert admin_client.get("/api/v1/admin/records/ingredient/999999").status_code == 404


def test_record_range_is_validated(admin_client: TestClient, employees: Any, store: Any) -> None:
    resp = admin_client.get(
        f"/api/v1/admin/records/employee/{employees['cashier'].id}",
        params={"store_id": store.id, "from": "2026-02-01", "to": "2026-01-01"},
    )
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "VALIDATION_ERROR"


def test_kitchen_lateness_uses_the_kds_color(
    admin_client: TestClient, device_client: TestClient, identify: Any, employees: Any, open_shift: Any,
    main_product: Any, store: Any, set_feature: Any, clock: Any,
) -> None:
    set_feature("kitchen.view", True)
    clock.set(datetime(2026, 3, 1, 15, 0, tzinfo=timezone.utc))
    open_shift()
    identify(device_client, employees["operator"])
    order = device_client.post("/api/v1/orders", json={"channel": "counter"}, headers=idem_headers()).json()
    order = device_client.post(
        f"/api/v1/orders/{order['id']}/items",
        json={"expected_version": order["version"], "items": [{"product_id": main_product.id, "qty": 1}]},
        headers=idem_headers(),
    ).json()
    sent = device_client.post(
        f"/api/v1/orders/{order['id']}/send", json={"expected_version": order["version"]}, headers=idem_headers()
    )
    assert sent.status_code in (200, 201), sent.text

    [panel] = _panel(admin_client, store.id)["stores"]
    assert panel["kitchen"]["enabled"] is True
    assert panel["kitchen"]["in_kitchen"] == 1
    assert panel["kitchen"]["late"] == 0

    # Cocina caliente: 15 min de objetivo; a los 30 es rojo en el KDS.
    clock.advance(minutes=30)
    [panel] = _panel(admin_client, store.id)["stores"]
    assert panel["kitchen"]["late"] == 1
    assert panel["kitchen"]["very_late"] == 1
    assert panel["kitchen"]["oldest_late_minutes"] == 30
    assert "kitchen_late" in [r["key"] for r in panel["reasons"]]

    set_feature("kitchen.view", False)
    [panel] = _panel(admin_client, store.id)["stores"]
    assert panel["kitchen"]["enabled"] is False

