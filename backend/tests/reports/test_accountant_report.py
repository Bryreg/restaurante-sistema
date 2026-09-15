"""`GET /admin/accountant-report?year&bimester|month&store_id`
(`docs/SPEC-NEGOCIO.md §8.2`): por fecha de negocio y por tarifa — base,
impuesto, cantidad de documentos, notas, propinas (informativas, NUNCA en el
neto de nada); totales por medio de pago."""

from __future__ import annotations

from datetime import date, datetime, timezone
from typing import Any

from fastapi.testclient import TestClient

from tests.reports.conftest import idem_headers


def test_month_period_sums_base_and_tax_by_rate(
    admin_client: TestClient, device_client: TestClient, identify: Any, employees: Any, open_shift: Any,
    sell: Any, main_product: Any, clock: Any, store: Any,
) -> None:
    clock.set(datetime(2026, 3, 10, 15, 0, tzinfo=timezone.utc))
    open_shift()
    identify(device_client, employees["cashier"])
    sell(main_product, qty=1, tip_amount=1_000)

    resp = admin_client.get(
        "/api/v1/admin/accountant-report", params={"store_id": store.id, "year": 2026, "month": 3}
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["period_kind"] == "month"
    assert body["date_from"] == "2026-03-01"
    assert body["date_to"] == "2026-03-31"
    assert len(body["rows"]) == 1
    row = body["rows"][0]
    assert row["business_date"] == "2026-03-10"
    assert row["documents_count"] == 1
    assert row["notes_count"] == 0
    assert row["tips_amount"] == 1_000  # informativa

    assert len(row["by_rate"]) == 1
    rate_row = row["by_rate"][0]
    assert rate_row["rate"] == 8
    assert rate_row["documents_base"] == 23_148
    assert rate_row["documents_tax"] == 1_852

    assert body["documents_total_base"] == 23_148
    assert body["documents_total_tax"] == 1_852
    assert body["tips_total"] == 1_000
    methods = {m["method"]: m["amount"] for m in body["totals_by_method"]}
    assert methods == {"cash": 25_000}


def test_bimester_period_spans_two_months(
    admin_client: TestClient, store: Any,
) -> None:
    # Bimestre 2 de 2026 = marzo-abril (SPEC-NEGOCIO §8.2, calendario DIAN
    # estándar de INC/IVA).
    resp = admin_client.get(
        "/api/v1/admin/accountant-report", params={"store_id": store.id, "year": 2026, "bimester": 2}
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["period_kind"] == "bimester"
    assert body["date_from"] == "2026-03-01"
    assert body["date_to"] == "2026-04-30"
    assert body["rows"] == []  # sin ventas: "sin datos", lista vacía, no ceros inventados


def test_requires_exactly_one_of_bimester_or_month(admin_client: TestClient, store: Any) -> None:
    both = admin_client.get(
        "/api/v1/admin/accountant-report", params={"store_id": store.id, "year": 2026, "month": 3, "bimester": 2}
    )
    assert both.status_code == 400, both.text
    assert both.json()["error"]["code"] == "VALIDATION_ERROR"

    neither = admin_client.get("/api/v1/admin/accountant-report", params={"store_id": store.id, "year": 2026})
    assert neither.status_code == 400, neither.text


def test_a_note_reverses_the_original_and_both_count_separately(
    admin_client: TestClient, device_client: TestClient, identify: Any, employees: Any, open_shift: Any,
    sell: Any, main_product: Any, clock: Any, store: Any,
) -> None:
    clock.set(datetime(2026, 4, 5, 15, 0, tzinfo=timezone.utc))
    open_shift()
    identify(device_client, employees["cashier"])
    sale = sell(main_product, qty=1)
    document_id = sale["document"]["id"]

    note_resp = admin_client.post(
        f"/api/v1/admin/documents/{document_id}/notes",
        json={
            "kind": "adjustment",
            "reason": "Producto no entregado",
            "lines": [{"item_id": sale["order"]["items"][0]["id"], "used": True}],
        },
        headers=idem_headers(),
    )
    assert note_resp.status_code == 201, note_resp.text

    resp = admin_client.get(
        "/api/v1/admin/accountant-report", params={"store_id": store.id, "year": 2026, "month": 4}
    )
    assert resp.status_code == 200, resp.text
    row = resp.json()["rows"][0]
    # "Ventas cobradas = Σ documentos no anulados NI REVERSADOS": el
    # documento original queda `status="reversed"` y por eso YA NO cuenta
    # como venta del período (§10) — la nota es la fila que sí cuenta, y
    # nunca se netean en silencio una contra otra: quien lee el reporte ve
    # las dos columnas y resta si quiere el neto del período.
    assert row["documents_count"] == 0
    assert row["notes_count"] == 1
    rate_row = next(r for r in row["by_rate"] if r["rate"] == 8)
    assert rate_row["documents_base"] == 0
    assert rate_row["notes_base"] == 23_148
