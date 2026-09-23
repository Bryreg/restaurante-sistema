"""`GET /admin/variance/by-dish` — SPEC-NEGOCIO §5.4: "varianza «por plato»
sólo como estimación prorrateada". Test obligatorio de la misión:
`method: "prorated"` presente y explícito en la respuesta."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Callable

from fastapi.testclient import TestClient

from app.auth.models import Employee
from app.stores.models import Store


def _noon_utc(day_offset: int, *, base: datetime) -> datetime:
    return base + timedelta(days=day_offset, hours=17)


def test_variance_by_dish_declares_the_prorated_method_and_distributes_by_theoretical_consumption(
    admin_client: TestClient,
    device_client: TestClient,
    identify: Any,
    store: Store,
    employees: dict[str, Employee],
    clock: Any,
    open_shift: Any,
    enable_analytics: Callable[[], None],
    create_ingredient: Callable[..., dict[str, Any]],
    apply_full_count: Callable[..., dict[str, Any]],
    main_product: Any,
    second_product: Any,
    set_recipe: Callable[..., Any],
    sell: Callable[..., Any],
) -> None:
    enable_analytics()
    ing = create_ingredient(name="Insumo compartido", official_cost="1", min_stock="1")
    # `main_product` consume el DOBLE de insumo por unidad que `second_product`.
    set_recipe(main_product.id, lines=[{"ingredient_id": ing["id"], "qty": "20", "unit": "g"}])
    set_recipe(second_product.id, lines=[{"ingredient_id": ing["id"], "qty": "10", "unit": "g"}])

    base = datetime(2026, 5, 1, tzinfo=timezone.utc)
    open_shift()

    clock.set(_noon_utc(0, base=base))
    opening_count = apply_full_count({ing["id"]: "10000"})

    clock.set(_noon_utc(1, base=base))
    identify(device_client, employees["cashier"])
    sell(main_product, qty=1)  # 20 g teóricos
    identify(device_client, employees["cashier"])
    sell(second_product, qty=1)  # 10 g teóricos -> total teórico 30 g, 2/3 al plato principal

    clock.set(_noon_utc(2, base=base))
    # Conteo de cierre: 300 g de fuga además de los 30 g vendidos.
    closing = apply_full_count({ing["id"]: "9670"})  # 10000 - 30 - 300 = 9670

    resp = admin_client.get(
        "/api/v1/admin/variance/by-dish", params={"store_id": store.id, "count_id": closing["id"]}
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["available"] is True
    assert body["method"] == "prorated", "SPEC-NEGOCIO §5.4: la varianza por plato es SIEMPRE una estimación prorrateada"
    assert body["opening_count_id"] == opening_count["id"]
    assert body["total_variance_value"] == 300  # $1/g * 300 g de fuga

    rows_by_product = {r["product_id"]: r for r in body["rows"]}
    assert main_product.id in rows_by_product
    assert second_product.id in rows_by_product
    # El reparto es por CONSUMO TEÓRICO: 20 g vs 10 g -> 2/3 y 1/3 de $300.
    assert rows_by_product[main_product.id]["variance_value"] == 200
    assert rows_by_product[second_product.id]["variance_value"] == 100
    assert rows_by_product[main_product.id]["theoretical_consumption_share_bp"] == 6667
    assert body["unattributed_variance_value"] == 0
    # Faltantes primero, por |valor|; tamaño de muestra a la vista (informe #8).
    assert [r["product_id"] for r in body["rows"]] == [main_product.id, second_product.id]
    assert all(r["direction"] == "shortage" for r in body["rows"])
    assert (body["window_hours"], body["window_days"], body["sales_in_window"]) == (48, 2, 2)
    assert body["insufficient_sample"] is True
    assert "48 h" in body["insufficient_sample_reason"] and "2 comandas" in body["insufficient_sample_reason"]


def test_variance_by_dish_weight_is_homogeneous_in_pesos_not_mixed_units(
    admin_client: TestClient,
    device_client: TestClient,
    identify: Any,
    store: Store,
    employees: dict[str, Employee],
    clock: Any,
    open_shift: Any,
    enable_analytics: Callable[[], None],
    create_ingredient: Callable[..., dict[str, Any]],
    apply_full_count: Callable[..., dict[str, Any]],
    main_product: Any,
    second_product: Any,
    set_recipe: Callable[..., Any],
    sell: Callable[..., Any],
) -> None:
    """Informe #8: Bandeja gasta 1.000 g de papa ($1/g = $1.000); Sancocho
    gasta 1 gaseosa ($2.000). Sumando cantidades crudas, la Bandeja pesaba
    99,9 % (1.000 g contra 1 unidad); en pesos pesa 1/3."""
    enable_analytics()
    papa = create_ingredient(name="Papa", official_cost="1", min_stock="1")
    gaseosa = create_ingredient(
        name="Gaseosa", base_unit="unit", purchase_unit="unit", purchase_factor=1, official_cost="2000", min_stock="1"
    )
    set_recipe(main_product.id, lines=[{"ingredient_id": papa["id"], "qty": "1000", "unit": "g"}])
    set_recipe(second_product.id, lines=[{"ingredient_id": gaseosa["id"], "qty": "1", "unit": "unit"}])

    base = datetime(2026, 6, 1, tzinfo=timezone.utc)
    open_shift()
    clock.set(_noon_utc(0, base=base))
    apply_full_count({papa["id"]: "10000", gaseosa["id"]: "10"})
    clock.set(_noon_utc(1, base=base))
    identify(device_client, employees["cashier"])
    sell(main_product, qty=1)
    identify(device_client, employees["cashier"])
    sell(second_product, qty=1)
    clock.set(_noon_utc(4, base=base))
    # Papa: 10.000 − 1.000 − 100 de fuga = 8.900 ($100 de faltante).
    # Gaseosa: 10 − 1 − 1 de fuga = 8 ($2.000 de faltante).
    closing = apply_full_count({papa["id"]: "8900", gaseosa["id"]: "8"})

    body = admin_client.get(
        "/api/v1/admin/variance/by-dish", params={"store_id": store.id, "count_id": closing["id"]}
    ).json()
    assert body["total_variance_value"] == 2100
    assert [r["product_id"] for r in body["rows"]] == [second_product.id, main_product.id]
    rows = {r["product_id"]: r for r in body["rows"]}
    assert rows[second_product.id]["variance_value"] == 2000
    assert rows[main_product.id]["variance_value"] == 100
    # Peso = costo teórico consumido: $2.000 vs $1.000 → 6667 / 3333.
    assert rows[second_product.id]["theoretical_consumption_share_bp"] == 6667
    assert rows[main_product.id]["theoretical_consumption_share_bp"] == 3333
    assert (body["window_days"], body["sales_in_window"]) == (4, 2)
    assert body["insufficient_sample"] is True  # 2 comandas < 20
    assert "48 h" not in body["insufficient_sample_reason"]


def test_variance_by_dish_without_a_previous_count_is_unavailable_with_a_reason(
    admin_client: TestClient,
    store: Store,
    enable_analytics: Callable[[], None],
    create_ingredient: Callable[..., dict[str, Any]],
    apply_full_count: Callable[..., dict[str, Any]],
) -> None:
    enable_analytics()
    ing = create_ingredient(name="Sin ventana", min_stock="1")
    count = apply_full_count({ing["id"]: "10"})

    resp = admin_client.get(
        "/api/v1/admin/variance/by-dish", params={"store_id": store.id, "count_id": count["id"]}
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["available"] is False
    assert body["reason"]
    assert body["method"] == "prorated"
    assert body["rows"] == []


def test_variance_by_dish_without_count_id_resolves_the_latest_applied_count(
    admin_client: TestClient,
    device_client: TestClient,
    identify: Any,
    store: Store,
    employees: dict[str, Employee],
    clock: Any,
    open_shift: Any,
    enable_analytics: Callable[[], None],
    create_ingredient: Callable[..., dict[str, Any]],
    apply_full_count: Callable[..., dict[str, Any]],
    main_product: Any,
    second_product: Any,
    set_recipe: Callable[..., Any],
    sell: Callable[..., Any],
) -> None:
    """AJUSTE ITERACIÓN 2 (C3/H-3, BLOQUEANTE): `count_id` es opcional.
    `frontend/src/api/analytics.ts::getVarianceByDish` siempre mandó sólo
    `store_id` (el comentario del cliente documenta por escrito "opcional:
    el más reciente si se omite") — el backend no lo cumplía y toda carga de
    la pantalla devolvía `422`. Este es el test que faltaba y por el que
    nadie vio el defecto: omitir `count_id` con un conteo aplicado tiene que
    devolver EXACTAMENTE lo mismo que pasarlo explícito."""
    enable_analytics()
    ing = create_ingredient(name="Insumo compartido (sin count_id)", official_cost="1", min_stock="1")
    set_recipe(main_product.id, lines=[{"ingredient_id": ing["id"], "qty": "20", "unit": "g"}])
    set_recipe(second_product.id, lines=[{"ingredient_id": ing["id"], "qty": "10", "unit": "g"}])

    base = datetime(2026, 6, 1, tzinfo=timezone.utc)
    open_shift()

    clock.set(_noon_utc(0, base=base))
    apply_full_count({ing["id"]: "10000"})

    clock.set(_noon_utc(1, base=base))
    identify(device_client, employees["cashier"])
    sell(main_product, qty=1)
    identify(device_client, employees["cashier"])
    sell(second_product, qty=1)

    clock.set(_noon_utc(2, base=base))
    closing = apply_full_count({ing["id"]: "9670"})

    explicit = admin_client.get(
        "/api/v1/admin/variance/by-dish", params={"store_id": store.id, "count_id": closing["id"]}
    )
    assert explicit.status_code == 200, explicit.text

    implicit = admin_client.get("/api/v1/admin/variance/by-dish", params={"store_id": store.id})
    assert implicit.status_code == 200, (
        f"sin `count_id` la ruta tiene que resolver sola, nunca 422: {implicit.text}"
    )

    assert implicit.json() == explicit.json(), (
        "omitir `count_id` (resolviendo el conteo aplicado más reciente) tiene que devolver "
        "EXACTAMENTE lo mismo que pasarlo explícito"
    )
    assert implicit.json()["count_id"] == closing["id"]


def test_variance_by_dish_without_count_id_and_without_any_applied_count_is_available_false_not_422(
    admin_client: TestClient,
    store: Store,
    enable_analytics: Callable[[], None],
) -> None:
    """AJUSTE ITERACIÓN 2 (C3/H-3): una sede sin NINGÚN conteo aplicado no
    tiene de dónde resolver `count_id`. La respuesta es `200` con
    `available: false` y `reason` en palabras — ni `404` ni `422` — la misma
    regla que `control_health_sustained` (D-1) ya aplica para "sin historial
    suficiente"."""
    enable_analytics()
    resp = admin_client.get("/api/v1/admin/variance/by-dish", params={"store_id": store.id})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["available"] is False
    assert body["reason"]
    assert body["method"] == "prorated"
    assert body["count_id"] is None
    assert body["rows"] == []


def test_variance_by_dish_with_explicit_count_id_behaves_exactly_as_before_the_adjustment(
    admin_client: TestClient,
    store: Store,
    enable_analytics: Callable[[], None],
    create_ingredient: Callable[..., dict[str, Any]],
    apply_full_count: Callable[..., dict[str, Any]],
) -> None:
    """AJUSTE ITERACIÓN 2 (C3/H-3): volver `count_id` opcional no le cambia
    una coma al camino donde SÍ viene explícito — sigue validando que el
    conteo exista, sea de esta sede y sea `full`/`applied`, y sigue
    devolviendo `count_id` tal cual se pidió."""
    enable_analytics()
    ing = create_ingredient(name="Sin ventana (count_id explícito)", min_stock="1")
    count = apply_full_count({ing["id"]: "10"})

    resp = admin_client.get(
        "/api/v1/admin/variance/by-dish", params={"store_id": store.id, "count_id": count["id"]}
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["available"] is False
    assert body["reason"]
    assert body["method"] == "prorated"
    assert body["count_id"] == count["id"]
    assert body["rows"] == []


def test_variance_by_dish_requires_inventory_variance_feature(
    admin_client: TestClient, store: Store, set_feature: Callable[..., None]
) -> None:
    set_feature("catalog.recipes", True)
    set_feature("inventory.perpetual", True)
    set_feature("inventory.counts", True)
    set_feature("inventory.variance", False)
    resp = admin_client.get("/api/v1/admin/variance/by-dish", params={"store_id": store.id, "count_id": 1})
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "FEATURE_DISABLED"
