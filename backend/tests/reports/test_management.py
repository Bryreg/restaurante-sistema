"""Gestión del período (`GET /admin/reports/management`) y el mes en curso
de Hoy (`GET /admin/reports/month`): rotación de mesas y RevPASH, costo primo,
mano de obra por hora, ranking de anulaciones/descuentos/cortesías, ritmo
hacia la meta y el aviso «¿le puedo creer a estos números?».

Todo entra por HTTP. Las cifras esperadas se arman con la misma regla que
publica el servidor (venta neta, minutos, sillas) y se comparan contra lo que
el propio servidor devuelve en otra sección, nunca contra una cuenta paralela
de la venta."""

from __future__ import annotations

from datetime import date
from typing import Any
from uuid import uuid4

from fastapi.testclient import TestClient
from sqlalchemy import select

from app.orders.money import round_half_up
from tests.conftest import KNOWN_PINS
from tests.payroll.conftest import bogota_utc
from tests.reports.test_cost import _make_flat_cost_ingredient

API = "/api/v1"
DAY = "2026-03-10"  # martes


def _idem() -> dict[str, str]:
    return {"Idempotency-Key": str(uuid4())}


def _management(admin_client: TestClient, store: Any, frm: str = DAY, to: str = DAY) -> dict[str, Any]:
    resp = admin_client.get(f"{API}/admin/reports/management", params={"store_id": store.id, "from": frm, "to": to})
    assert resp.status_code == 200, resp.text
    return resp.json()  # type: ignore[no-any-return]


def _surcharge_table(admin_client: TestClient, store: Any) -> None:
    resp = admin_client.post(
        f"{API}/admin/payroll/surcharge-tables",
        params={"store_id": store.id},
        json={
            "valid_from": "2020-01-01",
            "night_start_hour": 19,
            "night_end_hour": 6,
            "night_surcharge_bp": 3500,
            "sunday_holiday_surcharge_bp": 8000,
            "overtime_surcharge_bp": 2500,
            "weekly_ordinary_hours": 46,
        },
        headers=_idem(),
    )
    assert resp.status_code == 201, resp.text


def _wage(admin_client: TestClient, store: Any, employee: Any, pesos: int) -> None:
    resp = admin_client.post(
        f"{API}/admin/payroll/wages",
        params={"store_id": store.id},
        json={"employee_id": employee.id, "hourly_wage_pesos": pesos, "valid_from": "2020-01-01"},
        headers=_idem(),
    )
    assert resp.status_code == 201, resp.text


# ---------------------------------------------------------------------------
# h2 · Rotación de mesas y RevPASH.
# ---------------------------------------------------------------------------


def test_turnover_and_revpash_come_from_seats_services_and_opening_hours(
    db: Any, admin_client: TestClient, device_client: TestClient, identify: Any, employees: Any,
    open_shift: Any, sell: Any, drink_product: Any, store: Any, tables: Any, clock: Any, set_feature: Any,
) -> None:
    set_feature("pos.tables", True)
    store.opening_hours = [{"weekday": d, "open": "11:00", "close": "22:00"} for d in range(7)]
    db.commit()
    clock.set(bogota_utc(2026, 3, 10, 12, 0))
    open_shift()
    identify(device_client, employees["cashier"])
    sell(drink_product, channel="dine_in", table_ids=[tables[0].id])

    body = _management(admin_client, store)
    t = body["turnover"]
    assert t["seats"] == 8 and t["tables"] == 2
    assert t["services"] == 1
    assert t["dine_in_orders"] == 1
    assert t["dine_in_covers"] == 4  # la mesa de 4 sillas, sin comensales escritos
    # 1 comanda ÷ (2 mesas × 1 servicio) = media vuelta.
    assert t["orders_per_table_service_bp"] == 5000
    # 4 comensales ÷ (8 sillas × 1 servicio).
    assert t["covers_per_seat_service_bp"] == 5000
    assert t["open_hours"] == "11.00"
    assert t["seat_hours"] == "88.00"
    net = body["prime_cost"]["net_sales"]
    assert t["net_sales"] == net > 0
    assert t["revpash"] == round_half_up(net * 60, 8 * 11 * 60)
    assert t["turnover_reason"] is None and t["revpash_reason"] is None


