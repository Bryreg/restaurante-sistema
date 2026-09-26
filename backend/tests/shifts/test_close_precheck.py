"""«Paso 0» del cierre a ciegas, retomar un conteo sellado y el recuento
marcado (auditoría de tablet).

- `GET /shifts/{id}/close/precheck` dice ANTES de contar lo que el cierre va
  a exigir —comandas abiertas, domicilios sin liquidar, datáfono,
  transferencias, foto— sin publicar **ningún monto**.
- Si ya hay un conteo sellado y activo, lo publica para retomar en el paso 2.
- Volver a contar después de abrir el paso 2 deja el conteo anterior
  superado y marca el nuevo «recontado después de ver el esperado» para el
  administrador; el conteo superado ya no se puede confirmar.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy.orm import Session

from app.core import clock as clock_module
from app.orders.models import Order, OrderChannel, OrderStatus
from tests.shifts.conftest import idem

API = "/api/v1"


def _count(device_client: Any, shift_id: int, total: int = 200_000) -> int:
    resp = device_client.post(
        f"{API}/shifts/{shift_id}/close/count",
        json={
            "counted_cash": {"denominations": [{"value": 10000, "count": total // 10000}], "total": total},
            "tips_cash_out": 0,
            "photo": "foto.jpg",
        },
        headers=idem(),
    )
    assert resp.status_code == 201, resp.text
    return int(resp.json()["count_id"])


def _numbers(value: Any) -> list[int]:
    if isinstance(value, bool):
        return []
    if isinstance(value, int):
        return [value]
    if isinstance(value, dict):
        return [n for v in value.values() for n in _numbers(v)]
    if isinstance(value, list):
        return [n for v in value for n in _numbers(v)]
    return []


def test_precheck_lists_open_orders_without_revealing_any_amount(
    device_client, open_shift, employees, db: Session, org, store
) -> None:
    shift = open_shift()
    now = clock_module.now_utc()
    db.add(
        Order(
            organization_id=org.id,
            store_id=store.id,
            shift_id=shift["id"],
            business_date=now.date(),
            channel=OrderChannel.COUNTER,
            status=OrderStatus.OPEN,
            opened_by_employee_id=employees["cashier"].id,
            opened_by_employee_name="Cashier",
            opened_at=now,
            created_at=now,
            updated_at=now,
        )
    )
    db.commit()

    resp = device_client.get(f"{API}/shifts/{shift['id']}/close/precheck")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["open_orders"] == 1
    assert [i["code"] for i in body["items"] if i["level"] == "blocking"] == ["OPEN_ORDERS"]
    assert body["sealed_count"] is None
    # A ciegas: ninguna cifra de plata. Los únicos enteros son ids y conteos.
    allowed = {shift["id"], body["open_orders"], body["delivery_pending_payments"], body["delivery_pending_couriers"]}
    assert set(_numbers(body)) <= allowed, body
    assert "200.000" not in resp.text and "200000" not in resp.text


def test_a_sealed_count_is_published_to_resume_at_step_two(device_client, open_shift) -> None:
    shift = open_shift()
    count_id = _count(device_client, shift["id"])
    body = device_client.get(f"{API}/shifts/{shift['id']}/close/precheck").json()
    assert body["sealed_count"]["count_id"] == count_id
    assert body["sealed_count"]["counted_by"] == "Cashier"

    review = device_client.get(f"{API}/shifts/{shift['id']}/close/{count_id}/review").json()
    # Al retomar, la pantalla no tiene lo tecleado: la review trae lo sellado.
    assert review["counted"] == 200_000
    assert review["counted_pieces"] == 20


def test_recounting_after_seeing_the_expected_is_flagged_for_the_admin(
    device_client, admin_client, open_shift, store
) -> None:
    shift = open_shift()
    first = _count(device_client, shift["id"], total=190_000)
    seen = device_client.get(f"{API}/shifts/{shift['id']}/close/{first}/review")
    assert seen.status_code == 200
    second = _count(device_client, shift["id"], total=200_000)

    # El conteo anterior quedó superado y ya no se puede confirmar.
    stale = device_client.post(
        f"{API}/shifts/{shift['id']}/close/{first}/confirm",
        json={"difference_seen": seen.json()["difference"], "cause": "counting_error"},
    )
    assert stale.status_code == 409
    assert stale.json()["error"]["code"] == "CLOSE_COUNT_SUPERSEDED"
    assert device_client.get(f"{API}/shifts/{shift['id']}/close/precheck").json()["sealed_count"]["count_id"] == second

    timeline = admin_client.get(f"{API}/admin/shifts/{shift['id']}/timeline")
    assert timeline.status_code == 200, timeline.text
    counts = {e["data"]["id"]: e for e in timeline.json() if e["kind"] == "close_count"}
    assert counts[second]["data"]["recounted_after_review"] is True
    assert "recontado después de ver el esperado" in counts[second]["summary"]
    assert counts[first]["data"]["recounted_after_review"] is False
    assert counts[first]["data"]["superseded"] is True

    listed = admin_client.get(f"{API}/admin/shifts", params={"store_id": store.id})
    assert listed.status_code == 200, listed.text
    row = next(r for r in listed.json() if r["id"] == shift["id"])
    assert row["recounted_after_review"] is True


def test_recounting_before_opening_step_two_is_not_flagged(device_client, admin_client, open_shift) -> None:
    shift = open_shift()
    first = _count(device_client, shift["id"], total=190_000)
    second = _count(device_client, shift["id"], total=200_000)
    counts = {
        e["data"]["id"]: e
        for e in admin_client.get(f"{API}/admin/shifts/{shift['id']}/timeline").json()
        if e["kind"] == "close_count"
    }
    assert counts[second]["data"]["recounted_after_review"] is False
    assert counts[first]["data"]["superseded"] is True
