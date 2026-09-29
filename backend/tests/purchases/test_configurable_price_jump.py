"""El salto de precio que pide confirmación es el de la sede (Ajustes ›
Inventario y compras, `price_jump_pct`, 0035): con 25 %, un precio 17 % por
encima del promedio entra sin preguntar (con el 15 % de fábrica pediría
`PRICE_JUMP`, `test_receptions.test_price_jump_guard_asks_and_confirm_price_clears_it`)."""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from app.stores.models import Store
from tests.purchases.test_receptions import _idem, _line, _reception_payload


def test_price_jump_threshold_comes_from_the_store(
    admin_client: TestClient, store: Store, create_supplier: Any, ingredient_seeded: Any, db: Any
) -> None:
    from app.inventory.service import get_inventory_settings

    get_inventory_settings(db, store).price_jump_pct = 25
    db.commit()
    supplier = create_supplier()
    payload = _reception_payload(supplier["id"], ingredient_seeded.id, lines=[_line(ingredient_seeded.id, purchase_unit_price="17000")])
    resp = admin_client.post(f"/api/v1/receptions?store_id={store.id}", json=payload, headers=_idem())
    assert resp.status_code == 201, resp.text


def test_price_jump_message_names_the_store_threshold(
    admin_client: TestClient, store: Store, create_supplier: Any, ingredient_seeded: Any, db: Any
) -> None:
    from app.inventory.service import get_inventory_settings

    get_inventory_settings(db, store).price_jump_pct = 10
    db.commit()
    supplier = create_supplier()
    payload = _reception_payload(supplier["id"], ingredient_seeded.id, lines=[_line(ingredient_seeded.id, purchase_unit_price="16000")])
    resp = admin_client.post(f"/api/v1/receptions?store_id={store.id}", json=payload, headers=_idem())
    assert resp.status_code == 409, resp.text
    assert resp.json()["error"]["code"] == "PRICE_JUMP"
    assert "10" in resp.json()["error"]["message"]
