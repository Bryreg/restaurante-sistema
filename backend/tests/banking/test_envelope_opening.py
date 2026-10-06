"""Las aperturas de antes se siguen leyendo; ya no se escriben.

Hubo tres maneras de abrir el cajón: la **base fija** (`fixed_base`), el
**conteo por sobres sellado a ciegas** (2026-09-26, `POST
/shifts/opening-counts` + `opening_count_id`) y la apertura **«igual al
café»** (2026-09-29). El dueño congeló una sola: la del café
(`tests/banking/test_opening_like_cafe.py`). Lo que cobran estos tests:

- las rutas de escritura de las otras dos ya no existen o ya no cambian
  nada: sellar un conteo, listar `carry-candidates`, mandar
  `opening_count_id` o una reserva al abrir, o una sede que quedó con
  `opening_mode = fixed_base` en su columna de legado;
- un turno que abrió con la base fija **sigue cerrando y reportando con su
  base** (nunca se reescribe la historia);
- un turno que abrió con un conteo sellado **sigue mostrando su conteo** por
  sobre en el resumen y en la ficha del turno.

Los turnos viejos se arman abriendo «igual al café» y dejando por ORM las
columnas como las escribía la regla de antes: es exactamente lo que queda
en la base de datos de un turno de entonces.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.core import clock
from app.shifts.models import Shift, ShiftOpeningCount
from app.stores import service as stores_service
from tests.banking.conftest import denoms, idem

API = "/api/v1"
BASE = 200_000


def _yesterday_with(open_shift: Callable[..., dict], close_shift: Callable[..., dict], amount: int) -> int:
    """Un turno cerrado con `amount` por consignar: abrió vacío y contó `amount`."""
    shift = open_shift(total=0)
    body = close_shift(shift["id"], counted_cash=amount, closes_day=False)
    assert body["to_deposit"] == amount
    return int(shift["id"])


def test_the_write_paths_of_the_old_openings_are_gone(
    db: Session, device_client: TestClient, identify: Any, employees: dict, store: Any
) -> None:
    cashier = employees["cashier"]
    identify(device_client, cashier)

    sellar = device_client.post(f"{API}/shifts/opening-counts", json={"envelopes": []}, headers=idem())
    assert sellar.status_code in (404, 405), sellar.text
    # `carry-candidates` ya no es una ruta propia (cae en `GET /shifts/{id}`).
    assert device_client.get(f"{API}/shifts/carry-candidates").status_code != 200

    info = device_client.get(f"{API}/shifts/opening").json()
    assert "mode" not in info and "pending_count" not in info

    # Una sede que quedó con la regla vieja en su columna de legado abre igual
    # «igual al café», y los campos viejos del cuerpo no cambian nada.
    settings = stores_service.get_cash_settings(db, store.id)
    settings.opening_mode = "fixed_base"
    db.commit()
    abierto = device_client.post(
        f"{API}/shifts/open",
        json={"cash_responsible_id": cashier.id, "opening_count_id": 999, "cash_reserve": 50_000},
        headers=idem(),
    )
    assert abierto.status_code == 201, abierto.text
    body = abierto.json()
    assert (body["opening_mode"], body["opening_cash_total"], body["cash_reserve"]) == ("envelopes", 0, 0)
    shift = db.get(Shift, body["id"])
    assert shift is not None
    assert (shift.opening_fixed_base, shift.opening_expected) == (0, 0)


def test_a_shift_opened_with_the_fixed_base_still_closes_and_reports_with_its_base(
    db: Session, admin_client: TestClient, device_client: TestClient, open_shift: Any, close_shift: Any, store: Any
) -> None:
    viejo = open_shift(total=BASE)
    shift = db.get(Shift, viejo["id"])
    assert shift is not None
    # Las columnas como las dejaba la regla de antes.
    shift.opening_mode = "fixed_base"
    shift.opening_fixed_base = BASE
    shift.opening_expected = None
    shift.opening_cause = None
    shift.opening_note = None
    db.commit()

    summary = admin_client.get(f"{API}/shifts/{viejo['id']}").json()
    assert summary["opening_mode"] == "fixed_base"

    body = close_shift(viejo["id"], counted_cash=BASE + 40_000, closes_day=False)
    assert body["to_deposit"] == 40_000, "la regla del turno se congeló al abrir: la base fija sigue restando"

    cuadres = admin_client.get(f"{API}/admin/cuadres", params={"store_id": store.id, "status": "closed"}).json()
    card = next(c for c in cuadres["shifts"] if c["shift_id"] == viejo["id"])
    assert card["opening_mode"] == "fixed_base"
    inicial = next(c for c in card["cuadres"] if c["kind"] == "opening")
    assert (inicial["counted"], inicial["expected"], inicial["difference"]) == (BASE, BASE, 0)


def test_a_shift_opened_with_a_sealed_envelope_count_still_shows_it(
    db: Session,
    admin_client: TestClient,
    device_client: TestClient,
    open_shift: Any,
    close_shift: Any,
    identify: Any,
    employees: dict,
    store: Any,
) -> None:
    lunes = _yesterday_with(open_shift, close_shift, 50_000)
    martes = _yesterday_with(open_shift, close_shift, 30_000)
    cashier = employees["cashier"]
    identify(device_client, cashier)
    abierto = device_client.post(
        f"{API}/shifts/open",
        json={
            "cash_responsible_id": cashier.id,
            "carried_shift_ids": [lunes, martes],
            "opening_cash": denoms(75_000),
            "opening_cause": "counting_error",
            "opening_note": "Faltaron cinco mil en un sobre",
        },
        headers=idem(),
    )
    assert abierto.status_code == 201, abierto.text
    shift_id = abierto.json()["id"]
    # Como lo dejaba la regla del 2026-09-26: el conteo sellado, sin esperado
    # de apertura en el turno.
    shift = db.get(Shift, shift_id)
    assert shift is not None
    shift.opening_expected = None
    db.add(
        ShiftOpeningCount(
            organization_id=store.organization_id,
            store_id=store.id,
            shift_id=shift_id,
            envelopes=[
                {"source_shift_id": lunes, "business_date": "2026-09-27", "expected": 50_000, "counted": 45_000,
                 "difference": -5_000, "denominations": []},
                {"source_shift_id": martes, "business_date": "2026-09-28", "expected": 30_000, "counted": 30_000,
                 "difference": 0, "denominations": []},
            ],
            expected_total=80_000,
            counted_total=75_000,
            counted_by_employee_id=cashier.id,
            counted_by_employee_name=cashier.name,
            created_at=clock.now_utc(),
            superseded=False,
        )
    )
    db.commit()

    summary = device_client.get(f"{API}/shifts/{shift_id}").json()
    assert summary["opening_count"]["counted_by"]["id"] == cashier.id
    assert {e["shift_id"]: e["difference"] for e in summary["opening_count"]["envelopes"]} == {
        lunes: -5_000,
        martes: 0,
    }
    record = admin_client.get(f"{API}/admin/records/shift/{shift_id}").json()
    assert record["opening_count"]["expected_total"] == 80_000
    assert record["opening_count"]["counted_total"] == 75_000
    assert record["opening_count"]["difference_total"] == -5_000

    cuadres = admin_client.get(f"{API}/admin/cuadres", params={"store_id": store.id, "status": "open"}).json()
    card = next(c for c in cuadres["shifts"] if c["shift_id"] == shift_id)
    inicial = next(c for c in card["cuadres"] if c["kind"] == "opening")
    assert (inicial["counted"], inicial["expected"], inicial["difference"]) == (75_000, 80_000, -5_000)


def test_a_new_store_needs_no_opening_rule(admin_client: TestClient) -> None:
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
    assert "opening_mode" not in settings.json()
