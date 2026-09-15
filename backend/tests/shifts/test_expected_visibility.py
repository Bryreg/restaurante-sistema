"""Visibilidad del esperado (iteración 2, B-3/B-4; extendido en 1b-1 con O-1:
CONTRATO-INTERNO-1b-1.md §2.4 «Caja»).

`expected_cash`, `pickups[].expected_at_pickup`, `handovers[].breakdown` y,
desde 1b-1, `sales`/`tips` comparten un único predicado
(`router._can_see_expected`, usado en `_shift_summary` y en
`GET /shifts/current`): el admin siempre; el responsable de caja del turno
SOLO si `cash.blind_close` está apagada en su sede (con la flag encendida
—perfil `full`, el de estos tests, la deja encendida por defecto— el
responsable recién ve el esperado en el paso 2 del cierre,
`GET /shifts/{id}/close/{count_id}/review`, que no pasa por este predicado);
cualquier otro operador identificado, nunca. Esto sólo verifica
`GET /shifts/{id}` y `GET /shifts/current` — las respuestas de `POST
/pickups` y `POST /handovers` siguen devolviendo el snapshot al actor que
ejecuta la acción (retiro autorizado por PIN admin, relevo hecho por el
responsable), lo cual está documentado como decisión en el output, no es un
descuido.
"""

from __future__ import annotations

from sqlalchemy.orm import Session

from app.shifts.models import Shift
from tests.shifts.conftest import idem


def _open(db: Session) -> Shift:
    shift = db.query(Shift).filter(Shift.status == "open").order_by(Shift.id.desc()).first()
    assert shift is not None
    return shift


def test_non_responsible_operator_sees_none_of_the_three_and_admin_sees_all(
    device_client, admin_client, identify, employees, open_shift, db: Session
) -> None:
    open_shift(cash_responsible=employees["cashier"])
    shift = _open(db)

    pickup = device_client.post(
        f"/api/v1/shifts/{shift.id}/pickups",
        json={"amount": 20_000, "authorizer_pin": "9999", "photo": "retiro.jpg"},
        headers=idem(),
    )
    assert pickup.status_code == 201, pickup.text

    arqueo = device_client.post(
        f"/api/v1/shifts/{shift.id}/handovers",
        json={
            "kind": "spot_check",
            "counted_cash": {"denominations": [{"value": 50000, "count": 4}], "total": 200_000},
            "authorizer_pin": "9999",
        },
        headers=idem(),
    )
    assert arqueo.status_code == 201, arqueo.text

    # El mismo dispositivo, ahora identificado como un operador que NO es el
    # responsable de caja del turno.
    identify(device_client, employees["operator"])

    body = device_client.get(f"/api/v1/shifts/{shift.id}").json()
    assert body["expected_cash"] is None, "un operador no responsable no ve el esperado"
    assert body["pickups"], "el retiro sigue en la lista: sólo se oculta el esperado, no el evento"
    for p in body["pickups"]:
        assert p["expected_at_pickup"] is None, f"el esperado se filtró por el retiro: {p}"
    assert body["handovers"], "el arqueo sigue en la lista: sólo se oculta el esperado, no el evento"
    for h in body["handovers"]:
        assert h["breakdown"] is None, f"el esperado se filtró por el relevo: {h}"

    admin_body = admin_client.get(f"/api/v1/shifts/{shift.id}").json()
    assert admin_body["expected_cash"] is not None, "el admin ve el esperado"
    for p in admin_body["pickups"]:
        assert p["expected_at_pickup"] is not None, "el admin ve el snapshot del retiro"
    for h in admin_body["handovers"]:
        assert h["breakdown"] is not None, "el admin ve el desglose del relevo"


def test_responsible_with_blind_close_on_sees_none_until_review(
    device_client, admin_client, identify, employees, open_shift, db: Session
) -> None:
    """O-1 (decisión resuelta por default en 1b-1): con `cash.blind_close`
    encendida (perfil `full`, ya lo está), el RESPONSABLE de caja tampoco ve
    `expected_cash`/`sales`/`tips` en `current` ni en `{id}` — sólo el admin.
    El responsable lo ve recién en el paso 2 del cierre (`review`)."""

    open_shift(cash_responsible=employees["cashier"])
    shift = _open(db)
    identify(device_client, employees["cashier"])  # el responsable, identificado en el dispositivo

    current = device_client.get("/api/v1/shifts/current").json()
    assert current["expected_cash"] is None
    assert current["sales"] is None
    assert current["tips"] is None

    by_id = device_client.get(f"/api/v1/shifts/{shift.id}").json()
    assert by_id["expected_cash"] is None
    assert by_id["sales"] is None
    assert by_id["tips"] is None

    admin_by_id = admin_client.get(f"/api/v1/shifts/{shift.id}").json()
    assert admin_by_id["expected_cash"] is not None, "el admin ve el esperado aunque el responsable no"
    assert admin_by_id["sales"] is not None
    assert admin_by_id["tips"] is not None

    count = device_client.post(
        f"/api/v1/shifts/{shift.id}/close/count",
        json={
            "counted_cash": {"denominations": [{"value": 50000, "count": 4}], "total": 200_000},
            "photo": "cierre.jpg",
        },
        headers=idem(),
    )
    assert count.status_code == 201, count.text
    review = device_client.get(f"/api/v1/shifts/{shift.id}/close/{count.json()['count_id']}/review")
    assert review.status_code == 200, review.text
    assert review.json()["expected"] == admin_by_id["expected_cash"], "el paso 2 revela el mismo esperado que ve el admin"


def test_responsible_with_blind_close_off_sees_expected(
    device_client, admin_client, identify, employees, open_shift, set_feature, db: Session
) -> None:
    """Con `cash.blind_close` apagada, el responsable ve el esperado (y
    `sales`/`tips`) directamente en `current` y en `{id}`, como el admin."""

    set_feature("cash.blind_close", False)
    open_shift(cash_responsible=employees["cashier"])
    shift = _open(db)
    identify(device_client, employees["cashier"])

    current = device_client.get("/api/v1/shifts/current").json()
    assert current["expected_cash"] is not None
    assert current["sales"] is not None
    assert current["tips"] is not None

    by_id = device_client.get(f"/api/v1/shifts/{shift.id}").json()
    assert by_id["expected_cash"] is not None
    assert by_id["expected_cash"] == current["expected_cash"]
    assert by_id["sales"] is not None
    assert by_id["tips"] is not None
