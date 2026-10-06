"""La cascada «como el café» (decisión del dueño, 2026-09-29).

Cuando un turno paga del cajón —a proveedores, gastos— más plata de la que
entró, su consignable queda negativo: esa plata salió de la venta de un turno
anterior que seguía en el cajón. El hueco se cobra del **anterior más
reciente** con saldo y, sólo si no alcanza, de los más viejos; cada peso queda
dicho (cubrió / cubierto por) y lo que no encuentra de dónde cobrarse queda
como **faltante sin cubrir**, visible. Es UNA cuenta
(`app.banking.hooks.store_balances`) y la leen todos: la lista de pendientes
del banco, los días que se ofrecen al abrir, el techo de una consignación y
Hoy.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.auth.deps import Actor
from app.banking import hooks as banking_hooks
from app.shifts import hooks as shifts_hooks
from app.shifts.models import Shift
from tests.banking.conftest import denoms, idem, today_business_date

API = "/api/v1"
BASE = 200_000


def _day_with(open_shift: Callable[..., dict], close_shift: Callable[..., dict], amount: int) -> int:
    """Un turno cerrado con `amount` por consignar: abrió vacío y contó `amount`."""
    shift = open_shift(total=0)
    body = close_shift(shift["id"], counted_cash=amount, closes_day=False)
    assert body["to_deposit"] == amount
    return int(shift["id"])


def _pay_supplier(db: Session, employees: dict, paid: int) -> None:
    cashier = employees["cashier"]
    shifts_hooks.register_supplier_payment_expense(
        db,
        organization_id=cashier.organization_id,
        store_id=cashier.store_id,
        amount=paid,
        actor=Actor(
            kind="device",
            organization_id=cashier.organization_id,
            store_id=cashier.store_id,
            employee_id=cashier.id,
            employee_name=cashier.name,
            role=cashier.role,
        ),
        note="Pago de contado al proveedor",
    )
    db.commit()


def _day_paying_supplier(
    db: Session,
    device_client: TestClient,
    identify: Any,
    close_shift: Callable[..., dict],
    employees: dict,
    paid: int,
) -> int:
    """Un turno sin ventas que abre «igual al café» con los días por
    consignar que están en el cajón y le paga `paid` a un proveedor con esa
    plata: cierra con `to_deposit = −paid` (lo contado menos lo de días
    anteriores que sigue en el cajón)."""
    cashier = employees["cashier"]
    identify(device_client, cashier)
    preview = device_client.post(f"{API}/shifts/opening/preview", json={}).json()
    carried = [d["shift_id"] for d in preview["days"] if d["selected"]]
    opened = device_client.post(
        f"{API}/shifts/open",
        json={"cash_responsible_id": cashier.id, "carried_shift_ids": carried, "opening_cash": denoms(preview["expected"])},
        headers=idem(),
    )
    assert opened.status_code == 201, opened.text
    _pay_supplier(db, employees, paid)
    body = close_shift(opened.json()["id"], counted_cash=preview["expected"] - paid, closes_day=False, cause=None)
    assert body["to_deposit"] == -paid
    return int(opened.json()["id"])


def _old_fixed_base_day_paying_supplier(
    db: Session, open_shift: Callable[..., dict], close_shift: Callable[..., dict], employees: dict, paid: int
) -> int:
    """Un turno de ANTES (base fija, que se queda en el cajón) que le pagó a
    un proveedor más de lo que había por consignar: `to_deposit = −paid`.
    Con la apertura «igual al café» el cajón sólo puede pagar con plata que
    está en él; un turno viejo así sigue existiendo y la cascada lo lee."""
    shift = open_shift(total=BASE)
    row = db.get(Shift, shift["id"])
    assert row is not None
    row.opening_mode, row.opening_fixed_base, row.opening_expected = "fixed_base", BASE, None
    db.commit()
    _pay_supplier(db, employees, paid)
    body = close_shift(shift["id"], counted_cash=BASE - paid, closes_day=False, cause=None)
    assert body["to_deposit"] == -paid
    return int(shift["id"])


def _pending(admin_client: TestClient, store: Any) -> dict[int, dict[str, Any]]:
    bd = today_business_date(store).isoformat()
    resp = admin_client.get(f"{API}/admin/deposits/pending", params={"store_id": store.id, "from": bd, "to": bd})
    assert resp.status_code == 200, resp.text
    return {row["shift_id"]: row for row in resp.json()}


def test_the_gap_is_covered_by_the_most_recent_previous_shift_first_with_provenance(
    db: Session,
    admin_client: TestClient,
    device_client: TestClient,
    identify: Any,
    open_shift: Any,
    close_shift: Any,
    employees: dict,
    store: Any,
) -> None:
    sabado = _day_with(open_shift, close_shift, 100_000)
    domingo = _day_with(open_shift, close_shift, 50_000)
    lunes = _day_paying_supplier(db, device_client, identify, close_shift, employees, 80_000)

    rows = _pending(admin_client, store)
    # El lunes queda en cero; el domingo (el anterior MÁS RECIENTE) pone sus
    # 50.000 y el sábado los 30.000 que faltan.
    assert rows[lunes]["outstanding"] == 0
    assert rows[domingo]["outstanding"] == 0
    assert rows[sabado]["outstanding"] == 70_000
    assert [(c["shift_id"], c["amount"]) for c in rows[lunes]["covered_by"]] == [(domingo, 50_000), (sabado, 30_000)]
    assert [(c["shift_id"], c["amount"]) for c in rows[domingo]["covered"]] == [(lunes, 50_000)]
    assert [(c["shift_id"], c["amount"]) for c in rows[sabado]["covered"]] == [(lunes, 30_000)]
    assert rows[lunes]["uncovered_shortfall"] == 0
    # El snapshot de cierre no se toca: se lee, nunca se recalcula.
    assert rows[lunes]["to_deposit"] == -80_000

    # Los días que se ofrecen al abrir son los mismos, con el mismo saldo.
    candidates = device_client.get(f"{API}/shifts/opening").json()["envelopes"]
    assert [(c["shift_id"], c["outstanding"]) for c in candidates] == [(sabado, 70_000)]
    assert [(p.shift_id, p.outstanding) for p in banking_hooks.pending_shifts(
        db, organization_id=store.organization_id, store_id=store.id
    )] == [(sabado, 70_000)]


def test_what_cannot_be_covered_stays_visible_as_uncovered_shortfall(
    db: Session, admin_client: TestClient, open_shift: Any, close_shift: Any, employees: dict, store: Any
) -> None:
    ayer = _day_with(open_shift, close_shift, 20_000)
    hoy = _old_fixed_base_day_paying_supplier(db, open_shift, close_shift, employees, 50_000)

    rows = _pending(admin_client, store)
    assert rows[ayer]["outstanding"] == 0
    assert rows[hoy]["outstanding"] == 0
    assert [(c["shift_id"], c["amount"]) for c in rows[hoy]["covered_by"]] == [(ayer, 20_000)]
    assert rows[hoy]["uncovered_shortfall"] == 30_000


def test_a_deposit_cannot_take_what_the_cascade_already_used(
    db: Session,
    admin_client: TestClient,
    device_client: TestClient,
    identify: Any,
    open_shift: Any,
    close_shift: Any,
    employees: dict,
    store: Any,
) -> None:
    ayer = _day_with(open_shift, close_shift, 100_000)
    _day_paying_supplier(db, device_client, identify, close_shift, employees, 40_000)

    demasiado = admin_client.post(
        f"{API}/admin/deposits",
        params={"store_id": store.id},
        json={"amount": 100_000, "receipt_photo": "c.jpg", "allocations": [{"shift_id": ayer, "amount": 100_000}]},
        headers=idem(),
    )
    assert demasiado.status_code == 400
    assert demasiado.json()["error"]["code"] == "DEPOSIT_EXCEEDS_PENDING"

    justo = admin_client.post(
        f"{API}/admin/deposits",
        params={"store_id": store.id},
        json={"amount": 60_000, "receipt_photo": "c.jpg", "allocations": [{"shift_id": ayer, "amount": 60_000}]},
        headers=idem(),
    )
    assert justo.status_code == 201, justo.text
    assert _pending(admin_client, store)[ayer]["outstanding"] == 0
