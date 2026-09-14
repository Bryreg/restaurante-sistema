"""Visibilidad del esperado (iteración 2, B-3/B-4).

`expected_cash`, `pickups[].expected_at_pickup` y `handovers[].breakdown`
comparten un único predicado (`router._can_see_expected`, usado en
`_shift_summary` y en `GET /shifts/current`): admin o el responsable de caja
del turno ven los tres; cualquier otro operador identificado, ninguno. Esto
sólo verifica `GET /shifts/{id}` — las respuestas de `POST /pickups` y
`POST /handovers` siguen devolviendo el snapshot al actor que ejecuta la
acción (retiro autorizado por PIN admin, relevo hecho por el responsable), lo
cual está documentado como decisión en el output, no es un descuido.
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
