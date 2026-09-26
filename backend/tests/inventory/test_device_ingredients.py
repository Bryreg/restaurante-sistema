"""`GET /device/ingredients`: sólo `{id, name, base_unit, entry_mode,
entry_unit}` (la unidad cómoda en que se teclea la merma), ni un campo de
costo (regla dura, SPEC-NEGOCIO §2.2 -- el operador no recibe costos ni
márgenes en ninguna respuesta de sesión de dispositivo)."""

from __future__ import annotations

from typing import Any, Callable

from fastapi.testclient import TestClient

from app.inventory.schemas import DeviceIngredientOut, WasteOut


def test_device_ingredients_schema_has_no_cost_fields() -> None:
    fields = set(DeviceIngredientOut.model_fields.keys())
    # Se amplió con la unidad cómoda (`entry_mode`, `entry_unit`) para que la
    # merma del POS se teclee en kg/botellas/L y el servidor convierta; ninguno
    # de los dos es costo.
    assert fields == {"id", "name", "base_unit", "entry_mode", "entry_unit"}
    assert "cost" not in fields
    assert "margin" not in fields


def test_waste_device_schema_has_no_cost_fields() -> None:
    fields = set(WasteOut.model_fields.keys())
    assert "cost" not in fields
    assert "cost_source" not in fields
    assert "margin" not in fields


def test_device_ingredients_endpoint_returns_only_id_name_units(
    device_client: TestClient, create_ingredient: Callable[..., dict[str, Any]]
) -> None:
    create_ingredient(name="Arroz", official_cost="123.45")

    resp = device_client.get("/api/v1/device/ingredients")
    assert resp.status_code == 200, resp.text
    rows = resp.json()
    assert len(rows) >= 1
    for row in rows:
        assert set(row.keys()) == {"id", "name", "base_unit", "entry_mode", "entry_unit"}


def test_device_ingredients_only_shows_active(
    device_client: TestClient, admin_client: TestClient, create_ingredient: Callable[..., dict[str, Any]]
) -> None:
    created = create_ingredient(name="Se descontinúa")
    admin_client.delete(f"/api/v1/admin/ingredients/{created['id']}")

    resp = device_client.get("/api/v1/device/ingredients")
    names = [row["name"] for row in resp.json()]
    assert "Se descontinúa" not in names


def test_device_ingredients_requires_device_activation(admin_client: TestClient) -> None:
    # `admin_client` no es un dispositivo activado: 401.
    resp = admin_client.get("/api/v1/device/ingredients")
    assert resp.status_code == 401
