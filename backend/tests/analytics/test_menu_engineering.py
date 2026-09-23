"""`GET /admin/menu-engineering` (T4, `features/fase-3-dinero-control/
spec.md § 2` tabla T4; SPEC-NEGOCIO §5.4/§6.4).

Tests obligatorios de la misión: (1) el costo usado es el CONGELADO en el
ítem, no la ficha de hoy (la carta cambia después de vender y el resultado
no se mueve); (2) `analytics.menu_engineering` responde `400
FEATURE_DISABLED` apagada, y funciona encendida; (3) sin ventas del período,
`available=False` con `reason`, nunca una lista vacía muda."""

from __future__ import annotations

from typing import Any, Callable

from fastapi.testclient import TestClient

from app.catalog.models import Product
from app.stores.models import Store


def test_menu_engineering_without_sales_is_unavailable_with_a_reason(
    admin_client: TestClient, store: Store, enable_analytics: Callable[[], None]
) -> None:
    enable_analytics()
    resp = admin_client.get(
        "/api/v1/admin/menu-engineering", params={"store_id": store.id, "from": "2020-01-01", "to": "2099-12-31"}
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["available"] is False
    assert body["reason"]
    assert body["rows"] == []


def test_menu_engineering_uses_the_frozen_cost_never_the_recipe_of_today(
    db: Any,
    admin_client: TestClient,
    device_client: TestClient,
    identify: Any,
    employees: dict[str, Any],
    open_shift: Any,
    sell: Callable[..., Any],
    main_product: Product,
    store: Store,
    set_recipe: Callable[..., Any],
    create_ingredient: Callable[..., dict[str, Any]],
    enable_analytics: Callable[[], None],
) -> None:
    enable_analytics()
    ingredient = create_ingredient(name="Costo congelado", official_cost="10")  # $10/g
    # 100 g -> $1.000 exactos de costo teórico congelado.
    set_recipe(main_product.id, lines=[{"ingredient_id": ingredient["id"], "qty": "100", "unit": "g"}])

    open_shift()
    identify(device_client, employees["cashier"])
    sell(main_product, qty=3)

    # La carta CAMBIA después de la venta: nuevo costo oficial, y una ficha
    # nueva con MENOS insumo. Si `menu-engineering` revalorara, el costo
    # teórico publicado se movería.
    from app.inventory.models import Ingredient

    ing_row = db.get(Ingredient, ingredient["id"])
    ing_row.official_cost_micros = 999_000_000  # $999/g: si esto se leyera, el costo explotaría
    db.commit()
    set_recipe(main_product.id, lines=[{"ingredient_id": ingredient["id"], "qty": "1", "unit": "g"}], version=1)

    # `min_units=1`: este test prueba el costo congelado, no el mínimo de
    # muestra (3 unidades no alcanzarían el mínimo por defecto de 20).
    resp = admin_client.get(
        "/api/v1/admin/menu-engineering",
        params={"store_id": store.id, "from": "2020-01-01", "to": "2099-12-31", "min_units": 1},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["available"] is True
    row = next(r for r in body["rows"] if r["product_id"] == main_product.id)
    assert row["qty_sold"] == 3
    # 3 platos × $1.000 = $3.000, con el costo y la ficha de CUANDO SE VENDIÓ,
    # no con los $999/g ni el gramo único de la ficha nueva.
    assert row["theoretical_cost"] == 3000, (
        f"el costo tiene que ser el CONGELADO al vender ($3.000), no revalorado con la carta de hoy (dio {row['theoretical_cost']})"
    )
    assert row["revenue_net"] > 0
    assert row["classification"] in {"star", "plowhorse", "puzzle", "dog"}


def test_menu_engineering_requires_its_feature_flag(
    admin_client: TestClient, store: Store, enable_analytics: Callable[[], None], set_feature: Callable[..., None]
) -> None:
    enable_analytics()
    set_feature("analytics.menu_engineering", False)
    resp = admin_client.get(
        "/api/v1/admin/menu-engineering", params={"store_id": store.id, "from": "2020-01-01", "to": "2099-12-31"}
    )
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "FEATURE_DISABLED"


def test_menu_engineering_dependency_wins_over_store_gate(
    admin_client: TestClient, store: Store, set_feature: Callable[..., None]
) -> None:
    """`catalog.recipes` (la dependencia) apagada tiene que cortar con
    `FEATURE_DISABLED` ANTES que cualquier otra validación — nombrando la
    dependencia, no `analytics.menu_engineering` en sí, para no mandar al
    administrador a la pantalla equivocada (error repetido nº6)."""
    set_feature("catalog.recipes", False)
    set_feature("analytics.menu_engineering", True)
    resp = admin_client.get(
        "/api/v1/admin/menu-engineering", params={"store_id": store.id, "from": "2020-01-01", "to": "2099-12-31"}
    )
    assert resp.status_code == 400
    body = resp.json()
    assert body["error"]["code"] == "FEATURE_DISABLED"
    assert body["error"]["feature"] == "catalog.recipes"


def test_menu_engineering_excludes_fees_uses_unit_margin_min_units_and_category(
    db: Any,
    admin_client: TestClient,
    device_client: TestClient,
    identify: Any,
    employees: dict[str, Any],
    open_shift: Any,
    sell: Callable[..., Any],
    main_product: Product,
    second_product: Product,
    store: Store,
    set_recipe: Callable[..., Any],
    create_ingredient: Callable[..., dict[str, Any]],
    enable_analytics: Callable[[], None],
) -> None:
    """Informe #7 / analista #5, con números fijados.

    Bandeja ($25.000, INC 8 %): 20 unidades, 100 g a $10/g = $1.000 c/u.
    Sancocho ($18.000): 25 unidades, 10 g = $100 c/u. Un «cargo» vendido 5
    veces y después marcado `is_delivery_fee` no entra ni a la matriz ni a
    los umbrales (con él, n = 3 y el umbral bajaba de 3.500 a 2.333 bp)."""
    enable_analytics()
    ing = create_ingredient(name="Insumo matriz", official_cost="10")
    set_recipe(main_product.id, lines=[{"ingredient_id": ing["id"], "qty": "100", "unit": "g"}])
    set_recipe(second_product.id, lines=[{"ingredient_id": ing["id"], "qty": "10", "unit": "g"}])
    from app.catalog.models import Category
    from app.core import clock as clock_module

    now = clock_module.now_utc()
    cargo_cat = Category(
        organization_id=store.organization_id, store_id=store.id, name="Cargos", sort_order=9,
        default_course="main", default_station=None, active=True,
    )
    db.add(cargo_cat)
    db.flush()
    cargo = Product(
        organization_id=store.organization_id, store_id=store.id, category_id=cargo_cat.id, name="Cargo",
        description=None, station=None, default_course="main", price_dine_in=5000, price_takeout=None,
        price_delivery=None, price_platform=None, tax_code="inc_8", active=True, available=True, daily_count=None,
        daily_remaining=None, unavailable_by_employee_id=None, unavailable_by_employee_name=None,
        unavailable_at=None, created_at=now, updated_at=now,
    )
    db.add(cargo)
    db.commit()

    open_shift()
    for product, qty in ((main_product, 20), (second_product, 25), (cargo, 5)):
        identify(device_client, employees["cashier"])
        sell(product, qty=qty)
    cargo.is_delivery_fee = True
    db.commit()

    params = {"store_id": store.id, "from": "2020-01-01", "to": "2099-12-31"}
    body = admin_client.get("/api/v1/admin/menu-engineering", params=params).json()
    assert body["available"] is True
    assert body["excluded_products"] == 1
    assert {r["product_id"] for r in body["rows"]} == {main_product.id, second_product.id}
    assert body["popularity_threshold_bp"] == 3500  # 70 % ÷ 2 platos
    # Margen unitario promedio: (442.963 + 414.167) ÷ 45 = 19.047,3 → 19.047.
    assert body["avg_contribution_margin_per_unit"] == 19047
    assert body["min_units"] == 20
    assert body["costed_pct_bp"] == 10000
    rows = {r["product_id"]: r for r in body["rows"]}
    bandeja, sancocho = rows[main_product.id], rows[second_product.id]
    # Bandeja: $500.000 con INC → 462.963 netos − $20.000 = 442.963; ÷ 20 = 22.148.
    assert (bandeja["contribution_margin"], bandeja["contribution_margin_per_unit"]) == (442963, 22148)
    assert bandeja["category_name"] == "Platos"
    assert (bandeja["classification"], bandeja["recommended_action"]) == ("star", "Mantener")
    # Sancocho: 416.667 − 2.500 = 414.167; ÷ 25 = 16.566,7 → 16.567 < 19.047.
    assert sancocho["contribution_margin_per_unit"] == 16567
    assert (sancocho["classification"], sancocho["recommended_action"]) == ("plowhorse", "Revisar precio")
    assert body["counts_by_class"] == {
        "star": 1, "plowhorse": 1, "puzzle": 0, "dog": 0, "unclassified": 0, "insufficient_sample": 0,
    }

    # Con `min_units=21` la Bandeja (20) no se clasifica, pero sigue en la
    # mezcla: los umbrales no cambian.
    body = admin_client.get("/api/v1/admin/menu-engineering", params={**params, "min_units": 21}).json()
    rows = {r["product_id"]: r for r in body["rows"]}
    assert rows[main_product.id]["insufficient_sample"] is True
    assert rows[main_product.id]["classification"] is None
    assert rows[main_product.id]["recommended_action"] is None
    assert "20 unidades" in rows[main_product.id]["classification_reason"]
    assert rows[second_product.id]["classification"] == "plowhorse"
    assert body["popularity_threshold_bp"] == 3500 and body["avg_contribution_margin_per_unit"] == 19047
    assert body["counts_by_class"]["insufficient_sample"] == 1

    # Filtro por categoría: umbrales DENTRO de la categoría (n = 1).
    body = admin_client.get(
        "/api/v1/admin/menu-engineering", params={**params, "category_id": second_product.category_id}
    ).json()
    assert [r["product_id"] for r in body["rows"]] == [second_product.id]
    assert body["category_id"] == second_product.category_id
    assert body["popularity_threshold_bp"] == 7000
    assert body["avg_contribution_margin_per_unit"] == 16567
    assert body["rows"][0]["classification"] == "star"