def test_without_seats_or_opening_hours_turnover_and_revpash_are_null_with_reason(
    admin_client: TestClient, store: Any, set_feature: Any, clock: Any,
) -> None:
    set_feature("pos.tables", True)
    clock.set(bogota_utc(2026, 3, 10, 12, 0))
    t = _management(admin_client, store)["turnover"]
    assert t["seats"] is None
    assert t["orders_per_table_service_bp"] is None and "Zonas y mesas" in t["turnover_reason"]
    assert t["revpash"] is None and t["revpash_reason"]

    set_feature("pos.tables", False)
    off = _management(admin_client, store)["turnover"]
    assert off["revpash"] is None and "Mesas" in off["turnover_reason"]


def test_revpash_needs_the_opening_hours(
    db: Any, admin_client: TestClient, store: Any, tables: Any, set_feature: Any, clock: Any,
) -> None:
    set_feature("pos.tables", True)
    clock.set(bogota_utc(2026, 3, 10, 12, 0))
    t = _management(admin_client, store)["turnover"]
    assert t["seats"] == 8
    assert t["revpash"] is None and "horario" in t["revpash_reason"]


# ---------------------------------------------------------------------------
# h3 · Costo primo y h4 · mano de obra por hora.
# ---------------------------------------------------------------------------


def _worked_morning(
    db: Any, admin_client: TestClient, device_client: TestClient, identify: Any, employees: Any,
    open_shift: Any, sell: Any, main_product: Any, store: Any, clock: Any, set_recipe: Any,
) -> None:
    """Cocinero de 7:00 a 13:00 y cajero de 11:00 a 13:00 (sigue adentro),
    los dos a $10.000 la hora, y un plato de $25.000 con $1.000 de costo
    teórico vendido a las 11:30."""
    _surcharge_table(admin_client, store)
    cook, cashier = employees["operator2"], employees["cashier"]
    _wage(admin_client, store, cook, 10_000)
    _wage(admin_client, store, cashier, 10_000)
    ingredient = _make_flat_cost_ingredient(db, store, cost_micros_per_g=10_000_000, name="Insumo redondo")
    set_recipe(main_product.id, lines=[{"ingredient_id": ingredient.id, "qty": "100", "unit": "g"}])

    clock.set(bogota_utc(2026, 3, 10, 7, 0))
    identify(device_client, cook)
    clock.set(bogota_utc(2026, 3, 10, 11, 0))
    open_shift(responsible=cashier)
    clock.set(bogota_utc(2026, 3, 10, 11, 30))
    identify(device_client, cashier)
    sell(main_product)
    clock.set(bogota_utc(2026, 3, 10, 13, 0))
    resp = device_client.post(f"{API}/attendance/out", json={"employee_id": cook.id, "pin": KNOWN_PINS["Operator2"]})
    assert resp.status_code == 200, resp.text


def test_labor_by_hour_spreads_the_payroll_by_worked_minutes_and_prime_cost_adds_it(
    db: Any, admin_client: TestClient, device_client: TestClient, identify: Any, employees: Any,
    open_shift: Any, sell: Any, main_product: Any, store: Any, clock: Any, set_recipe: Any, set_feature: Any,
) -> None:
    set_feature("payroll", True)
    _worked_morning(db, admin_client, device_client, identify, employees, open_shift, sell, main_product, store, clock, set_recipe)

    body = _management(admin_client, store)
    labor = body["labor_by_hour"]
    assert labor["available"] is True, labor["reason"]
    # 6 h del cocinero + 2 h del cajero, a $10.000.
    assert labor["labor_total"] == 80_000
    assert labor["worked_hours_total"] == "8.00"
    by_hour = {h["hour"]: h for h in labor["hours"]}
    assert [h["hour"] for h in labor["hours"]] == [7, 8, 9, 10, 11, 12]
    assert by_hour[7]["labor"] == 10_000 and by_hour[7]["worked_hours"] == "1.00"
    assert by_hour[11]["labor"] == 20_000 and by_hour[11]["worked_hours"] == "2.00"
    assert sum(h["labor"] for h in labor["hours"]) == labor["labor_total"]
    assert by_hour[7]["net"] == 0 and by_hour[7]["labor_pct_bp"] is None
    assert by_hour[11]["net"] > 0
    assert by_hour[11]["labor_pct_bp"] == round_half_up(20_000 * 10_000, by_hour[11]["net"])

    prime = body["prime_cost"]
    assert prime["cost_basis"] == "theoretical"
    assert prime["cost_of_goods"] == prime["cost_theoretical"] == 1_000
    assert prime["cost_real"] is None and prime["cost_real_reason"]
    assert prime["labor"] == 80_000
    assert prime["prime_cost"] == 81_000
    assert prime["prime_cost_pct_bp"] == round_half_up(81_000 * 10_000, prime["net_sales"])
    assert prime["reason"] is None


