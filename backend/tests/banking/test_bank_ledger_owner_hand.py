"""Libro del banco (`GET /admin/bank/ledger`) y mano del dueño
(`GET /admin/bank/owner-hand`).

`retirado − consignado − gastado = saldo` se prueba acá literal (checklist
de la fase, `features/fase-3-dinero-control/spec.md § 4`).
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from tests.banking.conftest import idem, today_business_date

API = "/api/v1"


def test_bank_ledger_lists_deposit_and_card_settlement_and_transfer(
    admin_client: TestClient,
    make_payment: Callable[..., dict],
    open_shift: Callable[..., dict],
    store: Any,
) -> None:
    bd = today_business_date(store)
    shift = open_shift(total=200_000)
    make_payment(shift=shift, method="transfer", amount=40_000)

    deposit = admin_client.post(
        f"{API}/admin/deposits",
        params={"store_id": store.id},
        json={"amount": 20_000, "receipt_photo": "c.jpg", "business_date": bd.isoformat()},
        headers=idem(),
    )
    assert deposit.status_code == 201, deposit.text

    settlement = admin_client.post(
        f"{API}/admin/reconciliation/card",
        params={"store_id": store.id},
        json={
            "sales_business_date": bd.isoformat(),
            "settled_business_date": bd.isoformat(),
            "gross_amount": 100_000,
            "commission_amount": 3_000,
            "retention_amount": 1_000,
        },
        headers=idem(),
    )
    assert settlement.status_code == 201, settlement.text

    resp = admin_client.get(
        f"{API}/admin/bank/ledger", params={"store_id": store.id, "from": bd.isoformat(), "to": bd.isoformat()}
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    kinds = {e["kind"] for e in body["entries"]}
    assert kinds == {"deposit", "card_settlement", "transfer"}

    deposit_entry = next(e for e in body["entries"] if e["kind"] == "deposit")
    assert deposit_entry["amount"] == 20_000

    card_entry = next(e for e in body["entries"] if e["kind"] == "card_settlement")
    assert card_entry["gross_amount"] == 100_000
    assert card_entry["commission_amount"] == 3_000
    assert card_entry["retention_amount"] == 1_000
    assert card_entry["amount"] == 96_000  # neto: 100.000 - 3.000 - 1.000
    assert card_entry["lag_days"] == 0

    transfer_entry = next(e for e in body["entries"] if e["kind"] == "transfer")
    assert transfer_entry["amount"] == 40_000
    assert transfer_entry["id"] is None  # derivado de `Payment`, sin fila propia

    assert body["totals"]["deposits"] == 20_000
    assert body["totals"]["card_settlements_net"] == 96_000
    assert body["totals"]["transfers"] == 40_000
    assert body["totals"]["total"] == 20_000 + 96_000 + 40_000


def test_owner_hand_balances_withdrawn_minus_deposited_minus_spent(
    admin_client: TestClient,
    device_client: TestClient,
    identify: Callable[..., Any],
    employees: dict[str, Any],
    open_shift: Callable[..., dict],
    close_shift: Callable[..., dict],
    store: Any,
) -> None:
    """`withdrawn = pickups + to_deposit de turnos cerrados`;
    `balance = withdrawn - deposited - spent`, exacto."""

    bd = today_business_date(store)

    shift = open_shift(total=200_000)
    pickup = device_client.post(
        f"{API}/shifts/{shift['id']}/pickups",
        json={"amount": 20_000, "authorizer_pin": "9999", "photo": "retiro.jpg"},
        headers=idem(),
    )
    assert pickup.status_code == 201, pickup.text

    # `to_deposit` sale de lo CONTADO al cierre, no de restarle el retiro al
    # esperado (`app/shifts/service.py:1035`): contar $250.000 dice
    # `to_deposit = 250.000 - 200.000 - 0 = 50.000`, **independiente** del
    # retiro de $20.000 ya hecho — son dos salidas de plata distintas del
    # mismo turno, y las dos alimentan `withdrawn` acá.
    close_body = close_shift(shift["id"], counted_cash=250_000)
    assert close_body["to_deposit"] == 50_000

    deposit = admin_client.post(
        f"{API}/admin/deposits",
        params={"store_id": store.id},
        json={
            "amount": 25_000,
            "receipt_photo": "c.jpg",
            "allocations": [{"shift_id": shift["id"], "amount": 25_000}],
        },
        headers=idem(),
    )
    assert deposit.status_code == 201, deposit.text

    resp = admin_client.get(
        f"{API}/admin/bank/owner-hand", params={"store_id": store.id, "from": bd.isoformat(), "to": bd.isoformat()}
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()

    assert body["withdrawn_from_pickups"] == 20_000
    assert body["withdrawn_from_shift_close"] == 50_000
    assert body["withdrawn"] == 70_000
    assert body["deposited"] == 25_000
    assert body["spent"] == 0
    assert body["balance"] == body["withdrawn"] - body["deposited"] - body["spent"] == 45_000


def test_owner_hand_counts_refunds_settled_from_owner_as_spent(
    admin_client: TestClient,
    db: Session,
    make_payment: Callable[..., dict],
    open_shift: Callable[..., dict],
    store: Any,
) -> None:
    """`PendingRefund(settled_from=owner)` es plata que sale de la mano SIN
    movimiento de caja (`app.refunds.service.settle_pending_refund`,
    SPEC-NEGOCIO §6.3): tiene que reducir el saldo de la mano del dueño.

    El `document_id` que exige `PendingRefund` (FK real a
    `fiscal_documents`) sale de una venta real por HTTP (`make_payment`,
    que emite el documento) — así no hay que fabricar a mano un documento
    fiscal completo (`order_id`/`shift_id`/`lines`/`store_snapshot`... son
    territorio de otro dominio). Sólo la fila `PendingRefund` en sí se arma
    por ORM directo (declarado): es un libro de `app.refunds`, y lo que
    prueba este test es la LECTURA que hace `owner_hand`, no el flujo de
    devolución."""

    from datetime import datetime, timezone

    from app.refunds.models import PendingRefund, PendingRefundStatus, SettleFrom

    bd = today_business_date(store)
    now = datetime.now(timezone.utc)

    shift = open_shift(total=200_000)
    sale = make_payment(shift=shift, method="cash", amount=50_000)
    document_id = sale["document"]["id"]
    assert document_id is not None

    refund = PendingRefund(
        organization_id=store.organization_id,
        store_id=store.id,
        document_id=document_id,
        customer_id=None,
        customer_name="Consumidor final",
        customer_doc_number="222222222222",
        amount=12_000,
        method="cash",
        authorized_by_employee_id=1,
        authorized_by_employee_name="Admin",
        requested_at=now,
        status=PendingRefundStatus.SETTLED,
        settled_at=now,
        settled_from=SettleFrom.OWNER,
        settled_by_employee_id=1,
        settled_by_employee_name="Admin",
    )
    db.add(refund)
    db.commit()

    resp = admin_client.get(
        f"{API}/admin/bank/owner-hand", params={"store_id": store.id, "from": bd.isoformat(), "to": bd.isoformat()}
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["spent_on_refunds"] == 12_000
    assert body["spent"] == 12_000
    assert body["balance"] == 0 - 0 - 12_000


def test_owner_hand_does_not_count_cash_that_nobody_counted(
    admin_client: TestClient,
    device_client: TestClient,
    identify: Callable[..., Any],
    employees: dict[str, Any],
    open_shift: Callable[..., dict],
    close_shift: Callable[..., dict],
    clock: Any,
    store: Any,
) -> None:
    """**A-2 del cierre de la fase 3.**

    Un turno cerrado ADMINISTRATIVAMENTE no tuvo arqueo: su `to_deposit` sale
    del libro, no de que alguien abriera el cajón y contara. Sumarlo a la
    mano del dueño publicaba como «plata retirada» una cifra que nadie contó,
    y con el sesgo que este proyecto **no** tolera: mostrando MÁS plata de la
    que se contó.

    Que era mentira ya lo sabía el propio dominio y por partida doble:
    `GET /admin/deposits/pending` publica `to_deposit: null` con motivo para
    esos mismos turnos, y `create_deposit` **rechaza** imputarles una
    consignación (`400 SHIFT_CLOSED_WITHOUT_COUNT`). Eran dos respuestas
    distintas a la misma pregunta.

    Este test fija las dos mitades del remedio: la cifra se excluye, **y la
    exclusión no es silenciosa** — `uncounted_shifts` la deja a la vista.

    La precondición se arma acá, explícita: el cierre administrativo exige un
    turno abandonado (`SHIFT_NOT_STALE` si no), así que el reloj se adelanta
    con `app/core/clock.py`. La fecha de negocio se toma ANTES de adelantarlo
    — nunca se deriva «hoy» de un timestamp corrido (error repetido nº1).
    """
    bd = today_business_date(store)

    # Turno 1: cerrado con conteo de verdad. SÍ entra.
    contado = open_shift(total=200_000)
    close_shift(contado["id"], counted_cash=260_000)

    # Turno 2: abierto el mismo día operativo y abandonado. NO entra.
    sin_contar = open_shift(total=200_000)
    clock.advance(days=1)
    rescate = admin_client.post(
        f"{API}/admin/shifts/{sin_contar['id']}/close-administrative",
        json={"reason": "El cajero se fue sin cerrar"},
        headers=idem(),
    )
    assert rescate.status_code in (200, 201), rescate.text

    resp = admin_client.get(
        f"{API}/admin/bank/owner-hand",
        params={"store_id": store.id, "from": bd.isoformat(), "to": bd.isoformat()},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()

    # Sólo el turno contado aporta: 260.000 - 200.000 = 60.000.
    assert body["withdrawn_from_shift_close"] == 60_000, (
        "la mano del dueño está contando plata de un turno que nadie contó: "
        f"{body['withdrawn_from_shift_close']}"
    )
    assert body["withdrawn"] == body["withdrawn_from_pickups"] + body["withdrawn_from_shift_close"]

    # Y lo excluido se dice, no se calla.
    assert body["uncounted_shifts"] == 1, (
        "la exclusión quedó silenciosa: quien lee la mano del dueño no tiene "
        "forma de saber que hubo un turno sin arqueo en el período"
    )

    # La misma pregunta, desde la otra ruta, sigue dando la misma respuesta.
    pendientes = admin_client.get(
        f"{API}/admin/deposits/pending",
        params={"store_id": store.id, "from": bd.isoformat(), "to": bd.isoformat()},
    )
    assert pendientes.status_code == 200, pendientes.text
    sin_dato = [r for r in pendientes.json() if r["shift_id"] == sin_contar["id"]]
    assert sin_dato and sin_dato[0]["to_deposit"] is None, (
        "`deposits/pending` y `owner-hand` volvieron a decir cosas distintas "
        "sobre el mismo turno"
    )


def test_owner_hand_does_not_subtract_a_tip_payout_that_came_out_of_the_drawer(
    admin_client: TestClient,
    device_client: TestClient,
    identify: Callable[..., Any],
    employees: dict[str, Any],
    open_shift: Callable[..., dict],
    close_shift: Callable[..., dict],
    store: Any,
) -> None:
    """**A-3 del cierre de la fase 3: la misma plata restada dos veces.**

    Un reparto de propinas pagado **del cajón** ya redujo el `to_deposit` de
    su turno, y `withdrawn_from_shift_close` suma justamente ese `to_deposit`.
    Volver a restarlo como «gastado de la mano» contaba la misma plata dos
    veces. El sesgo iba al lado tolerado —mostraba MENOS plata de la que
    había— y por eso no rompía ninguna identidad publicada: el invariante del
    auditor estaba verde con el defecto adentro. Seguía siendo un número
    equivocado en pantalla.

    Este test fija las dos mitades: `drawer` **no** resta, `owner_hand` sí, y
    el balance publicado es el mismo antes y después de registrar el reparto
    del cajón.
    """
    bd = today_business_date(store)

    shift = open_shift(total=200_000)
    # Contado 260.000 con 10.000 de propina en efectivo retirada al cierre:
    # `to_deposit = 260.000 - 200.000 - 10.000 = 50.000`. Esos 10.000 YA
    # salieron del cajón acá.
    close_body = close_shift(shift["id"], counted_cash=260_000, tips_cash_out=10_000)
    assert close_body["to_deposit"] == 50_000

    def mano() -> dict:
        resp = admin_client.get(
            f"{API}/admin/bank/owner-hand",
            params={"store_id": store.id, "from": bd.isoformat(), "to": bd.isoformat()},
        )
        assert resp.status_code == 200, resp.text
        return resp.json()

    antes = mano()

    # El reparto de esos mismos 10.000, declarado como pagado DEL CAJÓN.
    del_cajon = admin_client.post(
        f"{API}/admin/tips/payouts",
        params={"store_id": store.id},
        json={
            "shift_ids": [shift["id"]],
            "distribution": [{"employee_id": employees["operator"].id, "amount": 10_000}],
            "paid_at": f"{bd.isoformat()}T20:00:00Z",
            "method": "cash",
            "paid_from": "drawer",
        },
        headers=idem(),
    )
    assert del_cajon.status_code == 201, del_cajon.text
    assert del_cajon.json()["paid_from"] == "drawer"

    despues = mano()
    assert despues["spent_on_tips"] == antes["spent_on_tips"] == 0, (
        "un reparto pagado del cajón se está restando de la mano del dueño: esa plata "
        "ya salió por `to_deposit`, así que se está contando dos veces"
    )
    assert despues["balance"] == antes["balance"], (
        "registrar un reparto pagado del cajón movió el saldo de la mano del dueño"
    )

    # Y el otro lado: uno pagado DE LA MANO sí resta.
    de_la_mano = admin_client.post(
        f"{API}/admin/tips/payouts",
        params={"store_id": store.id},
        json={
            "shift_ids": [shift["id"]],
            "distribution": [{"employee_id": employees["operator2"].id, "amount": 7_000}],
            "paid_at": f"{bd.isoformat()}T21:00:00Z",
            "method": "cash",
            "paid_from": "owner_hand",
        },
        headers=idem(),
    )
    assert de_la_mano.status_code == 201, de_la_mano.text

    final = mano()
    assert final["spent_on_tips"] == 7_000
    assert final["balance"] == antes["balance"] - 7_000
    # Nada de esto vino de una fila vieja sin origen declarado.
    assert final["tip_payouts_unknown_source"] == 0


def test_owner_hand_says_how_many_tip_payouts_did_not_declare_their_source(
    admin_client: TestClient,
    device_client: TestClient,
    identify: Callable[..., Any],
    employees: dict[str, Any],
    open_shift: Callable[..., dict],
    close_shift: Callable[..., dict],
    db: Any,
    store: Any,
) -> None:
    """La otra mitad de A-3: las filas que YA existían no tienen respuesta.

    La migración `0021` las marca `unknown` en vez de inventarles un origen.
    Se tratan como salidas de la mano —el sesgo que muestra menos plata, el
    único que este proyecto tolera— **y la suposición se publica**: quien lee
    la mano del dueño tiene que poder saber que ese número descansa sobre N
    repartos que nadie declaró.
    """
    from app.shifts.models import TipPayout, TipPayoutSource

    bd = today_business_date(store)
    shift = open_shift(total=200_000)
    close_shift(shift["id"], counted_cash=260_000, tips_cash_out=10_000)

    creado = admin_client.post(
        f"{API}/admin/tips/payouts",
        params={"store_id": store.id},
        json={
            "shift_ids": [shift["id"]],
            "distribution": [{"employee_id": employees["operator"].id, "amount": 9_000}],
            "paid_at": f"{bd.isoformat()}T20:00:00Z",
            "method": "cash",
            "paid_from": "owner_hand",
        },
        headers=idem(),
    )
    assert creado.status_code == 201, creado.text

    # Se lo envejece a mano para representar una fila anterior a la columna:
    # es la ÚNICA forma de tener un `unknown`, porque la API no lo acepta.
    fila = db.get(TipPayout, creado.json()["id"])
    fila.paid_from = TipPayoutSource.UNKNOWN
    db.flush()

    resp = admin_client.get(
        f"{API}/admin/bank/owner-hand",
        params={"store_id": store.id, "from": bd.isoformat(), "to": bd.isoformat()},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()

    assert body["spent_on_tips"] == 9_000, (
        "una fila sin origen declarado tiene que restar de la mano: es el sesgo que "
        "muestra menos plata, el único tolerado"
    )
    assert body["tip_payouts_unknown_source"] == 1, (
        "la suposición quedó escondida: quien lee la mano del dueño no tiene forma de "
        "saber que ese número descansa sobre un reparto que nadie declaró"
    )
