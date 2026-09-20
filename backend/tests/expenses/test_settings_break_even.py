"""`GET`/`PATCH /admin/expenses/settings` (costos fijos, agregada — ver
entregable) y `GET /admin/break-even`: `break_even_amount` es `null` **con
motivo**, jamás `0`, sin costos fijos cargados o sin margen de contribución
calculable."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from fastapi.testclient import TestClient

from app.orders.money import round_half_up
from app.stores.models import Store

_WIDE_RANGE = {"from": "2020-01-01", "to": "2099-12-31"}


def test_settings_default_is_none(admin_client: TestClient, store: Store) -> None:
    resp = admin_client.get(f"/api/v1/admin/expenses/settings?store_id={store.id}")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["fixed_costs"] is None


def test_patch_settings_sets_fixed_costs(admin_client: TestClient, store: Store) -> None:
    resp = admin_client.patch(f"/api/v1/admin/expenses/settings?store_id={store.id}", json={"fixed_costs": 3_000_000})
    assert resp.status_code == 200, resp.text
    assert resp.json()["fixed_costs"] == 3_000_000

    again = admin_client.get(f"/api/v1/admin/expenses/settings?store_id={store.id}")
    assert again.json()["fixed_costs"] == 3_000_000


def test_settings_reject_negative_fixed_costs(admin_client: TestClient, store: Store) -> None:
    resp = admin_client.patch(f"/api/v1/admin/expenses/settings?store_id={store.id}", json={"fixed_costs": -1})
    assert resp.status_code == 400, resp.text


def test_break_even_without_fixed_costs_is_null_with_reason_never_zero(admin_client: TestClient, store: Store) -> None:
    resp = admin_client.get("/api/v1/admin/break-even", params={"store_id": store.id, **_WIDE_RANGE})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["available"] is False
    assert body["break_even_amount"] is None
    assert body["break_even_amount"] != 0
    assert body["reason"]


def test_break_even_with_fixed_costs_but_no_sales_is_null_with_reason(admin_client: TestClient, store: Store) -> None:
    admin_client.patch(f"/api/v1/admin/expenses/settings?store_id={store.id}", json={"fixed_costs": 1_000_000})
    resp = admin_client.get("/api/v1/admin/break-even", params={"store_id": store.id, **_WIDE_RANGE})
    body = resp.json()
    assert body["fixed_costs"] == 1_000_000
    assert body["available"] is False
    assert body["break_even_amount"] is None
    assert body["reason"]


def test_break_even_with_fixed_costs_and_costed_sales_computes_amount(
    admin_client: TestClient,
    device_client: TestClient,
    identify: Callable[..., Any],
    employees: Any,
    open_shift: Callable[..., dict[str, Any]],
    sell: Callable[..., Any],
    drink_product: Any,
    ingredient_seeded: Any,
    set_recipe: Callable[..., Any],
    store: Store,
) -> None:
    set_recipe(drink_product.id, lines=[{"ingredient_id": ingredient_seeded.id, "qty": "10", "unit": "g"}])
    open_shift()
    identify(device_client, employees["cashier"])
    sell(drink_product, qty=1)

    admin_client.patch(f"/api/v1/admin/expenses/settings?store_id={store.id}", json={"fixed_costs": 1_000_000})

    sales = admin_client.get(
        "/api/v1/admin/sales", params={"store_id": store.id, **_WIDE_RANGE, "group_by": "business_date"}
    ).json()
    total = sales["total"]
    assert total["theoretical_cost"] is not None
    gross_margin = total["gross_margin"]
    net = total["net"]
    assert net > 0 and gross_margin is not None

    resp = admin_client.get("/api/v1/admin/break-even", params={"store_id": store.id, **_WIDE_RANGE})
    body = resp.json()

    if gross_margin >= 0:
        expected_margin_bp = round_half_up(gross_margin * 10_000, net)
    else:
        expected_margin_bp = -round_half_up(-gross_margin * 10_000, net)
    assert body["contribution_margin_pct_bp"] == expected_margin_bp

    if expected_margin_bp > 0:
        assert body["available"] is True
        assert body["break_even_amount"] == round_half_up(1_000_000 * 10_000, expected_margin_bp)
        assert body["reason"] is None
    else:
        assert body["available"] is False
        assert body["break_even_amount"] is None


def test_break_even_feature_disabled(admin_client: TestClient, store: Store, set_feature: Callable[..., None]) -> None:
    set_feature("money.obligations", False)
    resp = admin_client.get("/api/v1/admin/break-even", params={"store_id": store.id, **_WIDE_RANGE})
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "FEATURE_DISABLED"
