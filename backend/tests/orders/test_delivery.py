"""Canal `delivery` (pedido 2c, §3.3): flag `pos.delivery` (requiere
`pos.takeout`), dirección/teléfono/domiciliario exigidos al crear, y el
cargo de domicilio como LÍNEA de verdad — la regla que más fácil se rompe de
este pedido."""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy import select

from app.orders.models import Order, OrderItem
from tests.orders.conftest import idem_headers


def _delivery_payload(courier_id: int, **overrides: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "channel": "delivery",
        "delivery": {"address": "Cra 7 # 20-15", "phone": "3009998877", "courier_employee_id": courier_id},
    }
    body.update(overrides)
    return body


def test_delivery_requires_feature_flag(
    device_client: TestClient, identify: Any, employees: Any, open_shift: Any, set_feature: Any, courier: Any,
) -> None:
    open_shift()
    identify(device_client, employees["operator"])
    set_feature("pos.delivery", False)
    resp = device_client.post("/api/v1/orders", json=_delivery_payload(courier.id))
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "FEATURE_DISABLED"
    assert resp.json()["error"]["feature"] == "pos.delivery"


def test_delivery_requires_takeout_dependency_even_if_delivery_flag_is_on(
    device_client: TestClient, identify: Any, employees: Any, open_shift: Any, set_feature: Any, courier: Any,
    delivery_fee_product: Any,
) -> None:
    """La dependencia `pos.delivery -> pos.takeout` ya la hace cumplir
    `app.stores.router` al encender el flag (no se puede prender uno sin el
    otro por ese camino); este test fuerza el estado inconsistente DIRECTO
    en `FeatureState` (`set_feature`, que no pasa por ese router) para
    probar la defensa en profundidad de `create_order`."""
    open_shift()
    identify(device_client, employees["operator"])
    set_feature("pos.delivery", True)
    set_feature("pos.takeout", False)
    resp = device_client.post("/api/v1/orders", json=_delivery_payload(courier.id))
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "FEATURE_DISABLED"
    assert resp.json()["error"]["feature"] == "pos.takeout"


def test_delivery_requires_delivery_info(
    device_client: TestClient, identify: Any, employees: Any, open_shift: Any, delivery_fee_product: Any,
) -> None:
    open_shift()
    identify(device_client, employees["operator"])
    resp = device_client.post("/api/v1/orders", json={"channel": "delivery"})
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "DELIVERY_INFO_REQUIRED"


def test_delivery_requires_a_real_courier(
    device_client: TestClient, identify: Any, employees: Any, open_shift: Any, delivery_fee_product: Any,
) -> None:
    open_shift()
    identify(device_client, employees["operator"])
    resp = device_client.post("/api/v1/orders", json=_delivery_payload(999_999))
    assert resp.status_code == 404, resp.text


def test_delivery_without_fee_product_configured_is_rejected(
    device_client: TestClient, identify: Any, employees: Any, open_shift: Any, courier: Any,
) -> None:
    """Sin un producto `is_delivery_fee` en la carta de esta sede, la
    comanda de domicilio NO se crea: nunca se inventa un monto en el
    servidor ni se cae a un campo aparte."""
    open_shift()
    identify(device_client, employees["operator"])
    resp = device_client.post("/api/v1/orders", json=_delivery_payload(courier.id))
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "DELIVERY_FEE_NOT_CONFIGURED"


def test_delivery_order_creates_with_fee_line_automatically(
    db: Any, device_client: TestClient, identify: Any, employees: Any, open_shift: Any, courier: Any, delivery_fee_product: Any,
) -> None:
    open_shift()
    identify(device_client, employees["operator"])
    resp = device_client.post("/api/v1/orders", json=_delivery_payload(courier.id))
    assert resp.status_code == 201, resp.text
    order = resp.json()

    assert order["delivery"]["address"] == "Cra 7 # 20-15"
    assert order["delivery"]["phone"] == "3009998877"
    assert order["delivery"]["courier"]["id"] == courier.id
    assert order["delivery"]["courier"]["name"] == courier.name

    # El cargo entró SOLO, sin que el operador agregara nada.
    assert len(order["items"]) == 1
    fee_line = order["items"][0]
    assert fee_line["product_id"] == delivery_fee_product.id
    assert fee_line["qty"] == 1
    assert fee_line["unit_price"] == delivery_fee_product.price_dine_in
    assert fee_line["station"] is None  # nunca pasa por cocina
    assert fee_line["tax_rate"] == 8  # inc_8 en la sede de prueba

    # Sin receta, sin costo — nunca un cero mudo.
    row = db.execute(select(OrderItem).where(OrderItem.id == fee_line["id"])).scalars().one()
    assert row.unit_cost is None
    assert row.cost_source is None
    assert row.recipe_version is None


