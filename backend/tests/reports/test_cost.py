"""`GET /admin/sales` gana `theoretical_value`/`gross_contribution`/
`recipe_coverage_pct`; `GET /admin/orders` gana `courtesies_theoretical_
value`; `GET /admin/today` gana las cuatro alertas de 2a (spec.md «Reports
that gain cost», pedido 2a, `backend-consumo`).

**Decisión declarada** (ver también el docstring de `app.reports.schemas` y
`app.orders.service.admin_list_orders`): los nombres de estos campos NO usan
las subcadenas `cost`/`margin` porque `tests/audit/test_security_
invariants.py` (territorio ajeno, no se toca) barre el OpenAPI de
`/admin/sales` y `/admin/orders` buscando exactamente esas subcadenas — un
invariante escrito para 1b que no distingue "costo visible al operador"
(prohibido) de "costo visible al admin" (lo que pide este pedido). El dato
es el mismo que pide la spec; sólo cambia la llave.
"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from app.core.quantity import apply_yield, line_cost_micros, micros_to_pesos


def _make_flat_cost_ingredient(db: Any, store: Any, *, cost_micros_per_g: int, name: str) -> Any:
    """Insumo con costo exacto por gramo, `yield_pct=100` (números
    redondos, sin la fracción del rendimiento de por medio) — inserta
    directo, como `tests/conftest.py::ingredient_seeded`, sólo que acá con
    un costo elegido a mano en vez del fijo de esa fixture."""
    from app.core import clock as clock_module
    from app.inventory.models import BaseUnit, Ingredient

    now = clock_module.now_utc()
    row = Ingredient(
        organization_id=store.organization_id,
        store_id=store.id,
        name=name,
        category="Otros",
        base_unit=BaseUnit.G,
        purchase_unit="kg",
        purchase_factor=1000,
        yield_pct=100,
        official_cost_micros=cost_micros_per_g,
        estimated_cost_micros=None,
        min_stock=1000,
        lead_time_days=1,
        perishable=False,
        key_item=False,
        active=True,
        consumption_untracked=False,
        substitute_ingredient_id=None,
        supplier_id=None,
        created_at=now,
        updated_at=now,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def test_sales_report_theoretical_value_sums_sub_peso_costs_without_losing_them(
    db: Any, admin_client: TestClient, device_client: TestClient, identify: Any, employees: Any, open_shift: Any,
    sell: Any, main_product: Any, store: Any, set_recipe: Any,
) -> None:
    """Ronda 2 (B-1-2/B-2), "el cero mudo congelado": `unit_cost` (pesos)
    de UN plato de $0,30 de costo teórico redondea correctamente a `0`
    (`micros_to_pesos(300_000)`, half-up) — no es un cero mudo, tiene
    `cost_source`. Pero **100 de esos platos cuestan $30, no $0**: si
    `_document_cost_stats`/`aggregate_sales` sumaran `unit_cost * qty` en
    PESOS (el bug), 100 × 0 sigue dando 0. Sumando en MICROS
    (`unit_cost_micros * qty`) y convirtiendo una sola vez al cerrar el
    bucket, da exacto.
    """
    ingrediente = _make_flat_cost_ingredient(db, store, cost_micros_per_g=3_000, name="Sazonador")
    # 100 g × $0,003/g = $0,30 de costo teórico por plato.
    set_recipe(main_product.id, lines=[{"ingredient_id": ingrediente.id, "qty": "100", "unit": "g"}])
    open_shift()
    identify(device_client, employees["cashier"])
    sell(main_product, qty=100)  # UN ítem, qty=100 -> 100 platos en una sola línea de venta

    from sqlalchemy import select

    from app.orders.models import OrderItem

    item = db.execute(select(OrderItem).where(OrderItem.qty == 100)).scalars().one()
    assert item.unit_cost == 0, "el costo unitario congelado SÍ redondea a 0: $0,30 no llega a $1"
    assert item.cost_source == "official", "el 0 tiene origen: no es un cero mudo"
    assert item.unit_cost_micros == 300_000, "pero el valor exacto, sin redondear, viaja en unit_cost_micros"

    # Rango ancho y fijo, no `date.today()`: el `business_date` (cutoff de
    # sede, `app.core.tz`) puede quedar un día detrás de la fecha calendario
    # UTC durante varias horas cada día (Bogotá es UTC-5) — un test que
    # compara contra `date.today()` es flaky por reloj real cerca de la
    # medianoche UTC. Mismo patrón que `tests/audit/test_cost_invariants.py`.
    resp = admin_client.get(
        "/api/v1/admin/sales",
        params={"store_id": store.id, "from": "2020-01-01", "to": "2099-12-31", "group_by": "business_date"},
    )
    assert resp.status_code == 200, resp.text
    row = resp.json()["rows"][0]
    assert row["theoretical_value"] == 30, (
        f"100 platos de $0,30 tienen que costar $30 en el reporte, no $0 (dio {row['theoretical_value']})"
    )
    total = resp.json()["total"]
    assert total["theoretical_value"] == 30


def test_sales_report_theoretical_value_matches_the_round_number_case(
    db: Any, admin_client: TestClient, device_client: TestClient, identify: Any, employees: Any, open_shift: Any,
    sell: Any, main_product: Any, store: Any, set_recipe: Any,
) -> None:
    """Regresión explícita del caso de `tests/audit/test_cost_invariants.py`
    (`test_the_sales_report_gains_theoretical_cost_gross_margin_and_costed_
    share`: insumo a $10/g, 100 g, rendimiento 100 % -> $1.000 exactos):
    el refactor a MICROS de `_document_cost_stats` (ronda 2, B-2) no puede
    mover ni un peso un número que ya daba exacto en pesos."""
    ingrediente = _make_flat_cost_ingredient(db, store, cost_micros_per_g=10_000_000, name="Insumo redondo")
    set_recipe(main_product.id, lines=[{"ingredient_id": ingrediente.id, "qty": "100", "unit": "g"}])
    open_shift()
    identify(device_client, employees["cashier"])
    sell(main_product, qty=1)

    from sqlalchemy import select

    from app.orders.models import OrderItem

    item = db.execute(select(OrderItem).where(OrderItem.product_id == main_product.id)).scalars().one()
    assert item.unit_cost == 1000

    # Rango ancho y fijo, no `date.today()`: el `business_date` (cutoff de
    # sede, `app.core.tz`) puede quedar un día detrás de la fecha calendario
    # UTC durante varias horas cada día (Bogotá es UTC-5) — un test que
    # compara contra `date.today()` es flaky por reloj real cerca de la
    # medianoche UTC. Mismo patrón que `tests/audit/test_cost_invariants.py`.
    resp = admin_client.get(
        "/api/v1/admin/sales",
        params={"store_id": store.id, "from": "2020-01-01", "to": "2099-12-31", "group_by": "business_date"},
    )
    assert resp.status_code == 200, resp.text
    row = resp.json()["rows"][0]
    assert row["theoretical_value"] == 1000, f"costo teórico del período: {row['theoretical_value']}"


def test_sales_report_gains_theoretical_value_and_coverage(
    admin_client: TestClient, device_client: TestClient, identify: Any, employees: Any, open_shift: Any,
    sell: Any, main_product: Any, store: Any, ingredient_seeded: Any, set_recipe: Any,
) -> None:
    set_recipe(main_product.id, lines=[{"ingredient_id": ingredient_seeded.id, "qty": "100", "unit": "g"}])
    open_shift()
    identify(device_client, employees["cashier"])
    sell(main_product, qty=1)

    qty_base = apply_yield(100 * 1000, ingredient_seeded.yield_pct)
    unit_cost_micros = line_cost_micros(qty_base, ingredient_seeded.official_cost_micros)
    expected_theoretical_value = micros_to_pesos(unit_cost_micros)

    # Rango ancho y fijo, no `date.today()`: el `business_date` (cutoff de
    # sede, `app.core.tz`) puede quedar un día detrás de la fecha calendario
    # UTC durante varias horas cada día (Bogotá es UTC-5) — un test que
    # compara contra `date.today()` es flaky por reloj real cerca de la
    # medianoche UTC. Mismo patrón que `tests/audit/test_cost_invariants.py`.
    resp = admin_client.get(
        "/api/v1/admin/sales",
        params={"store_id": store.id, "from": "2020-01-01", "to": "2099-12-31", "group_by": "business_date"},
    )
    assert resp.status_code == 200, resp.text
    row = resp.json()["rows"][0]

    assert row["theoretical_value"] == expected_theoretical_value
    assert row["gross_contribution"] == row["net"] - expected_theoretical_value
    assert row["recipe_coverage_pct"] == 100  # el único ítem vendido tenía ficha completa

    total = resp.json()["total"]
    assert total["theoretical_value"] == row["theoretical_value"]


def test_sales_report_theoretical_value_is_null_without_any_recipe(
    admin_client: TestClient, device_client: TestClient, identify: Any, employees: Any, open_shift: Any,
    sell: Any, drink_product: Any, store: Any,
) -> None:
    """Nunca un cero mudo: sin ninguna ficha, `theoretical_value` es `None`,
    no `0`. `recipe_coverage_pct` sí es `0` (hubo ventas, ninguna con
    ficha: es un dato real, no "sin datos")."""
    open_shift()
    identify(device_client, employees["cashier"])
    sell(drink_product, qty=1)

    # Rango ancho y fijo, no `date.today()`: el `business_date` (cutoff de
    # sede, `app.core.tz`) puede quedar un día detrás de la fecha calendario
    # UTC durante varias horas cada día (Bogotá es UTC-5) — un test que
    # compara contra `date.today()` es flaky por reloj real cerca de la
    # medianoche UTC. Mismo patrón que `tests/audit/test_cost_invariants.py`.
    resp = admin_client.get(
        "/api/v1/admin/sales",
        params={"store_id": store.id, "from": "2020-01-01", "to": "2099-12-31", "group_by": "business_date"},
    )
    row = resp.json()["rows"][0]
    assert row["theoretical_value"] is None
    assert row["gross_contribution"] is None
    assert row["recipe_coverage_pct"] == 0


def test_admin_orders_gains_courtesies_theoretical_value(
    admin_client: TestClient, device_client: TestClient, identify: Any, employees: Any, open_shift: Any,
    main_product: Any, store: Any, ingredient_seeded: Any, set_recipe: Any,
) -> None:
    from tests.reports.conftest import idem_headers

    set_recipe(main_product.id, lines=[{"ingredient_id": ingredient_seeded.id, "qty": "100", "unit": "g"}])
    open_shift()
    identify(device_client, employees["operator"])

    order = device_client.post("/api/v1/orders", json={"channel": "counter"}, headers=idem_headers()).json()
    order = device_client.post(
        f"/api/v1/orders/{order['id']}/items",
        json={"expected_version": order["version"], "items": [{"product_id": main_product.id, "qty": 1}]},
        headers=idem_headers(),
    ).json()
    item_id = order["items"][0]["id"]
    order = device_client.post(
        f"/api/v1/orders/{order['id']}/items/{item_id}/courtesy",
        json={"expected_version": order["version"], "reason": "complaint", "authorizer_pin": "9999"},
    ).json()
    send_resp = device_client.post(
        f"/api/v1/orders/{order['id']}/send", json={"expected_version": order["version"]}, headers=idem_headers()
    )
    assert send_resp.status_code == 200, send_resp.text

    qty_base = apply_yield(100 * 1000, ingredient_seeded.yield_pct)
    unit_cost_micros = line_cost_micros(qty_base, ingredient_seeded.official_cost_micros)
    expected = micros_to_pesos(unit_cost_micros)

    resp = admin_client.get("/api/v1/admin/orders", params={"store_id": store.id})
    assert resp.status_code == 200, resp.text
    rows = resp.json()["rows"]
    assert len(rows) == 1
    assert rows[0]["courtesies"] == 1
    assert rows[0]["courtesies_theoretical_value"] == expected


def test_today_reports_low_stock_alert(
    admin_client: TestClient, store: Any, ingredient_seeded: Any,
) -> None:
    """`ingredient_seeded.min_stock == 5000` (milésimas) y no se compró ni
    vendió nada: el stock teórico es `0 < min_stock`, así que tiene que
    aparecer en `ingredients_below_min` — distinta lista, distinto mensaje,
    de `ingredients_negative` (SPEC-NEGOCIO §5.2)."""
    resp = admin_client.get("/api/v1/admin/today", params={"store_id": store.id})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    below_min_ids = {row["ingredient_id"] for row in body["ingredients_below_min"]}
    assert ingredient_seeded.id in below_min_ids
    assert body["ingredients_negative"] == []  # todavía no hay ningún movimiento negativo
    assert body["preps_without_production"] == []
    assert body["products_discounting_nothing"] == []
