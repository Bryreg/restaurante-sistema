"""Ajustes › Inventario y compras (0035): los umbrales se guardan, se validan
antes de escribir y cambian lo que el sistema hace."""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from typing import Any, Callable
from uuid import uuid4

from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth.models import Employee
from app.notifications.models import Notification, NotificationRule
from app.stores.models import Store


def _settings_url(store: Store) -> str:
    return f"/api/v1/admin/stores/{store.id}/inventory-settings"


def test_inventory_settings_expose_and_keep_the_new_thresholds(admin_client: TestClient, store: Store) -> None:
    body = admin_client.get(_settings_url(store)).json()
    assert body["price_jump_pct"] == 15
    assert body["stale_days"] == 14
    assert body["food_cost_band_min_pct"] == 28 and body["food_cost_band_max_pct"] == 35
    resp = admin_client.put(
        _settings_url(store),
        json={"variance_yellow_threshold_bp": 200, "variance_red_threshold_bp": 400, "price_jump_pct": 25, "stale_days": 30},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["price_jump_pct"] == 25
    # Un cuerpo viejo (sólo la varianza) no pisa lo nuevo.
    again = admin_client.put(_settings_url(store), json={"variance_yellow_threshold_bp": 200, "variance_red_threshold_bp": 400})
    assert again.json()["price_jump_pct"] == 25
    thresholds = admin_client.get(f"/api/v1/admin/stores/{store.id}/inventory-thresholds").json()
    assert thresholds["price_jump_pct"] == 25 and thresholds["stale_days"] == 30


def test_inverted_bands_are_rejected_before_writing(admin_client: TestClient, store: Store) -> None:
    base = {"variance_yellow_threshold_bp": 200, "variance_red_threshold_bp": 400}
    bad = admin_client.put(_settings_url(store), json={**base, "food_cost_band_min_pct": 40, "food_cost_band_max_pct": 30})
    assert bad.status_code == 400 and bad.json()["error"]["code"] == "FOOD_COST_BAND_INVERTED"
    bad = admin_client.put(_settings_url(store), json={**base, "supplier_received_critical_bp": 9950})
    assert bad.json()["error"]["code"] == "SUPPLIER_THRESHOLDS_INVERTED"
    bad = admin_client.put(_settings_url(store), json={**base, "supplier_drift_critical_bp": 400})
    assert bad.json()["error"]["code"] == "SUPPLIER_THRESHOLDS_INVERTED"
    assert admin_client.get(_settings_url(store)).json()["food_cost_band_min_pct"] == 28


def test_stale_days_and_lot_window_come_from_the_store(db: Session, store: Store) -> None:
    from app.inventory import hooks
    from app.inventory.models import StockBatch
    from app.inventory.service import get_inventory_settings, lot_status

    assert hooks.store_thresholds(db, store.id).stale_days == 14
    row = get_inventory_settings(db, store)
    row.stale_days = 45
    row.lot_expiring_window_days = 20
    db.flush()
    assert hooks.inventory_staleness(db, store_id=store.id, cutoff_hour=store.cutoff_hour).stale_days == 45
    today = date(2026, 3, 1)
    batch = StockBatch(qty_remaining=10, expires_at=today + timedelta(days=15))
    assert lot_status(batch, today) == "active"  # con el default de 7 días
    assert lot_status(batch, today, hooks.store_thresholds(db, store.id).lot_expiring_window_days) == "expiring"


def test_waste_spike_reads_the_rule_factor(
    device_client: TestClient, identify: Callable[..., Any], employees: dict[str, Employee],
    create_ingredient: Callable[..., dict[str, Any]], db: Session, clock: Any, store: Store,
) -> None:
    """Con la regla en 250 % (2,5 veces), duplicar la merma ya no avisa."""
    db.add(NotificationRule(organization_id=store.organization_id, store_id=store.id, type="waste_spike", enabled=True, threshold=250, level="warning"))
    db.commit()
    ingredient = create_ingredient(official_cost="1")
    for when, qty in ((datetime(2026, 3, 2, 15, 0, tzinfo=timezone.utc), "1"), (datetime(2026, 3, 9, 15, 0, tzinfo=timezone.utc), "2")):
        clock.set(when)
        identify(device_client, employees["operator"])
        resp = device_client.post(
            "/api/v1/waste",
            json={"ingredient_id": ingredient["id"], "qty": qty, "type": "expired", "employee_pin": "2222"},
            headers={"Idempotency-Key": str(uuid4())},
        )
        assert resp.status_code == 201, resp.text
    rows = db.execute(select(Notification).where(Notification.type == "waste_spike")).scalars().all()
    assert rows == []


def test_area_count_limits_are_configurable(admin_client: TestClient, store: Store, set_feature: Callable[..., None]) -> None:
    set_feature("inventory.perpetual", True)
    set_feature("inventory.shift_counts", True)
    url = "/api/v1/admin/area-count-settings"
    body = admin_client.get(url, params={"store_id": store.id})
    assert body.status_code == 200, body.text
    assert body.json()["max_items_per_area"] == 15
    assert body.json()["suggest_closing_from_hour"] == 20
    resp = admin_client.put(
        url, params={"store_id": store.id},
        json={"threshold_pct_bp": 200, "threshold_amount": 20000, "max_items_per_area": 3, "max_recount_items": 2, "suggest_closing_from_hour": 18},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["max_items_per_area"] == 3
    assert resp.json()["suggest_closing_from_hour"] == 18
    bad = admin_client.put(url, params={"store_id": store.id}, json={"threshold_pct_bp": 200, "suggest_closing_from_hour": 24})
    assert bad.status_code == 400


def test_suggested_moment_uses_the_configured_hour(store: Store) -> None:
    from app.inventory.area_counts import suggested_moment

    at_19_bogota = datetime(2026, 3, 2, 0, 0, tzinfo=timezone.utc)  # 19:00 en Bogotá
    assert suggested_moment(store=store, now=at_19_bogota, opening_done=False, closing_done=False) == "opening"
    assert suggested_moment(store=store, now=at_19_bogota, opening_done=False, closing_done=False, closing_from_hour=18) == "closing"


def test_thresholds_save_without_the_variance_feature(
    admin_client: TestClient, store: Store, set_feature: Callable[..., None]
) -> None:
    """Compras y Carta los leen aunque la varianza esté apagada: se guardan
    por su propia ruta, que no exige `inventory.variance`."""
    set_feature("inventory.variance", False)
    url = f"/api/v1/admin/stores/{store.id}/inventory-thresholds"
    resp = admin_client.put(url, json={"food_cost_band_min_pct": 25, "food_cost_band_max_pct": 32})
    assert resp.status_code == 200, resp.text
    assert resp.json()["food_cost_band_min_pct"] == 25
    assert resp.json()["price_jump_pct"] == 15  # lo que no vino, quedó
    bad = admin_client.put(url, json={"food_cost_band_min_pct": 40})
    assert bad.status_code == 400 and bad.json()["error"]["code"] == "FOOD_COST_BAND_INVERTED"
    assert admin_client.get(url).json()["food_cost_band_min_pct"] == 25
