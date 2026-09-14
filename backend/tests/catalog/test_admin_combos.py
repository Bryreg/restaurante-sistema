"""Combos y menú del día: `COMBO_WITHOUT_GROUPS` al activar sin grupos,
grupos/opciones anidados, y «armar el menú de hoy» (`PUT .../today`)."""

from __future__ import annotations

from typing import Any, Callable

from fastapi.testclient import TestClient

from app.stores.models import Store


def test_activating_combo_without_groups_is_rejected(admin_client: TestClient, store: Store) -> None:
    resp = admin_client.post(
        f"/api/v1/admin/combos?store_id={store.id}",
        json={
            "name": "Combo vacío",
            "price": 10_000,
            "active": True,
            "schedule": {"days": [0, 1, 2, 3, 4, 5, 6], "from": "00:00", "to": "23:59"},
            "groups": [],
        },
    )
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "COMBO_WITHOUT_GROUPS"


def test_combo_can_be_created_inactive_without_groups_then_activated(
    admin_client: TestClient, store: Store, create_product: Callable[..., dict[str, Any]]
) -> None:
    product = create_product(name="Jugo de mango", dine_in=8_000)
    resp = admin_client.post(
        f"/api/v1/admin/combos?store_id={store.id}",
        json={
            "name": "Combo en borrador",
            "price": 10_000,
            "active": False,
            "schedule": {"days": [0], "from": "10:00", "to": "12:00"},
            "groups": [],
        },
    )
    combo = resp.json()
    assert combo["active"] is False

    resp = admin_client.patch(
        f"/api/v1/admin/combos/{combo['id']}",
        json={"active": True},
    )
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "COMBO_WITHOUT_GROUPS"

    resp = admin_client.patch(
        f"/api/v1/admin/combos/{combo['id']}",
        json={"groups": [{"name": "Bebida", "options": [{"product_id": product["id"]}]}], "active": True},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["active"] is True
    assert len(resp.json()["groups"]) == 1


def test_set_combo_today_replaces_active_options(
    admin_client: TestClient, create_combo: Callable[..., dict[str, Any]], create_product: Callable[..., dict[str, Any]]
) -> None:
    sancocho = create_product(name="Sancocho de gallina", dine_in=22_000)
    ajiaco = create_product(name="Ajiaco santafereño", dine_in=24_000)
    combo = create_combo(
        groups=[
            {
                "name": "Sopa",
                "options": [{"product_id": sancocho["id"]}, {"product_id": ajiaco["id"]}],
            }
        ]
    )
    group = combo["groups"][0]
    sancocho_option = next(o for o in group["options"] if o["product_id"] == sancocho["id"])
    ajiaco_option = next(o for o in group["options"] if o["product_id"] == ajiaco["id"])

    resp = admin_client.put(
        f"/api/v1/admin/combos/{combo['id']}/today",
        json={"active_option_ids": [sancocho_option["id"]]},
    )
    assert resp.status_code == 200, resp.text
    updated_group = resp.json()["groups"][0]
    active_ids = {o["id"] for o in updated_group["options"] if o["active_today"]}
    assert active_ids == {sancocho_option["id"]}
    inactive = next(o for o in updated_group["options"] if o["id"] == ajiaco_option["id"])
    assert inactive["active_today"] is False


def test_combo_isolation_across_organizations(admin_client: TestClient, store_b: Store) -> None:
    resp = admin_client.get(f"/api/v1/admin/combos?store_id={store_b.id}")
    assert resp.status_code == 404


def test_update_modifier_group_and_combo_audit_before_after(
    admin_client: TestClient, create_combo: Callable[..., dict[str, Any]], create_product: Callable[..., dict[str, Any]]
) -> None:
    product = create_product(name="Gaseosa", dine_in=5_000)
    combo = create_combo(groups=[{"name": "Bebida", "options": [{"product_id": product["id"]}]}])

    resp = admin_client.patch(f"/api/v1/admin/combos/{combo['id']}", json={"price": 16_000})
    assert resp.status_code == 200

    resp = admin_client.get("/api/v1/admin/audit?entity=combo")
    row = next(r for r in resp.json() if r["entity_id"] == str(combo["id"]) and r["action"] == "update")
    assert row["before"]["price"] == combo["price"]
    assert row["after"]["price"] == 16_000
