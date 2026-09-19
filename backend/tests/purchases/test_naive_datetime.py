"""Una hora de pared sin zona —la que entrega `<input type="datetime-local">`—
tiene que entrar, no devolver `500`.

**Defecto encontrado recorriendo la app en un navegador real, no por un test.**
`POST /admin/payables/{id}/payments` moría con
`ValueError: Los datetimes que se guardan tienen que ser aware` desde
`UTCDateTime`, así que **registrar un pago desde la pantalla nunca funcionó**.
Los 976 tests de la fase no lo veían porque arman el JSON a mano y escriben la
`Z`: probaban un cliente que no existe.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any
from uuid import uuid4

from fastapi.testclient import TestClient

from app.core import tz


def _idem() -> dict[str, str]:
    return {"Idempotency-Key": str(uuid4())}


def test_a_payment_with_a_naive_wall_clock_is_accepted_and_stored_as_bogota(
    admin_client: TestClient, create_payable: Callable[..., Any]
) -> None:
    payable = create_payable()
    admin_client.post(f"/api/v1/admin/payables/{payable['id']}/approve", json={"authorizer_pin": "9999"})

    # EXACTAMENTE lo que manda el navegador: sin zona, sin segundos, sin `Z`.
    resp = admin_client.post(
        f"/api/v1/admin/payables/{payable['id']}/payments",
        json={
            "amount": payable["amount"] // 2,
            "method": "transfer",
            "paid_at": "2026-09-19T03:14",
            "from_cash_drawer": False,
            "authorizer_pin": "9999",
        },
        headers=_idem(),
    )
    assert resp.status_code == 201, f"una hora de pared sin zona tiene que entrar, no reventar: {resp.text}"

    # Y se interpreta como hora de la SEDE, no como UTC: 03:14 en Bogotá son
    # las 08:14 UTC. Si se hubiera guardado como UTC crudo, el pago figuraría
    # cinco horas antes de cuando ocurrió.
    filas = admin_client.get(f"/api/v1/admin/payables/{payable['id']}/payments").json()
    assert len(filas) == 1
    guardado = filas[0]["paid_at"]
    assert guardado.startswith("2026-09-19T08:14"), f"se esperaba 08:14 UTC (03:14 en Bogotá), llegó {guardado}"


def test_a_payment_with_an_explicit_offset_is_respected(
    admin_client: TestClient, create_payable: Callable[..., Any]
) -> None:
    """Un cliente que SÍ manda la zona no se toca."""
    payable = create_payable()
    admin_client.post(f"/api/v1/admin/payables/{payable['id']}/approve", json={"authorizer_pin": "9999"})

    resp = admin_client.post(
        f"/api/v1/admin/payables/{payable['id']}/payments",
        json={
            "amount": payable["amount"] // 2,
            "method": "transfer",
            "paid_at": "2026-09-19T08:14:00Z",
            "from_cash_drawer": False,
            "authorizer_pin": "9999",
        },
        headers=_idem(),
    )
    assert resp.status_code == 201, resp.text
    filas = admin_client.get(f"/api/v1/admin/payables/{payable['id']}/payments").json()
    assert filas[0]["paid_at"].startswith("2026-09-19T08:14")


def test_the_helper_is_the_inverse_of_to_bogota() -> None:
    from datetime import datetime

    pared = datetime(2026, 9, 19, 3, 14)
    instante = tz.from_bogota_wall_clock(pared)
    assert instante.tzinfo is not None
    assert tz.to_bogota(instante).replace(tzinfo=None) == pared
