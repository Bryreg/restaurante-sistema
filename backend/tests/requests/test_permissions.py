"""Quién puede qué: la tablet pide y recibe; el administrador resuelve. La
función se prueba encendida y apagada, y un id de otra organización es 404."""

from __future__ import annotations

from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.requests.models import StaffRequest
from tests.requests.conftest import API, find_secret_keys, idem


def _change(device_client: Any) -> Any:
    return device_client.post(
        f"{API}/requests/change",
        json={"denominations": {"denominations": [{"value": 1000, "count": 5}], "total": 5000}, "reason": "Monedas"},
        headers=idem(),
    )


def test_operator_routes_need_a_person_identified(device_client) -> None:
    for resp in (
        device_client.get(f"{API}/requests/mine"),
        device_client.get(f"{API}/requests/supply-suggestions"),
        _change(device_client),
    ):
        assert resp.status_code == 401, resp.text


def test_a_device_never_reaches_the_admin_routes(device_client, open_shift, store) -> None:
    open_shift()
    created = _change(device_client).json()
    for resp in (
        device_client.get(f"{API}/admin/requests", params={"store_id": store.id}),
        device_client.get(f"{API}/admin/requests/supplies", params={"store_id": store.id}),
        device_client.post(f"{API}/admin/requests/{created['id']}/approve", json={}, headers=idem()),
        device_client.post(f"{API}/admin/requests/{created['id']}/reject", json={"reason": "x"}, headers=idem()),
        device_client.post(f"{API}/admin/requests/{created['id']}/mark-bought", json={}, headers=idem()),
    ):
        assert resp.status_code == 401, resp.text


def test_admin_of_another_organization_gets_404(device_client, open_shift, store, admin_client_b, db: Session) -> None:
    open_shift()
    created = _change(device_client).json()

    assert admin_client_b.get(f"{API}/admin/requests", params={"store_id": store.id}).status_code == 404
    for path in ("approve", "mark-bought"):
        resp = admin_client_b.post(f"{API}/admin/requests/{created['id']}/{path}", json={}, headers=idem())
        assert resp.status_code == 404, resp.text
    resp = admin_client_b.post(f"{API}/admin/requests/{created['id']}/reject", json={"reason": "no"}, headers=idem())
    assert resp.status_code == 404
    db.expire_all()
    assert db.get(StaffRequest, created["id"]).status.value == "pending"  # type: ignore[union-attr]


def test_feature_off_is_refused_on_both_sides(
    device_client, admin_client, open_shift, store, set_feature, db: Session
) -> None:
    open_shift()
    created = _change(device_client).json()
    set_feature("pos.requests", False)

    for resp in (
        device_client.get(f"{API}/requests/mine"),
        device_client.get(f"{API}/requests/supply-suggestions"),
        _change(device_client),
        device_client.post(f"{API}/requests/{created['id']}/received", json={}, headers=idem()),
        admin_client.get(f"{API}/admin/requests", params={"store_id": store.id}),
        admin_client.post(f"{API}/admin/requests/{created['id']}/approve", json={}, headers=idem()),
    ):
        assert resp.status_code == 400, resp.text
        assert resp.json()["error"]["code"] == "FEATURE_DISABLED"
        assert resp.json()["error"]["feature"] == "pos.requests"
    assert db.execute(select(func.count(StaffRequest.id))).scalar_one() == 1


def test_feature_on_by_default_in_standard_and_full_not_basic() -> None:
    from app.core.features import FEATURE_BY_KEY

    assert FEATURE_BY_KEY["pos.requests"].defaults == {"basic": False, "standard": True, "full": True}


def test_mine_shows_the_open_shift_and_the_approved_pending_ones_without_costs(
    device_client, admin_client, open_shift, identify, employees
) -> None:
    open_shift()
    created = _change(device_client).json()
    admin_client.post(f"{API}/admin/requests/{created['id']}/approve", json={}, headers=idem())
    mine = device_client.get(f"{API}/requests/mine")
    assert mine.status_code == 200
    assert [r["status"] for r in mine.json()] == ["approved"]
    assert find_secret_keys(mine.json()) == []


def test_openapi_of_the_request_routes_declares_no_cost_fields() -> None:
    from app.main import app

    spec = app.openapi()
    names: set[str] = set()
    for name, schema in spec["components"]["schemas"].items():
        if name.startswith(("StaffRequest", "SupplySuggestion", "RequestLine", "PersonRef")):
            names.update(schema.get("properties", {}).keys())
    assert names, "no se encontraron los esquemas de solicitudes"
    assert [n for n in names if "cost" in n.lower() or "margin" in n.lower()] == []
