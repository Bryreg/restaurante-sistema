"""`POST /orders/{id}/items` y `PATCH .../items/{item_id}`: snapshot,
modificadores, combos, idempotencia y versión optimista."""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from tests.orders.conftest import idem_headers


def test_snapshot_freezes_price_and_tax(device_client: TestClient, identify: Any, employees: Any, open_shift: Any, new_order: Any, add_items: Any, main_product: Any) -> None:
    open_shift()
    identify(device_client, employees["operator"])
    order = new_order().json()
    resp = add_items(order, [{"product_id": main_product.id, "qty": 2}])
    assert resp.status_code == 200, resp.text
    item = resp.json()["items"][0]
    assert item["qty"] == 2
    assert item["list_price"] == main_product.price_dine_in
    assert item["unit_price"] == main_product.price_dine_in
    assert item["tax_code"] == "inc_8"
    assert item["tax_rate"] == 8
    assert item["status"] == "pending"
    assert item["course"] == "main"
    assert item["station"] == "hot_kitchen"
    assert resp.json()["version"] == order["version"] + 1


def test_takeout_price_falls_back_to_dine_in(device_client: TestClient, identify: Any, employees: Any, open_shift: Any, new_order: Any, add_items: Any, drink_product: Any) -> None:
    open_shift()
    identify(device_client, employees["operator"])
    order = new_order(channel="takeout", takeout={"customer_name": "Ana"}).json()
    resp = add_items(order, [{"product_id": drink_product.id, "qty": 1}])
    assert resp.status_code == 200, resp.text
    item = resp.json()["items"][0]
    assert item["list_price"] == drink_product.price_dine_in  # sin price_takeout propio: cae a dine_in
    assert item["station"] is None


def test_same_idempotency_key_does_not_duplicate(device_client: TestClient, identify: Any, employees: Any, open_shift: Any, new_order: Any, main_product: Any) -> None:
    open_shift()
    identify(device_client, employees["operator"])
    order = new_order().json()
    headers = idem_headers()
    body = {"expected_version": order["version"], "items": [{"product_id": main_product.id, "qty": 1}]}
    first = device_client.post(f"/api/v1/orders/{order['id']}/items", json=body, headers=headers)
    second = device_client.post(f"/api/v1/orders/{order['id']}/items", json=body, headers=headers)
    assert first.status_code == 200, first.text
    assert second.status_code == 200, second.text
    assert first.json() == second.json()
    assert len(second.json()["items"]) == 1


def test_stale_version_returns_current_order(device_client: TestClient, identify: Any, employees: Any, open_shift: Any, new_order: Any, add_items: Any, main_product: Any) -> None:
    open_shift()
    identify(device_client, employees["operator"])
    order = new_order().json()
    fresh = add_items(order, [{"product_id": main_product.id, "qty": 1}]).json()  # version += 1
    stale = add_items(order, [{"product_id": main_product.id, "qty": 1}])  # todavía usa la version vieja
    assert stale.status_code == 409, stale.text
    err = stale.json()["error"]
    assert err["code"] == "STALE_VERSION"
    assert err["order"]["version"] == fresh["version"]
    assert len(err["order"]["items"]) == 1


def test_product_unavailable(device_client: TestClient, identify: Any, employees: Any, open_shift: Any, new_order: Any, add_items: Any, main_product: Any, db: Any) -> None:
    open_shift()
    identify(device_client, employees["operator"])
    main_product.available = False
    db.commit()
    order = new_order().json()
    resp = add_items(order, [{"product_id": main_product.id, "qty": 1}])
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "PRODUCT_UNAVAILABLE"
    assert resp.json()["error"]["product_id"] == main_product.id


def test_product_unavailable_by_daily_count(device_client: TestClient, identify: Any, employees: Any, open_shift: Any, set_feature: Any, new_order: Any, add_items: Any, main_product: Any, db: Any) -> None:
    set_feature("pos.daily_count", True)
    main_product.daily_count = 2
    main_product.daily_remaining = 2
    db.commit()
    open_shift()
    identify(device_client, employees["operator"])
    order = new_order().json()
    resp = add_items(order, [{"product_id": main_product.id, "qty": 3}])
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "PRODUCT_UNAVAILABLE"
    assert resp.json()["error"]["remaining"] == 2


