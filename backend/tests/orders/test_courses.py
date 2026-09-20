"""Curso y «marchar» (pedido 2c, `pos.courses`, requiere `kitchen.view`):
`fired_at` por curso, idempotente, con `Idempotency-Key` y `409` ante
concurrencia (versión vieja)."""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from tests.orders.conftest import idem_headers


def _fire(device_client: TestClient, order: dict[str, Any], course: str, *, headers: dict[str, str] | None = None) -> Any:
    return device_client.post(
        f"/api/v1/orders/{order['id']}/courses/{course}/fire",
        json={"expected_version": order["version"]},
        headers=headers or idem_headers(),
    )


def test_fire_course_requires_feature_flag(
    device_client: TestClient, identify: Any, employees: Any, open_shift: Any, set_feature: Any, new_order: Any,
) -> None:
    set_feature("pos.courses", False)
    open_shift()
    identify(device_client, employees["operator"])
    order = new_order().json()
    resp = _fire(device_client, order, "starter")
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "FEATURE_DISABLED"
    assert resp.json()["error"]["feature"] == "pos.courses"


def test_fire_course_seals_fired_at(
    device_client: TestClient, identify: Any, employees: Any, open_shift: Any, new_order: Any,
) -> None:
    open_shift()
    identify(device_client, employees["operator"])
    order = new_order().json()
    resp = _fire(device_client, order, "starter")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert len(body["courses_fired"]) == 1
    assert body["courses_fired"][0]["course"] == "starter"
    assert body["courses_fired"][0]["fired_at"] is not None
    assert body["courses_fired"][0]["fired_by"]["name"] == "Operator"
    assert body["version"] == order["version"] + 1


def test_fire_course_twice_is_idempotent_and_does_not_move_fired_at(
    device_client: TestClient, identify: Any, employees: Any, open_shift: Any, new_order: Any,
) -> None:
    open_shift()
    identify(device_client, employees["operator"])
    order = new_order().json()
    first = _fire(device_client, order, "starter").json()
    first_fired_at = first["courses_fired"][0]["fired_at"]
    first_version = first["version"]

    second = _fire(device_client, first, "starter").json()
    assert len(second["courses_fired"]) == 1
    assert second["courses_fired"][0]["fired_at"] == first_fired_at
    assert second["version"] == first_version  # no bumpeó de nuevo


def test_fire_different_courses_keep_independent_timestamps(
    device_client: TestClient, identify: Any, employees: Any, open_shift: Any, new_order: Any, clock: Any,
) -> None:
    open_shift()
    identify(device_client, employees["operator"])
    order = new_order().json()
    order = _fire(device_client, order, "starter").json()
    clock.advance(minutes=5)
    identify(device_client, employees["operator"])  # la ventana de la persona (3 min) ya expiró
    order = _fire(device_client, order, "main").json()

    by_course = {c["course"]: c["fired_at"] for c in order["courses_fired"]}
    assert set(by_course) == {"starter", "main"}
    assert by_course["starter"] != by_course["main"]


def test_fire_course_rejects_stale_version(
    device_client: TestClient, identify: Any, employees: Any, open_shift: Any, new_order: Any,
) -> None:
    open_shift()
    identify(device_client, employees["operator"])
    order = new_order().json()
    stale = dict(order)
    order = _fire(device_client, order, "starter").json()  # bumpea la versión de verdad
    resp = _fire(device_client, stale, "main")
    assert resp.status_code == 409, resp.text
    assert resp.json()["error"]["code"] == "STALE_VERSION"
