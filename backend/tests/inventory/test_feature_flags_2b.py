"""Cada capacidad nueva de 2b detrás de su flag, con `400 FEATURE_DISABLED`,
**respetando las dependencias ya declaradas** en `app.core.features`
(`inventory.counts`/`inventory.variance`/`inventory.lots`/`purchases`
requieren `inventory.perpetual`; `inventory.variance` requiere además
`inventory.counts`). Test con cada flag en los dos estados."""

from __future__ import annotations

from typing import Any, Callable
from uuid import uuid4

from fastapi.testclient import TestClient

from app.stores.models import Store

ADMIN_PIN = "9999"


def test_lots_off_then_on(admin_client: TestClient, store: Store, set_feature: Callable[..., None]) -> None:
    set_feature("inventory.perpetual", True)
    set_feature("inventory.lots", False)
    off = admin_client.get(f"/api/v1/admin/lots?store_id={store.id}")
    assert off.status_code == 400 and off.json()["error"]["code"] == "FEATURE_DISABLED"
    set_feature("inventory.lots", True)
    on = admin_client.get(f"/api/v1/admin/lots?store_id={store.id}")
    assert on.status_code == 200


def test_counts_off_then_on(admin_client: TestClient, store: Store, set_feature: Callable[..., None]) -> None:
    set_feature("inventory.perpetual", True)
    set_feature("inventory.counts", False)
    off = admin_client.get(f"/api/v1/admin/counts?store_id={store.id}")
    assert off.status_code == 400 and off.json()["error"]["code"] == "FEATURE_DISABLED"
    set_feature("inventory.counts", True)
    on = admin_client.get(f"/api/v1/admin/counts?store_id={store.id}")
    assert on.status_code == 200


def test_variance_off_then_on(
    admin_client: TestClient, store: Store, create_ingredient: Callable[..., dict[str, Any]],
    set_feature: Callable[..., None],
) -> None:
    set_feature("inventory.perpetual", True)
    set_feature("inventory.counts", True)
    set_feature("inventory.variance", False)

    resp = admin_client.post(f"/api/v1/admin/counts?store_id={store.id}", json={"scope": "full"})
    count_id = resp.json()["id"]

    off = admin_client.get(f"/api/v1/admin/variance?store_id={store.id}&count_id={count_id}")
    assert off.status_code == 400 and off.json()["error"]["code"] == "FEATURE_DISABLED"

    off_health = admin_client.get(f"/api/v1/admin/control-health?store_id={store.id}")
    assert off_health.status_code == 400

    off_settings = admin_client.get(f"/api/v1/admin/stores/{store.id}/inventory-settings")
    assert off_settings.status_code == 400

    set_feature("inventory.variance", True)
    on = admin_client.get(f"/api/v1/admin/variance?store_id={store.id}&count_id={count_id}")
    # El conteo sigue `open` (no se aplicó): corta con `COUNT_NOT_APPLIED`,
    # NO con `FEATURE_DISABLED` -- es la prueba de que la flag ya no bloquea.
    assert on.status_code == 400
    assert on.json()["error"]["code"] == "COUNT_NOT_APPLIED"


def test_order_consumption_off_then_on(admin_client: TestClient, store: Store, db: Any, set_feature: Callable[..., None], employees: Any) -> None:
    from datetime import datetime, timezone

    from app.orders.models import Order, OrderChannel, OrderStatus

    set_feature("inventory.perpetual", False)
    now = datetime(2026, 5, 1, tzinfo=timezone.utc)
    order = Order(
        organization_id=store.organization_id, store_id=store.id, shift_id=None, business_date=now.date(),
        channel=OrderChannel.COUNTER, status=OrderStatus.OPEN, version=1,
        opened_by_employee_id=employees["admin"].id, opened_by_employee_name=employees["admin"].name,
        opened_at=now, created_at=now, updated_at=now,
    )
    db.add(order)
    db.commit()

    off = admin_client.get(f"/api/v1/admin/orders/{order.id}/consumption?store_id={store.id}")
    assert off.status_code == 400 and off.json()["error"]["code"] == "FEATURE_DISABLED"
    set_feature("inventory.perpetual", True)
    on = admin_client.get(f"/api/v1/admin/orders/{order.id}/consumption?store_id={store.id}")
    assert on.status_code == 200


# ---------------------------------------------------------------------------
# Las dependencias declaradas se respetan de verdad (no sólo en el catálogo):
# prender `inventory.counts` sin `inventory.perpetual` primero, por la ruta
# real de administración de funciones, tiene que cortar.
# ---------------------------------------------------------------------------


def test_turning_on_counts_without_perpetual_first_is_rejected_by_the_real_route(
    admin_client: TestClient, store: Store, set_feature: Callable[..., None]
) -> None:
    set_feature("inventory.perpetual", False)
    resp = admin_client.put(
        f"/api/v1/admin/features/inventory.counts", json={"enabled": True, "store_id": store.id}
    )
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "FEATURE_DEPENDENCY"


def test_turning_on_variance_without_counts_first_is_rejected_by_the_real_route(
    admin_client: TestClient, store: Store, set_feature: Callable[..., None]
) -> None:
    set_feature("inventory.perpetual", True)
    set_feature("inventory.counts", False)
    resp = admin_client.put(
        f"/api/v1/admin/features/inventory.variance", json={"enabled": True, "store_id": store.id}
    )
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "FEATURE_DEPENDENCY"


def test_turning_on_purchases_and_lots_requires_perpetual_first(
    admin_client: TestClient, store: Store, set_feature: Callable[..., None]
) -> None:
    set_feature("inventory.perpetual", False)
    for key in ("purchases", "inventory.lots"):
        resp = admin_client.put(f"/api/v1/admin/features/{key}", json={"enabled": True, "store_id": store.id})
        assert resp.status_code == 400, key
        assert resp.json()["error"]["code"] == "FEATURE_DEPENDENCY", key
