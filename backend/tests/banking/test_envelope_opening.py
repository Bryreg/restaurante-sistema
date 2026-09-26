"""El cajón abre SÓLO con los sobres por consignar (decisión del dueño, 2026-09-26).

Lo que cobran estos tests, todo por HTTP:

- con la regla de sobres, la apertura lista los sobres **sin monto** (a
  ciegas), y ni `carry-candidates` los publica;
- el conteo se sella sobre por sobre y recién ahí el servidor revela lo
  esperado, lo contado y la diferencia **de cada sobre**, atribuidos a quien
  contó; con diferencia, abrir exige causa;
- el esperado de apertura es la suma de los sobres elegidos, **sin base
  fija**, y lo que el turno consigna al cerrar es sólo su venta;
- un turno abierto con la base fija la conserva aunque la sede cambie de
  regla (nunca se reescribe la historia);
- sin sobres, el cajón abre vacío; una sede con base fija no acepta el
  conteo por sobres.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.auth.models import Employee
from app.shifts import service as shifts_service
from app.shifts.models import Shift, ShiftOpeningCount
from app.stores import service as stores_service
from tests.banking.conftest import denoms, idem

API = "/api/v1"
BASE = 200_000


def _envelopes_mode(db: Session, store: Any) -> None:
    """La precondición, armada explícitamente: esta sede abre con sobres."""
    settings = stores_service.get_cash_settings(db, store.id)
    settings.opening_mode = "envelopes"
    db.commit()


def _yesterday_with(open_shift: Callable[..., dict], close_shift: Callable[..., dict], amount: int) -> int:
    """Un turno (regla anterior) cerrado con `amount` por consignar."""
    shift = open_shift(total=BASE)
    body = close_shift(shift["id"], counted_cash=BASE + amount, closes_day=False)
    assert body["to_deposit"] == amount
    return int(shift["id"])


def _seal(device_client: TestClient, identify: Any, who: Employee, counts: dict[int, int]) -> Any:
    identify(device_client, who)
    return device_client.post(
        f"{API}/shifts/opening-counts",
        json={"envelopes": [{"shift_id": sid, "counted": denoms(total)} for sid, total in counts.items()]},
        headers=idem(),
    )


def _open(device_client: TestClient, who: Employee, **extra: Any) -> Any:
    return device_client.post(
        f"{API}/shifts/open", json={"cash_responsible_id": who.id, **extra}, headers=idem()
    )


def test_the_opening_lists_the_envelopes_by_date_and_never_their_amount(
    db: Session, device_client: TestClient, open_shift: Any, close_shift: Any, store: Any
) -> None:
    ayer = _yesterday_with(open_shift, close_shift, 50_000)
    _envelopes_mode(db, store)

    info = device_client.get(f"{API}/shifts/opening")
    assert info.status_code == 200, info.text
    body = info.json()
    assert body["mode"] == "envelopes"
    assert [e["shift_id"] for e in body["envelopes"]] == [ayer]
    assert set(body["envelopes"][0]) == {"shift_id", "business_date"}, "el sobre se cuenta a ciegas: sin monto"

    candidates = device_client.get(f"{API}/shifts/carry-candidates").json()
    assert [(c["shift_id"], c["outstanding"]) for c in candidates] == [(ayer, None)]


def test_sealing_reveals_the_difference_of_each_envelope_attributed_to_who_counted(
    db: Session,
    device_client: TestClient,
    open_shift: Any,
    close_shift: Any,
    identify: Any,
    employees: dict,
    store: Any,
) -> None:
    lunes = _yesterday_with(open_shift, close_shift, 50_000)
    martes = _yesterday_with(open_shift, close_shift, 30_000)
    _envelopes_mode(db, store)
    cashier = employees["cashier"]

    sealed = _seal(device_client, identify, cashier, {lunes: 45_000, martes: 30_000})
    assert sealed.status_code == 201, sealed.text
    reveal = sealed.json()
    por_sobre = {e["shift_id"]: (e["expected"], e["counted"], e["difference"]) for e in reveal["envelopes"]}
    assert por_sobre == {lunes: (50_000, 45_000, -5_000), martes: (30_000, 30_000, 0)}
    assert reveal["counted_by"] == {"id": cashier.id, "name": cashier.name}
    assert reveal["requires_cause"] is True

    # Con diferencia, abrir exige causa — y el rechazo no escribe nada.
    sin_causa = _open(device_client, cashier, opening_count_id=reveal["id"])
    assert sin_causa.status_code == 400
    assert sin_causa.json()["error"]["code"] == "OPENING_DIFFERENCE_NEEDS_CAUSE"
    assert shifts_service.get_current_shift(db, store=store) is None

    abierto = _open(device_client, cashier, opening_count_id=reveal["id"], opening_cause="counting_error")
    assert abierto.status_code == 201, abierto.text
    assert abierto.json()["opening_cash_total"] == 75_000
    assert abierto.json()["opening_mode"] == "envelopes"

    summary = device_client.get(f"{API}/shifts/{abierto.json()['id']}").json()
    assert summary["opening_count"]["counted_by"]["id"] == cashier.id
    assert {e["shift_id"]: e["difference"] for e in summary["opening_count"]["envelopes"]} == {
        lunes: -5_000,
        martes: 0,
    }


def test_the_drawer_opens_with_the_envelopes_only_and_the_shift_deposits_only_its_sale(
    db: Session,
    device_client: TestClient,
    open_shift: Any,
    close_shift: Any,
    identify: Any,
    employees: dict,
    store: Any,
) -> None:
    ayer = _yesterday_with(open_shift, close_shift, 50_000)
    _envelopes_mode(db, store)
    cashier = employees["cashier"]

    reveal = _seal(device_client, identify, cashier, {ayer: 50_000}).json()
    assert reveal["requires_cause"] is False
    hoy = _open(device_client, cashier, opening_count_id=reveal["id"]).json()

    shift = db.get(Shift, hoy["id"])
    assert shift is not None
    assert shift.opening_fixed_base == 0
    breakdown = shifts_service.compute_breakdown(db, shift)
    assert breakdown["base"] == 50_000, "sin base fija: el cajón abre sólo con el sobre"
    assert breakdown["expected"] == 50_000

    resp = device_client.post(
        f"{API}/shifts/{hoy['id']}/cash-movements",
        json={"kind": "income", "cause": "other_income", "amount": 30_000, "note": "venta"},
        headers=idem(),
    )
    assert resp.status_code == 201, resp.text
    body = close_shift(hoy["id"], counted_cash=80_000, closes_day=False, cause=None)
    # 80.000 contados − 0 de base − 50.000 que son de ayer = 30.000 de hoy.
    assert body["to_deposit"] == 30_000


def test_a_shift_opened_with_the_fixed_base_keeps_it_after_the_store_switches(
    db: Session, open_shift: Any, close_shift: Any, store: Any
) -> None:
    viejo = open_shift(total=BASE)
    _envelopes_mode(db, store)
    shift = db.get(Shift, viejo["id"])
    assert shift is not None
    assert shift.opening_mode == "fixed_base"
    assert shift.opening_fixed_base == BASE

    body = close_shift(viejo["id"], counted_cash=BASE + 40_000, closes_day=False)
    assert body["to_deposit"] == 40_000, "la regla del turno se congeló al abrir: la base fija sigue restando"


def test_without_envelopes_the_drawer_opens_empty_and_loose_cash_is_rejected(
    db: Session, device_client: TestClient, identify: Any, employees: dict, store: Any
) -> None:
    _envelopes_mode(db, store)
    cashier = employees["cashier"]
    identify(device_client, cashier)

    con_base = _open(device_client, cashier, opening_cash=denoms(BASE))
    assert con_base.status_code == 400
    assert con_base.json()["error"]["code"] == "OPENING_COUNT_REQUIRED"
    assert shifts_service.get_current_shift(db, store=store) is None

    vacio = _open(device_client, cashier)
    assert vacio.status_code == 201, vacio.text
    assert vacio.json()["opening_cash_total"] == 0


def test_counting_again_supersedes_the_previous_seal_which_can_no_longer_open(
    db: Session,
    device_client: TestClient,
    open_shift: Any,
    close_shift: Any,
    identify: Any,
    employees: dict,
    store: Any,
) -> None:
    ayer = _yesterday_with(open_shift, close_shift, 50_000)
    _envelopes_mode(db, store)
    cashier = employees["cashier"]

    primero = _seal(device_client, identify, cashier, {ayer: 40_000}).json()
    segundo = _seal(device_client, identify, cashier, {ayer: 50_000}).json()
    assert db.get(ShiftOpeningCount, primero["id"]).superseded is True  # type: ignore[union-attr]

    info = device_client.get(f"{API}/shifts/opening").json()
    assert info["pending_count"]["id"] == segundo["id"]

    viejo = _open(device_client, cashier, opening_count_id=primero["id"], opening_cause="counting_error")
    assert viejo.status_code == 409
    assert viejo.json()["error"]["code"] == "OPENING_COUNT_USED"

    ok = _open(device_client, cashier, opening_count_id=segundo["id"])
    assert ok.status_code == 201, ok.text


def test_a_fixed_base_store_does_not_take_an_envelope_count(
    device_client: TestClient, identify: Any, employees: dict
) -> None:
    resp = _seal(device_client, identify, employees["cashier"], {})
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "OPENING_MODE_MISMATCH"


def test_a_person_without_cash_permission_cannot_seal_the_opening(
    db: Session, device_client: TestClient, identify: Any, employees: dict, store: Any
) -> None:
    _envelopes_mode(db, store)
    resp = _seal(device_client, identify, employees["operator"], {})
    assert resp.status_code == 403
    assert resp.json()["error"]["code"] == "CASH_PERMISSION_REQUIRED"


def test_a_new_store_is_born_with_the_envelope_rule(admin_client: TestClient) -> None:
    resp = admin_client.post(
        f"{API}/admin/stores",
        json={
            "name": "Sede Norte",
            "nit": "900123456",
            "dv": "7",
            "legal_name": "Organización Demo SAS",
            "address": "Calle 1",
            "municipality_dane": "11001",
            "opening_hours": [],
            "cutoff_hour": 6,
            "store_pin": "654321",
        },
    )
    assert resp.status_code == 200, resp.text
    settings = admin_client.get(f"{API}/admin/stores/{resp.json()['id']}/cash-settings")
    assert settings.status_code == 200, settings.text
    assert settings.json()["opening_mode"] == "envelopes"