def test_delivery_fee_line_enters_totals_and_tax_base_like_any_item(
    device_client: TestClient, identify: Any, employees: Any, open_shift: Any, courier: Any, delivery_fee_product: Any,
    main_product: Any,
) -> None:
    """§4.3: el cargo entra a la base gravable y a los totales por el MISMO
    camino que cualquier ítem — sin una suma nueva. Test numérico."""
    open_shift()
    identify(device_client, employees["operator"])
    order = device_client.post("/api/v1/orders", json=_delivery_payload(courier.id)).json()
    order = device_client.post(
        f"/api/v1/orders/{order['id']}/items",
        json={"expected_version": order["version"], "items": [{"product_id": main_product.id, "qty": 1}]},
        headers=idem_headers(),
    ).json()

    fee_line = next(i for i in order["items"] if i["product_id"] == delivery_fee_product.id)
    main_line = next(i for i in order["items"] if i["product_id"] == main_product.id)

    # `price_includes_tax=True` en la sede de prueba: base + tax == net, y
    # net == unit_price (sin descuentos).
    assert fee_line["net"] == delivery_fee_product.price_dine_in
    assert fee_line["tax"] > 0

    assert order["totals"]["subtotal"] == fee_line["gross"] + main_line["gross"]
    assert order["totals"]["total"] == fee_line["net"] + main_line["net"]
    assert order["totals"]["tax_total"] == fee_line["tax"] + main_line["tax"]
    # La base gravable de INC 8% incluye el cargo: son dos líneas con la
    # MISMA tasa, así que caen en el mismo `tax_lines` bucket.
    bucket = next(t for t in order["totals"]["tax_lines"] if t["rate"] == 8)
    assert bucket["tax"] == fee_line["tax"] + main_line["tax"]


def test_delivery_fee_product_cannot_be_added_manually(
    device_client: TestClient, identify: Any, employees: Any, open_shift: Any, courier: Any, delivery_fee_product: Any,
) -> None:
    open_shift()
    identify(device_client, employees["operator"])
    order = device_client.post("/api/v1/orders", json=_delivery_payload(courier.id)).json()
    resp = device_client.post(
        f"/api/v1/orders/{order['id']}/items",
        json={"expected_version": order["version"], "items": [{"product_id": delivery_fee_product.id, "qty": 1}]},
        headers=idem_headers(),
    )
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "DELIVERY_FEE_NOT_ORDERABLE"


def test_delivery_order_never_publishes_a_courier_with_id_zero(
    db: Any, device_client: TestClient, identify: Any, employees: Any, open_shift: Any, courier: Any, delivery_fee_product: Any,
) -> None:
    """RONDA 3 — H-4 (cero mudo). `courier_employee_id` es una columna
    nullable (`0013_channels_orders`) y `create_order` sólo la exige AL
    CREAR; una fila que llegue con la columna en `NULL` por fuera del
    servicio (una `UPDATE` a mano, el gap declarado de reasignación de
    domiciliario) no puede publicarse con `courier.id == 0` y nombre vacío —
    `null` no es 0 (AGENTS.md). Réplica en mi territorio del invariante del
    auditor (`tests/audit/test_channels_invariants.py::
    test_a_delivery_order_never_publishes_a_courier_with_id_zero`), que no
    toco por ser territorio prohibido."""
    open_shift()
    identify(device_client, employees["operator"])
    resp = device_client.post("/api/v1/orders", json=_delivery_payload(courier.id))
    assert resp.status_code == 201, resp.text
    order_id = resp.json()["id"]

    row = db.get(Order, order_id)
    row.courier_employee_id = None
    row.courier_employee_name = None
    db.commit()

    order = device_client.get(f"/api/v1/orders/{order_id}").json()
    assert order["delivery"] is not None, "el bloque `delivery` no puede desaparecer: cambiaría el contrato"
    assert order["delivery"]["courier"] is None, (
        f"se publicó un domiciliario inventado: {order['delivery']['courier']!r}; "
        "`null` no es 0 (AGENTS.md): sin domiciliario real, `courier` tiene que ser `None`"
    )


def test_delivery_disabled_leaves_other_channels_identical(
    device_client: TestClient, identify: Any, employees: Any, open_shift: Any, set_feature: Any,
) -> None:
    """Checklist de la spec: con `pos.delivery` apagada, todo lo demás sigue
    idéntico — acá, que `counter` sigue funcionando sin exigir nada nuevo."""
    set_feature("pos.delivery", False)
    open_shift()
    identify(device_client, employees["operator"])
    resp = device_client.post("/api/v1/orders", json={"channel": "counter"})
    assert resp.status_code == 201, resp.text
