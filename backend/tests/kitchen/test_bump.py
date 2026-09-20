"""`POST /kitchen/items/{id}/bump` y `.../unbump` (`kitchen.kds`, CONTRATO
C1: pasan por `app.orders.hooks.bump_item`/`unbump_item`, nunca escriben
`OrderItem.status` a mano). Checklist de la spec: «Bump por ítem es
idempotente (test)»."""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from tests.orders.conftest import idem_headers


def _send_one_main_item(new_order: Any, add_items: Any, main_product: Any, send_order: Any) -> dict[str, Any]:
    order = new_order().json()
    order = add_items(order, [{"product_id": main_product.id, "qty": 1}]).json()
    return send_order(order).json()


def test_bump_is_idempotent_same_state_same_instant(
    device_client: TestClient, identify: Any, employees: Any, open_shift: Any,
    new_order: Any, add_items: Any, main_product: Any, send_order: Any,
) -> None:
    open_shift()
    identify(device_client, employees["operator"])
    order = _send_one_main_item(new_order, add_items, main_product, send_order)
    item_id = order["items"][0]["id"]

    first = device_client.post(f"/api/v1/kitchen/items/{item_id}/bump", headers=idem_headers())
    assert first.status_code == 200, first.text
    body1 = first.json()
    assert body1["status"] == "ready"
    assert body1["changed"] is True
    assert body1["bumped_by"]["name"] == "Operator"
    ready_at_1 = body1["ready_at"]
    assert ready_at_1 is not None

    # Segundo bump del MISMO ítem, con una Idempotency-Key DISTINTA (dos
    # toques reales, no un replay de la misma key): tiene que dejar el
    # mismo estado y el mismo instante, sin error.
    second = device_client.post(f"/api/v1/kitchen/items/{item_id}/bump", headers=idem_headers())
    assert second.status_code == 200, second.text
    body2 = second.json()
    assert body2["status"] == "ready"
    assert body2["changed"] is False  # el segundo bump es un no-op idempotente
    assert body2["ready_at"] == ready_at_1  # el mismo instante: no se movió
    assert body2["bumped_by"]["name"] == "Operator"  # la atribución del primero se conserva


def test_bump_replays_with_the_same_idempotency_key(
    device_client: TestClient, identify: Any, employees: Any, open_shift: Any,
    new_order: Any, add_items: Any, main_product: Any, send_order: Any,
) -> None:
    open_shift()
    identify(device_client, employees["operator"])
    order = _send_one_main_item(new_order, add_items, main_product, send_order)
    item_id = order["items"][0]["id"]

    headers = idem_headers()
    first = device_client.post(f"/api/v1/kitchen/items/{item_id}/bump", headers=headers)
    replay = device_client.post(f"/api/v1/kitchen/items/{item_id}/bump", headers=headers)
    assert first.status_code == 200 and replay.status_code == 200
    assert first.json() == replay.json()  # exactamente la misma respuesta guardada, no una segunda ejecución


def test_bump_unknown_item_is_404_not_500(
    device_client: TestClient, identify: Any, employees: Any, open_shift: Any,
) -> None:
    open_shift()
    identify(device_client, employees["operator"])
    resp = device_client.post("/api/v1/kitchen/items/999999/bump", headers=idem_headers())
    assert resp.status_code == 404, resp.text
    assert resp.json()["error"]["code"] == "NOT_FOUND"


def test_bump_requires_identified_operator(
    device_client: TestClient, identify: Any, employees: Any, open_shift: Any,
    new_order: Any, add_items: Any, main_product: Any, send_order: Any,
) -> None:
    """Bumpear es una acción atribuible (§ misión): a diferencia de
    `GET /kitchen/rounds`, esta ruta SÍ exige una persona identificada."""
    open_shift()
    order = _send_one_main_item(new_order, add_items, main_product, send_order)
    item_id = order["items"][0]["id"]

    # `open_shift()` identifica al responsable de caja para abrir el turno;
    # se libera acá para dejar el dispositivo activado pero SIN persona
    # vigente (`POST /auth/device/release`), el caso real que la ruta tiene
    # que rechazar.
    release = device_client.post("/api/v1/auth/device/release")
    assert release.status_code == 200, release.text

    resp = device_client.post(f"/api/v1/kitchen/items/{item_id}/bump", headers=idem_headers())
    assert resp.status_code == 401, resp.text
    assert resp.json()["error"]["code"] == "IDENTIFY_REQUIRED"

    # Con la persona identificada de nuevo, el mismo bump sí funciona.
    identify(device_client, employees["operator"])
    ok = device_client.post(f"/api/v1/kitchen/items/{item_id}/bump", headers=idem_headers())
    assert ok.status_code == 200, ok.text