def test_modifiers_min_max_required(device_client: TestClient, identify: Any, employees: Any, open_shift: Any, set_feature: Any, new_order: Any, add_items: Any, main_product: Any, db: Any) -> None:
    from app.catalog.models import ModifierGroup, ModifierOption

    set_feature("pos.modifiers", True)
    group = ModifierGroup(
        organization_id=main_product.organization_id, store_id=main_product.store_id, product_id=main_product.id,
        name="Término", required=True, min=1, max=1, sort_order=0,
    )
    db.add(group)
    db.flush()
    opt_ok = ModifierOption(organization_id=main_product.organization_id, store_id=main_product.store_id, modifier_group_id=group.id, name="Término medio", price_delta=0, sort_order=0, available=True)
    opt_unavailable = ModifierOption(organization_id=main_product.organization_id, store_id=main_product.store_id, modifier_group_id=group.id, name="Bien cocido", price_delta=1000, sort_order=1, available=False)
    db.add_all([opt_ok, opt_unavailable])
    db.commit()

    # `open_shift()` crea el día operativo si es el primero del día, y eso
    # limpia los agotados (`reset_daily_availability`, SPEC-NEGOCIO §3.3):
    # por eso el turno se abre ANTES de marcar la opción sin disponibilidad,
    # y no al revés.
    open_shift()
    identify(device_client, employees["operator"])
    opt_unavailable.available = False
    db.commit()
    order = new_order().json()

    missing = add_items(order, [{"product_id": main_product.id, "qty": 1, "modifiers": []}])
    assert missing.status_code == 400, missing.text
    assert missing.json()["error"]["code"] == "MODIFIER_SELECTION_INVALID"

    unavailable = add_items(order, [{"product_id": main_product.id, "qty": 1, "modifiers": [{"option_id": opt_unavailable.id}]}])
    assert unavailable.status_code == 400, unavailable.text
    assert unavailable.json()["error"]["code"] == "OPTION_UNAVAILABLE"

    ok = add_items(order, [{"product_id": main_product.id, "qty": 1, "modifiers": [{"option_id": opt_ok.id}]}])
    assert ok.status_code == 200, ok.text
    item = ok.json()["items"][0]
    assert item["modifiers"][0]["option_id"] == opt_ok.id
    assert item["modifiers_text"] == "Término medio"


def test_modifiers_need_feature_flag(device_client: TestClient, identify: Any, employees: Any, open_shift: Any, set_feature: Any, new_order: Any, add_items: Any, main_product: Any, db: Any) -> None:
    from app.catalog.models import ModifierGroup, ModifierOption

    group = ModifierGroup(organization_id=main_product.organization_id, store_id=main_product.store_id, product_id=main_product.id, name="Término", required=False, min=0, max=1, sort_order=0)
    db.add(group)
    db.flush()
    opt = ModifierOption(organization_id=main_product.organization_id, store_id=main_product.store_id, modifier_group_id=group.id, name="Extra", price_delta=500, sort_order=0, available=True)
    db.add(opt)
    db.commit()

    set_feature("pos.modifiers", False)
    open_shift()
    identify(device_client, employees["operator"])
    order = new_order().json()
    resp = add_items(order, [{"product_id": main_product.id, "qty": 1, "modifiers": [{"option_id": opt.id}]}])
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "FEATURE_DISABLED"
    assert resp.json()["error"]["feature"] == "pos.modifiers"


def test_combo_not_active(device_client: TestClient, identify: Any, employees: Any, open_shift: Any, set_feature: Any, new_order: Any, add_items: Any, main_product: Any, db: Any) -> None:
    from app.catalog.models import Combo
    from app.core import clock as clock_module

    set_feature("pos.combos", True)
    now = clock_module.now_utc()
    combo = Combo(
        organization_id=main_product.organization_id, store_id=main_product.store_id, name="Menú",
        price=15000, active=False, schedule={"days": [0, 1, 2, 3, 4, 5, 6], "from": "00:00", "to": "23:59"},
        created_at=now, updated_at=now,
    )
    db.add(combo)
    db.commit()

    open_shift()
    identify(device_client, employees["operator"])
    order = new_order().json()
    resp = add_items(order, [{"combo_id": combo.id, "qty": 1}])
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "COMBO_NOT_ACTIVE"


