"""Concurrencia real del cobro sobre `race_env` (única fixture válida para
tests con hilos, `CONTRATO-INTERNO-1b-1.md §1` y `§3` — corrección de la
lección D-2 de la entrega 1a).

Dueño del test de punta a punta de `pay_order -> orders.service.claim_payment`
en carrera (`CONTRATO-INTERNO-1b-1.md §2.5`): este archivo.
"""

from __future__ import annotations

import threading
import uuid
from datetime import date
from typing import Any

from sqlalchemy import select

from app.fiscal import service as fiscal_service
from app.fiscal.models import FiscalDocument, FiscalDocumentType

NO_TIP = {"asked": True, "accepted": False, "modified": False, "amount": 0}


def _seed_fiscal_range(race_env: Any) -> None:
    """`race_env` arma su PROPIA base (no la de `db`/`store`): el rango
    vigente para que `pay_order` no corte con `NO_FISCAL_RANGE` se crea acá
    (mismo criterio que `tests/payments/conftest.py::seed_fiscal_ranges`,
    pero sobre `race_env.session_factory()`)."""
    from app.core import clock as clock_module

    with race_env.session_factory() as db:
        fiscal_service.create_range(
            db,
            organization_id=race_env.organization_id,
            store_id=race_env.store_id,
            document_type=FiscalDocumentType.POS_EQUIVALENT,
            prefix="POS",
            from_number=1,
            to_number=999_999_999,
            resolution_number="18760000001",
            resolution_date=date(2020, 1, 1),
            valid_from=date(2020, 1, 1),
            valid_until=date(2099, 12, 31),
            technical_key="race-technical-key",
            now=clock_module.now_utc(),
        )
        db.commit()


def _seed_order(race_env: Any, *, qty: int = 1) -> dict[str, Any]:
    _seed_fiscal_range(race_env)
    product_id = race_env.seed_product(name="Gaseosa", price=5000, station=None, tax_code="inc_8")
    race_env.open_shift()
    order_resp = race_env.client.post(
        "/api/v1/orders", json={"channel": "counter"}, headers={"Idempotency-Key": str(uuid.uuid4())}
    )
    assert order_resp.status_code == 201, order_resp.text
    order = order_resp.json()
    items_resp = race_env.client.post(
        f"/api/v1/orders/{order['id']}/items",
        json={"expected_version": order["version"], "items": [{"product_id": product_id, "qty": qty}]},
        headers={"Idempotency-Key": str(uuid.uuid4())},
    )
    assert items_resp.status_code == 200, items_resp.text
    return items_resp.json()


def _pay_body(race_env: Any, total: int) -> dict[str, Any]:
    return {"pin": race_env.employee_pin, "tip": NO_TIP, "splits": [{"method": "cash", "amount": total}]}


def test_two_concurrent_payments_one_wins_one_conflicts(race_env: Any) -> None:
    """Dos cobros concurrentes sobre la MISMA comanda: exactamente uno gana
    (`201`). La perdedora es siempre `409 ORDER_ALREADY_PAID`: lo levanta el
    `UPDATE` condicional atómico de `orders.service.claim_payment` cuando la
    carrera es real (Postgres, CI) y lo levanta `assert_payable` cuando SQLite
    serializó los dos requests y la comanda ya figura cobrada (hallazgo B-1 del
    auditor de 1b-1; mismo criterio que
    `tests/shifts/test_open.py::test_two_concurrent_opens_one_wins_and_the_other_is_rejected`,
    la carrera análoga de 1a: no hay forma determinística de forzar el
    entrelazado real de dos hilos contra SQLite). Un solo `fiscal_document`
    para la comanda de cualquier forma."""
    order = _seed_order(race_env)
    total = order["totals"]["total"]
    body = _pay_body(race_env, total)

    outcomes: list[tuple[int, str]] = []
    lock = threading.Lock()

    def _attempt() -> None:
        resp = race_env.client.post(
            f"/api/v1/orders/{order['id']}/payments",
            json=body,
            headers={"Idempotency-Key": str(uuid.uuid4())},
        )
        code = resp.json().get("error", {}).get("code", "") if resp.status_code >= 400 else ""
        with lock:
            outcomes.append((resp.status_code, code))

    threads = [threading.Thread(target=_attempt) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    winners = [o for o in outcomes if o[0] == 201]
    assert len(winners) == 1, f"exactamente un cobro debía ganar, resultados: {outcomes}"
    losers = [o for o in outcomes if o not in winners]
    assert losers and losers[0] == (409, "ORDER_ALREADY_PAID"), (
        f"la perdedora tiene que ser un rechazo declarado, resultados: {outcomes}"
    )

    with race_env.session_factory() as db:
        rows = db.execute(select(FiscalDocument).where(FiscalDocument.order_id == order["id"])).scalars().all()
        assert len(rows) == 1
        assert rows[0].target_key == f"order:{order['id']}"


def test_same_idempotency_key_replays_same_response_single_document(race_env: Any) -> None:
    order = _seed_order(race_env)
    total = order["totals"]["total"]
    body = _pay_body(race_env, total)
    key = str(uuid.uuid4())

    first = race_env.client.post(
        f"/api/v1/orders/{order['id']}/payments", json=body, headers={"Idempotency-Key": key}
    )
    assert first.status_code == 201, first.text
    second = race_env.client.post(
        f"/api/v1/orders/{order['id']}/payments", json=body, headers={"Idempotency-Key": key}
    )
    assert second.status_code == 201, second.text
    assert first.json() == second.json()

    with race_env.session_factory() as db:
        rows = db.execute(select(FiscalDocument).where(FiscalDocument.order_id == order["id"])).scalars().all()
        assert len(rows) == 1