def test_prime_cost_without_payroll_is_null_with_reason_not_zero(
    db: Any, admin_client: TestClient, device_client: TestClient, identify: Any, employees: Any,
    open_shift: Any, sell: Any, main_product: Any, store: Any, clock: Any, set_recipe: Any, set_feature: Any,
) -> None:
    set_feature("payroll", False)
    ingredient = _make_flat_cost_ingredient(db, store, cost_micros_per_g=10_000_000, name="Insumo redondo")
    set_recipe(main_product.id, lines=[{"ingredient_id": ingredient.id, "qty": "100", "unit": "g"}])
    clock.set(bogota_utc(2026, 3, 10, 12, 0))
    open_shift()
    identify(device_client, employees["cashier"])
    sell(main_product)

    body = _management(admin_client, store)
    prime = body["prime_cost"]
    assert prime["cost_of_goods"] == 1_000
    assert prime["labor"] is None and "Nómina" in prime["labor_reason"]
    assert prime["prime_cost"] is None and prime["prime_cost_pct_bp"] is None
    assert prime["reason"] == prime["labor_reason"]
    assert body["labor_by_hour"]["available"] is False
    assert all(h["labor"] is None for h in body["labor_by_hour"]["hours"])


def test_prime_cost_without_recipes_has_no_cost_of_goods(
    admin_client: TestClient, device_client: TestClient, identify: Any, employees: Any,
    open_shift: Any, sell: Any, drink_product: Any, store: Any, clock: Any, set_feature: Any,
) -> None:
    set_feature("payroll", False)
    clock.set(bogota_utc(2026, 3, 10, 12, 0))
    open_shift()
    identify(device_client, employees["cashier"])
    sell(drink_product)
    prime = _management(admin_client, store)["prime_cost"]
    assert prime["cost_of_goods"] is None and prime["cost_basis"] is None
    assert prime["cost_reason"] and prime["prime_cost"] is None


# ---------------------------------------------------------------------------
# h8 · Anulaciones, descuentos y cortesías por persona.
# ---------------------------------------------------------------------------


