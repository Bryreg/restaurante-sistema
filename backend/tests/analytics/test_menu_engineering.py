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

    resp = admin_client.get(
        "/api/v1/admin/menu-engineering", params={"store_id": store.id, "from": "2020-01-01", "to": "2099-12-31"}
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