def test_unbump_reverses_a_bump_and_is_also_idempotent(
    device_client: TestClient, identify: Any, employees: Any, open_shift: Any,
    new_order: Any, add_items: Any, main_product: Any, send_order: Any,
) -> None:
    open_shift()
    identify(device_client, employees["operator"])
    order = _send_one_main_item(new_order, add_items, main_product, send_order)
    item_id = order["items"][0]["id"]

    bumped = device_client.post(f"/api/v1/kitchen/items/{item_id}/bump", headers=idem_headers())
    assert bumped.json()["status"] == "ready"

    undone = device_client.post(f"/api/v1/kitchen/items/{item_id}/unbump", headers=idem_headers())
    assert undone.status_code == 200, undone.text
    body = undone.json()
    assert body["status"] == "sent"
    assert body["changed"] is True
    assert body["ready_at"] is None
    assert body["bumped_by"] is None  # ya no está `ready`: no hay quién lo bumpeó ahora

    # Deshacer un ítem que ya no está `ready` (nunca se bumpeó, o ya se
    # deshizo): no-op idempotente, no error.
    again = device_client.post(f"/api/v1/kitchen/items/{item_id}/unbump", headers=idem_headers())
    assert again.status_code == 200, again.text
    assert again.json()["changed"] is False
    assert again.json()["status"] == "sent"

    # Y se puede volver a bumpear después de deshacerlo (el caso real: "un
    # bump equivocado en hora pico es inevitable").
    rebumped = device_client.post(f"/api/v1/kitchen/items/{item_id}/bump", headers=idem_headers())
    assert rebumped.status_code == 200
    assert rebumped.json()["status"] == "ready"
    assert rebumped.json()["changed"] is True


def test_bump_and_unbump_require_kitchen_kds_flag(
    device_client: TestClient, identify: Any, employees: Any, open_shift: Any, set_feature: Any,
    new_order: Any, add_items: Any, main_product: Any, send_order: Any,
) -> None:
    open_shift()
    identify(device_client, employees["operator"])
    order = _send_one_main_item(new_order, add_items, main_product, send_order)
    item_id = order["items"][0]["id"]

    set_feature("kitchen.kds", False)
    bump_off = device_client.post(f"/api/v1/kitchen/items/{item_id}/bump", headers=idem_headers())
    assert bump_off.status_code == 400, bump_off.text
    assert bump_off.json()["error"]["code"] == "FEATURE_DISABLED"
    assert bump_off.json()["error"]["feature"] == "kitchen.kds"

    unbump_off = device_client.post(f"/api/v1/kitchen/items/{item_id}/unbump", headers=idem_headers())
    assert unbump_off.status_code == 400, unbump_off.text
    assert unbump_off.json()["error"]["code"] == "FEATURE_DISABLED"

    # Y `kitchen.view` (1b) sigue andando IDÉNTICO con `kitchen.kds` apagada:
    # el ítem sigue en la cola mínima, sin campos nuevos.
    rounds = device_client.get("/api/v1/kitchen/rounds").json()
    assert rounds[0]["items"][0]["item_id"] == item_id
    assert "bumped_by" not in rounds[0]["items"][0]
    assert "platform" not in rounds[0]

    set_feature("kitchen.kds", True)
    bump_on = device_client.post(f"/api/v1/kitchen/items/{item_id}/bump", headers=idem_headers())
    assert bump_on.status_code == 200, bump_on.text
    assert bump_on.json()["changed"] is True