def test_controls_ranking_by_person_with_amounts_and_authorizer(
    admin_client: TestClient, device_client: TestClient, identify: Any, employees: Any,
    open_shift: Any, main_product: Any, store: Any, clock: Any, set_feature: Any,
) -> None:
    set_feature("pos.courtesies", True)
    set_feature("pos.discounts", True)
    clock.set(bogota_utc(2026, 3, 10, 12, 0))
    open_shift()
    identify(device_client, employees["operator"])
    order = device_client.post(f"{API}/orders", json={"channel": "counter"}, headers=_idem()).json()
    order = device_client.post(
        f"{API}/orders/{order['id']}/items",
        json={"expected_version": order["version"], "items": [{"product_id": main_product.id, "qty": 1}] * 3},
        headers=_idem(),
    ).json()
    first, second, third = (i["id"] for i in order["items"])

    resp = device_client.post(
        f"{API}/orders/{order['id']}/items/{first}/void",
        json={"expected_version": order["version"], "reason": "duplicate"},
    )
    assert resp.status_code == 200, resp.text
    order = resp.json()
    resp = device_client.post(
        f"{API}/orders/{order['id']}/discounts",
        json={"expected_version": order["version"], "scope": "item", "item_id": second, "kind": "percent", "value": 5, "reason": "promo"},
    )
    assert resp.status_code == 200, resp.text
    order = resp.json()
    discount_amount = order["discounts"][0]["amount"]
    resp = device_client.post(
        f"{API}/orders/{order['id']}/items/{third}/courtesy",
        json={"expected_version": order["version"], "reason": "complaint", "authorizer_pin": KNOWN_PINS["Admin"]},
    )
    assert resp.status_code == 200, resp.text

    controls = _management(admin_client, store)["controls"]
    assert len(controls["rows"]) == 1
    row = controls["rows"][0]
    assert row["employee_name"] == "Operator"
    assert row["voids_count"] == 1 and row["voids_amount"] == main_product.price_dine_in
    assert row["discounts_count"] == 1 and row["discounts_amount"] == discount_amount
    assert row["courtesies_count"] == 1 and row["courtesies_amount"] == main_product.price_dine_in
    assert row["total_count"] == 3
    assert row["total_amount"] == 2 * main_product.price_dine_in + discount_amount
    authorizers = {a["name"]: a for a in row["authorizers"]}
    assert authorizers["Admin"] == {"name": "Admin", "count": 1, "amount": main_product.price_dine_in}
    assert authorizers["Sin autorización"]["count"] == 2
    assert controls["total_amount"] == row["total_amount"]
    assert controls["total_pct_of_sales_bp"] is None  # no se cobró nada: sin venta, sin porcentaje


# ---------------------------------------------------------------------------
# h10 · «¿Le puedo creer a estos números?»
# ---------------------------------------------------------------------------


def test_reliability_lists_what_makes_the_numbers_doubtful(
    admin_client: TestClient, store: Any, set_feature: Any, clock: Any,
) -> None:
    for key in ("pos.tables", "payroll", "inventory.perpetual", "inventory.counts"):
        set_feature(key, True)
    clock.set(bogota_utc(2026, 3, 10, 12, 0))
    rel = _management(admin_client, store)["reliability"]
    keys = [i["key"] for i in rel["items"]]
    assert rel["reliable"] is False
    assert "inventory_never_counted" in keys
    assert "payroll_no_tables" in keys
    assert "no_table_seats" in keys and "no_opening_hours" in keys
    # Lo crítico primero.
    severities = [i["severity"] for i in rel["items"]]
    assert severities == sorted(severities, key=lambda s: 0 if s == "critical" else 1)


def test_reliability_with_the_functions_off_and_nothing_sold_is_clean(
    admin_client: TestClient, store: Any, set_feature: Any, clock: Any,
) -> None:
    for key in ("pos.tables", "payroll", "inventory.counts"):
        set_feature(key, False)
    clock.set(bogota_utc(2026, 3, 10, 12, 0))
    rel = _management(admin_client, store)["reliability"]
    assert rel == {"date_from": DAY, "date_to": DAY, "reliable": True, "items": []}


def test_reliability_flags_people_without_contract_and_unconfirmed_legal_params(
    db: Any, admin_client: TestClient, device_client: TestClient, identify: Any, employees: Any,
    open_shift: Any, sell: Any, main_product: Any, store: Any, clock: Any, set_recipe: Any, set_feature: Any,
) -> None:
    set_feature("payroll", True)
    _worked_morning(db, admin_client, device_client, identify, employees, open_shift, sell, main_product, store, clock, set_recipe)
    rel = _management(admin_client, store)["reliability"]
    by_key = {i["key"]: i for i in rel["items"]}
    assert by_key["payroll_without_contract"]["count"] == 2
    assert "payroll_legal_unconfirmed" in by_key
    # La tabla la cargó una persona: está confirmada.
    assert "payroll_tables_unconfirmed" not in by_key
    assert "payroll_without_wage" not in by_key


def test_management_is_admin_only_and_scoped_to_the_organization(
    device_client: TestClient, admin_client: TestClient, store_b: Any, store: Any,
) -> None:
    assert device_client.get(
        f"{API}/admin/reports/management", params={"store_id": store.id, "from": DAY, "to": DAY}
    ).status_code in (401, 403)
    assert admin_client.get(
        f"{API}/admin/reports/management", params={"store_id": store_b.id, "from": DAY, "to": DAY}
    ).status_code == 404


