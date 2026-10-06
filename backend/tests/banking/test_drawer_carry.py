"""La plata de días anteriores en el cajón, y consignarla desde el POS.

El dueño decidió (2026-09-24) que la venta que todavía no se consignó se queda
en el mismo cajón. Lo que estos tests cobran, todo por HTTP:

- quien abre **marca** qué días están en el cajón; el conteo de apertura se
  compara contra lo marcado (no hay base fija: la apertura es «igual al
  café»), con el saldo calculado por el servidor;
- al cerrar, lo que el turno debe consignar es **sólo su venta**: la de ayer
  no se cuenta dos veces;
- consignar desde el POS descuenta del saldo del día desde ya, sale del
  esperado del cajón y queda por confirmar; confirmar la saca de la bandeja;
  rechazar (reversar) devuelve el monto al saldo y al cajón.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.auth.models import Employee
from app.shifts import service as shifts_service
from app.shifts.models import Shift
from tests.banking.conftest import denoms, idem, today_business_date
from tests.photos.test_photos import FOTO

API = "/api/v1"


def _pending(admin_client: TestClient, store: Any, shift_id: int) -> dict[str, Any]:
    bd = today_business_date(store).isoformat()
    resp = admin_client.get(f"{API}/admin/deposits/pending", params={"store_id": store.id, "from": bd, "to": bd})
    assert resp.status_code == 200, resp.text
    return {row["shift_id"]: row for row in resp.json()}[shift_id]


def _open_with_carry(
    device_client: TestClient,
    identify: Callable[..., object],
    cashier: Employee,
    *,
    counted: int,
    carried: list[int],
    cause: str | None = None,
) -> Any:
    identify(device_client, cashier)
    payload: dict[str, Any] = {
        "opening_cash": denoms(counted),
        "cash_responsible_id": cashier.id,
        "carried_shift_ids": carried,
    }
    if cause is not None:
        payload["opening_cause"] = cause
    return device_client.post(f"{API}/shifts/open", json=payload, headers=idem())


def _yesterday_with_50k(open_shift: Callable[..., dict], close_shift: Callable[..., dict]) -> int:
    """Un turno cerrado con $50.000 por consignar (abrió vacío y contó $50.000)."""
    shift = open_shift(total=0)
    body = close_shift(shift["id"], counted_cash=50_000, closes_day=False)
    assert body["to_deposit"] == 50_000
    return shift["id"]


def _income(device_client: TestClient, shift_id: int, amount: int) -> None:
    resp = device_client.post(
        f"{API}/shifts/{shift_id}/cash-movements",
        json={"kind": "income", "cause": "other_income", "amount": amount, "note": "venta de prueba"},
        headers=idem(),
    )
    assert resp.status_code in (200, 201), resp.text


def _pos_deposit(device_client: TestClient, source: int, amount: int) -> Any:
    return device_client.post(
        f"{API}/deposits",
        json={"source_shift_id": source, "amount": amount, "bank_name": "Bancolombia", "receipt_photo": FOTO},
        headers=idem(),
    )


def test_opening_lists_the_days_with_money_to_deposit_and_one_can_be_unmarked(
    device_client: TestClient, open_shift: Any, close_shift: Any, identify: Any, employees: dict
) -> None:
    ayer = _yesterday_with_50k(open_shift, close_shift)
    resp = device_client.get(f"{API}/shifts/opening")
    assert resp.status_code == 200, resp.text
    assert [(c["shift_id"], c["outstanding"]) for c in resp.json()["envelopes"]] == [(ayer, 50_000)]

    # Desmarcado (su plata no está en el cajón): debería haber $0 y el cajón
    # abre vacío.
    opened = _open_with_carry(device_client, identify, employees["cashier"], counted=0, carried=[])
    assert opened.status_code in (200, 201), opened.text


def test_the_opening_count_is_compared_against_what_was_marked(
    device_client: TestClient, open_shift: Any, close_shift: Any, identify: Any, employees: dict
) -> None:
    ayer = _yesterday_with_50k(open_shift, close_shift)

    # Marca ayer pero cuenta $20.000: faltan $30.000 de los $50.000 de ayer.
    short = _open_with_carry(device_client, identify, employees["cashier"], counted=20_000, carried=[ayer])
    assert short.status_code == 400
    assert short.json()["error"]["code"] == "OPENING_DIFFERENCE_NEEDS_CAUSE"
    assert "$ 50.000" in short.json()["error"]["message"]

    ok = _open_with_carry(device_client, identify, employees["cashier"], counted=50_000, carried=[ayer])
    assert ok.status_code in (200, 201), ok.text


def test_yesterdays_money_is_not_counted_twice_at_close(
    device_client: TestClient,
    admin_client: TestClient,
    open_shift: Any,
    close_shift: Any,
    identify: Any,
    employees: dict,
    store: Any,
) -> None:
    ayer = _yesterday_with_50k(open_shift, close_shift)
    hoy = _open_with_carry(device_client, identify, employees["cashier"], counted=50_000, carried=[ayer]).json()
    _income(device_client, hoy["id"], 30_000)

    body = close_shift(hoy["id"], counted_cash=80_000, closes_day=False)
    # 80.000 contados − 50.000 que son de ayer = 30.000 de hoy.
    assert body["to_deposit"] == 30_000
    assert _pending(admin_client, store, ayer)["outstanding"] == 50_000
    assert _pending(admin_client, store, hoy["id"])["outstanding"] == 30_000


def test_a_pos_deposit_leaves_the_drawer_discounts_the_day_and_waits_for_confirmation(
    device_client: TestClient,
    admin_client: TestClient,
    open_shift: Any,
    close_shift: Any,
    identify: Any,
    employees: dict,
    store: Any,
    db: Session,
) -> None:
    ayer = _yesterday_with_50k(open_shift, close_shift)
    hoy = _open_with_carry(device_client, identify, employees["cashier"], counted=50_000, carried=[ayer]).json()

    drawer = device_client.get(f"{API}/deposits/drawer").json()
    assert [(d["source_shift_id"], d["remaining"]) for d in drawer["days"]] == [(ayer, 50_000)]

    dep = _pos_deposit(device_client, ayer, 50_000)
    assert dep.status_code == 201, dep.text
    body = dep.json()
    assert body["source"] == "pos"
    assert body["from_shift_id"] == hoy["id"]
    assert body["needs_confirmation"] is True
    assert body["receipt_photo"].startswith("/api/v1/photos/")

    # Descuenta del saldo de ayer desde ya: nadie lo consigna dos veces.
    assert _pending(admin_client, store, ayer)["outstanding"] == 0
    # Y salió del cajón: el esperado baja lo consignado.
    shift = db.get(Shift, hoy["id"])
    assert shift is not None
    breakdown = shifts_service.compute_breakdown(db, shift)
    assert breakdown["deposits"] == 50_000
    assert breakdown["expected"] == 0

    today = admin_client.get(f"{API}/admin/today", params={"store_id": store.id}).json()
    assert today["deposits_to_confirm_count"] == 1

    confirmed = admin_client.post(f"{API}/admin/deposits/{body['id']}/confirm")
    assert confirmed.status_code == 200, confirmed.text
    assert confirmed.json()["needs_confirmation"] is False
    assert confirmed.json()["confirmed_by_employee_name"]
    today = admin_client.get(f"{API}/admin/today", params={"store_id": store.id}).json()
    assert today["deposits_to_confirm_count"] == 0

    # Al cerrar, el cajón ya no tiene lo de ayer: todo lo contado es de hoy.
    closed = close_shift(hoy["id"], counted_cash=0, closes_day=False)
    assert closed["to_deposit"] == 0


def test_the_blind_close_review_shows_the_deposit_as_a_line_of_the_equation(
    device_client: TestClient,
    open_shift: Any,
    close_shift: Any,
    identify: Any,
    employees: dict,
    set_feature: Any,
    store: Any,
) -> None:
    """El paso 2 del cierre a ciegas muestra la ecuación del esperado: si hubo
    una consignación desde el cajón, es un renglón de ella; si no, los
    renglones que se ven no llegan al total."""
    ayer = _yesterday_with_50k(open_shift, close_shift)
    hoy = _open_with_carry(device_client, identify, employees["cashier"], counted=50_000, carried=[ayer]).json()
    assert _pos_deposit(device_client, ayer, 50_000).status_code == 201

    count = device_client.post(
        f"{API}/shifts/{hoy['id']}/close/count",
        json={"counted_cash": denoms(0), "tips_cash_out": 0, "photo": "c.jpg"},
        headers=idem(),
    )
    assert count.status_code in (200, 201), count.text
    review = device_client.get(f"{API}/shifts/{hoy['id']}/close/{count.json()['count_id']}/review")
    assert review.status_code == 200, review.text
    eq = review.json()["equation"]
    assert eq["deposits"] == 50_000
    assert eq["base"] + eq["cash_sales"] + eq["incomes"] - eq["expenses"] - eq["pickups"] - eq["deposits"] == eq["expected"]


def test_rejecting_a_pos_deposit_puts_the_money_back_in_the_day_and_the_drawer(
    device_client: TestClient,
    admin_client: TestClient,
    open_shift: Any,
    close_shift: Any,
    identify: Any,
    employees: dict,
    store: Any,
    db: Session,
) -> None:
    ayer = _yesterday_with_50k(open_shift, close_shift)
    hoy = _open_with_carry(device_client, identify, employees["cashier"], counted=50_000, carried=[ayer]).json()
    dep = _pos_deposit(device_client, ayer, 20_000).json()

    rejected = admin_client.post(
        f"{API}/admin/deposits/{dep['id']}/reverse", json={"reason": "el comprobante no es de esta cuenta"}, headers=idem()
    )
    assert rejected.status_code == 200, rejected.text
    assert _pending(admin_client, store, ayer)["outstanding"] == 50_000
    shift = db.get(Shift, hoy["id"])
    assert shift is not None
    assert shifts_service.compute_breakdown(db, shift)["expected"] == 50_000
    # Rechazada no se puede confirmar.
    assert admin_client.post(f"{API}/admin/deposits/{dep['id']}/confirm").status_code == 400


def test_the_pos_only_deposits_what_is_in_the_drawer(
    device_client: TestClient,
    admin_client: TestClient,
    open_shift: Any,
    close_shift: Any,
    identify: Any,
    employees: dict,
    store: Any,
) -> None:
    ayer = _yesterday_with_50k(open_shift, close_shift)
    _open_with_carry(device_client, identify, employees["cashier"], counted=50_000, carried=[ayer])

    over = _pos_deposit(device_client, ayer, 60_000)
    assert over.status_code == 400
    assert over.json()["error"]["code"] == "DEPOSIT_EXCEEDS_DRAWER"

    assert _pos_deposit(device_client, ayer + 999, 10_000).json()["error"]["code"] == "DEPOSIT_NOT_IN_DRAWER"

    # Sin foto no se registra.
    no_photo = device_client.post(
        f"{API}/deposits", json={"source_shift_id": ayer, "amount": 10_000, "receipt_photo": ""}, headers=idem()
    )
    assert no_photo.status_code == 400

    # El administrador no imputa un día que está en el cajón del turno abierto.
    admin = admin_client.post(
        f"{API}/admin/deposits",
        params={"store_id": store.id},
        json={"amount": 10_000, "receipt_photo": "c.jpg", "allocations": [{"shift_id": ayer, "amount": 10_000}]},
        headers=idem(),
    )
    assert admin.status_code == 400
    assert admin.json()["error"]["code"] == "DAY_IN_DRAWER"


def test_only_days_with_money_to_deposit_can_be_marked(
    device_client: TestClient, open_shift: Any, close_shift: Any, identify: Any, employees: dict
) -> None:
    ayer = _yesterday_with_50k(open_shift, close_shift)
    cashier = employees["cashier"]

    repeated = _open_with_carry(device_client, identify, cashier, counted=100_000, carried=[ayer, ayer])
    assert repeated.json()["error"]["code"] == "CARRIED_SHIFT_REPEATED"

    unknown = _open_with_carry(device_client, identify, cashier, counted=50_000, carried=[ayer + 999])
    assert unknown.json()["error"]["code"] == "CARRIED_SHIFT_NOT_PENDING"


# ---------------------------------------------------------------------------
# Auditoría de tablet: el banco que se recuerda.
# ---------------------------------------------------------------------------


def test_the_drawer_remembers_the_banks_the_store_used(
    device_client: TestClient,
    open_shift: Any,
    close_shift: Any,
    identify: Any,
    employees: dict,
) -> None:
    ayer = _yesterday_with_50k(open_shift, close_shift)
    assert device_client.get(f"{API}/deposits/drawer").json()["recent_banks"] == []
    _open_with_carry(device_client, identify, employees["cashier"], counted=50_000, carried=[ayer])
    first = _pos_deposit(device_client, ayer, 20_000)
    assert first.status_code == 201, first.text
    other = device_client.post(
        f"{API}/deposits",
        json={"source_shift_id": ayer, "amount": 10_000, "bank_name": "Davivienda", "receipt_photo": FOTO},
        headers=idem(),
    )
    assert other.status_code == 201, other.text
    again = _pos_deposit(device_client, ayer, 5_000)
    assert again.status_code == 201, again.text
    # El último usado primero, sin repetir.
    assert device_client.get(f"{API}/deposits/drawer").json()["recent_banks"] == ["Bancolombia", "Davivienda"]


def test_reversing_a_confirmation_leaves_the_deposit_alive_and_the_trace_in_the_audit(
    device_client: TestClient,
    admin_client: TestClient,
    open_shift: Any,
    close_shift: Any,
    identify: Any,
    employees: dict,
    store: Any,
    db: Session,
) -> None:
    """«Reversar con motivo» en «Requiere tu atención»: la confirmación se
    reversa (vuelve a estar por confirmar) sin tocar la consignación, y quién
    la había confirmado queda en el historial."""
    from sqlalchemy import select

    from app.audit.models import AuditLog

    ayer = _yesterday_with_50k(open_shift, close_shift)
    _open_with_carry(device_client, identify, employees["cashier"], counted=50_000, carried=[ayer])
    dep = _pos_deposit(device_client, ayer, 50_000).json()

    # Sin confirmar no hay qué reversar; sin motivo tampoco se acepta.
    early = admin_client.post(f"{API}/admin/deposits/{dep['id']}/unconfirm", json={"reason": "error"}, headers=idem())
    assert early.status_code == 400 and early.json()["error"]["code"] == "DEPOSIT_NOT_CONFIRMED"
    assert admin_client.post(f"{API}/admin/deposits/{dep['id']}/confirm").status_code == 200
    blank = admin_client.post(f"{API}/admin/deposits/{dep['id']}/unconfirm", json={"reason": "  "}, headers=idem())
    assert blank.status_code in (400, 422)

    back = admin_client.post(
        f"{API}/admin/deposits/{dep['id']}/unconfirm", json={"reason": "Confirmé la equivocada"}, headers=idem()
    )
    assert back.status_code == 200, back.text
    assert back.json()["needs_confirmation"] is True
    assert back.json()["status"] == "live"
    assert _pending(admin_client, store, ayer)["outstanding"] == 0  # la plata sigue consignada
    today = admin_client.get(f"{API}/admin/today", params={"store_id": store.id}).json()
    assert today["deposits_to_confirm_count"] == 1

    trail = (
        db.execute(
            select(AuditLog)
            .where(AuditLog.entity == "bank_deposit", AuditLog.entity_id == dep["id"])
            .order_by(AuditLog.id)
        )
        .scalars()
        .all()
    )
    assert [a.action for a in trail][-2:] == ["confirm", "unconfirm"]
    assert trail[-1].reason == "Confirmé la equivocada"
    assert trail[-1].before["confirmed_by_employee_name"]  # type: ignore[index]
