"""El CSV para Excel en español (`app.core.csv`) y las descargas nuevas.

Pedido del dueño: «toda la información debe poder ser descargable». El
escritor común pasó a `;` + BOM UTF-8 + encabezados en español; cada
pantalla que tenía la cifra en JSON y no la dejaba bajar ahora acepta
`format=csv`. Estos tests fijan las tres cosas en el escritor y las repiten
contra cada endpoint nuevo, con datos reales donde el fixture los da y vacío
donde no (un CSV vacío tiene que seguir siendo un CSV válido, con su BOM).
"""

from __future__ import annotations

import csv
import importlib
import io
import pathlib
import re
from decimal import Decimal
from typing import Any

import pytest
from pydantic import BaseModel

from app.core.csv import BOM, csv_text, sectioned_rows, spanish_header
from app.core.csv_headers import untranslated_tokens

API = "/api/v1"
RAW_KEY = re.compile(r"^[a-z][a-z0-9_]*$")
APP = pathlib.Path(__file__).resolve().parents[2] / "app"


def _parse(text: str) -> list[list[str]]:
    assert text.startswith(BOM), "sin BOM, Excel lee «Ã±» donde dice «ñ»"
    return list(csv.reader(io.StringIO(text[len(BOM):]), delimiter=";"))


# ---------------------------------------------------------------------------
# El escritor.
# ---------------------------------------------------------------------------


def test_writer_uses_semicolon_bom_and_spanish_headers() -> None:
    text = csv_text([{"business_date": "2026-09-29", "unit_price": 12000, "employee_name": "Ana"}])
    assert text.startswith(BOM)
    header = text[len(BOM):].split("\r\n")[0]
    assert header == "Fecha operativa;Precio unitario;Empleado"


def test_endpoint_mapping_wins_over_the_glossary() -> None:
    rows = _parse(csv_text([{"value": 1}], headers={"value": "Valor de la UVT (pesos)"}))
    assert rows[0] == ["Valor de la UVT (pesos)"]


def test_null_is_an_empty_cell_never_zero_and_booleans_read_si_no() -> None:
    rows = _parse(csv_text([{"amount": None, "active": True, "voided": False}]))
    assert rows[1] == ["", "Sí", "No"]


def test_decimals_use_comma_for_excel_es_co() -> None:
    rows = _parse(csv_text([{"cost": "0.003", "pct": Decimal("12.50"), "ratio": 1.5, "qty": 3, "date": "2026-09-29"}]))
    assert rows[1] == ["0,003", "12,50", "1,5", "3", "2026-09-29"]


def test_a_value_with_semicolon_is_quoted_not_split() -> None:
    rows = _parse(csv_text([{"name": "Papas; grandes", "notes": "x"}]))
    assert rows[1] == ["Papas; grandes", "x"]


def test_empty_rows_still_give_a_valid_file_with_bom() -> None:
    assert csv_text([]) == BOM
    assert _parse(csv_text([], headers={"id": "ID"})) == [["ID"]]


def test_sectioned_rows_puts_summary_first_and_tables_after() -> None:
    class Line(BaseModel):
        name: str
        qty: int

    class Report(BaseModel):
        total: int
        lines: list[Line]

    rows = sectioned_rows(Report(total=5, lines=[Line(name="a", qty=1), Line(name="b", qty=4)]))
    assert rows[0] == {"Sección": "Resumen", "total": 5}
    assert rows[1] == {"Sección": "Líneas", "name": "a", "qty": 1}
    parsed = _parse(csv_text(rows))
    assert parsed[0] == ["Sección", "Total", "Nombre", "Cantidad"]


def test_every_field_of_every_api_schema_has_a_spanish_header() -> None:
    """Un campo nuevo con una palabra nueva no llega a un CSV en inglés sin
    que este test lo diga: se agrega la palabra a `TOKENS` (o la clave a
    `KEYS`) en `app/core/csv_headers.py`."""
    missing: dict[str, set[str]] = {}
    for path in sorted(APP.glob("*/*schemas.py")):
        module = importlib.import_module(".".join(path.relative_to(APP.parent).with_suffix("").parts))
        for obj in vars(module).values():
            if isinstance(obj, type) and issubclass(obj, BaseModel) and obj is not BaseModel:
                for field in obj.model_fields:
                    tokens = untranslated_tokens(field)
                    if tokens:
                        missing.setdefault(field, set()).update(tokens)
    assert not missing, f"campos sin encabezado en español: {sorted(missing.items())[:40]}"


def test_spanish_header_orders_like_spanish() -> None:
    assert spanish_header("unit_price") == "Precio unitario"
    assert spanish_header("created_at") == "Creado (fecha y hora)"
    assert spanish_header("margin_pct") == "Margen (%)"
    assert spanish_header("totals__net") == "Totales · Venta neta"
    assert spanish_header("Ya en español") == "Ya en español"


# ---------------------------------------------------------------------------
# Cada descarga nueva.
# ---------------------------------------------------------------------------


def _assert_excel_csv(resp: Any, route: str) -> list[list[str]]:
    assert resp.status_code == 200, f"{route}: {resp.status_code} {resp.text[:300]}"
    assert resp.headers["content-type"].startswith("text/csv"), f"{route}: {resp.headers['content-type']}"
    assert "attachment" in resp.headers.get("content-disposition", ""), route
    rows = _parse(resp.content.decode("utf-8"))
    if rows:
        raw = [h for h in rows[0] if RAW_KEY.match(h)]
        assert not raw, f"{route}: encabezados sin traducir {raw}"
    return rows


