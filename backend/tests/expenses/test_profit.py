"""`GET /admin/profit`: ventas netas, costo, gastos, obligaciones, nómina,
`profit` — `null` con motivo cuando falta un dato, nunca `0` mudo.

**Prueba de que no se vuelve a sumar documentos de venta**: los tests que
necesitan `net_sales`/`cost` los comparan contra lo que `GET /admin/sales`
(la agregación real, `app.reports.service.aggregate_sales`) ya reporta para
el mismo rango — nunca contra una cuenta hecha a mano en el test."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any
from uuid import uuid4

from fastapi.testclient import TestClient

from app.core.modules import find_spec_safe
from app.orders.money import round_half_up
from app.stores.models import Store

_WIDE_RANGE = {"from": "2020-01-01", "to": "2099-12-31"}


def _idem() -> dict[str, str]:
    return {"Idempotency-Key": str(uuid4())}


def _sales_total(admin_client: TestClient, store: Store) -> dict[str, Any]:
    resp = admin_client.get(
        "/api/v1/admin/sales",
        params={"store_id": store.id, **_WIDE_RANGE, "group_by": "business_date"},
    )
    assert resp.status_code == 200, resp.text
    return dict(resp.json()["total"])


def test_profit_with_no_data_at_all_is_zero_and_available(
    admin_client: TestClient, store: Store, set_feature: Callable[..., None]
) -> None:
    """Sin ventas, sin gastos, sin obligaciones y sin nómina (función
    apagada): un resultado de $0 es un hecho real ("no pasó nada"), no "sin
    datos" — `available` es `True`. La precondición ("nómina apagada") se
    arma explícita: el default del perfil `full` la trae ENCENDIDA, y con
    ella encendida el resultado depende de si `app.payroll` ya aterrizó
    (ver `test_profit_payroll_seam`, más abajo)."""
    set_feature("payroll", False)
    resp = admin_client.get("/api/v1/admin/profit", params={"store_id": store.id, **_WIDE_RANGE})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["available"] is True
    assert body["net_sales"] == 0
    assert body["cost"] == 0
    assert body["expenses"] == 0
    assert body["obligations"] == 0
    assert body["payroll"] == 0
    assert body["profit"] == 0


def test_profit_subtracts_expenses_and_obligations_due_in_period(
    admin_client: TestClient, store: Store, set_feature: Callable[..., None]
) -> None:
    set_feature("payroll", False)
    admin_client.post(
        f"/api/v1/admin/expenses?store_id={store.id}",
        json={"category": "utilities", "description": "Agua", "amount": 200_000, "business_date": "2026-03-05", "source": "bank"},
        headers=_idem(),
    )
    admin_client.post(
        f"/api/v1/admin/obligations?store_id={store.id}",
        json={"category": "rent", "description": "Arriendo de marzo", "amount": 2_000_000, "due_date": "2026-03-05"},
        headers=_idem(),
    )

    resp = admin_client.get("/api/v1/admin/profit", params={"store_id": store.id, **_WIDE_RANGE})
    body = resp.json()
    assert body["expenses"] == 200_000
    assert body["obligations"] == 2_000_000
    assert body["profit"] == 0 - 0 - 200_000 - 2_000_000 - 0
    assert body["available"] is True


def test_profit_obligation_counts_by_due_date_not_by_settled_date(admin_client: TestClient, store: Store) -> None:
    """Accrual, no caja: la obligación cuenta para el período en que
    VENCE, sin importar si ya se saldó — así una obligación pagada tarde no
    "desaparece" del mes al que correspondía."""
    row = admin_client.post(
        f"/api/v1/admin/obligations?store_id={store.id}",
        json={"category": "rent", "description": "Arriendo", "amount": 500_000, "due_date": "2026-04-05"},
        headers=_idem(),
    ).json()
    admin_client.post(f"/api/v1/admin/obligations/{row['id']}/settle", json={"source": "bank"}, headers=_idem())

    narrow = {"from": "2026-04-01", "to": "2026-04-30"}
    resp = admin_client.get("/api/v1/admin/profit", params={"store_id": store.id, **narrow})
    assert resp.json()["obligations"] == 500_000

    outside = {"from": "2026-05-01", "to": "2026-05-31"}
    resp_outside = admin_client.get("/api/v1/admin/profit", params={"store_id": store.id, **outside})
    assert resp_outside.json()["obligations"] == 0


def test_cancelled_obligation_never_counts_toward_profit(admin_client: TestClient, store: Store) -> None:
    row = admin_client.post(
        f"/api/v1/admin/obligations?store_id={store.id}",
        json={"category": "taxes", "description": "ICA", "amount": 800_000, "due_date": "2026-06-10"},
        headers=_idem(),
    ).json()
    admin_client.post(f"/api/v1/admin/obligations/{row['id']}/cancel", json={"reason": "no aplica"}, headers=_idem())

    resp = admin_client.get("/api/v1/admin/profit", params={"store_id": store.id, **_WIDE_RANGE})
    assert resp.json()["obligations"] == 0


def test_profit_with_costed_sale_matches_reports_aggregation(
    admin_client: TestClient,
    device_client: TestClient,
    identify: Callable[..., Any],
    employees: Any,
    open_shift: Callable[..., dict[str, Any]],
    sell: Callable[..., Any],
    drink_product: Any,
    ingredient_seeded: Any,
    set_recipe: Callable[..., Any],
    store: Store,
    set_feature: Callable[..., None],
) -> None:
    set_feature("payroll", False)
    set_recipe(drink_product.id, lines=[{"ingredient_id": ingredient_seeded.id, "qty": "10", "unit": "g"}])
    open_shift()
    identify(device_client, employees["cashier"])
    sell(drink_product, qty=1)

    total = _sales_total(admin_client, store)
    assert total["theoretical_cost"] is not None

    resp = admin_client.get("/api/v1/admin/profit", params={"store_id": store.id, **_WIDE_RANGE})
    body = resp.json()
    assert body["available"] is True
    assert body["net_sales"] == total["net"]
    assert body["cost"] == total["theoretical_cost"]
    assert body["profit"] == total["net"] - total["theoretical_cost"]


def test_profit_unavailable_when_there_were_sales_without_theoretical_cost(
    admin_client: TestClient,
    device_client: TestClient,
    identify: Callable[..., Any],
    employees: Any,
    open_shift: Callable[..., dict[str, Any]],
    sell: Callable[..., Any],
    drink_product: Any,
    store: Store,
) -> None:
    """Hubo ventas, pero el producto no tiene ficha técnica: el costo
    teórico es `None` (no `0`), y la utilidad sale `null` con motivo — nunca
    finge que el costo fue cero."""
    open_shift()
    identify(device_client, employees["cashier"])
    sell(drink_product, qty=1)

    total = _sales_total(admin_client, store)
    assert total["theoretical_cost"] is None, "precondición: sin receta, sin costo teórico"

    resp = admin_client.get("/api/v1/admin/profit", params={"store_id": store.id, **_WIDE_RANGE})
    body = resp.json()
    assert body["available"] is False
    assert body["cost"] is None
    assert body["reason"]


def test_profit_payroll_seam(admin_client: TestClient, store: Store, set_feature: Callable[..., None]) -> None:
    """Costura hacia `app.payroll.hooks` (T3, construido en paralelo en esta
    misma ronda). Con `payroll` apagada, la nómina es `0` legítimo. Con
    `payroll` encendida, el comportamiento depende de si `app.payroll.hooks`
    y su `period_payroll_cost` ya aterrizaron: sin ellos, este dominio
    **nunca** calcula una nómina propia — sale `None` con motivo, nunca `0`
    mudo, y por lo tanto la utilidad sale `unavailable`."""
    set_feature("payroll", False)
    resp_off = admin_client.get("/api/v1/admin/profit", params={"store_id": store.id, **_WIDE_RANGE})
    assert resp_off.json()["payroll"] == 0

    set_feature("payroll", True)
    resp_on = admin_client.get("/api/v1/admin/profit", params={"store_id": store.id, **_WIDE_RANGE})
    body = resp_on.json()

    hooks_module = None
    if find_spec_safe("app.payroll.hooks") is not None:
        import importlib

        hooks_module = importlib.import_module("app.payroll.hooks")
    fn = getattr(hooks_module, "period_payroll_cost", None) if hooks_module is not None else None

    if fn is None:
        assert body["payroll"] is None
        assert body["payroll_reason"]
        assert body["available"] is False
    else:
        assert body["payroll"] is None or isinstance(body["payroll"], int)


# ---------------------------------------------------------------------------
# Informe de visualización #2: Utilidad y Punto de equilibrio cuentan la
# MISMA historia (mismos costos fijos, mismo costo de venta), cada renglón
# en % de la venta, y el período anterior al lado.
# ---------------------------------------------------------------------------

_JANUARY = {"from": "2026-01-01", "to": "2026-01-31"}


def test_profit_and_break_even_use_the_same_fixed_costs_and_agree_on_the_sign(
    admin_client: TestClient,
    device_client: TestClient,
    identify: Callable[..., Any],
    employees: Any,
    open_shift: Callable[..., dict[str, Any]],
    sell: Callable[..., Any],
    drink_product: Any,
    ingredient_seeded: Any,
    set_recipe: Callable[..., Any],
    store: Store,
    set_feature: Callable[..., None],
    clock: Any,
) -> None:
    """Con los mismos datos: ventas por ENCIMA del equilibrio ⇔ utilidad
    positiva, y ventas por DEBAJO ⇔ utilidad negativa. Antes el equilibrio
    usaba un costo fijo escrito a mano y podía decir «ya lo superaste» al
    lado de una pérdida."""
    set_feature("payroll", False)
    set_recipe(drink_product.id, lines=[{"ingredient_id": ingredient_seeded.id, "qty": "10", "unit": "g"}])
    open_shift()
    identify(device_client, employees["cashier"])
    sell(drink_product, qty=1)
    sales = admin_client.get(
        "/api/v1/admin/sales", params={"store_id": store.id, **_JANUARY, "group_by": "business_date"}
    ).json()["total"]
    net, cost = sales["net"], sales["theoretical_cost"]
    contribution = net - cost
    assert contribution > 2_000, "precondición: la venta deja margen"

    def _both() -> tuple[dict[str, Any], dict[str, Any]]:
        be = admin_client.get("/api/v1/admin/break-even", params={"store_id": store.id, **_JANUARY}).json()
        pr = admin_client.get("/api/v1/admin/profit", params={"store_id": store.id, **_JANUARY}).json()
        return be, pr

    # (a) Fijos de $1.000, menos que el margen: se pasó el equilibrio y hay utilidad.
    small = admin_client.post(
        f"/api/v1/admin/obligations?store_id={store.id}",
        json={"category": "rent", "description": "Chica", "amount": 1_000, "due_date": "2026-01-05"},
        headers=_idem(),
    ).json()
    be, pr = _both()
    assert be["fixed_costs"] == pr["fixed_costs"] == 1_000
    assert be["fixed_costs_breakdown"] == pr["fixed_costs_breakdown"]
    assert pr["profit"] == net - cost - 1_000
    assert pr["profit"] > 0
    assert net > be["break_even_amount"]
    assert be["gap_amount"] == 0
    assert be["progress_bp"] > 10_000
    assert be["days_to_break_even_at_current_pace"] == 0

    # (b) Mismos datos, fijos de $100.000: no llega al equilibrio y pierde plata.
    admin_client.post(f"/api/v1/admin/obligations/{small['id']}/cancel", json={"reason": "prueba"}, headers=_idem())
    admin_client.post(
        f"/api/v1/admin/obligations?store_id={store.id}",
        json={"category": "rent", "description": "Grande", "amount": 100_000, "due_date": "2026-01-05"},
        headers=_idem(),
    )
    be, pr = _both()
    assert be["fixed_costs"] == pr["fixed_costs"] == 100_000
    assert pr["profit"] == net - cost - 100_000
    assert pr["profit"] < 0
    assert net < be["break_even_amount"]
    assert be["gap_amount"] == be["break_even_amount"] - net > 0
    assert be["progress_bp"] < 10_000

    # Cada renglón como % de la venta neta, con signo.
    lines = {line["key"]: line for line in pr["lines"]}
    assert [line["key"] for line in pr["lines"]] == ["net_sales", "cost", "payroll", "obligations", "expenses", "profit"]
    assert lines["net_sales"]["pct_of_sales_bp"] == 10_000
    assert lines["cost"]["amount"] == cost
    assert lines["cost"]["pct_of_sales_bp"] == round_half_up(cost * 10_000, net)
    assert lines["obligations"]["pct_of_sales_bp"] == round_half_up(100_000 * 10_000, net)
    assert lines["profit"]["amount"] == pr["profit"]
    assert lines["profit"]["pct_of_sales_bp"] == -round_half_up(-pr["profit"] * 10_000, net)
    assert pr["costed_pct"] == 100


def test_profit_previous_period_has_the_same_length_and_the_same_lines(
    admin_client: TestClient, store: Store, set_feature: Callable[..., None]
) -> None:
    set_feature("payroll", False)
    admin_client.post(
        f"/api/v1/admin/obligations?store_id={store.id}",
        json={"category": "rent", "description": "Arriendo de enero", "amount": 500_000, "due_date": "2026-01-10"},
        headers=_idem(),
    )
    admin_client.post(
        f"/api/v1/admin/expenses?store_id={store.id}",
        json={"category": "maintenance", "description": "Nevera", "amount": 200_000, "business_date": "2026-02-10", "source": "bank"},
        headers=_idem(),
    )

    body = admin_client.get(
        "/api/v1/admin/profit", params={"store_id": store.id, "from": "2026-02-01", "to": "2026-02-28"}
    ).json()
    assert body["profit"] == -200_000
    assert body["fixed_costs_breakdown"] == [{"label": "Gastos de mantenimiento", "amount": 200_000, "source": "expenses"}]
    # Sin venta neta no hay porcentaje: `null`, nunca 0.
    assert all(line["pct_of_sales_bp"] is None for line in body["lines"])

    previous = body["previous_period"]
    assert previous["date_from"] == "2026-01-04"
    assert previous["date_to"] == "2026-01-31"
    assert previous["obligations"] == 500_000
    assert previous["expenses"] == 0
    assert previous["profit"] == -500_000
    assert [line["key"] for line in previous["lines"]] == [line["key"] for line in body["lines"]]
    assert "previous_period" not in previous
