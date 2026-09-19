"""Deuda de 1b-2 que cierra 2b (`docs/ESTADO.md` punto 13,
`outputs-2a/ENTREGA.md § 5`): `admin_list_shifts` y `admin_employee_activity`
servían CSV leyendo `request.query_params` sin declarar `format` en el
contrato, así que el OpenAPI no lo publicaba. Ahora sí, y el `format=csv`
real sigue funcionando exactamente igual que antes."""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from app.main import app
from app.stores.models import Store


def test_openapi_declares_format_on_admin_list_shifts_and_employee_activity(admin_client: TestClient) -> None:
    schema = app.openapi()
    shifts_get = schema["paths"]["/api/v1/admin/shifts"]["get"]
    shifts_params = {p["name"] for p in shifts_get.get("parameters", [])}
    assert "format" in shifts_params

    activity_get = schema["paths"]["/api/v1/admin/employees/{employee_id}/activity"]["get"]
    activity_params = {p["name"] for p in activity_get.get("parameters", [])}
    assert "format" in activity_params


def test_admin_list_shifts_csv_still_works(admin_client: TestClient, store: Store, open_shift: Any, device_client: Any) -> None:
    open_shift()
    resp = admin_client.get(f"/api/v1/admin/shifts?store_id={store.id}&format=csv")
    assert resp.status_code == 200, resp.text
    assert resp.headers["content-type"].startswith("text/csv")


def test_admin_employee_activity_csv_still_works(admin_client: TestClient, employees: dict) -> None:
    resp = admin_client.get(f"/api/v1/admin/employees/{employees['cashier'].id}/activity?format=csv")
    assert resp.status_code == 200, resp.text
    assert resp.headers["content-type"].startswith("text/csv")
