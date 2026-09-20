"""Canal `platform` (pedido 2c, §3.3): flag `pos.platforms`, `source`/
`external_id`, CONTRATO C2 (`app.channels.hooks.get_platform`) y las dos
reglas que más fácil se rompen: el pago por plataforma NO mueve el
esperado de caja, y cancelar DESPUÉS de preparar compensa la venta sin
generar merma (CONTRATO C4)."""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.orders import hooks as orders_hooks
from app.orders import service as orders_service
from app.orders.models import Order, OrderStatus
from tests.orders.conftest import idem_headers


def _platform_payload(platform_id: int, external_id: str = "RAPPI-0001", **overrides: Any) -> dict[str, Any]:
    body: dict[str, Any] = {"channel": "platform", "platform": {"platform_id": platform_id, "external_id": external_id}}
    body.update(overrides)
    return body


def test_platform_requires_feature_flag(
    device_client: TestClient, identify: Any, employees: Any, open_shift: Any, set_feature: Any, platform: Any,
) -> None:
    open_shift()
    identify(device_client, employees["operator"])
    set_feature("pos.platforms", False)
    resp = device_client.post("/api/v1/orders", json=_platform_payload(platform.id))
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "FEATURE_DISABLED"
    assert resp.json()["error"]["feature"] == "pos.platforms"


def test_platform_requires_platform_info(
    device_client: TestClient, identify: Any, employees: Any, open_shift: Any,
) -> None:
    open_shift()
    identify(device_client, employees["operator"])
    resp = device_client.post("/api/v1/orders", json={"channel": "platform"})
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "PLATFORM_INFO_REQUIRED"


def test_unknown_platform_id_is_rejected_with_400_not_500(
    device_client: TestClient, identify: Any, employees: Any, open_shift: Any,
) -> None:
    open_shift()
    identify(device_client, employees["operator"])
    resp = device_client.post("/api/v1/orders", json=_platform_payload(999_999))
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "PLATFORM_NOT_CONFIGURED"


def test_inactive_platform_is_rejected(
    db: Any, device_client: TestClient, identify: Any, employees: Any, open_shift: Any, platform: Any,
) -> None:
    platform.active = False
    db.commit()
    open_shift()
    identify(device_client, employees["operator"])
    resp = device_client.post("/api/v1/orders", json=_platform_payload(platform.id))
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "PLATFORM_NOT_CONFIGURED"


def test_channels_module_not_mounted_is_rejected_with_400_never_500(
    monkeypatch: pytest.MonkeyPatch, device_client: TestClient, identify: Any, employees: Any, open_shift: Any,
) -> None:
    """CONTRATO C2: si `app.channels.hooks` no está montado (paso 0 de este
    reparto, antes de que exista el dominio), la comanda de plataforma se
    rechaza con 400 tipado, nunca con un `source` mudo aceptado ni con un
    `500`. Se simula "no montado" con `find_spec_safe`, sin desinstalar el
    módulo real."""
    monkeypatch.setattr(orders_service, "find_spec_safe", lambda name: None)
    open_shift()
    identify(device_client, employees["operator"])
    resp = device_client.post("/api/v1/orders", json=_platform_payload(1))
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "PLATFORM_NOT_CONFIGURED"


def test_platform_order_creates_with_snapshot(
    db: Any, device_client: TestClient, identify: Any, employees: Any, open_shift: Any, platform: Any,
) -> None:
    open_shift()
    identify(device_client, employees["operator"])
    resp = device_client.post("/api/v1/orders", json=_platform_payload(platform.id, external_id="RAPPI-777"))
    assert resp.status_code == 201, resp.text
    order = resp.json()
    assert order["platform"]["id"] == platform.id
    assert order["platform"]["name"] == platform.name
    assert order["platform"]["external_id"] == "RAPPI-777"
    # La comisión NUNCA viaja en la respuesta compartida con el dispositivo
    # ("el operador no ve costos ni márgenes").
    assert "commission_bp" not in order["platform"]


