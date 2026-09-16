"""`GET /admin/sales?from&to&store_id&group_by=` (spec.md «Admin reports»,
`docs/SPEC-NEGOCIO.md §10`): `gross` = ventas cobradas (Σ documentos no
anulados ni reversados); `net` = `gross - tax`, sin propina; `avg_ticket` =
`net ÷ orders`; `avg_per_cover` = `net ÷ covers`."""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from tests.reports.conftest import idem_headers


def test_business_date_grouping_matches_the_kpi_formulas(
    admin_client: TestClient, device_client: TestClient, identify: Any, employees: Any, open_shift: Any,
    sell: Any, main_product: Any, store: Any,
) -> None:
    open_shift()
    identify(device_client, employees["cashier"])
    sell(main_product, qty=1)
    sell(main_product, qty=1)

    # Rango ancho y fijo, no `date.today()`: `business_date` (cutoff de sede)
    # puede quedar un día detrás de la fecha calendario UTC durante varias
    # horas cada día (Bogotá es UTC-5) — comparar contra `date.today()` es
    # flaky por reloj real cerca de la medianoche UTC.
    resp = admin_client.get(
        "/api/v1/admin/sales",
        params={"store_id": store.id, "from": "2020-01-01", "to": "2099-12-31", "group_by": "business_date"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert len(body["rows"]) == 1
    row = body["rows"][0]

    # Dos ventas de $25.000 (INC 8 % incluido): base 23.148 + impuesto 1.852
    # cada una -> bruto 50.000, impuesto 3.704, neto 46.296.
    assert row["gross"] == 50_000
    assert row["tax"] == 3_704
    assert row["net"] == 46_296
    assert row["orders"] == 2
    assert row["avg_ticket"] == 23_148  # 46.296 / 2
    assert row["tips"] == 0

    # El total del reporte es exactamente la suma de sus filas (mismo cálculo).
    assert body["total"]["gross"] == row["gross"]
    assert body["total"]["net"] == row["net"]
    assert body["total"]["tax"] == row["tax"]


def test_tips_never_enter_gross_net_or_tax(
    admin_client: TestClient, device_client: TestClient, identify: Any, employees: Any, open_shift: Any,
    sell: Any, main_product: Any, store: Any,
) -> None:
    open_shift()
    identify(device_client, employees["cashier"])
    sell(main_product, qty=1, tip_amount=2_500)

    resp = admin_client.get(
        "/api/v1/admin/sales",
        params={"store_id": store.id, "from": "2020-01-01", "to": "2099-12-31", "group_by": "business_date"},
    )
    row = resp.json()["rows"][0]
    assert row["gross"] == 25_000  # la propina NO se suma acá
    assert row["tips"] == 2_500
    assert row["net"] == row["gross"] - row["tax"]


def test_group_by_method_splits_a_mixed_payment_prorating_the_tax(
    admin_client: TestClient, device_client: TestClient, identify: Any, employees: Any, open_shift: Any,
    main_product: Any, store: Any,
) -> None:
    """División de medios dentro de UN documento: el impuesto se reparte con
    `app.orders.money.prorate` (la única matemática), nunca con una cuenta
    nueva en `app.reports`."""
    open_shift()
    identify(device_client, employees["cashier"])
    order = device_client.post("/api/v1/orders", json={"channel": "counter"}, headers=idem_headers()).json()
    items_resp = device_client.post(
        f"/api/v1/orders/{order['id']}/items",
        json={"expected_version": order["version"], "items": [{"product_id": main_product.id, "qty": 1}]},
        headers=idem_headers(),
    )
    assert items_resp.status_code == 200, items_resp.text
    order = items_resp.json()  # $25.000, tax 1.852
    total = order["totals"]["total"]
    cash_amount = total - 10_000
    pay_body: dict[str, Any] = {
        "pin": "1111",
        "splits": [
            {"method": "cash", "amount": cash_amount, "tendered": cash_amount},
            {"method": "card", "amount": 10_000},
        ],
    }
    if order.get("tip") is not None:
        pay_body["tip"] = {"asked": True, "accepted": False, "modified": False, "amount": 0}
    pay_resp = device_client.post(f"/api/v1/orders/{order['id']}/payments", json=pay_body, headers=idem_headers())
    assert pay_resp.status_code == 201, pay_resp.text

    resp = admin_client.get(
        "/api/v1/admin/sales",
        params={"store_id": store.id, "from": "2020-01-01", "to": "2099-12-31", "group_by": "method"},
    )
    assert resp.status_code == 200, resp.text
    rows = {r["key"]: r for r in resp.json()["rows"]}
    assert set(rows) == {"cash", "card"}
    assert rows["cash"]["gross"] + rows["card"]["gross"] == total
    assert rows["cash"]["tax"] + rows["card"]["tax"] == order["totals"]["tax_lines"][0]["tax"]
    for key in ("cash", "card"):
        assert rows[key]["tax"] <= rows[key]["gross"]  # A-12: el tope nunca se pasa


def test_isolation_by_store_and_organization(
    admin_client: TestClient, device_client: TestClient, identify: Any, employees: Any, open_shift: Any,
    sell: Any, main_product: Any, store: Any, store_b: Any,
) -> None:
    open_shift()
    identify(device_client, employees["cashier"])
    sell(main_product, qty=1)

    # Otra sede de OTRA organización: 404, nunca 200 vacío ni 403.
    resp = admin_client.get(
        "/api/v1/admin/sales",
        params={"store_id": store_b.id, "from": "2020-01-01", "to": "2099-12-31", "group_by": "business_date"},
    )
    assert resp.status_code == 404, resp.text


def test_csv_export(
    admin_client: TestClient, device_client: TestClient, identify: Any, employees: Any, open_shift: Any,
    sell: Any, main_product: Any, store: Any,
) -> None:
    open_shift()
    identify(device_client, employees["cashier"])
    sell(main_product, qty=1)

    resp = admin_client.get(
        "/api/v1/admin/sales",
        params={
            "store_id": store.id,
            "from": "2020-01-01",
            "to": "2099-12-31",
            "group_by": "business_date",
            "format": "csv",
        },
    )
    assert resp.status_code == 200, resp.text
    assert resp.headers["content-type"].startswith("text/csv")
    assert "gross" in resp.text.splitlines()[0]


def test_every_group_by_value_answers_200_with_sane_rows(
    admin_client: TestClient, device_client: TestClient, identify: Any, employees: Any, open_shift: Any,
    sell: Any, main_product: Any, tables: Any, store: Any,
) -> None:
    """Smoke test de los cinco `group_by` que no tienen un test propio
    (`shift`, `channel`, `employee`, `hour`, `zone`): `zone` es el que hace
    un join extra (`OrderTable` -> `Table` -> `Zone`), el más fácil de
    romper con un `KeyError` silencioso."""
    open_shift()
    identify(device_client, employees["cashier"])
    sell(main_product, qty=1, channel="dine_in", table_ids=[tables[0].id])

    for group_by in ("shift", "channel", "employee", "hour", "zone"):
        resp = admin_client.get(
            "/api/v1/admin/sales",
            params={"store_id": store.id, "from": "2020-01-01", "to": "2099-12-31", "group_by": group_by},
        )
        assert resp.status_code == 200, f"{group_by}: {resp.text}"
        body = resp.json()
        assert sum(r["gross"] for r in body["rows"]) == body["total"]["gross"] == 25_000
        assert sum(r["orders"] for r in body["rows"]) == 1


def test_invalid_range_is_a_400(admin_client: TestClient, store: Any) -> None:
    resp = admin_client.get(
        "/api/v1/admin/sales",
        params={"store_id": store.id, "from": "2026-02-10", "to": "2026-02-01", "group_by": "business_date"},
    )
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "VALIDATION_ERROR"
