"""Ficha de chef (0039): se guarda el método y lo de la cocina, los alérgenos
se heredan de los insumos (también a través de las preparaciones) y la versión
para imprimir viene escalada y, sólo si se pide, con costos."""

from __future__ import annotations

from typing import Any, Callable

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

API = "/api/v1"


def _setup(
    db: Session, store: Any, admin_client: TestClient, make_ingredient: Any, make_product: Any,
    set_feature: Callable[..., None],
) -> tuple[dict[str, Any], Any]:
    for key in ("catalog.recipes", "catalog.preps", "inventory.perpetual"):
        set_feature(key, True)
    harina = make_ingredient("Harina (ficha)")
    harina.allergens = "gluten"
    leche = make_ingredient("Leche (ficha)", base_unit="ml")
    leche.allergens = "lacteos"
    db.flush()
    salsa = admin_client.post(
        f"{API}/admin/preparations", params={"store_id": store.id},
        json={"name": "Bechamel", "mode": "batch", "standard_yield_qty": "1000", "standard_yield_unit": "g",
              "lines": [{"ingredient_id": leche.id, "qty": "800", "unit": "ml"}]},
    ).json()
    product = make_product("Lasaña (ficha)", price_dine_in=30_000)
    saved = admin_client.put(
        f"{API}/admin/products/{product.id}/recipe",
        json={"version": 0, "lines": [
            {"ingredient_id": harina.id, "qty": "100", "unit": "g"},
            {"preparation_id": salsa["id"], "qty": "250", "unit": "g"},
        ]},
    )
    assert saved.status_code == 200, saved.text
    return salsa, product


def test_sheet_is_saved_and_inherits_allergens(
    db: Session, store: Any, admin_client: TestClient, make_ingredient: Any, make_product: Any,
    set_feature: Callable[..., None],
) -> None:
    _salsa, product = _setup(db, store, admin_client, make_ingredient, make_product, set_feature)
    resp = admin_client.put(
        f"{API}/admin/products/{product.id}/sheet",
        json={"method_steps": ["Armar capas", "  ", "Hornear 25 min a 180 °C"], "portion": "350 g · plato hondo",
              "station": "caliente", "prep_minutes": 35, "plating_notes": "Gratinar arriba"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["method_steps"] == ["Armar capas", "Hornear 25 min a 180 °C"]
    assert body["station"] == "caliente" and body["prep_minutes"] == 35
    # Gluten de la harina y lácteos de la leche que va DENTRO de la bechamel.
    assert body["allergens"] == ["gluten", "lacteos"]


def test_printable_is_scaled_on_the_server_and_costs_only_when_asked(
    db: Session, store: Any, admin_client: TestClient, make_ingredient: Any, make_product: Any,
    set_feature: Callable[..., None],
) -> None:
    _salsa, product = _setup(db, store, admin_client, make_ingredient, make_product, set_feature)

    kitchen = admin_client.get(f"{API}/admin/products/{product.id}/sheet/print", params={"scale": 4}).json()
    assert kitchen["scale_text"] == "4 porciones"
    assert kitchen["cost"] is None
    harina = next(c for c in kitchen["components"] if c["kind"] == "ingredient")
    assert harina["qty"] == "400"
    bechamel = next(c for c in kitchen["components"] if c["kind"] == "preparation")
    assert bechamel["qty"] == "1000"
    # 1000 g de bechamel de una tanda de 1000 g: 800 ml de leche adentro.
    assert [(c["name"], c["qty"]) for c in bechamel["components"]] == [("Leche (ficha)", "800")]

    owner = admin_client.get(
        f"{API}/admin/products/{product.id}/sheet/print", params={"scale": 2, "costs": True}
    ).json()
    assert owner["cost"] is not None
    assert owner["cost"]["net_price"] > 0

    assert admin_client.get(f"{API}/admin/products/{product.id}/sheet/print", params={"scale": 0}).status_code == 400