def test_platform_order_never_publishes_an_empty_string_for_a_null_name_or_external_id(
    db: Any, device_client: TestClient, identify: Any, employees: Any, open_shift: Any, platform: Any,
) -> None:
    """RONDA 3, punto 3 (barrido del mismo patrón que H-4). `platform_name`/
    `platform_external_id` son columnas nullable que `create_order` sólo
    llena AL CREAR — nada en este dominio las reescribe después, pero nada
    en la base lo impide (una `UPDATE` a mano, exactamente como el
    `courier_employee_id` de H-4). Antes de este arreglo,
    `order.platform_name or ""` disfrazaba el `NULL` de string vacío; ahora
    `PlatformOut.name`/`external_id` son `str | None` y pasan el `None` tal
    cual. `id` no se toca: nunca pasó por `or`."""
    open_shift()
    identify(device_client, employees["operator"])
    resp = device_client.post("/api/v1/orders", json=_platform_payload(platform.id, external_id="RAPPI-777"))
    assert resp.status_code == 201, resp.text
    order_id = resp.json()["id"]

    row = db.get(Order, order_id)
    row.platform_name = None
    row.platform_external_id = None
    db.commit()

    order = device_client.get(f"/api/v1/orders/{order_id}").json()
    assert order["platform"] is not None, "el bloque `platform` no puede desaparecer: sigue habiendo `platform_id`"
    assert order["platform"]["id"] == platform.id
    assert order["platform"]["name"] is None, f"se publicó '' en vez de `None`: {order['platform']!r}"
    assert order["platform"]["external_id"] is None, f"se publicó '' en vez de `None`: {order['platform']!r}"

    row = db.execute(select(Order).where(Order.id == order["id"])).scalars().one()
    assert row.platform_commission_bp == platform.commission_bp

    # Cambiar la comisión de la plataforma DESPUÉS no toca la comanda ya
    # creada: es un snapshot, igual que precio/impuesto/receta en el ítem.
    platform.commission_bp = 9_999
    db.commit()
    row2 = db.execute(select(Order).where(Order.id == order["id"])).scalars().one()
    assert row2.platform_commission_bp != 9_999


def test_platform_commission_is_not_subtracted_from_the_sale(
    db: Any, device_client: TestClient, identify: Any, employees: Any, open_shift: Any, platform: Any, main_product: Any,
) -> None:
    """Checklist de la spec: "la comisión de la plataforma... no se resta de
    la venta: la venta es la venta, la comisión es un costo". `commission_bp`
    nunca entra a `app.orders.money.compute_totals`: el total de una comanda
    de plataforma es igual, comisión alta o baja."""
    open_shift()
    identify(device_client, employees["operator"])
    order = device_client.post("/api/v1/orders", json=_platform_payload(platform.id)).json()
    order = device_client.post(
        f"/api/v1/orders/{order['id']}/items",
        json={"expected_version": order["version"], "items": [{"product_id": main_product.id, "qty": 1}]},
        headers=idem_headers(),
    ).json()
    total_with_commission = order["totals"]["total"]

    # Un total que sólo depende de precio/impuesto, nunca de `commission_bp`.
    from app.orders import service as orders_service_module
    from app.orders.models import Order as OrderModel

    row = db.execute(select(OrderModel).where(OrderModel.id == order["id"])).scalars().one()
    assert row.platform_commission_bp == platform.commission_bp
    totals = orders_service_module.compute_order_totals(db, row)
    assert totals.total == total_with_commission
    # `type(...)` en vez de `isinstance` a propósito: `bool` es subclase de
    # `int` en Python y un `True` colado pasaría `isinstance` sin ser plata.
    assert type(totals.total) is int  # nunca float, ni siquiera "por accidente" vía el commission_bp


def test_platform_disabled_leaves_other_channels_identical(
    device_client: TestClient, identify: Any, employees: Any, open_shift: Any, set_feature: Any,
) -> None:
    set_feature("pos.platforms", False)
    open_shift()
    identify(device_client, employees["operator"])
    resp = device_client.post("/api/v1/orders", json={"channel": "counter"})
    assert resp.status_code == 201, resp.text


# ---------------------------------------------------------------------------
# La regla que más fácil se rompe: el pago por plataforma NO mueve el
# efectivo esperado del turno (`app.shifts.service.compute_breakdown`).
# ---------------------------------------------------------------------------


def test_platform_payment_does_not_move_expected_cash(
    db: Any, device_client: TestClient, identify: Any, employees: Any, open_shift: Any, platform: Any, main_product: Any,
) -> None:
    from app.shifts import service as shifts_service
    from app.shifts.models import Shift

    shift_body = open_shift()
    shift = db.get(Shift, shift_body["id"])
    before = shifts_service.compute_breakdown(db, shift)

    identify(device_client, employees["cashier"])
    order = device_client.post("/api/v1/orders", json=_platform_payload(platform.id)).json()
    order = device_client.post(
        f"/api/v1/orders/{order['id']}/items",
        json={"expected_version": order["version"], "items": [{"product_id": main_product.id, "qty": 1}]},
        headers=idem_headers(),
    ).json()
    total = order["totals"]["total"]

    pay_body: dict[str, Any] = {"pin": "1111", "splits": [{"method": "platform", "amount": total}]}
    if order.get("tip") is not None:
        pay_body["tip"] = {"asked": True, "accepted": False, "modified": False, "amount": 0}
    pay_resp = device_client.post(f"/api/v1/orders/{order['id']}/payments", json=pay_body, headers=idem_headers())
    assert pay_resp.status_code == 201, pay_resp.text

    db.expire_all()
    after = shifts_service.compute_breakdown(db, shift)
    assert after["expected"] == before["expected"]
    assert after["cash_sales"] == before["cash_sales"]


# ---------------------------------------------------------------------------
# CONTRATO C4: cancelar DESPUÉS de preparar compensa la VENTA, no genera
# merma. El insumo ya se descontó y se queda descontado.
# ---------------------------------------------------------------------------


