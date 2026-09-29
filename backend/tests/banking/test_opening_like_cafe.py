"""La apertura «igual al café» y «Ajustar apertura» (decisión del dueño, 2026-09-29).

Lo que cobran estos tests, todo por HTTP y con igualdades exactas:

- quien abre ve «Debería haber en la registradora» = la suma de los días por
  consignar, **todos marcados de entrada** (desmarcables), y la diferencia en
  vivo — calculada por el servidor (`POST /shifts/opening/preview`);
- con diferencia, causa **y** justificación escrita obligatorias, y el
  rechazo no escribe nada; no se abre con $0 si debería haber plata;
- el **sobrante** al abrir se consigna con este turno; el **faltante** queda
  como novedad justificada y no le baja la venta al turno;
- «Ajustar apertura» rehace de qué días era la plata del cajón, con vista
  previa y con la misma cuenta del cierre: el caso del café, que pedía
  $697.900 en vez de $197.900. El día que sale queda reversado con motivo,
  nunca borrado.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.audit.models import AuditLog
from app.auth.models import Employee
from app.shifts import service as shifts_service
from app.shifts.models import Shift, ShiftCarryIn
from app.stores import service as stores_service
from tests.banking.conftest import denoms, idem, today_business_date

API = "/api/v1"
BASE = 200_000


def _envelopes_mode(db: Session, store: Any) -> None:
    settings = stores_service.get_cash_settings(db, store.id)
    settings.opening_mode = "envelopes"
    db.commit()


def _day_with(open_shift: Callable[..., dict], close_shift: Callable[..., dict], amount: int) -> int:
    """Un turno (regla anterior, base fija) cerrado con `amount` por consignar."""
    shift = open_shift(total=BASE)
    body = close_shift(shift["id"], counted_cash=BASE + amount, closes_day=False)
    assert body["to_deposit"] == amount
    return int(shift["id"])


def _preview(device_client: TestClient, **body: Any) -> Any:
    return device_client.post(f"{API}/shifts/opening/preview", json=body)


def _open(device_client: TestClient, identify: Any, who: Employee, **extra: Any) -> Any:
    identify(device_client, who)
    return device_client.post(f"{API}/shifts/open", json={"cash_responsible_id": who.id, **extra}, headers=idem())


def _income(device_client: TestClient, shift_id: int, amount: int) -> None:
    resp = device_client.post(
        f"{API}/shifts/{shift_id}/cash-movements",
        json={"kind": "income", "cause": "other_income", "amount": amount, "note": "venta"},
        headers=idem(),
    )
    assert resp.status_code == 201, resp.text


def _pending_row(admin_client: TestClient, store: Any, shift_id: int) -> dict[str, Any]:
    bd = today_business_date(store).isoformat()
    resp = admin_client.get(f"{API}/admin/deposits/pending", params={"store_id": store.id, "from": bd, "to": bd})
    assert resp.status_code == 200, resp.text
    return {row["shift_id"]: row for row in resp.json()}[shift_id]


# ---------------------------------------------------------------------------
# Apertura
# ---------------------------------------------------------------------------


def test_the_opening_shows_what_should_be_in_the_drawer_with_every_day_marked(
    db: Session, device_client: TestClient, open_shift: Any, close_shift: Any, identify: Any, employees: dict, store: Any
) -> None:
    lunes = _day_with(open_shift, close_shift, 50_000)
    martes = _day_with(open_shift, close_shift, 30_000)
    _envelopes_mode(db, store)
    identify(device_client, employees["cashier"])

    info = device_client.get(f"{API}/shifts/opening").json()
    assert [(e["shift_id"], e["outstanding"]) for e in info["envelopes"]] == [(lunes, 50_000), (martes, 30_000)]

    todo = _preview(device_client).json()
    assert [(d["shift_id"], d["selected"]) for d in todo["days"]] == [(lunes, True), (martes, True)]
    assert todo["expected"] == 80_000
    assert todo["counted"] is None and todo["difference"] is None

    # Desmarcar el martes (no está en el cajón) y contar: la diferencia la
    # calcula el servidor, en vivo.
    sin_martes = _preview(device_client, carried_shift_ids=[lunes], counted=denoms(60_000)).json()
    assert sin_martes["expected"] == 50_000
    assert sin_martes["counted"] == 60_000
    assert sin_martes["difference"] == 10_000
    assert sin_martes["surplus_consignable"] == 10_000
    assert sin_martes["shortage"] == 0
    assert sin_martes["requires_justification"] is True
    assert [(d["shift_id"], d["selected"]) for d in sin_martes["days"]] == [(lunes, True), (martes, False)]

    vacio = _preview(device_client, counted=denoms(0)).json()
    assert vacio["blocks_empty"] is True


def test_opening_exactly_needs_no_justification_and_the_shift_deposits_only_its_sale(
    db: Session, device_client: TestClient, open_shift: Any, close_shift: Any, identify: Any, employees: dict, store: Any
) -> None:
    ayer = _day_with(open_shift, close_shift, 50_000)
    _envelopes_mode(db, store)

    resp = _open(device_client, identify, employees["cashier"], carried_shift_ids=[ayer], opening_cash=denoms(50_000))
    assert resp.status_code == 201, resp.text
    shift = db.get(Shift, resp.json()["id"])
    assert shift is not None
    assert (shift.opening_cash_total, shift.opening_expected, shift.opening_cause) == (50_000, 50_000, None)

    _income(device_client, shift.id, 30_000)
    body = close_shift(shift.id, counted_cash=80_000, closes_day=False, cause=None)
    assert body["to_deposit"] == 30_000


def test_a_difference_needs_cause_and_written_reason_and_the_rejection_writes_nothing(
    db: Session, device_client: TestClient, open_shift: Any, close_shift: Any, identify: Any, employees: dict, store: Any
) -> None:
    ayer = _day_with(open_shift, close_shift, 50_000)
    _envelopes_mode(db, store)
    cashier = employees["cashier"]

    sin_causa = _open(device_client, identify, cashier, carried_shift_ids=[ayer], opening_cash=denoms(45_000))
    assert sin_causa.status_code == 400
    assert sin_causa.json()["error"]["code"] == "OPENING_DIFFERENCE_NEEDS_CAUSE"

    sin_nota = _open(
        device_client, identify, cashier, carried_shift_ids=[ayer], opening_cash=denoms(45_000), opening_cause="counting_error"
    )
    assert sin_nota.status_code == 400
    assert sin_nota.json()["error"]["code"] == "OPENING_DIFFERENCE_NEEDS_NOTE"
    assert shifts_service.get_current_shift(db, store=store) is None
    assert db.execute(select(ShiftCarryIn)).scalars().first() is None

    ok = _open(
        device_client,
        identify,
        cashier,
        carried_shift_ids=[ayer],
        opening_cash=denoms(45_000),
        opening_cause="counting_error",
        opening_note="Faltaban cinco mil en el sobre de ayer",
    )
    assert ok.status_code == 201, ok.text


def test_it_cannot_open_with_zero_when_there_should_be_money(
    db: Session, device_client: TestClient, open_shift: Any, close_shift: Any, identify: Any, employees: dict, store: Any
) -> None:
    ayer = _day_with(open_shift, close_shift, 50_000)
    _envelopes_mode(db, store)

    resp = _open(
        device_client,
        identify,
        employees["cashier"],
        carried_shift_ids=[ayer],
        opening_cash=denoms(0),
        opening_cause="unknown",
        opening_note="no hay nada",
    )
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "OPENING_EMPTY_DRAWER"
    assert shifts_service.get_current_shift(db, store=store) is None

    # Desmarcando el día (la plata no está en el cajón), sí: no debería haber nada.
    vacio = _open(device_client, identify, employees["cashier"], carried_shift_ids=[], opening_cash=denoms(0))
    assert vacio.status_code == 201, vacio.text


def test_the_surplus_at_opening_is_deposited_with_this_shift(
    db: Session,
    admin_client: TestClient,
    device_client: TestClient,
    open_shift: Any,
    close_shift: Any,
    identify: Any,
    employees: dict,
    store: Any,
) -> None:
    ayer = _day_with(open_shift, close_shift, 50_000)
    _envelopes_mode(db, store)
    hoy = _open(
        device_client,
        identify,
        employees["cashier"],
        carried_shift_ids=[ayer],
        opening_cash=denoms(60_000),
        opening_cause="unknown",
        opening_note="Apareció un billete de diez mil",
    ).json()

    _income(device_client, hoy["id"], 30_000)
    body = close_shift(hoy["id"], counted_cash=90_000, closes_day=False, cause=None)
    # 30.000 de venta + 10.000 de sobrante al abrir: se consignan con este turno.
    assert body["to_deposit"] == 40_000
    assert _pending_row(admin_client, store, ayer)["outstanding"] == 50_000


def test_the_shortfall_at_opening_stays_a_novelty_and_does_not_lower_the_sale(
    db: Session,
    admin_client: TestClient,
    device_client: TestClient,
    open_shift: Any,
    close_shift: Any,
    identify: Any,
    employees: dict,
    store: Any,
) -> None:
    ayer = _day_with(open_shift, close_shift, 50_000)
    _envelopes_mode(db, store)
    hoy = _open(
        device_client,
        identify,
        employees["cashier"],
        carried_shift_ids=[ayer],
        opening_cash=denoms(45_000),
        opening_cause="counting_error",
        opening_note="Faltan cinco mil del sobre de ayer",
    ).json()

    _income(device_client, hoy["id"], 30_000)
    body = close_shift(hoy["id"], counted_cash=75_000, closes_day=False, cause=None)
    # La venta de hoy entera; el faltante no se esconde adentro de ella: el
    # día de ayer lo sigue pidiendo.
    assert body["to_deposit"] == 30_000
    assert _pending_row(admin_client, store, ayer)["outstanding"] == 50_000


# ---------------------------------------------------------------------------
# Ajustar apertura
# ---------------------------------------------------------------------------


def test_adjust_opening_redoes_the_days_like_the_cafe_697900_to_197900(
    db: Session,
    admin_client: TestClient,
    device_client: TestClient,
    open_shift: Any,
    close_shift: Any,
    identify: Any,
    employees: dict,
    store: Any,
) -> None:
    """El caso del café: quien abrió no marcó el día anterior ($500.000 que
    estaban en el cajón), los contó como sobrante y el día pasó a pedir
    $697.900 en vez de $197.900 — la misma plata pedida dos veces."""
    viernes = _day_with(open_shift, close_shift, 500_000)
    _envelopes_mode(db, store)
    sabado = _open(
        device_client,
        identify,
        employees["cashier"],
        carried_shift_ids=[],
        opening_cash=denoms(500_000),
        opening_cause="unknown",
        opening_note="Había plata en el cajón",
    ).json()
    _income(device_client, sabado["id"], 197_900)
    body = close_shift(sabado["id"], counted_cash=697_900, closes_day=False, cause=None)
    assert body["to_deposit"] == 697_900
    assert _pending_row(admin_client, store, viernes)["outstanding"] == 500_000

    form = admin_client.get(f"{API}/admin/shifts/{sabado['id']}/adjust-opening").json()
    assert [(d["shift_id"], d["amount"], d["selected"]) for d in form["days"]] == [(viernes, 500_000, False)]

    ajuste = {"carried_shift_ids": [viernes], "reason": "El cajón tenía la venta del viernes"}
    preview = admin_client.post(f"{API}/admin/shifts/{sabado['id']}/adjust-opening/preview", json=ajuste)
    assert preview.status_code == 200, preview.text
    p = preview.json()
    assert (p["carried_total_before"], p["carried_total_after"]) == (0, 500_000)
    assert (p["opening_expected_after"], p["opening_difference_after"]) == (500_000, 0)
    assert (p["to_deposit_before"], p["to_deposit_after"]) == (697_900, 197_900)
    shift = db.get(Shift, sabado["id"])
    assert shift is not None and shift.to_deposit == 697_900, "la vista previa no escribe"

    resp = admin_client.post(f"{API}/admin/shifts/{sabado['id']}/adjust-opening", json=ajuste)
    assert resp.status_code == 200, resp.text
    db.expire_all()
    shift = db.get(Shift, sabado["id"])
    assert shift is not None
    assert (shift.to_deposit, shift.opening_expected, shift.difference) == (197_900, 500_000, 0)
    assert _pending_row(admin_client, store, sabado["id"])["outstanding"] == 197_900

    audit = (
        db.execute(select(AuditLog).where(AuditLog.entity == "shift", AuditLog.action == "adjust_opening"))
        .scalars()
        .one()
    )
    assert audit.before["to_deposit"] == 697_900
    assert audit.after["to_deposit"] == 197_900
    assert audit.after["carried"] == {str(viernes): 500_000}

    # Y deshacerlo: el día sale de la selección reversado con motivo, nunca borrado.
    atras = admin_client.post(
        f"{API}/admin/shifts/{sabado['id']}/adjust-opening",
        json={"carried_shift_ids": [], "reason": "Me equivoqué de día"},
    )
    assert atras.status_code == 200, atras.text
    filas = db.execute(select(ShiftCarryIn).where(ShiftCarryIn.shift_id == sabado["id"])).scalars().all()
    assert len(filas) == 1
    assert filas[0].reversed_at is not None and filas[0].reversed_reason == "Me equivoqué de día"
    db.expire_all()
    assert db.get(Shift, sabado["id"]).to_deposit == 697_900  # type: ignore[union-attr]


def test_adjust_opening_offers_neither_the_shift_itself_nor_later_days_and_needs_a_reason(
    db: Session,
    admin_client: TestClient,
    device_client: TestClient,
    open_shift: Any,
    close_shift: Any,
    identify: Any,
    employees: dict,
    store: Any,
) -> None:
    _envelopes_mode(db, store)
    primero = _open(device_client, identify, employees["cashier"], carried_shift_ids=[], opening_cash=denoms(0)).json()
    _income(device_client, primero["id"], 40_000)
    close_shift(primero["id"], counted_cash=40_000, closes_day=False, cause=None)
    segundo = _open(
        device_client, identify, employees["cashier"], carried_shift_ids=[primero["id"]], opening_cash=denoms(40_000)
    ).json()
    _income(device_client, segundo["id"], 10_000)
    close_shift(segundo["id"], counted_cash=50_000, closes_day=False, cause=None)

    form = admin_client.get(f"{API}/admin/shifts/{primero['id']}/adjust-opening").json()
    assert form["days"] == [], "ni el mismo turno ni uno que cerró después de que abrió"

    posterior = admin_client.post(
        f"{API}/admin/shifts/{primero['id']}/adjust-opening",
        json={"carried_shift_ids": [segundo["id"]], "reason": "prueba"},
    )
    assert posterior.status_code == 400
    assert posterior.json()["error"]["code"] == "ADJUST_DAY_NOT_AVAILABLE"

    sin_motivo = admin_client.post(
        f"{API}/admin/shifts/{primero['id']}/adjust-opening", json={"opening_cash_total": 5_000, "reason": "  "}
    )
    assert sin_motivo.status_code == 400
    assert sin_motivo.json()["error"]["code"] == "ADJUST_REASON_REQUIRED"
    db.expire_all()
    assert db.get(Shift, primero["id"]).opening_cash_total == 0  # type: ignore[union-attr]


def test_adjust_opening_takes_the_real_total_without_denominations(
    db: Session,
    admin_client: TestClient,
    device_client: TestClient,
    open_shift: Any,
    close_shift: Any,
    identify: Any,
    employees: dict,
    store: Any,
) -> None:
    ayer = _day_with(open_shift, close_shift, 50_000)
    _envelopes_mode(db, store)
    hoy = _open(
        device_client, identify, employees["cashier"], carried_shift_ids=[ayer], opening_cash=denoms(50_000)
    ).json()
    _income(device_client, hoy["id"], 30_000)
    close_shift(hoy["id"], counted_cash=80_000, closes_day=False, cause=None)

    # En realidad había 40.000: faltaban 10.000 al abrir (novedad), así que
    # el cierre cuadra de otra forma y lo que se consigna sigue siendo la venta.
    preview = admin_client.post(
        f"{API}/admin/shifts/{hoy['id']}/adjust-opening/preview",
        json={"opening_cash_total": 40_000, "reason": "Se contó mal al abrir"},
    ).json()
    assert preview["opening_difference_after"] == -10_000
    assert (preview["close_expected_before"], preview["close_expected_after"]) == (80_000, 70_000)
    assert (preview["close_difference_before"], preview["close_difference_after"]) == (0, 10_000)
    assert (preview["to_deposit_before"], preview["to_deposit_after"]) == (30_000, 40_000)

    resp = admin_client.post(
        f"{API}/admin/shifts/{hoy['id']}/adjust-opening",
        json={"opening_cash_total": 40_000, "reason": "Se contó mal al abrir"},
    )
    assert resp.status_code == 200, resp.text
    db.expire_all()
    shift = db.get(Shift, hoy["id"])
    assert shift is not None
    assert (shift.opening_cash_total, shift.expected_cash, shift.difference, shift.to_deposit) == (
        40_000,
        70_000,
        10_000,
        40_000,
    )