def test_combo_selection_valid_freezes_selections(device_client: TestClient, identify: Any, employees: Any, open_shift: Any, set_feature: Any, new_order: Any, add_items: Any, main_product: Any, drink_product: Any, db: Any) -> None:
    from app.core import clock as clock_module
    from app.catalog.models import Combo, ComboGroup, ComboOption

    set_feature("pos.combos", True)
    now = clock_module.now_utc()
    combo = Combo(
        organization_id=main_product.organization_id, store_id=main_product.store_id, name="Menú del día",
        price=18000, active=True, schedule={"days": [0, 1, 2, 3, 4, 5, 6], "from": "00:00", "to": "23:59"},
        created_at=now, updated_at=now,
    )
    db.add(combo)
    db.flush()
    group = ComboGroup(organization_id=combo.organization_id, store_id=combo.store_id, combo_id=combo.id, name="Plato", sort_order=0)
    db.add(group)
    db.flush()
    option = ComboOption(organization_id=combo.organization_id, store_id=combo.store_id, combo_group_id=group.id, product_id=main_product.id, active_today=True, available_today=True)
    db.add(option)
    db.commit()

    open_shift()
    identify(device_client, employees["operator"])
    order = new_order().json()

    incomplete = add_items(order, [{"combo_id": combo.id, "qty": 1, "combo_selections": []}])
    assert incomplete.status_code == 400, incomplete.text
    assert incomplete.json()["error"]["code"] == "COMBO_SELECTION_INVALID"

    ok = add_items(order, [{"combo_id": combo.id, "qty": 1, "combo_selections": [{"group_id": group.id, "option_id": option.id}]}])
    assert ok.status_code == 200, ok.text
    item = ok.json()["items"][0]
    assert item["unit_price"] == 18000
    assert item["combo_selections"][0]["product_id"] == main_product.id
    assert item["station"] == "hot_kitchen"


def test_patch_only_while_pending(device_client: TestClient, identify: Any, employees: Any, open_shift: Any, new_order: Any, add_items: Any, main_product: Any, send_order: Any) -> None:
    open_shift()
    identify(device_client, employees["operator"])
    order = new_order().json()
    order = add_items(order, [{"product_id": main_product.id, "qty": 1}]).json()
    item_id = order["items"][0]["id"]

    patched = device_client.patch(
        f"/api/v1/orders/{order['id']}/items/{item_id}", json={"expected_version": order["version"], "qty": 3}
    )
    assert patched.status_code == 200, patched.text
    assert patched.json()["items"][0]["qty"] == 3

    order = patched.json()
    order = send_order(order).json()
    stuck = device_client.patch(
        f"/api/v1/orders/{order['id']}/items/{item_id}", json={"expected_version": order["version"], "qty": 5}
    )
    assert stuck.status_code == 400, stuck.text
    assert stuck.json()["error"]["code"] == "ITEM_NOT_PENDING"


def test_bill_presented_needs_auth_to_add_items(device_client: TestClient, identify: Any, employees: Any, open_shift: Any, set_feature: Any, new_order: Any, add_items: Any, main_product: Any) -> None:
    set_feature("pos.pre_bill", True)
    open_shift()
    identify(device_client, employees["operator"])
    order = new_order().json()
    order = add_items(order, [{"product_id": main_product.id, "qty": 1}]).json()
    presented = device_client.post(
        f"/api/v1/orders/{order['id']}/bill/present", json={"expected_version": order["version"]}, headers=idem_headers()
    )
    assert presented.status_code == 200, presented.text
    order_id = order["id"]
    current = device_client.get(f"/api/v1/orders/{order_id}").json()

    denied = add_items(current, [{"product_id": main_product.id, "qty": 1}])
    assert denied.status_code == 400, denied.text
    assert denied.json()["error"]["code"] == "BILL_PRESENTED_NEEDS_AUTH"

    authorized = add_items(current, [{"product_id": main_product.id, "qty": 1}], authorizer_pin="9999")
    assert authorized.status_code == 200, authorized.text
    assert len(authorized.json()["items"]) == 2
