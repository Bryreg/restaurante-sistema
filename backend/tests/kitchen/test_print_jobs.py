"""`GET/POST /kitchen/print-jobs` (`kitchen.kds`): el TRABAJO de impresión
por estación — qué se imprimiría, para qué estación, cuándo, y su registro.
No hay impresora real (§13, fase 3); esto es lo que un driver real
consumiría."""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from tests.orders.conftest import idem_headers


def _send_one_main_item(new_order: Any, add_items: Any, main_product: Any, send_order: Any) -> dict[str, Any]:
    order = new_order().json()
    order = add_items(order, [{"product_id": main_product.id, "qty": 1}]).json()
    return send_order(order).json()


def test_print_job_lists_the_pending_docket_and_registers_the_print(
    device_client: TestClient, identify: Any, employees: Any, open_shift: Any,
    new_order: Any, add_items: Any, main_product: Any, send_order: Any,
) -> None:
    open_shift()
    identify(device_client, employees["operator"])
    order = _send_one_main_item(new_order, add_items, main_product, send_order)
    round_id = None  # se resuelve leyendo `GET /kitchen/rounds` para no asumir el id

    rounds = device_client.get("/api/v1/kitchen/rounds").json()
    assert len(rounds) == 1

    pending = device_client.get("/api/v1/kitchen/print-jobs").json()
    assert len(pending) == 1
    docket = pending[0]
    assert docket["order_id"] == order["id"]
    assert docket["station"] == "hot_kitchen"
    assert docket["channel"] == "counter"
    assert docket["item_count"] == 1
    assert docket["items"][0]["name"] == "Bandeja Paisa"
    assert docket["printed"] is False
    assert docket["printed_at"] is None
    assert docket["printed_by"] is None
    assert docket["print_count"] == 0
    round_id = docket["round_id"]

    filtered_out = device_client.get("/api/v1/kitchen/print-jobs", params={"station": "bar"}).json()
    assert filtered_out == []
    filtered_in = device_client.get("/api/v1/kitchen/print-jobs", params={"station": "hot_kitchen"}).json()
    assert len(filtered_in) == 1

    registered = device_client.post(
        "/api/v1/kitchen/print-jobs", json={"round_id": round_id, "station": "hot_kitchen"}, headers=idem_headers()
    )
    assert registered.status_code == 200, registered.text
    body = registered.json()
    assert body["printed"] is True
    assert body["printed_at"] is not None
    assert body["printed_by"]["name"] == "Operator"
    assert body["print_count"] == 1
    assert body["item_count"] == 1

    after = device_client.get("/api/v1/kitchen/print-jobs").json()
    assert after[0]["printed"] is True
    assert after[0]["print_count"] == 1


def test_reprinting_is_allowed_and_each_confirmation_adds_a_row(
    device_client: TestClient, identify: Any, employees: Any, open_shift: Any,
    new_order: Any, add_items: Any, main_product: Any, send_order: Any,
) -> None:
    open_shift()
    identify(device_client, employees["operator"])
    _send_one_main_item(new_order, add_items, main_product, send_order)
    round_id = device_client.get("/api/v1/kitchen/print-jobs").json()[0]["round_id"]

    first = device_client.post(
        "/api/v1/kitchen/print-jobs", json={"round_id": round_id, "station": "hot_kitchen"}, headers=idem_headers()
    ).json()
    second = device_client.post(
        "/api/v1/kitchen/print-jobs", json={"round_id": round_id, "station": "hot_kitchen"}, headers=idem_headers()
    ).json()
    assert first["print_count"] == 1
    assert second["print_count"] == 2  # el papel se atascó: reimprimir es legítimo


def test_print_job_replays_with_the_same_idempotency_key(
    device_client: TestClient, identify: Any, employees: Any, open_shift: Any,
    new_order: Any, add_items: Any, main_product: Any, send_order: Any,
) -> None:
    open_shift()
    identify(device_client, employees["operator"])
    _send_one_main_item(new_order, add_items, main_product, send_order)
    round_id = device_client.get("/api/v1/kitchen/print-jobs").json()[0]["round_id"]

    headers = idem_headers()
    body = {"round_id": round_id, "station": "hot_kitchen"}
    first = device_client.post("/api/v1/kitchen/print-jobs", json=body, headers=headers)
    replay = device_client.post("/api/v1/kitchen/print-jobs", json=body, headers=headers)
    assert first.json() == replay.json()
    # Un solo registro real (la clave repetida devolvió la misma respuesta
    # guardada, no ejecutó `register_print_job` una segunda vez).
    assert device_client.get("/api/v1/kitchen/print-jobs").json()[0]["print_count"] == 1


def test_registering_a_station_with_nothing_pending_is_not_an_error(
    device_client: TestClient, identify: Any, employees: Any, open_shift: Any,
    new_order: Any, add_items: Any, main_product: Any, send_order: Any,
) -> None:
    """Una estación sin ítems `sent`/`ready` en la ronda (ya se marcaron
    listos, o nunca hubo nada para esa estación) se registra igual con
    `item_count=0` — mismo criterio que `expedite_order` con
    `changed_item_ids=[]`: "no había nada que hacer" no es un fallo."""
    open_shift()
    identify(device_client, employees["operator"])
    _send_one_main_item(new_order, add_items, main_product, send_order)
    round_id = device_client.get("/api/v1/kitchen/print-jobs").json()[0]["round_id"]

    resp = device_client.post(
        "/api/v1/kitchen/print-jobs", json={"round_id": round_id, "station": "bar"}, headers=idem_headers()
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["item_count"] == 0
    assert body["items"] == []
    assert body["printed"] is True
    assert body["print_count"] == 1


def test_print_job_unknown_round_is_404(
    device_client: TestClient, identify: Any, employees: Any, open_shift: Any,
) -> None:
    open_shift()
    identify(device_client, employees["operator"])
    resp = device_client.post(
        "/api/v1/kitchen/print-jobs", json={"round_id": 999999, "station": "hot_kitchen"}, headers=idem_headers()
    )
    assert resp.status_code == 404, resp.text


def test_print_jobs_require_kitchen_kds_flag(
    device_client: TestClient, identify: Any, employees: Any, open_shift: Any, set_feature: Any,
    new_order: Any, add_items: Any, main_product: Any, send_order: Any,
) -> None:
    open_shift()
    identify(device_client, employees["operator"])
    order = _send_one_main_item(new_order, add_items, main_product, send_order)
    round_id = device_client.get("/api/v1/kitchen/print-jobs").json()[0]["round_id"]

    set_feature("kitchen.kds", False)
    get_off = device_client.get("/api/v1/kitchen/print-jobs")
    assert get_off.status_code == 400
    assert get_off.json()["error"]["code"] == "FEATURE_DISABLED"

    post_off = device_client.post(
        "/api/v1/kitchen/print-jobs", json={"round_id": round_id, "station": "hot_kitchen"}, headers=idem_headers()
    )
    assert post_off.status_code == 400
    assert post_off.json()["error"]["code"] == "FEATURE_DISABLED"

    # `kitchen.view` (1b) sigue andando: la comanda se sigue viendo en la
    # cola mínima.
    rounds = device_client.get("/api/v1/kitchen/rounds").json()
    assert rounds[0]["order_id"] == order["id"]