# ---------------------------------------------------------------------------
# h6 · El ritmo hacia la meta del mes (Hoy).
# ---------------------------------------------------------------------------


def test_goal_pace_expected_to_date_and_projection_from_closed_days(
    admin_client: TestClient, device_client: TestClient, identify: Any, employees: Any,
    open_shift: Any, sell: Any, drink_product: Any, store: Any, clock: Any,
) -> None:
    clock.set(bogota_utc(2026, 3, 2, 12, 0))
    open_shift()
    identify(device_client, employees["cashier"])
    sell(drink_product)  # $5.000 cobrados el 2 de marzo
    resp = admin_client.put(
        f"{API}/admin/accountant-report/goal", json={"store_id": store.id, "year": 2026, "month": 3, "amount": 310_000}
    )
    assert resp.status_code == 200, resp.text

    clock.set(bogota_utc(2026, 3, 3, 12, 0))
    resp = admin_client.get(f"{API}/admin/reports/month", params={"store_id": store.id})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["date_from"] == "2026-03-01" and body["date_to"] == "2026-03-03"
    pace = body["goal_pace"]
    assert pace["goal"] == 310_000 and pace["goal_source"] == "month"
    assert pace["month_to_date"] == 5_000
    assert pace["days_elapsed"] == 3 and pace["closed_days"] == 2 and pace["days_in_month"] == 31
    assert pace["expected_to_date"] == 30_000  # 310.000 × 3 ÷ 31
    assert pace["gap_to_expected"] == -25_000
    assert pace["projected_month_end"] == 77_500  # 5.000 ÷ 2 días cerrados × 31
    assert pace["projected_vs_goal_bp"] == 2_500
    assert pace["on_track"] is False
    assert pace["progress_bp"] == round_half_up(5_000 * 10_000, 310_000)
    assert body["prime_cost"]["date_from"] == "2026-03-01"
    assert "items" in body["reliability"]


def test_goal_pace_without_goal_says_where_to_set_it(admin_client: TestClient, store: Any, clock: Any) -> None:
    clock.set(bogota_utc(2026, 3, 1, 12, 0))
    pace = admin_client.get(f"{API}/admin/reports/month", params={"store_id": store.id}).json()["goal_pace"]
    assert pace["goal"] is None and pace["expected_to_date"] is None and pace["on_track"] is None
    assert "Informe del contador" in pace["reason"]
    assert pace["projected_month_end"] is None and pace["projection_reason"]


# ---------------------------------------------------------------------------
# Inventario: la varianza de un período se reparte por días entre conteos.
# ---------------------------------------------------------------------------


def test_period_variance_is_prorated_by_business_days_with_its_sign() -> None:
    from app.inventory.hooks import CountWindowVariance, period_variance

    window = CountWindowVariance(opening_date=date(2026, 3, 1), closing_date=date(2026, 3, 11), value=1_000, uncosted_ingredients=0)
    inside = period_variance([window], date_from=date(2026, 3, 1), date_to=date(2026, 3, 10))
    assert inside.value == 1_000 and inside.days_covered == 10 and inside.days_in_period == 10

    partial = period_variance([window], date_from=date(2026, 3, 5), date_to=date(2026, 3, 31))
    assert partial.value == 600 and partial.days_covered == 6 and partial.days_in_period == 27

    negative = CountWindowVariance(opening_date=date(2026, 3, 1), closing_date=date(2026, 3, 11), value=-1_000, uncosted_ingredients=0)
    assert period_variance([negative], date_from=date(2026, 3, 5), date_to=date(2026, 3, 31)).value == -600

    outside = period_variance([window], date_from=date(2026, 4, 1), date_to=date(2026, 4, 30))
    assert outside.value is None and outside.reason


def test_count_windows_read_only_applied_full_counts(db: Any, store: Any) -> None:
    from app.inventory.hooks import count_window_variances
    from app.inventory.models import StockCount

    assert db.execute(select(StockCount)).first() is None
    assert count_window_variances(db, store_id=store.id, date_from=date(2026, 3, 1), date_to=date(2026, 3, 31)) == []
