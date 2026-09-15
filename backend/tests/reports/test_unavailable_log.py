"""`GET /admin/unavailable-log?from&to` (spec.md «Admin reports»): producto,
quién, cuándo, venta perdida estimada.

Se lee de `audit_logs` (`entity="product"`, `action="set_availability"`),
NO del snapshot actual de `Product`: así un producto que se agotó y volvió a
estar disponible sigue apareciendo en el rango de fechas en el que se agotó
(`app.catalog.router.set_product_availability` ya auditaba esto; 1b-2 agrega
el mismo `record_audit` alrededor del 86 AUTOMÁTICO por contador de
porciones en `app.orders.service._apply_send`, para que las dos vías
queden en la misma bitácora)."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from fastapi.testclient import TestClient


def _mark_unavailable(device_client: TestClient, product_id: int) -> Any:
    return device_client.post(f"/api/v1/products/{product_id}/availability", json={"available": False})


def _mark_available(device_client: TestClient, product_id: int) -> Any:
    return device_client.post(f"/api/v1/products/{product_id}/availability", json={"available": True})


def test_a_manually_86d_product_shows_up_with_who_when_and_no_estimate(
    admin_client: TestClient, device_client: TestClient, identify: Any, employees: Any, open_shift: Any,
    main_product: Any, clock: Any, store: Any,
) -> None:
    clock.set(datetime(2026, 5, 1, 15, 0, tzinfo=timezone.utc))  # 10:00 Bogotá
    open_shift()
    identify(device_client, employees["operator"])

    resp = _mark_unavailable(device_client, main_product.id)
    assert resp.status_code == 200, resp.text

    log = admin_client.get(
        "/api/v1/admin/unavailable-log", params={"store_id": store.id, "from": "2026-05-01", "to": "2026-05-01"}
    )
    assert log.status_code == 200, log.text
    rows = log.json()
    assert len(rows) == 1
    assert rows[0]["product_id"] == main_product.id
    assert rows[0]["name"] == main_product.name
    assert rows[0]["by"]["name"] == "Operator"
    # Sin ventas previas de este producto en los 7 días de negocio de antes:
    # "sin datos" (`None`), nunca `0` inventado.
    assert rows[0]["estimated_lost_units"] is None
    assert rows[0]["estimated_lost_sales"] is None


def test_becoming_available_again_does_not_erase_the_event_from_its_date(
    admin_client: TestClient, device_client: TestClient, identify: Any, employees: Any, open_shift: Any,
    main_product: Any, clock: Any, store: Any,
) -> None:
    clock.set(datetime(2026, 5, 1, 15, 0, tzinfo=timezone.utc))
    open_shift()
    identify(device_client, employees["operator"])

    assert _mark_unavailable(device_client, main_product.id).status_code == 200
    clock.advance(hours=1)
    identify(device_client, employees["operator"])  # ventana deslizante expirada
    assert _mark_available(device_client, main_product.id).status_code == 200

    # El producto YA NO está agotado ahora mismo, pero el 1 de mayo sí lo
    # estuvo un rato: sigue apareciendo en el reporte de ESE día.
    log = admin_client.get(
        "/api/v1/admin/unavailable-log", params={"store_id": store.id, "from": "2026-05-01", "to": "2026-05-01"}
    )
    assert log.status_code == 200, log.text
    assert len(log.json()) == 1

    later = admin_client.get(
        "/api/v1/admin/unavailable-log", params={"store_id": store.id, "from": "2026-06-01", "to": "2026-06-30"}
    )
    assert later.json() == []  # fuera del rango pedido: no aparece


def test_estimate_uses_the_trailing_average_and_the_price_at_the_time(
    admin_client: TestClient, device_client: TestClient, identify: Any, employees: Any, open_shift: Any,
    sell: Any, main_product: Any, clock: Any, store: Any,
) -> None:
    clock.set(datetime(2026, 5, 1, 15, 0, tzinfo=timezone.utc))
    open_shift()
    identify(device_client, employees["cashier"])
    # 14 unidades vendidas en los 7 días de negocio anteriores al agotado -> 2/día de promedio.
    sell(main_product, qty=14)

    clock.set(datetime(2026, 5, 8, 15, 0, tzinfo=timezone.utc))
    identify(device_client, employees["operator"])
    resp = _mark_unavailable(device_client, main_product.id)
    assert resp.status_code == 200, resp.text

    log = admin_client.get(
        "/api/v1/admin/unavailable-log", params={"store_id": store.id, "from": "2026-05-08", "to": "2026-05-08"}
    )
    assert log.status_code == 200, log.text
    row = log.json()[0]
    assert row["estimated_lost_units"] == 2
    assert row["estimated_lost_sales"] == 2 * main_product.price_dine_in


def test_an_automatic_86_from_the_daily_count_is_in_the_same_log(
    admin_client: TestClient, device_client: TestClient, identify: Any, employees: Any, open_shift: Any, set_feature: Any,
    main_product: Any, clock: Any, store: Any, db: Any,
) -> None:
    """1b-2: el 86 automático (`app.orders.service._apply_send`, contador de
    porciones llegando a `0` al enviar) audita igual que el manual — misma
    bitácora, mismo reporte."""
    set_feature("pos.daily_count", True)
    clock.set(datetime(2026, 5, 2, 15, 0, tzinfo=timezone.utc))
    main_product.daily_count = 1
    main_product.daily_remaining = 1
    db.commit()

    open_shift()
    identify(device_client, employees["operator"])
    order_resp = device_client.post("/api/v1/orders", json={"channel": "counter"}, headers={"Idempotency-Key": "k1"})
    assert order_resp.status_code == 201, order_resp.text
    order = order_resp.json()
    items_resp = device_client.post(
        f"/api/v1/orders/{order['id']}/items",
        json={"expected_version": order["version"], "items": [{"product_id": main_product.id, "qty": 1}]},
        headers={"Idempotency-Key": "k2"},
    )
    assert items_resp.status_code == 200, items_resp.text
    order = items_resp.json()
    sent = device_client.post(
        f"/api/v1/orders/{order['id']}/send", json={"expected_version": order["version"]}, headers={"Idempotency-Key": "k3"}
    )
    assert sent.status_code == 200, sent.text

    log = admin_client.get(
        "/api/v1/admin/unavailable-log", params={"store_id": store.id, "from": "2026-05-02", "to": "2026-05-02"}
    )
    assert log.status_code == 200, log.text
    rows = log.json()
    assert len(rows) == 1
    assert rows[0]["product_id"] == main_product.id
    assert rows[0]["by"]["name"] == "Operator"  # quien envió la ronda que lo agotó


def test_isolation_by_store(admin_client: TestClient, store_b: Any) -> None:
    resp = admin_client.get(
        "/api/v1/admin/unavailable-log", params={"store_id": store_b.id, "from": "2026-05-01", "to": "2026-05-01"}
    )
    assert resp.status_code == 404, resp.text
