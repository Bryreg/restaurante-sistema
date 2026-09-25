"""El desglose del turno muestra el efectivo de domicilios APARTE (2c).

Renglón del checklist: «El efectivo de domicilios se arquea aparte del cajón
hasta que el domiciliario liquida (test sobre el desglose del turno)».

Vive en `tests/shifts` porque lo que se prueba acá es el CONTRATO del turno:
`compute_breakdown` no cambió de fórmula, `expected` no cambió de
significado, y el renglón nuevo es informativo. El flujo de punta a punta
(cobrar, liquidar, deshacer) vive en `tests/channels/test_delivery_settlement.py`.
"""

from __future__ import annotations

import inspect
from typing import Any

from sqlalchemy.orm import Session

from app.shifts import hooks, service
from app.shifts.models import Shift
from app.shifts.schemas import BreakdownOut


def test_the_expected_formula_did_not_change(db: Session, open_shift: Any) -> None:
    """La fórmula, letra por letra: `base + cash_sales + incomes − expenses
    − pickups`. `delivery_cash_pending` **no** está sumado."""
    source = inspect.getsource(service.compute_breakdown)
    assert "expected = base + sales.cash + incomes - expenses - pickups" in source, (
        "cambió la única matemática del esperado del turno"
    )
    # Y no hay una segunda fórmula escondida sumando el pendiente.
    assert "expected + sales.delivery" not in source
    assert "delivery_cash_pending +" not in source.split("return")[0]


def test_the_breakdown_publishes_the_pending_delivery_cash_as_its_own_row(
    db: Session, open_shift: Any
) -> None:
    body = open_shift()
    shift = db.get(Shift, body["id"])
    assert shift is not None

    breakdown = service.compute_breakdown(db, shift)
    assert set(breakdown) == {
        "base",
        "cash_sales",
        "incomes",
        "expenses",
        "pickups",
        # 2026-09-24: lo consignado desde el cajón (resta del esperado) y,
        # informativo, cuánto de la base es plata de días anteriores.
        "deposits",
        "carried_in",
        "expected",
        "delivery_cash_pending",
    }
    assert breakdown["delivery_cash_pending"] == 0
    assert breakdown["expected"] == shift.opening_cash_total

    # El contrato publicado lo trae con default 0 (aditivo: ningún cliente
    # viejo se rompe).
    out = BreakdownOut(**breakdown)
    assert out.delivery_cash_pending == 0
    assert BreakdownOut(base=0, cash_sales=0, incomes=0, expenses=0, pickups=0, expected=0).delivery_cash_pending == 0


def test_sales_totals_keeps_the_old_buckets_untouched(db: Session, open_shift: Any) -> None:
    """Los cuatro campos nuevos son ADITIVOS: `cash`/`card`/`transfer`/
    `other` y sus propinas siguen existiendo con el mismo nombre, que es lo
    que leen `tips.py`, el cierre y el frontend."""
    body = open_shift()
    totals = hooks.get_sales_totals(db, body["id"])
    for field in (
        "cash",
        "card",
        "transfer",
        "other",
        "tips_cash",
        "tips_card",
        "tips_transfer",
        "tips_other",
        "delivery_cash",
        "delivery_cash_pending",
        "tips_delivery",
        "tips_delivery_pending",
    ):
        assert hasattr(totals, field), f"`SalesTotals` perdió `{field}`"
        assert isinstance(getattr(totals, field), int)


def test_the_shift_summary_hides_the_pending_row_from_whoever_cannot_see_the_expected(
    db: Session, device_client: Any, open_shift: Any, set_feature: Any, employees: Any, identify: Any
) -> None:
    """`cash.blind_close` encendida: el responsable de caja no ve el
    esperado, y tampoco el renglón derivado. `None`, no `0` — "no te lo
    puedo mostrar" no es "no hay"."""
    set_feature("cash.blind_close", True)
    open_shift()

    resp = device_client.get("/api/v1/shifts/current")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["expected_cash"] is None
    assert body["delivery_cash_pending"] is None, "`0` diría «no hay efectivo pendiente», que es otra cosa"

    set_feature("cash.blind_close", False)
    resp = device_client.get("/api/v1/shifts/current")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["expected_cash"] is not None
    assert body["delivery_cash_pending"] == 0


def test_the_close_review_shows_the_pending_delivery_cash_next_to_the_expected(
    db: Session, device_client: Any, open_shift: Any, set_feature: Any
) -> None:
    """El paso 2 del cierre a ciegas es EL momento en que importa: quien
    contó está por justificar una diferencia, y el efectivo que tiene el
    domiciliario **no está en el cajón**.

    El renglón va al lado del esperado, sin entrar en la ecuación.
    """
    import uuid

    body = open_shift()
    shift_id = body["id"]
    count = device_client.post(
        f"/api/v1/shifts/{shift_id}/close/count",
        json={
            "counted_cash": {"denominations": [{"value": 50000, "count": 4}], "total": 200_000},
            # La sede exige foto del conteo por default (`photo_required_on_close`).
            "photo": "data:image/png;base64,iVBORw0KGgo=",
        },
        headers={"Idempotency-Key": str(uuid.uuid4())},
    )
    assert count.status_code in (200, 201), count.text
    count_id = count.json()["count_id"] if "count_id" in count.json() else count.json()["id"]

    review = device_client.get(f"/api/v1/shifts/{shift_id}/close/{count_id}/review")
    assert review.status_code == 200, review.text
    equation = review.json()["equation"]
    assert "delivery_cash_pending" in equation
    assert equation["delivery_cash_pending"] == 0
    # Y la ecuación sigue cerrando sin ese término.
    assert (
        equation["expected"]
        == equation["base"]
        + equation["cash_sales"]
        + equation["incomes"]
        - equation["expenses"]
        - equation["pickups"]
    )
