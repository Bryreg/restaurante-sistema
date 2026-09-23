"""`GET /admin/break-even` con costos fijos AUTOMÁTICOS (decisión del dueño,
informe de visualización #2) y `GET`/`PATCH /admin/expenses/settings`, que
queda obsoleta: se guarda, se lee y no entra a ninguna cuenta.

`break_even_amount` sigue siendo `null` **con motivo**, jamás `0`, sin
costos fijos registrados o sin margen de contribución calculable. Las cifras
esperadas se arman con lo que `GET /admin/sales` (la agregación real) ya
reporta — nunca con una venta sumada a mano en el test."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any
from uuid import uuid4

from fastapi.testclient import TestClient

from app.orders.money import round_half_up
from app.stores.models import Store

_WIDE_RANGE = {"from": "2020-01-01", "to": "2099-12-31"}
# El reloj de prueba está en 2026-01-15 12:00 UTC (07:00 en Bogotá, corte
# 06:00): la fecha de negocio es el 15, el día 15 de este mes.
_JANUARY = {"from": "2026-01-01", "to": "2026-01-31"}


def _idem() -> dict[str, str]:
    return {"Idempotency-Key": str(uuid4())}


def _obligation(admin_client: TestClient, store: Store, *, amount: int, due: str, category: str = "rent") -> dict[str, Any]:
    resp = admin_client.post(
        f"/api/v1/admin/obligations?store_id={store.id}",
        json={"category": category, "description": "Obligación de prueba", "amount": amount, "due_date": due},
        headers=_idem(),
    )
    assert resp.status_code == 201, resp.text
    return dict(resp.json())


def _expense(admin_client: TestClient, store: Store, *, amount: int, day: str, category: str = "utilities") -> None:
    resp = admin_client.post(
        f"/api/v1/admin/expenses?store_id={store.id}",
        json={"category": category, "description": "Gasto de prueba", "amount": amount, "business_date": day, "source": "bank"},
        headers=_idem(),
    )
    assert resp.status_code == 201, resp.text


def _sales_total(admin_client: TestClient, store: Store, period: dict[str, str]) -> dict[str, Any]:
    resp = admin_client.get("/api/v1/admin/sales", params={"store_id": store.id, **period, "group_by": "business_date"})
    assert resp.status_code == 200, resp.text
    return dict(resp.json()["total"])


def test_settings_default_is_none(admin_client: TestClient, store: Store) -> None:
    resp = admin_client.get(f"/api/v1/admin/expenses/settings?store_id={store.id}")
    assert resp.status_code == 200, resp.text
    assert resp.json()["fixed_costs"] is None


def test_patch_settings_still_stores_the_deprecated_value(admin_client: TestClient, store: Store) -> None:
    resp = admin_client.patch(f"/api/v1/admin/expenses/settings?store_id={store.id}", json={"fixed_costs": 3_000_000})
    assert resp.status_code == 200, resp.text
    assert resp.json()["fixed_costs"] == 3_000_000
    assert admin_client.get(f"/api/v1/admin/expenses/settings?store_id={store.id}").json()["fixed_costs"] == 3_000_000


def test_settings_reject_negative_fixed_costs(admin_client: TestClient, store: Store) -> None:
    resp = admin_client.patch(f"/api/v1/admin/expenses/settings?store_id={store.id}", json={"fixed_costs": -1})
    assert resp.status_code == 400, resp.text


def test_break_even_without_registered_fixed_costs_is_null_with_reason_even_with_a_manual_value(
    admin_client: TestClient, store: Store, set_feature: Callable[..., None]
) -> None:
    """Sin obligaciones, sin nómina (apagada) y sin gastos, no hay costos
    fijos registrados: el equilibrio es `null` con motivo, jamás `$0`. El
    número escrito a mano en la configuración vieja NO lo rescata."""
    set_feature("payroll", False)
    admin_client.patch(f"/api/v1/admin/expenses/settings?store_id={store.id}", json={"fixed_costs": 9_000_000})

    body = admin_client.get("/api/v1/admin/break-even", params={"store_id": store.id, **_WIDE_RANGE}).json()
    assert body["fixed_costs"] == 0
    assert body["fixed_costs_source"] == "automatic"
    assert body["fixed_costs_breakdown"] == []
    assert body["available"] is False
    assert body["break_even_amount"] is None
    assert body["progress_bp"] is None
    assert body["gap_amount"] is None
    assert body["days_to_break_even_at_current_pace"] is None
    assert body["reason"]


def test_break_even_fixed_costs_are_obligations_plus_expenses_of_the_period_never_the_manual_value(
    admin_client: TestClient, store: Store, set_feature: Callable[..., None]
) -> None:
    set_feature("payroll", False)
    admin_client.patch(f"/api/v1/admin/expenses/settings?store_id={store.id}", json={"fixed_costs": 9_000_000})
    _obligation(admin_client, store, amount=1_000_000, due="2026-01-05", category="rent")
    _obligation(admin_client, store, amount=300_000, due="2026-01-20", category="taxes")
    _expense(admin_client, store, amount=200_000, day="2026-01-10", category="utilities")
    # Fuera del período: no cuentan.
    _obligation(admin_client, store, amount=777_000, due="2026-02-05")
    _expense(admin_client, store, amount=55_000, day="2025-12-31")
    # Cancelada: no cuenta.
    cancelled = _obligation(admin_client, store, amount=450_000, due="2026-01-06", category="utilities")
    admin_client.post(f"/api/v1/admin/obligations/{cancelled['id']}/cancel", json={"reason": "no aplica"}, headers=_idem())

    body = admin_client.get("/api/v1/admin/break-even", params={"store_id": store.id, **_JANUARY}).json()
    assert body["fixed_costs"] == 1_500_000
    assert body["fixed_costs_breakdown"] == [
        {"label": "Arriendo", "amount": 1_000_000, "source": "obligations"},
        {"label": "Impuestos", "amount": 300_000, "source": "obligations"},
        {"label": "Gastos de servicios", "amount": 200_000, "source": "expenses"},
    ]
    # Sin ventas: el margen no se puede calcular, y el equilibrio tampoco.
    assert body["net_sales"] == 0
    assert body["available"] is False
    assert body["break_even_amount"] is None
    assert body["reason"]


def test_break_even_with_costed_sales_computes_amount_progress_gap_and_pace(
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
    """Equilibrio = fijos × venta / (venta − costo), con el margen exacto.
    Con fijos de $100.000 y una sola venta de $5.000 el equilibrio queda
    muy arriba: `gap_amount` es lo que falta, `progress_bp` la venta sobre
    el equilibrio y los días al ritmo actual se redondean hacia arriba."""
    set_feature("payroll", False)
    set_recipe(drink_product.id, lines=[{"ingredient_id": ingredient_seeded.id, "qty": "10", "unit": "g"}])
    open_shift()
    identify(device_client, employees["cashier"])
    sell(drink_product, qty=1)
    _obligation(admin_client, store, amount=100_000, due="2026-01-05")

    total = _sales_total(admin_client, store, _JANUARY)
    net, cost = total["net"], total["theoretical_cost"]
    assert net > 0 and cost is not None and net - cost > 0

    body = admin_client.get("/api/v1/admin/break-even", params={"store_id": store.id, **_JANUARY}).json()
    assert body["available"] is True, body
    assert body["net_sales"] == net
    assert body["costed_pct"] == 100
    assert body["costed_pct_min"] == 95
    assert body["contribution_margin_pct_bp"] == round_half_up((net - cost) * 10_000, net)

    expected_break_even = round_half_up(100_000 * net, net - cost)
    assert body["break_even_amount"] == expected_break_even
    assert body["progress_bp"] == round_half_up(net * 10_000, expected_break_even)
    assert body["gap_amount"] == expected_break_even - net
    # Día 15 de un período de 31: ritmo = venta / 15 días.
    assert body["days_in_period"] == 31
    assert body["days_elapsed"] == 15
    assert body["days_to_break_even_at_current_pace"] == -(-((expected_break_even - net) * 15) // net)


def test_break_even_pace_is_null_when_the_period_already_ended(
    admin_client: TestClient, store: Store, set_feature: Callable[..., None], clock: Any
) -> None:
    set_feature("payroll", False)
    _obligation(admin_client, store, amount=100_000, due="2025-12-05")
    body = admin_client.get(
        "/api/v1/admin/break-even", params={"store_id": store.id, "from": "2025-12-01", "to": "2025-12-31"}
    ).json()
    assert body["days_elapsed"] is None
    assert body["days_to_break_even_at_current_pace"] is None


def test_break_even_is_null_with_reason_when_too_little_of_the_sale_has_cost(
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
    db: Any,
    clock: Any,
) -> None:
    """Informe científico #4: con media venta sin ficha técnica el margen
    sale inflado (la venta sin costo entra con costo $0). Por debajo de
    `costed_pct_min` el margen y el equilibrio son `null` con motivo, y la
    utilidad también — nunca una cifra que se lea como exacta."""
    from app.catalog.models import Product

    set_feature("payroll", False)
    set_recipe(drink_product.id, lines=[{"ingredient_id": ingredient_seeded.id, "qty": "10", "unit": "g"}])
    uncosted = Product(
        organization_id=store.organization_id, store_id=store.id, category_id=drink_product.category_id,
        name="Jugo sin ficha", description=None, station=None, default_course="beverage", price_dine_in=5000,
        price_takeout=None, price_delivery=None, price_platform=None, tax_code="inc_8", active=True, available=True,
        daily_count=None, daily_remaining=None, unavailable_by_employee_id=None, unavailable_by_employee_name=None,
        unavailable_at=None, created_at=drink_product.created_at, updated_at=drink_product.updated_at,
    )
    db.add(uncosted)
    db.commit()
    open_shift()
    identify(device_client, employees["cashier"])
    sell(drink_product, qty=1)
    sell(uncosted, qty=1)
    _obligation(admin_client, store, amount=100_000, due="2026-01-05")

    costed_pct = _sales_total(admin_client, store, _JANUARY)["costed_pct"]
    assert costed_pct is not None and costed_pct < 95, "precondición: media venta sin costo"

    body = admin_client.get("/api/v1/admin/break-even", params={"store_id": store.id, **_JANUARY}).json()
    assert body["costed_pct"] == costed_pct
    assert body["contribution_margin_pct_bp"] is None
    assert body["break_even_amount"] is None
    assert body["available"] is False
    assert "95 %" in body["reason"]

    profit = admin_client.get("/api/v1/admin/profit", params={"store_id": store.id, **_JANUARY}).json()
    assert profit["costed_pct"] == costed_pct
    assert profit["profit"] is None
    assert profit["available"] is False
    assert profit["reason"] == body["reason"]


def test_break_even_feature_disabled(admin_client: TestClient, store: Store, set_feature: Callable[..., None]) -> None:
    set_feature("money.obligations", False)
    resp = admin_client.get("/api/v1/admin/break-even", params={"store_id": store.id, **_WIDE_RANGE})
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "FEATURE_DISABLED"