def test_platform_cancel_after_send_compensates_the_sale_without_waste(
    db: Any, device_client: TestClient, identify: Any, employees: Any, open_shift: Any, platform: Any, main_product: Any,
    ingredient_seeded: Any, set_recipe: Any, admin_actor: Any,
) -> None:
    from app.inventory import hooks as inventory_hooks
    from app.inventory.models import MovementCause, StockMovement

    set_recipe(main_product.id, lines=[{"ingredient_id": ingredient_seeded.id, "qty": "100", "unit": "g"}])
    open_shift()
    identify(device_client, employees["operator"])

    order = device_client.post("/api/v1/orders", json=_platform_payload(platform.id)).json()
    order = device_client.post(
        f"/api/v1/orders/{order['id']}/items",
        json={"expected_version": order["version"], "items": [{"product_id": main_product.id, "qty": 1}]},
        headers=idem_headers(),
    ).json()

    stock_before_send = inventory_hooks.current_stock(db, store_id=main_product.store_id, ingredient_id=ingredient_seeded.id)
    send_resp = device_client.post(f"/api/v1/orders/{order['id']}/send", json={"expected_version": order["version"]}, headers=idem_headers())
    assert send_resp.status_code == 200, send_resp.text
    order = send_resp.json()

    stock_after_send = inventory_hooks.current_stock(db, store_id=main_product.store_id, ingredient_id=ingredient_seeded.id)
    assert stock_after_send < stock_before_send  # el insumo se descontó al enviar

    waste_rows_before = list(db.execute(select(StockMovement).where(StockMovement.cause == MovementCause.WASTE)).scalars())

    order_row = db.execute(select(Order).where(Order.id == order["id"])).scalars().one()
    from app.core import clock

    updated = orders_hooks.mark_platform_order_cancelled(
        db, order=order_row, actor=admin_actor, now=clock.now_utc(), reason="restaurant_out_of_stock"
    )
    db.commit()

    assert updated.status == OrderStatus.COMPENSATED
    assert updated.platform_cancel_reason == "restaurant_out_of_stock"
    assert updated.platform_cancelled_at is not None

    # El stock NO se repuso: sigue exactamente donde lo dejó el envío.
    stock_after_cancel = inventory_hooks.current_stock(db, store_id=main_product.store_id, ingredient_id=ingredient_seeded.id)
    assert stock_after_cancel == stock_after_send

    # El libro NO ganó ninguna fila de merma por esto.
    waste_rows_after = list(db.execute(select(StockMovement).where(StockMovement.cause == MovementCause.WASTE)).scalars())
    assert len(waste_rows_after) == len(waste_rows_before)

    # Tampoco se creó ningún `WasteStub` (ese es el camino de `void_item`,
    # que este hook nunca llama) ni una fila en `wastes`
    # (`app.inventory.models.Waste`, el reporte de mermas de verdad).
    from app.inventory.models import Waste
    from app.orders.models import WasteStub

    assert db.execute(select(WasteStub).where(WasteStub.order_id == order["id"])).scalars().first() is None
    assert db.execute(select(Waste)).scalars().first() is None

    # Los ítems de la comanda NO se tocan: siguen `sent` con su timestamp,
    # no `voided` — lo que se preparó, se preparó.
    from app.orders.models import OrderItem

    item = db.execute(select(OrderItem).where(OrderItem.order_id == order["id"])).scalars().first()
    assert item.status.value == "sent"
    assert item.sent_at is not None


def test_platform_cancel_is_idempotent(
    db: Any, device_client: TestClient, identify: Any, employees: Any, open_shift: Any, platform: Any, admin_actor: Any,
) -> None:
    from app.core import clock

    open_shift()
    identify(device_client, employees["operator"])
    order = device_client.post("/api/v1/orders", json=_platform_payload(platform.id)).json()
    order_row = db.execute(select(Order).where(Order.id == order["id"])).scalars().one()

    now = clock.now_utc()
    first = orders_hooks.mark_platform_order_cancelled(db, order=order_row, actor=admin_actor, now=now, reason="a")
    db.commit()
    version_after_first = first.version

    second = orders_hooks.mark_platform_order_cancelled(db, order=order_row, actor=admin_actor, now=now, reason="b")
    db.commit()
    assert second.version == version_after_first
    assert second.platform_cancel_reason == "a"  # no lo pisó el segundo llamado


def test_platform_cancel_rejects_non_platform_orders(
    db: Any, device_client: TestClient, identify: Any, employees: Any, open_shift: Any, admin_actor: Any,
) -> None:
    from app.core import clock
    from app.core.errors import ConflictError

    open_shift()
    identify(device_client, employees["operator"])
    order = device_client.post("/api/v1/orders", json={"channel": "counter"}).json()
    order_row = db.execute(select(Order).where(Order.id == order["id"])).scalars().one()

    with pytest.raises(ConflictError):
        orders_hooks.mark_platform_order_cancelled(db, order=order_row, actor=admin_actor, now=clock.now_utc(), reason="x")
