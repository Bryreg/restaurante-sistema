"""Gancho cruzado `shifts.service -> orders.hooks` (comandas abiertas al
cerrar el turno; traslado al turno siguiente). Dueño del test de punta a
punta: `backend-base` (CONTRATO-INTERNO-1b-1.md §2.5).

La comanda se crea escribiendo directo contra `app.orders.models` (el
modelo, que ya existe) en vez de pasar por `POST /orders` (el router es
territorio de `backend-comanda` y todavía no existe al escribir este test):
lo que este archivo prueba es el lado de `backend-base` del gancho
(`shifts.service` llamando a `orders.hooks.count_open_orders` /
`detach_open_orders` / `adopt_transferred_orders`), no la creación de la
comanda por API. Si `app.orders.models` todavía no existiera, el archivo
completo se salta con un motivo explícito (no falla en seco) — hoy sí existe,
así que corre de verdad.
"""

from __future__ import annotations

import pytest
from sqlalchemy.orm import Session

from app.core.modules import find_spec_safe

from tests.shifts.conftest import idem

pytestmark = pytest.mark.skipif(
    find_spec_safe("app.orders.models") is None,
    reason="app.orders.models todavía no existe (territorio de backend-comanda; CONTRATO-INTERNO-1b-1.md §1)",
)


def _make_open_order(db: Session, *, organization_id: int, store_id: int, shift_id: int | None, employee: object) -> int:
    from app.core import clock as clock_module
    from app.orders.models import Order, OrderChannel, OrderStatus

    now = clock_module.now_utc()
    order = Order(
        organization_id=organization_id,
        store_id=store_id,
        shift_id=shift_id,
        business_date=now.date(),
        channel=OrderChannel.COUNTER,
        status=OrderStatus.OPEN,
        opened_by_employee_id=employee.id,  # type: ignore[attr-defined]
        opened_by_employee_name=employee.name,  # type: ignore[attr-defined]
        opened_at=now,
        created_at=now,
        updated_at=now,
    )
    db.add(order)
    db.flush()
    return order.id


def test_close_blocked_by_open_order_and_transfer_reopens_it_next_shift(
    device_client, identify, employees, open_shift, db: Session, org, store
) -> None:
    from app.orders.models import Order

    shift = open_shift(cash_responsible=employees["cashier"])
    order_id = _make_open_order(
        db, organization_id=org.id, store_id=store.id, shift_id=shift["id"], employee=employees["cashier"]
    )

    identify(device_client, employees["cashier"])

    count = device_client.post(
        f"/api/v1/shifts/{shift['id']}/close/count",
        json={
            "counted_cash": {"denominations": [{"value": 50000, "count": 4}], "total": 200_000},
            "photo": "cierre.jpg",
        },
        headers=idem(),
    )
    assert count.status_code == 201, count.text
    count_id = count.json()["count_id"]

    review = device_client.get(f"/api/v1/shifts/{shift['id']}/close/{count_id}/review")
    assert review.status_code == 200, review.text
    assert review.json()["open_orders"] == 1, "la comanda abierta tiene que verse en la revisión del cierre"

    blocked = device_client.post(
        f"/api/v1/shifts/{shift['id']}/close/{count_id}/confirm",
        json={"difference_seen": review.json()["difference"]},
    )
    assert blocked.status_code == 400, blocked.text
    assert blocked.json()["error"]["code"] == "OPEN_ORDERS_EXIST"
    assert blocked.json()["error"]["open_orders"] == 1

    # El turno sigue abierto: el gate cortó antes de escribir nada.
    still_open = device_client.get(f"/api/v1/shifts/{shift['id']}")
    assert still_open.json()["status"] == "open"

    confirmed = device_client.post(
        f"/api/v1/shifts/{shift['id']}/close/{count_id}/confirm",
        json={"difference_seen": review.json()["difference"], "transfer_open_orders": True},
    )
    assert confirmed.status_code == 200, confirmed.text

    detached = db.get(Order, order_id)
    assert detached is not None
    assert detached.shift_id is None, "la comanda trasladada queda huérfana, a la espera del turno siguiente"
    assert detached.transferred_from_shift_id == shift["id"]

    new_shift = open_shift(cash_responsible=employees["cashier"])

    adopted = db.get(Order, order_id)
    assert adopted is not None
    assert adopted.shift_id == new_shift["id"], "el turno siguiente adopta la comanda trasladada"
    assert adopted.transferred_to_shift_id == new_shift["id"]


def test_close_administrative_always_transfers_open_orders(
    admin_client, employees, open_shift, clock, db: Session, org, store
) -> None:
    from app.orders.models import Order

    shift = open_shift(cash_responsible=employees["cashier"])
    order_id = _make_open_order(
        db, organization_id=org.id, store_id=store.id, shift_id=shift["id"], employee=employees["cashier"]
    )

    # El cierre administrativo exige un turno "stale" (pasada la hora de
    # corte del día siguiente): adelantamos el reloj de pruebas.
    clock.advance(days=2)

    result = admin_client.post(
        f"/api/v1/admin/shifts/{shift['id']}/close-administrative",
        json={"reason": "Turno abandonado, se cierra desde admin"},
    )
    assert result.status_code == 200, result.text

    transferred = db.get(Order, order_id)
    assert transferred is not None
    assert transferred.shift_id is None
    assert transferred.transferred_from_shift_id == shift["id"]
