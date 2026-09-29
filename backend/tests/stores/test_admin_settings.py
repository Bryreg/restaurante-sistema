"""«Todo se debe poder configurar desde el panel administrativo» (0035).

Cada umbral que vivía quemado en el código ahora se guarda por sede y el
código que lo usaba lo LEE. Estos tests fijan las dos mitades: que el ajuste
se guarda y se valida, y que cambiarlo cambia el comportamiento (un ajuste
que se guarda y nadie lee es el bug que tenía `NotificationRule.threshold`).
"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth.models import Employee
from app.notifications.models import NotificationRule
from app.stores.models import Store

API = "/api/v1"


def _sales(admin_client: TestClient, store: Store) -> dict[str, Any]:
    resp = admin_client.get(f"{API}/admin/stores/{store.id}/sales-settings")
    assert resp.status_code == 200, resp.text
    return resp.json()


def _put_sales(admin_client: TestClient, store: Store, **changes: Any) -> Any:
    body = _sales(admin_client, store)
    for key in (
        "station_target_minutes",
        "quick_notes",
        "employee_session_minutes",
        "pin_lock_attempts",
        "pin_lock_minutes",
        "period_low_base_orders",
        "daily_low_base_orders",
        "employee_session_minutes_default",
        "pin_lock_attempts_default",
        "pin_lock_minutes_default",
    ):
        body.pop(key, None)
    body.update(changes)
    return admin_client.put(f"{API}/admin/stores/{store.id}/sales-settings", json=body)


# ---------------------------------------------------------------------------
# Ajustes › Ventas: estaciones, notas rápidas, seguridad, muestra chica.
# ---------------------------------------------------------------------------


def test_sales_settings_expose_factory_defaults(admin_client: TestClient, store: Store) -> None:
    data = _sales(admin_client, store)
    assert data["station_target_minutes"] == {"bar": 5, "hot_kitchen": 15, "cold_kitchen": 10}
    assert data["quick_notes"]["_default"] == ["Sin cebolla", "Sin sal", "Aparte", "Para llevar"]
    assert data["quick_notes"]["beverage"][0] == "Sin hielo"
    assert data["employee_session_minutes"] is None
    assert data["employee_session_minutes_default"] == 3
    assert data["pin_lock_attempts_default"] == 5
    assert data["period_low_base_orders"] == 20
    assert data["daily_low_base_orders"] == 5


def test_new_fields_are_kept_when_absent_and_saved_when_sent(admin_client: TestClient, store: Store) -> None:
    resp = _put_sales(
        admin_client,
        store,
        station_target_minutes={"bar": 7},
        quick_notes={"main": ["Término medio", "  "]},
        pin_lock_attempts=3,
        daily_low_base_orders=8,
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["station_target_minutes"]["bar"] == 7
    assert data["station_target_minutes"]["hot_kitchen"] == 15  # el de fábrica sigue
    assert data["quick_notes"]["main"] == ["Término medio"]  # la nota vacía no se guarda
    assert data["pin_lock_attempts"] == 3
    assert data["daily_low_base_orders"] == 8

    # Un cuerpo escrito antes de 0035 (sin los campos nuevos) no los pisa.
    again = _put_sales(admin_client, store)
    assert again.status_code == 200, again.text
    assert again.json()["station_target_minutes"]["bar"] == 7
    assert again.json()["pin_lock_attempts"] == 3

    # `null` explícito en un campo de seguridad vuelve al de entorno.
    reset = _put_sales(admin_client, store, pin_lock_attempts=None)
    assert reset.json()["pin_lock_attempts"] is None


def test_sales_settings_validation_rejects_before_writing(admin_client: TestClient, store: Store) -> None:
    for bad in (
        {"station_target_minutes": {"bar": 0}},
        {"quick_notes": {"main": ["x" * 41]}},
        {"quick_notes": {"main": [f"n{i}" for i in range(9)]}},
        {"pin_lock_attempts": 1},
        {"employee_session_minutes": 0},
        {"period_low_base_orders": 0},
    ):
        resp = _put_sales(admin_client, store, **bad)
        assert resp.status_code == 400, (bad, resp.text)
    assert _sales(admin_client, store)["station_target_minutes"]["bar"] == 5  # nada se escribió


def test_device_reads_the_quick_notes_of_its_store(
    admin_client: TestClient, device_client: TestClient, store: Store
) -> None:
    assert _put_sales(admin_client, store, quick_notes={"beverage": ["Con limón"]}).status_code == 200
    resp = device_client.get(f"{API}/quick-notes")
    assert resp.status_code == 200, resp.text
    assert resp.json()["beverage"] == ["Con limón"]
    assert resp.json()["_default"] == ["Sin cebolla", "Sin sal", "Aparte", "Para llevar"]


def test_station_target_minutes_change_the_kitchen_target() -> None:
    from app.kitchen.service import target_minutes_for

    assert target_minutes_for({}, course="beverage", station="bar") == 5
    assert target_minutes_for({}, course="beverage", station="bar", station_targets={"bar": 9}) == 9
    # El objetivo del curso sigue mandando sobre el de la estación.
    assert target_minutes_for({"main": 18}, course="main", station="hot_kitchen", station_targets={"hot_kitchen": 30}) == 18


def test_pin_lock_attempts_come_from_the_store(
    admin_client: TestClient, device_client: TestClient, store: Store, employees: dict[str, Employee]
) -> None:
    assert _put_sales(admin_client, store, pin_lock_attempts=2, pin_lock_minutes=7).status_code == 200
    operator = employees["operator"]
    first = device_client.post(f"{API}/auth/device/identify", json={"employee_id": operator.id, "pin": "0000"})
    assert first.json()["error"]["message"] == "PIN incorrecto · te quedan 1 intento"
    second = device_client.post(f"{API}/auth/device/identify", json={"employee_id": operator.id, "pin": "0000"})
    assert second.json()["error"]["code"] == "PIN_LOCKED"
    assert "7 minutos" in second.json()["error"]["message"]


def test_employee_session_minutes_come_from_the_store(
    admin_client: TestClient, device_client: TestClient, store: Store, employees: dict[str, Employee], clock: Any
) -> None:
    assert _put_sales(admin_client, store, employee_session_minutes=30).status_code == 200
    operator = employees["operator"]
    ok = device_client.post(f"{API}/auth/device/identify", json={"employee_id": operator.id, "pin": "2222"})
    assert ok.status_code == 200, ok.text
    clock.advance(minutes=10)  # el default de entorno (3) ya la habría vencido
    assert device_client.get(f"{API}/auth/me").json()["employee"] is not None
    clock.advance(minutes=31)
    assert device_client.get(f"{API}/auth/me").json()["employee"] is None


def test_low_base_orders_come_from_the_store(db: Session, store: Store) -> None:
    from app.reports.service import low_base_orders
    from app.stores import service as stores_service

    assert low_base_orders(db, store.id, "period_low_base_orders", 20) == 20
    stores_service.get_sales_settings(db, store.id).period_low_base_orders = 50
    db.flush()
    assert low_base_orders(db, store.id, "period_low_base_orders", 20) == 50


# ---------------------------------------------------------------------------
# Ajustes › Caja: días sin consignar.
# ---------------------------------------------------------------------------


def test_deposit_overdue_days_round_trip(admin_client: TestClient, store: Store) -> None:
    url = f"{API}/admin/stores/{store.id}/cash-settings"
    body = admin_client.get(url).json()
    assert body["deposit_overdue_days"] == 3
    body["deposit_overdue_days"] = 5
    assert admin_client.put(url, json=body).json()["deposit_overdue_days"] == 5
    # Sin el campo, se conserva.
    body.pop("deposit_overdue_days")
    assert admin_client.put(url, json=body).json()["deposit_overdue_days"] == 5
    body["deposit_overdue_days"] = 0
    assert admin_client.put(url, json=body).status_code == 400


# ---------------------------------------------------------------------------
# Notificaciones › Reglas: el umbral ya no es decorativo.
# ---------------------------------------------------------------------------


def _set_rule(db: Session, store: Store, type: str, threshold: int | None) -> None:
    row = db.execute(
        select(NotificationRule).where(NotificationRule.store_id == store.id, NotificationRule.type == type)
    ).scalars().first()
    if row is None:
        row = NotificationRule(
            organization_id=store.organization_id, store_id=store.id, type=type, enabled=True, level="warning"
        )
        db.add(row)
    row.threshold = threshold
    db.flush()


def test_rule_threshold_uses_the_rule_or_the_default(db: Session, store: Store) -> None:
    from app.notifications.service import rule_threshold

    assert rule_threshold(db, store.id, "void_rate_high") == 10
    assert rule_threshold(db, store.id, "order_unsent_too_long") == 15
    assert rule_threshold(db, store.id, "order_unpaid_too_long") == 20
    assert rule_threshold(db, store.id, "waste_spike") == 150
    assert rule_threshold(db, store.id, "fiscal_range_low") == 80
    _set_rule(db, store, "void_rate_high", 25)
    assert rule_threshold(db, store.id, "void_rate_high") == 25
    _set_rule(db, store, "void_rate_high", None)
    assert rule_threshold(db, store.id, "void_rate_high") == 10


def test_rules_screen_says_what_each_threshold_measures(admin_client: TestClient, store: Store) -> None:
    rules = {r["type"]: r for r in admin_client.get(f"{API}/admin/notification-rules", params={"store_id": store.id}).json()}
    assert rules["order_unsent_too_long"]["threshold_default"] == 15
    assert "minutos" in rules["order_unsent_too_long"]["threshold_unit"]
    assert rules["pin_locked"]["threshold_default"] is None  # ese tipo no lee umbral


def test_rules_reject_a_zero_threshold(admin_client: TestClient, store: Store) -> None:
    resp = admin_client.put(
        f"{API}/admin/notification-rules",
        params={"store_id": store.id},
        json=[{"type": "void_rate_high", "enabled": True, "threshold": 0, "level": "critical"}],
    )
    assert resp.status_code == 400, resp.text


def test_fiscal_range_alert_reads_the_rule(db: Session, store: Store, org: Any) -> None:
    from datetime import date

    from app.core import clock as core_clock
    from app.fiscal import service as fiscal_service
    from app.fiscal.models import FiscalDocumentType
    from app.notifications.models import Notification

    _set_rule(db, store, "fiscal_range_low", 95)
    fiscal_service.create_range(
        db,
        organization_id=org.id,
        store_id=store.id,
        document_type=FiscalDocumentType.CREDIT_NOTE,
        prefix="NC7",
        from_number=1,
        to_number=10,
        resolution_number="18760000011",
        resolution_date=date(2020, 1, 1),
        valid_from=date(2020, 1, 1),
        valid_until=date(2099, 1, 1),
        technical_key=None,
        now=core_clock.now_utc(),
    )
    db.commit()
    for _ in range(8):  # 80 %: con la regla en 95 %, todavía no avisa
        fiscal_service.reserve_next_number(
            db, organization_id=org.id, store_id=store.id, document_type=FiscalDocumentType.CREDIT_NOTE,
            business_date=date(2026, 6, 1),
        )
    db.commit()
    rows = db.execute(
        select(Notification).where(Notification.type == "fiscal_range_low", Notification.store_id == store.id)
    ).scalars().all()
    assert rows == []