@pytest.fixture()
def seeded(db: Any, store: Any, catalog_seeded: Any, ingredient_seeded: Any) -> dict[str, Any]:
    from app.catalog.models import Product

    product = db.query(Product).filter(Product.store_id == store.id).first()
    return {"product_id": product.id if product else 1, "ingredient_id": ingredient_seeded.id}


def test_every_new_download_serves_excel_csv(
    admin_client: Any, store: Any, employees: dict[str, Any], seeded: dict[str, Any]
) -> None:
    rango = {"from": "2026-01-01", "to": "2026-01-31"}
    s = {"store_id": store.id}
    rutas: list[tuple[str, dict[str, Any]]] = [
        # Banco
        ("/admin/deposits", {**s, **rango}),
        ("/admin/deposits/pending", {**s, **rango}),
        ("/admin/bank/ledger", {**s, **rango}),
        ("/admin/bank/owner-hand", {**s, **rango}),
        ("/admin/reconciliation/card", {**s, **rango}),
        ("/admin/reconciliation/card/settlements", {**s, **rango}),
        ("/admin/reconciliation/platform", {**s, **rango}),
        ("/admin/reconciliation/platform/settlements", {**s, **rango}),
        # Gastos
        ("/admin/expenses", {**s, **rango}),
        ("/admin/obligations", s),
        ("/admin/break-even", {**s, **rango}),
        ("/admin/profit", {**s, **rango}),
        # Analítica
        ("/admin/menu-engineering", {**s, **rango}),
        ("/admin/variance/by-dish", s),
        ("/admin/control-health/sustained", s),
        ("/admin/replenishment", s),
        # Informes y fichas
        ("/admin/reports/overview", {**s, **rango}),
        (f"/admin/records/employee/{employees['cashier'].id}", {**s, **rango}),
        (f"/admin/records/ingredient/{seeded['ingredient_id']}", rango),
        # Inventario
        ("/admin/lots", s),
        ("/admin/food-cost", {**s, **rango}),
        ("/admin/control-health", s),
        ("/admin/area-recounts", s),
        # Canales
        ("/admin/platforms", s),
        ("/admin/platform-commissions", {**s, **rango}),
        ("/admin/platform-receivables", {**s, **rango}),
        ("/admin/delivery-settlements", s),
        # Compras
        ("/admin/suppliers", s),
        ("/admin/suppliers/reliability", {**s, **rango}),
        ("/admin/payables/summary", s),
        ("/admin/reception-drafts", s),
        # Solicitudes
        ("/admin/requests", s),
        ("/admin/requests/supplies", s),
        # Carta
        ("/admin/modifier-groups", {"product_id": seeded["product_id"]}),
        (f"/admin/products/{seeded['product_id']}/recipe", {}),
        # Ajustes
        ("/admin/uvt", {}),
        ("/admin/zones", s),
        ("/admin/tables", s),
        ("/admin/features", s),
        (f"/admin/stores/{store.id}/fiscal/history", {}),
        # Fiscal
        ("/admin/fiscal/export", {**s, **rango}),
    ]
    for ruta, params in rutas:
        resp = admin_client.get(f"{API}{ruta}", params={**params, "format": "csv"})
        _assert_excel_csv(resp, ruta)
        # Y sin `format`, la misma ruta sigue devolviendo JSON.
        plain = admin_client.get(f"{API}{ruta}", params=params)
        assert plain.status_code == 200, f"{ruta}: {plain.text[:200]}"
        assert plain.headers["content-type"].startswith("application/json"), ruta


def test_summary_downloads_carry_their_figures(admin_client: Any, store: Any) -> None:
    rows = _assert_excel_csv(
        admin_client.get(
            f"{API}/admin/bank/owner-hand",
            params={"store_id": store.id, "from": "2026-01-01", "to": "2026-01-31", "format": "csv"},
        ),
        "owner-hand",
    )
    assert "Saldo" in rows[0] and "Retirado" in rows[0]
    assert len(rows) == 2


def test_fiscal_export_downloads_as_a_json_file(admin_client: Any, store: Any) -> None:
    resp = admin_client.get(
        f"{API}/admin/fiscal/export",
        params={"store_id": store.id, "from": "2026-01-01", "to": "2026-01-31", "download": "true"},
    )
    assert resp.status_code == 200, resp.text
    assert resp.headers["content-type"].startswith("application/json")
    assert 'filename="exportacion-fiscal-2026-01-01-a-2026-01-31.json"' in resp.headers["content-disposition"]
    assert resp.json()["manifest_hash"]


def test_new_downloads_are_admin_only(device_client: Any, store: Any) -> None:
    """El operador no ve costos: ninguna descarga nueva se sirve a la tablet."""
    for ruta in ("/admin/food-cost", "/admin/lots", "/admin/bank/ledger", "/admin/menu-engineering"):
        resp = device_client.get(
            f"{API}{ruta}", params={"store_id": store.id, "from": "2026-01-01", "to": "2026-01-31", "format": "csv"}
        )
        assert resp.status_code in (401, 403, 404), f"{ruta}: {resp.status_code}"
