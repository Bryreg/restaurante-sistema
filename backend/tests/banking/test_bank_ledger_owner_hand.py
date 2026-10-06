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
    shift = open_shift(total=0)
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
    """c9: `withdrawn = retiros + sobres entregados`, y la plata del cierre
    que sigue en el cajón (apertura «igual al café», nadie abrió después) NO
    está en la mano: se publica en `still_in_drawer`.
    `balance = withdrawn - deposited - spent`, exacto."""

    bd = today_business_date(store)

    shift = open_shift(total=0)
    pickup = device_client.post(
        f"{API}/shifts/{shift['id']}/pickups",
        json={"amount": 20_000, "authorizer_pin": "9999", "photo": "retiro.jpg"},
        headers=idem(),
    )
    assert pickup.status_code == 201, pickup.text

    # `to_deposit` sale de lo CONTADO al cierre, no de restarle el retiro al
    # esperado (`app/shifts/service.py::_finalize_close`): con el cajón
    # abierto vacío, contar $50.000 dice `to_deposit = 50.000 - 0 = 50.000`,
    # **independiente** del
    # retiro de $20.000 ya hecho — son dos salidas de plata distintas del
    # mismo turno, y las dos alimentan `withdrawn` acá.
    close_body = close_shift(shift["id"], counted_cash=50_000)
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
    # Lo consignado por el administrador pasó por su mano camino al banco;
    # los otros 25.000 siguen en el cajón esperando al que abra.
    assert body["withdrawn_from_envelopes"] == 25_000
    assert body["still_in_drawer"] == 25_000
    assert body["withdrawn"] == 45_000
    assert body["deposited"] == 25_000
    assert body["spent"] == 0
    assert body["balance"] == body["withdrawn"] - body["deposited"] - body["spent"] == 20_000


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

    shift = open_shift(total=0)
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
    contado = open_shift(total=0)
    close_shift(contado["id"], counted_cash=60_000)

    # Turno 2: abierto el mismo día operativo y abandonado. NO entra.
    sin_contar = open_shift(total=0)
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

    # Sólo el turno contado aporta: los 60.000 que contó (abrió vacío).
    # El turno 2 abrió sin marcar los 60.000 del turno 1: salieron en sobre.
    assert body["withdrawn_from_envelopes"] == 60_000, (
        "la mano del dueño está contando plata de un turno que nadie contó: "
        f"{body['withdrawn_from_envelopes']}"
    )
    assert body["withdrawn"] == body["withdrawn_from_pickups"] + body["withdrawn_from_envelopes"]

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
    make_payment: Callable[..., dict],
    store: Any,
) -> None:
    """**A-3 del cierre de la fase 3: la misma plata restada dos veces.**

    Un reparto de propinas pagado **del cajón** ya redujo el `to_deposit` de
    su turno, y `withdrawn_from_envelopes` sale justamente de ese `to_deposit`.
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

    shift = open_shift(total=0)
    # c3: un reparto no puede entregar más propina de la que se recogió; la
    # propina sale de un cobro con datáfono, para no tocar el efectivo.
    card = make_payment(shift=shift, method="card", amount=10_000, tip=20_000)
    # Contado 60.000 con 10.000 de propina en efectivo retirada al cierre:
    # `to_deposit = 60.000 - 10.000 = 50.000`. Esos 10.000 YA
    # salieron del cajón acá.
    close_body = close_shift(
        shift["id"], counted_cash=60_000, tips_cash_out=10_000, counted_card=card["_amount"] + 20_000
    )
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

    # c3: un reparto reversado no salió de ninguna mano.
    reversa = admin_client.post(
        f"{API}/admin/tips/payouts/{de_la_mano.json()['id']}/reverse",
        params={"store_id": store.id},
        json={"reason": "Se registró dos veces"},
        headers=idem(),
    )
    assert reversa.status_code == 200, reversa.text
    assert mano()["spent_on_tips"] == 0


def test_owner_hand_says_how_many_tip_payouts_did_not_declare_their_source(
    admin_client: TestClient,
    device_client: TestClient,
    identify: Callable[..., Any],
    employees: dict[str, Any],
    open_shift: Callable[..., dict],
    close_shift: Callable[..., dict],
    db: Any,
    make_payment: Callable[..., dict],
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
    shift = open_shift(total=0)
    card = make_payment(shift=shift, method="card", amount=10_000, tip=9_000)
    close_shift(shift["id"], counted_cash=60_000, tips_cash_out=10_000, counted_card=card["_amount"] + 9_000)

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


def test_owner_hand_says_how_many_days_the_oldest_undeposited_cash_has_been_waiting(
    admin_client: TestClient,
    open_shift: Callable[..., dict],
    close_shift: Callable[..., dict],
    store: Any,
    db: Session,
) -> None:
    """Informe de visualización #15: la plata más vieja sin consignar es el
    cierre contado más antiguo con saldo por consignar, contado a HOY y sin
    acotarse al `from` del período (la plata de antes del período que sigue
    en la mano es justamente la más vieja). Consignada toda: `null`."""
    from datetime import timedelta

    from app.shifts.models import BusinessDay, Shift

    bd = today_business_date(store)
    shift = open_shift(total=0)
    assert close_shift(shift["id"], counted_cash=50_000)["to_deposit"] == 50_000

    # El cierre queda en un día de negocio de hace 4 días.
    row = db.get(Shift, shift["id"])
    assert row is not None
    day = db.get(BusinessDay, row.business_day_id)
    assert day is not None
    day.business_date = bd - timedelta(days=4)
    db.commit()

    params = {"store_id": store.id, "from": bd.isoformat(), "to": bd.isoformat()}
    body = admin_client.get(f"{API}/admin/bank/owner-hand", params=params).json()
    assert body["oldest_undeposited_date"] == (bd - timedelta(days=4)).isoformat()
    assert body["oldest_undeposited_days"] == 4

    # Consignación parcial: sigue esperando la misma plata.
    admin_client.post(
        f"{API}/admin/deposits",
        params={"store_id": store.id},
        json={"amount": 30_000, "receipt_photo": "c.jpg", "allocations": [{"shift_id": shift["id"], "amount": 30_000}]},
        headers=idem(),
    )
    assert admin_client.get(f"{API}/admin/bank/owner-hand", params=params).json()["oldest_undeposited_days"] == 4

    admin_client.post(
        f"{API}/admin/deposits",
        params={"store_id": store.id},
        json={"amount": 20_000, "receipt_photo": "c.jpg", "allocations": [{"shift_id": shift["id"], "amount": 20_000}]},
        headers=idem(),
    )
    body = admin_client.get(f"{API}/admin/bank/owner-hand", params=params).json()
    assert body["oldest_undeposited_days"] is None
    assert body["oldest_undeposited_date"] is None


# ---------------------------------------------------------------------------
# c9 — sólo cuenta la plata que de verdad salió del cajón hacia el dueño.
# ---------------------------------------------------------------------------


def _owner_hand_today(admin_client: TestClient, store: Any) -> dict:
    bd = today_business_date(store).isoformat()
    resp = admin_client.get(f"{API}/admin/bank/owner-hand", params={"store_id": store.id, "from": bd, "to": bd})
    assert resp.status_code == 200, resp.text
    body: dict = resp.json()
    assert body["balance"] == body["withdrawn"] - body["deposited"] - body["spent"]
    assert body["withdrawn"] == body["withdrawn_from_pickups"] + body["withdrawn_from_envelopes"]
    return body


def _open_next(
    device_client: TestClient, identify: Callable[..., Any], cashier: Any, *, counted: int, carried: list[int]
) -> dict:
    """Abre el turno siguiente «igual al café», marcando qué días están en el
    cajón y contando exactamente lo que debería haber."""
    from tests.banking.conftest import denoms

    identify(device_client, cashier)
    payload: dict[str, Any] = {"cash_responsible_id": cashier.id, "carried_shift_ids": carried}
    if counted:
        payload["opening_cash"] = denoms(counted)
    resp = device_client.post(f"{API}/shifts/open", json=payload, headers=idem())
    assert resp.status_code in (200, 201), resp.text
    return resp.json()


def test_owner_hand_does_not_count_the_money_that_stays_in_the_drawer(
    admin_client: TestClient,
    device_client: TestClient,
    identify: Callable[..., Any],
    employees: dict[str, Any],
    open_shift: Callable[..., dict],
    close_shift: Callable[..., dict],
    store: Any,
) -> None:
    """Con la apertura «igual al café» la venta por consignar se queda en el
    cajón: quien abre la marca y la cuenta. Esa plata NO está en la mano del
    dueño — antes la pantalla la sumaba igual."""
    ayer = open_shift(total=0)
    assert close_shift(ayer["id"], counted_cash=50_000)["to_deposit"] == 50_000

    # Nadie abrió todavía: la plata espera en el cajón.
    body = _owner_hand_today(admin_client, store)
    assert (body["withdrawn_from_envelopes"], body["still_in_drawer"], body["balance"]) == (0, 50_000, 0)

    # El siguiente la marca y la cuenta: sigue en el cajón.
    _open_next(device_client, identify, employees["cashier"], counted=50_000, carried=[ayer["id"]])
    body = _owner_hand_today(admin_client, store)
    assert (body["withdrawn_from_envelopes"], body["still_in_drawer"], body["balance"]) == (0, 50_000, 0)


def test_owner_hand_counts_the_envelope_that_left_the_drawer(
    admin_client: TestClient,
    device_client: TestClient,
    identify: Callable[..., Any],
    employees: dict[str, Any],
    open_shift: Callable[..., dict],
    close_shift: Callable[..., dict],
    store: Any,
) -> None:
    """Quien abre desmarca el día: no estaba en el cajón, salió en sobre
    hacia el dueño. Ahí sí entra a la mano, y consignarlo la baja."""
    ayer = open_shift(total=0)
    close_shift(ayer["id"], counted_cash=50_000)
    _open_next(device_client, identify, employees["cashier"], counted=0, carried=[])

    body = _owner_hand_today(admin_client, store)
    assert (body["withdrawn_from_envelopes"], body["still_in_drawer"], body["balance"]) == (50_000, 0, 50_000)

    deposit = admin_client.post(
        f"{API}/admin/deposits",
        params={"store_id": store.id},
        json={"amount": 30_000, "receipt_photo": "c.jpg", "allocations": [{"shift_id": ayer["id"], "amount": 30_000}]},
        headers=idem(),
    )
    assert deposit.status_code == 201, deposit.text
    body = _owner_hand_today(admin_client, store)
    # El sobre sigue siendo de 50.000; consignó 30.000 y le quedan 20.000.
    assert (body["withdrawn_from_envelopes"], body["deposited"], body["balance"]) == (50_000, 30_000, 20_000)


def test_expenses_paid_from_the_owner_hand_reduce_it(
    admin_client: TestClient,
    device_client: TestClient,
    identify: Callable[..., Any],
    employees: dict[str, Any],
    open_shift: Callable[..., dict],
    close_shift: Callable[..., dict],
    store: Any,
) -> None:
    """`ExpenseSource.OWNER_HAND` (c9): un gasto o una obligación pagados del
    bolsillo del dueño restan de su mano; uno anulado o pagado por banco no."""
    bd = today_business_date(store).isoformat()
    shift = open_shift(total=0)
    pickup = device_client.post(
        f"{API}/shifts/{shift['id']}/pickups",
        json={"amount": 40_000, "authorizer_pin": "9999", "photo": "retiro.jpg"},
        headers=idem(),
    )
    assert pickup.status_code == 201, pickup.text

    def expense(amount: int, source: str) -> dict:
        resp = admin_client.post(
            f"{API}/admin/expenses",
            params={"store_id": store.id},
            json={"category": "supplies", "description": "Hielo", "amount": amount, "business_date": bd, "source": source},
            headers=idem(),
        )
        assert resp.status_code == 201, resp.text
        assert resp.json()["source"] == source
        return resp.json()

    expense(7_000, "owner_hand")
    expense(9_000, "bank")
    anulado = expense(3_000, "owner_hand")
    void = admin_client.post(
        f"{API}/admin/expenses/{anulado['id']}/void", json={"reason": "Duplicado"}, headers=idem()
    )
    assert void.status_code in (200, 201), void.text

    obligation = admin_client.post(
        f"{API}/admin/obligations",
        params={"store_id": store.id},
        json={"category": "utilities", "description": "Gas", "amount": 5_000, "due_date": bd},
        headers=idem(),
    )
    assert obligation.status_code == 201, obligation.text
    settled = admin_client.post(
        f"{API}/admin/obligations/{obligation.json()['id']}/settle", json={"source": "owner_hand"}, headers=idem()
    )
    assert settled.status_code in (200, 201), settled.text

    body = _owner_hand_today(admin_client, store)
    assert body["spent_on_expenses"] == 7_000 + 5_000
    assert body["spent"] == body["spent_on_tips"] + body["spent_on_refunds"] + body["spent_on_expenses"]
    assert body["balance"] == 40_000 - 12_000
