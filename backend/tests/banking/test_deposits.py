"""Consignaciones y saldo por consignar (`GET`/`POST /admin/deposits`,
`GET /admin/deposits/pending`).

La llave anti doble conteo de este territorio (retiro vs consignación) se
prueba acá: una imputación no puede superar `Shift.to_deposit`, ni sola ni
sumada a las que ya existen.

Ningún test de este archivo usa la fixture `clock` de `tests/conftest.py`
junto con `open_shift`/`device_client` (ver el porqué en
`tests/banking/conftest.py::today_business_date`): las fechas de negocio se
calculan con `today_business_date(store)`, la fecha REAL de hoy vista con la
misma puerta que usa el servidor.
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import date
from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from tests.banking.conftest import idem, today_business_date

API = "/api/v1"


def _pending_row(client: TestClient, store_id: int, shift_id: int, *, bd: date) -> dict[str, Any]:
    resp = client.get(
        f"{API}/admin/deposits/pending",
        params={"store_id": store_id, "from": bd.isoformat(), "to": bd.isoformat()},
    )
    assert resp.status_code == 200, resp.text
    rows = {row["shift_id"]: row for row in resp.json()}
    assert shift_id in rows, f"turno {shift_id} no aparece en {rows}"
    return rows[shift_id]


def test_pending_deposit_reads_shift_to_deposit_without_recalculating(
    admin_client: TestClient,
    open_shift: Callable[..., dict],
    close_shift: Callable[..., dict],
    store: Any,
) -> None:
    """§ 1a del entregable: el saldo por consignar se DERIVA de
    `Shift.to_deposit`, nunca se resta otra vez acá. Con base fija $200.000 y
    contado $250.000, `to_deposit` es exactamente $50.000
    (`counted_cash_total - opening_cash_fixed - tips_cash_out`,
    `app/shifts/service.py:1035`) — la prueba de que no hay una segunda
    fórmula es que el número que llega acá coincide EXACTO con el que
    devolvió `POST /shifts/{id}/close`."""

    shift = open_shift(total=200_000)
    close_body = close_shift(shift["id"], counted_cash=250_000, tips_cash_out=0)
    assert close_body["to_deposit"] == 50_000

    bd = today_business_date(store)
    row = _pending_row(admin_client, store.id, shift["id"], bd=bd)
    assert row["to_deposit"] == close_body["to_deposit"] == 50_000
    assert row["reason"] is None
    assert row["deposited"] == 0
    assert row["outstanding"] == 50_000


def test_pending_deposit_subtracts_tips_cash_out_exactly_once(
    admin_client: TestClient,
    open_shift: Callable[..., dict],
    close_shift: Callable[..., dict],
    store: Any,
) -> None:
    shift = open_shift(total=200_000)
    close_body = close_shift(shift["id"], counted_cash=260_000, tips_cash_out=10_000)
    assert close_body["to_deposit"] == 50_000  # 260.000 - 200.000 - 10.000

    row = _pending_row(admin_client, store.id, shift["id"], bd=today_business_date(store))
    assert row["to_deposit"] == 50_000


def test_create_deposit_allocates_to_shift_and_reduces_outstanding(
    admin_client: TestClient,
    open_shift: Callable[..., dict],
    close_shift: Callable[..., dict],
    store: Any,
) -> None:
    shift = open_shift(total=200_000)
    close_body = close_shift(shift["id"], counted_cash=250_000)
    assert close_body["to_deposit"] == 50_000
    bd = today_business_date(store)

    resp = admin_client.post(
        f"{API}/admin/deposits",
        params={"store_id": store.id},
        json={
            "amount": 30_000,
            "receipt_photo": "comprobante-1.jpg",
            "bank_reference": "CONS-001",
            "allocations": [{"shift_id": shift["id"], "amount": 30_000}],
        },
        headers=idem(),
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["amount"] == 30_000
    assert body["allocated_amount"] == 30_000
    assert body["unallocated_amount"] == 0
    assert body["status"] == "live"
    assert body["receipt_photo"] == "comprobante-1.jpg"
    assert body["allocations"] == [{"shift_id": shift["id"], "amount": 30_000}]

    row = _pending_row(admin_client, store.id, shift["id"], bd=bd)
    assert row["deposited"] == 30_000
    assert row["outstanding"] == 20_000

    listing = admin_client.get(
        f"{API}/admin/deposits", params={"store_id": store.id, "from": bd.isoformat(), "to": bd.isoformat()}
    )
    assert listing.status_code == 200, listing.text
    assert [d["id"] for d in listing.json()] == [body["id"]]


def test_deposit_allocation_cannot_exceed_shift_to_deposit(
    admin_client: TestClient,
    open_shift: Callable[..., dict],
    close_shift: Callable[..., dict],
    store: Any,
) -> None:
    """La llave anti doble conteo: un mismo peso no puede imputarse más allá
    de lo que el turno tiene pendiente."""

    shift = open_shift(total=200_000)
    close_shift(shift["id"], counted_cash=250_000)  # to_deposit = 50.000
    bd = today_business_date(store)

    resp = admin_client.post(
        f"{API}/admin/deposits",
        params={"store_id": store.id},
        json={
            "amount": 60_000,
            "receipt_photo": "comprobante.jpg",
            "allocations": [{"shift_id": shift["id"], "amount": 60_000}],
        },
        headers=idem(),
    )
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "DEPOSIT_EXCEEDS_PENDING"

    # Nada quedó escrito: ni la consignación ni la imputación.
    listing = admin_client.get(
        f"{API}/admin/deposits", params={"store_id": store.id, "from": bd.isoformat(), "to": bd.isoformat()}
    )
    assert listing.json() == []


def test_two_deposits_cannot_together_exceed_shift_to_deposit(
    admin_client: TestClient,
    open_shift: Callable[..., dict],
    close_shift: Callable[..., dict],
    store: Any,
) -> None:
    shift = open_shift(total=200_000)
    close_shift(shift["id"], counted_cash=250_000)  # to_deposit = 50.000

    first = admin_client.post(
        f"{API}/admin/deposits",
        params={"store_id": store.id},
        json={
            "amount": 40_000,
            "receipt_photo": "c1.jpg",
            "allocations": [{"shift_id": shift["id"], "amount": 40_000}],
        },
        headers=idem(),
    )
    assert first.status_code == 201, first.text

    second = admin_client.post(
        f"{API}/admin/deposits",
        params={"store_id": store.id},
        json={
            "amount": 20_000,
            "receipt_photo": "c2.jpg",
            "allocations": [{"shift_id": shift["id"], "amount": 20_000}],
        },
        headers=idem(),
    )
    assert second.status_code == 400, second.text
    assert second.json()["error"]["code"] == "DEPOSIT_EXCEEDS_PENDING"
    assert "10.000" in second.json()["error"]["message"] or "10000" in second.json()["error"]["message"]


def test_deposit_allocation_amount_cannot_exceed_deposit_amount(
    admin_client: TestClient,
    open_shift: Callable[..., dict],
    close_shift: Callable[..., dict],
    store: Any,
) -> None:
    shift = open_shift(total=200_000)
    close_shift(shift["id"], counted_cash=250_000)

    resp = admin_client.post(
        f"{API}/admin/deposits",
        params={"store_id": store.id},
        json={
            "amount": 10_000,
            "receipt_photo": "c.jpg",
            "allocations": [{"shift_id": shift["id"], "amount": 20_000}],
        },
        headers=idem(),
    )
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "ALLOCATION_EXCEEDS_DEPOSIT"


def test_deposit_can_be_unallocated_and_still_counts_as_deposited(admin_client: TestClient, store: Any) -> None:
    """Plata retirada que se consigna sin atar a un turno puntual: no reduce
    el saldo de ningún turno, pero sigue viva para el libro del banco y la
    mano del dueño."""

    resp = admin_client.post(
        f"{API}/admin/deposits",
        params={"store_id": store.id},
        json={"amount": 15_000, "receipt_photo": "c.jpg", "business_date": today_business_date(store).isoformat()},
        headers=idem(),
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["allocated_amount"] == 0
    assert body["unallocated_amount"] == 15_000
    assert body["allocations"] == []


def test_create_deposit_is_idempotent(admin_client: TestClient, store: Any) -> None:
    bd = today_business_date(store)
    headers = idem()
    payload = {"amount": 15_000, "receipt_photo": "c.jpg", "business_date": bd.isoformat()}
    first = admin_client.post(f"{API}/admin/deposits", params={"store_id": store.id}, json=payload, headers=headers)
    second = admin_client.post(f"{API}/admin/deposits", params={"store_id": store.id}, json=payload, headers=headers)
    assert first.status_code == 201, first.text
    assert second.status_code == 201, second.text
    assert first.json()["id"] == second.json()["id"]

    listing = admin_client.get(
        f"{API}/admin/deposits", params={"store_id": store.id, "from": bd.isoformat(), "to": bd.isoformat()}
    )
    assert len(listing.json()) == 1


def test_deposit_requires_receipt_photo(admin_client: TestClient, store: Any) -> None:
    resp = admin_client.post(
        f"{API}/admin/deposits",
        params={"store_id": store.id},
        json={"amount": 15_000, "receipt_photo": "", "business_date": today_business_date(store).isoformat()},
        headers=idem(),
    )
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "VALIDATION_ERROR"


def test_reverse_deposit_frees_up_outstanding_again(
    admin_client: TestClient,
    open_shift: Callable[..., dict],
    close_shift: Callable[..., dict],
    store: Any,
) -> None:
    shift = open_shift(total=200_000)
    close_shift(shift["id"], counted_cash=250_000)  # to_deposit = 50.000
    bd = today_business_date(store)

    created = admin_client.post(
        f"{API}/admin/deposits",
        params={"store_id": store.id},
        json={
            "amount": 50_000,
            "receipt_photo": "c.jpg",
            "allocations": [{"shift_id": shift["id"], "amount": 50_000}],
        },
        headers=idem(),
    )
    assert created.status_code == 201, created.text
    deposit_id = created.json()["id"]

    row_before = _pending_row(admin_client, store.id, shift["id"], bd=bd)
    assert row_before["outstanding"] == 0

    reversed_resp = admin_client.post(
        f"{API}/admin/deposits/{deposit_id}/reverse",
        json={"reason": "Se cargó con el comprobante equivocado"},
        headers=idem(),
    )
    assert reversed_resp.status_code == 200, reversed_resp.text
    assert reversed_resp.json()["status"] == "reversed"
    assert reversed_resp.json()["reversed_reason"] == "Se cargó con el comprobante equivocado"

    row_after = _pending_row(admin_client, store.id, shift["id"], bd=bd)
    assert row_after["outstanding"] == 50_000, "reversar la consignación tiene que devolver el saldo pendiente"
    assert row_after["deposited"] == 0

    # Una consignación reversada no puede volver a reversarse.
    again = admin_client.post(
        f"{API}/admin/deposits/{deposit_id}/reverse",
        json={"reason": "otra vez"},
        headers=idem(),
    )
    assert again.status_code == 400
    assert again.json()["error"]["code"] == "DEPOSIT_ALREADY_REVERSED"


def test_pending_deposit_is_null_with_reason_when_shift_closed_without_count(
    admin_client: TestClient,
    db: Session,
    store: Any,
) -> None:
    """Defensivo: HOY ningún camino HTTP deja un turno `CLOSED` con
    `to_deposit IS NULL` (`app.shifts.service._finalize_close` y
    `close_administrative` siempre lo completan — ver
    `outputs/backend-banco.md § gaps`). La columna es nullable en el modelo
    y el contrato de este territorio exige manejarlo (`to_deposit: null` con
    `reason`), así que esta única precondición se arma por ORM directo — es
    la excepción declarada de este archivo, no una lectura de libro: no hay
    HOY una puerta HTTP que la produzca."""

    from app.core import clock as clock_module
    from app.shifts.models import BusinessDay, BusinessDayStatus, Shift, ShiftStatus

    bd = today_business_date(store)
    now = clock_module.now_utc()
    day = BusinessDay(
        organization_id=store.organization_id,
        store_id=store.id,
        business_date=bd,
        status=BusinessDayStatus.CLOSED,
        opened_at=now,
        closed_at=now,
    )
    db.add(day)
    db.flush()
    shift = Shift(
        organization_id=store.organization_id,
        store_id=store.id,
        business_day_id=day.id,
        status=ShiftStatus.CLOSED,
        opened_at=now,
        opened_by_employee_id=1,
        opened_by_employee_name="Test",
        cash_responsible_id=1,
        cash_responsible_name="Test",
        opening_cash_total=200_000,
        opening_denominations=[],
        closed_at=now,
        closed_by_employee_id=1,
        closed_by_employee_name="Test",
        closed_without_count=True,
        expected_cash=None,
        counted_cash=None,
        difference=None,
        to_deposit=None,
    )
    db.add(shift)
    db.commit()

    row = _pending_row(admin_client, store.id, shift.id, bd=bd)
    assert row["to_deposit"] is None
    assert row["reason"] is not None and len(row["reason"]) > 0
    assert row["outstanding"] is None
    assert row["deposited"] == 0


def test_pending_deposit_distinguishes_administrative_null_from_counted_zero(
    admin_client: TestClient,
    open_shift: Callable[..., dict],
    close_shift: Callable[..., dict],
    db: Session,
    clock: Any,
    store: Any,
) -> None:
    """C4/H-4 (iteración 2, bloqueante): el punto entero del hallazgo es que
    estos dos casos se DISTINGAN. Antes de la corrección, `pending_deposits`
    cortaba con `shift.to_deposit is None`, y un cierre ADMINISTRATIVO
    (`app/shifts/service.py::close_administrative`) nunca deja
    `to_deposit` en `NULL` — le escribe `expected - opening_cash_fixed`,
    derivado del libro, no de un conteo — así que esa rama era código
    muerto y el turno sin conteo se publicaba con una CIFRA, indistinguible
    de un turno arqueado a ciegas con saldo real cero.

    Caso A: turno cerrado ADMINISTRATIVAMENTE (`Shift.closed_without_count`)
    → `to_deposit: null` + `reason`.
    Caso B: turno ARQUEADO a mano con saldo real CERO (`to_deposit == 0`,
    un conteo de verdad que dio exactamente $0) → `to_deposit: 0`, SIN
    `reason` — publicar `null` acá sería esconder un dato real, y publicar
    un número en el caso A sería el cero mudo con otro disfraz (error
    repetido nº7). Los fixtures `open_shift`/`admin_client` (con su token)
    se instancian ANTES que `clock` en la lista de parámetros a propósito
    (`tests/banking/conftest.py`, docstring del módulo): el token ya se
    emitió con la hora real cuando el reloj de prueba lo adelanta.
    """

    # Caso B primero, con `closes_day=False`: dos turnos en el MISMO día de
    # negocio (`bd`), para poder pedir los dos en el mismo rango.
    zero_shift = open_shift(total=200_000)
    bd = today_business_date(store)
    zero_close = close_shift(zero_shift["id"], counted_cash=200_000, tips_cash_out=0, closes_day=False)
    assert zero_close["to_deposit"] == 0

    stale_shift = open_shift(total=200_000)

    # `is_shift_stale`: abierto pasada la hora de corte del día SIGUIENTE a
    # su fecha de negocio (`app/shifts/service.py::is_shift_stale`) — el
    # turno sigue teniendo `business_date == bd`, sólo se adelanta el
    # reloj que evalúa si está "abandonado".
    clock.advance(days=2)

    admin_resp = admin_client.post(
        f"{API}/admin/shifts/{stale_shift['id']}/close-administrative",
        json={"reason": "turno abandonado, prueba C4"},
        headers=idem(),
    )
    assert admin_resp.status_code == 200, admin_resp.text
    # `close_administrative` (`app/shifts/service.py`) responde sólo
    # `{to_deposit, closes_day}` — el `to_deposit` NO es null (es
    # `expected - opening_cash_fixed`, derivado del libro): esa es
    # exactamente la trampa del hallazgo, verificada acá antes de mirar
    # `GET /admin/deposits/pending`.
    assert admin_resp.json()["to_deposit"] is not None

    resp = admin_client.get(
        f"{API}/admin/deposits/pending",
        params={"store_id": store.id, "from": bd.isoformat(), "to": bd.isoformat()},
    )
    assert resp.status_code == 200, resp.text
    by_shift = {row["shift_id"]: row for row in resp.json()}

    admin_row = by_shift[stale_shift["id"]]
    assert admin_row["to_deposit"] is None, (
        f"turno cerrado ADMINISTRATIVAMENTE publicó to_deposit={admin_row['to_deposit']!r}: "
        "tiene que ser null (C4/H-4)"
    )
    assert admin_row["reason"], "null sin reason es un null mudo"
    assert "administrativ" in admin_row["reason"].lower()
    assert admin_row["outstanding"] is None

    zero_row = by_shift[zero_shift["id"]]
    assert zero_row["to_deposit"] == 0, "turno ARQUEADO con saldo real cero tiene que publicar 0, no null"
    assert zero_row["reason"] is None, "0 real no lleva reason: no es el mismo caso que el administrativo"
    assert zero_row["outstanding"] == 0


def test_create_deposit_rejects_allocation_to_shift_closed_without_count(
    admin_client: TestClient,
    open_shift: Callable[..., dict],
    clock: Any,
    store: Any,
) -> None:
    """C4/H-4, punto 3 (decisión ratificada del Maestro, iteración 2): si
    «por consignar» publica `null` para un turno cerrado sin conteo,
    imputarle una consignación a ESE turno tiene que rechazarse — si no, la
    misma pregunta («¿cuánto queda por consignar de este turno?») vuelve a
    tener dos respuestas, que es el H-4 de 2b otra vez. Esto NO deja plata
    sin poder consignarse: la misma consignación se registra igual con
    `allocations: []` (el monto es input del usuario)."""

    stale_shift = open_shift(total=200_000)
    clock.advance(days=2)
    admin_resp = admin_client.post(
        f"{API}/admin/shifts/{stale_shift['id']}/close-administrative",
        json={"reason": "turno abandonado, prueba C4"},
        headers=idem(),
    )
    assert admin_resp.status_code == 200, admin_resp.text

    rejected = admin_client.post(
        f"{API}/admin/deposits",
        params={"store_id": store.id},
        json={
            "amount": 10_000,
            "receipt_photo": "comprobante.jpg",
            "allocations": [{"shift_id": stale_shift["id"], "amount": 10_000}],
        },
        headers=idem(),
    )
    assert rejected.status_code == 400, rejected.text
    assert rejected.json()["error"]["code"] == "SHIFT_CLOSED_WITHOUT_COUNT"

    accepted = admin_client.post(
        f"{API}/admin/deposits",
        params={"store_id": store.id},
        json={
            "amount": 10_000,
            "receipt_photo": "comprobante.jpg",
            "allocations": [],
        },
        headers=idem(),
    )
    assert accepted.status_code == 201, accepted.text
    assert accepted.json()["allocations"] == []
