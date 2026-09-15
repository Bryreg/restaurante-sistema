"""Gancho cruzado `compute_breakdown`/`_evaluate_close` -> `shifts.hooks.get_sales_totals`
leyendo `app.payments.models.Payment` (CONTRATO-INTERNO-1b-1.md §2.5). Dueño
del test de punta a punta: `backend-base`.

`test_sales_totals_flow_into_shift` es el E2E real descrito en el contrato:
abre turno, crea comanda `counter` por `POST /orders`, agrega un ítem, cobra
por `POST /orders/{id}/payments` con `cash` + `card` y propina, y verifica
`GET /shifts/{id}` como admin. Necesita el router de `app.orders`
(`backend-comanda`) y el módulo `app.payments` completo (`backend-cobro`),
que en el momento de escribir este archivo todavía no existen — se salta con
un motivo explícito (ronda 2, CONTRATO-INTERNO-1b-1.md §1) en vez de fallar
en seco contra rutas que no están montadas todavía.

`test_get_sales_totals_without_payments_module_is_zero` sí corre siempre:
protege el guardado `find_spec` de `hooks.get_sales_totals` (si `app.payments`
no existe o no expone `Payment`, el turno sigue calculando su esperado sin
reventar).
"""

from __future__ import annotations

import pytest
from sqlalchemy.orm import Session

from app.core.modules import find_spec_safe
from app.shifts import hooks
from app.shifts.models import Shift

from tests.shifts.conftest import idem

_ORDERS_ROUTER_READY = find_spec_safe("app.orders.router") is not None
_PAYMENTS_MODULE_READY = find_spec_safe("app.payments.models") is not None


def _open(db: Session) -> Shift:
    shift = db.query(Shift).filter(Shift.status == "open").order_by(Shift.id.desc()).first()
    assert shift is not None
    return shift


def test_get_sales_totals_without_payments_module_is_zero(open_shift, db: Session) -> None:
    shift = _open_after(open_shift, db)
    totals = hooks.get_sales_totals(db, shift.id)
    assert totals.cash == 0
    assert totals.card == 0
    assert totals.transfer == 0
    assert totals.other == 0
    assert totals.tips_cash == 0
    assert totals.tips_card == 0
    assert totals.tips_transfer == 0
    assert totals.tips_other == 0


def _open_after(open_shift, db: Session) -> Shift:
    open_shift()
    return _open(db)


@pytest.mark.skipif(
    not (_ORDERS_ROUTER_READY and _PAYMENTS_MODULE_READY),
    reason=(
        "requiere app.orders.router (backend-comanda) y app.payments (backend-cobro); "
        "todavía no existen (ronda 2, CONTRATO-INTERNO-1b-1.md §1)"
    ),
)
def test_sales_totals_flow_into_shift(
    device_client, admin_client, identify, employees, open_shift, catalog_seeded, db: Session
) -> None:
    shift = open_shift(responsible=employees["cashier"])
    identify(device_client, employees["cashier"])

    catalog = device_client.get("/api/v1/catalog").json()
    assert catalog["products"], "el seed de carta tiene que dejar al menos un producto"
    product_id = catalog["products"][0]["id"]

    created = device_client.post("/api/v1/orders", json={"channel": "counter"})
    assert created.status_code == 201, created.text
    order = created.json()

    added = device_client.post(
        f"/api/v1/orders/{order['id']}/items",
        json={"expected_version": order["version"], "items": [{"product_id": product_id, "qty": 1}]},
        headers=idem(),
    )
    assert added.status_code == 200, added.text
    order = added.json()
    total = order["totals"]["total"]
    cash_part = total // 2
    card_part = total - cash_part

    paid = device_client.post(
        f"/api/v1/orders/{order['id']}/payments",
        json={
            "expected_version": order["version"],
            "pin": "1111",
            "tip": {"asked": True, "accepted": True, "modified": False, "amount": 1000},
            "splits": [
                {"method": "cash", "amount": cash_part, "tendered": cash_part},
                {"method": "card", "amount": card_part},
            ],
        },
        headers=idem(),
    )
    assert paid.status_code == 201, paid.text

    summary = admin_client.get(f"/api/v1/shifts/{shift['id']}").json()
    assert summary["expected_cash"] == shift["opening_cash_total"] + cash_part
    assert summary["sales"]["card"] == card_part
    assert summary["tips"]["cash"] >= 0

    count = device_client.post(
        f"/api/v1/shifts/{shift['id']}/close/count",
        json={"counted_cash": {"denominations": [{"value": 50000, "count": 4}], "total": 200_000}},
        headers=idem(),
    )
    assert count.status_code == 400, count.text
    assert count.json()["error"]["code"] == "CARD_TOTAL_REQUIRED"
