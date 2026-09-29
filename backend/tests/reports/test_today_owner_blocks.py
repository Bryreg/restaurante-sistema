"""«Hoy» según el dueño (2026-09-29): ventas en efectivo y en tarjeta, top de
productos del día, entradas de mercancía con su lote y vencimiento, y la
descarga de cada bloque en CSV para Excel en español (`;`, BOM, encabezados
en español). Todo lo calcula el servidor; la pantalla sólo lo escribe.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

from fastapi.testclient import TestClient

from tests.reports.conftest import idem_headers


def _csv_lines(resp: Any) -> list[str]:
    assert resp.status_code == 200, resp.text
    assert resp.headers["content-type"].startswith("text/csv")
    text = resp.content.decode("utf-8")
    assert text.startswith("﻿"), "sin BOM, Excel rompe las tildes"
    return text.lstrip("﻿").splitlines()


def _sell_by_card(device_client: TestClient, product: Any) -> None:
    """`sell` manda `tendered`, que sólo aplica al efectivo: la venta con
    tarjeta se arma acá, por la misma puerta HTTP."""
    order = device_client.post("/api/v1/orders", json={"channel": "counter"}, headers=idem_headers()).json()
    order = device_client.post(
        f"/api/v1/orders/{order['id']}/items",
        json={"expected_version": order["version"], "items": [{"product_id": product.id, "qty": 1}]},
        headers=idem_headers(),
    ).json()
    body: dict[str, Any] = {"pin": "1111", "splits": [{"method": "card", "amount": order["totals"]["total"]}]}
    if order.get("tip") is not None:
        body["tip"] = {"asked": True, "accepted": False, "modified": False, "amount": 0}
    resp = device_client.post(f"/api/v1/orders/{order['id']}/payments", json=body, headers=idem_headers())
    assert resp.status_code == 201, resp.text


def test_cash_card_split_and_top_products_come_from_the_server(
    admin_client: TestClient, device_client: TestClient, identify: Any, employees: Any, open_shift: Any,
    sell: Any, main_product: Any, drink_product: Any, store: Any,
) -> None:
    open_shift()
    identify(device_client, employees["cashier"])
    sell(main_product, qty=2)
    _sell_by_card(device_client, drink_product)
    sell(drink_product, qty=1, tip_amount=1_000)

    body = admin_client.get("/api/v1/admin/today", params={"store_id": store.id}).json()
    cash, card, other = body["cash_sales"], body["card_sales"], body["other_payment_sales"]
    # Los bolsillos cierran contra la cifra rectora: nada se pierde ni se duplica.
    assert cash["net"] + card["net"] + other["net"] == body["net"]
    assert cash["payments"] == 2 and card["payments"] == 1 and other["payments"] == 0
    assert other["net"] == 0
    # La propina no es venta: no entra en el efectivo vendido.
    assert cash["gross"] + card["gross"] == body["gross"]

    top = body["top_products"]
    assert [p["label"] for p in top] == [main_product.name, drink_product.name]
    assert [p["units"] for p in top] == [2, 2]
    assert sum(p["net"] for p in top) == body["net"]
    assert all(p["share_bp"] is not None for p in top)

    lines = _csv_lines(
        admin_client.get("/api/v1/admin/today/top-products", params={"store_id": store.id, "format": "csv"})
    )
    assert lines[0] == "Producto;Unidades;Venta neta"
    assert lines[1] == f"{main_product.name};2;{top[0]['net']}"


def test_without_sales_the_split_is_zero_and_top_products_empty(admin_client: TestClient, store: Any) -> None:
    body = admin_client.get("/api/v1/admin/today", params={"store_id": store.id}).json()
    assert body["cash_sales"] == {"net": 0, "gross": 0, "payments": 0}
    assert body["card_sales"] == {"net": 0, "gross": 0, "payments": 0}
    assert body["top_products"] == []
    # CSV vacío: igual sale la fila de encabezados.
    lines = _csv_lines(
        admin_client.get("/api/v1/admin/today/top-products", params={"store_id": store.id, "format": "csv"})
    )
    assert lines == ["Producto;Unidades;Venta neta"]


def test_sales_by_hour_csv_leaves_pending_hours_blank_not_zero(
    admin_client: TestClient, device_client: TestClient, identify: Any, employees: Any, open_shift: Any,
    sell: Any, main_product: Any, store: Any, clock: Any,
) -> None:
    # 10:30 en Bogotá (15:30 UTC): de las 11 en adelante, «todavía no llega».
    clock.set(datetime(2026, 3, 3, 15, 30, tzinfo=timezone.utc))
    open_shift()
    identify(device_client, employees["cashier"])
    sell(main_product, qty=1)

    lines = _csv_lines(
        admin_client.get("/api/v1/admin/today/sales-by-hour", params={"store_id": store.id, "format": "csv"})
    )
    assert lines[0] == "Hora;Venta neta;Cobrado;Comandas;Mismo día semana pasada (día completo)"
    rows = {line.split(";")[0]: line.split(";") for line in lines[1:]}
    assert len(rows) == 24
    assert rows["10:00"][1:4] == [str(25_000 - 1_852), "25000", "1"]
    assert rows["09:00"][1:4] == ["0", "0", "0"]  # pasó y no vendió: 0 real
    assert rows["11:00"][1:4] == ["", "", ""]  # todavía no llega: vacío, no 0

    as_json = admin_client.get("/api/v1/admin/today/sales-by-hour", params={"store_id": store.id}).json()
    assert as_json["business_date"] == "2026-03-03"
    assert len(as_json["hours"]) == 24


def _reception(admin_client: TestClient, store: Any, supplier_id: int, lines: list[dict[str, Any]]) -> dict[str, Any]:
    resp = admin_client.post(
        f"/api/v1/receptions?store_id={store.id}",
        json={
            "supplier_id": supplier_id,
            "invoice_number": "FE-77",
            "invoice_date": "2026-03-03",
            "no_invoice": False,
            "received_by_pin": "2222",
            "lines": lines,
        },
        headers={"Idempotency-Key": str(uuid4())},
    )
    assert resp.status_code == 201, resp.text
    return resp.json()  # type: ignore[no-any-return]


def _line(ingredient_id: int, *, qty: str, lot: str | None, expires: str | None) -> dict[str, Any]:
    return {
        "ingredient_id": ingredient_id,
        "qty_received": qty,
        "qty_invoiced": qty,
        "purchase_unit_price": "14500",
        "tax_base": 0,
        "tax_rate": 0,
        "tax_amount": 0,
        "lot_code": lot,
        "expires_at": expires,
    }


def test_receptions_today_carry_lot_expiry_and_who_received(
    admin_client: TestClient, store: Any, set_feature: Any, ingredient_seeded: Any, employees: Any, clock: Any,
) -> None:
    clock.set(datetime(2026, 3, 3, 15, 0, tzinfo=timezone.utc))
    for key in ("catalog.recipes", "inventory.perpetual", "purchases", "inventory.lots"):
        set_feature(key, True)
    supplier = admin_client.post(
        f"/api/v1/admin/suppliers?store_id={store.id}",
        json={"name": "Avícola El Dorado", "payment_term_days": 15, "invoices_required": True, "active": True},
    )
    assert supplier.status_code == 201, supplier.text
    _reception(
        admin_client,
        store,
        supplier.json()["id"],
        [
            # 2.500 g de un insumo que se compra por kg → «2.5» kg.
            _line(ingredient_seeded.id, qty="2500", lot="L-0301", expires="2026-03-06"),
            _line(ingredient_seeded.id, qty="1000", lot="L-0302", expires="2026-04-30"),
            _line(ingredient_seeded.id, qty="500", lot=None, expires=None),
        ],
    )

    body = admin_client.get("/api/v1/admin/today", params={"store_id": store.id}).json()
    assert body["receptions_enabled"] is True
    lines = body["receptions_today"]
    assert [(r["qty"], r["purchase_unit"]) for r in lines] == [("2.5", "kg"), ("1", "kg"), ("0.5", "kg")]
    assert {r["supplier_name"] for r in lines} == {"Avícola El Dorado"}
    assert {r["received_by"] for r in lines} == {employees["operator"].name}
    assert [r["lot_code"] for r in lines] == ["L-0301", "L-0302", None]
    assert [r["expires_at"] for r in lines] == ["2026-03-06", "2026-04-30", None]
    assert [r["days_to_expiry"] for r in lines] == [3, 58, None]
    # El estado del lote con la regla de Lotes: ≤ 7 días es «por vencer».
    assert [r["lot_status"] for r in lines] == ["expiring", "active", "active"]
    assert "unit_cost_micros" not in lines[0] and "purchase_unit_price" not in lines[0]

    csv_lines = _csv_lines(
        admin_client.get("/api/v1/admin/today/receptions", params={"store_id": store.id, "format": "csv"})
    )
    assert csv_lines[0] == "Hora;Proveedor;Insumo;Cantidad;Unidad de compra;Lote;Vence;Estado del lote;Recibió"
    assert csv_lines[1] == (
        f"10:00;Avícola El Dorado;{ingredient_seeded.name};2.5;kg;L-0301;2026-03-06;Vence pronto;{employees['operator'].name}"
    )
    assert csv_lines[3].split(";")[5:8] == ["", "", "Vigente"]


def test_receptions_block_is_off_without_purchases(admin_client: TestClient, store: Any, set_feature: Any) -> None:
    set_feature("purchases", False)
    body = admin_client.get("/api/v1/admin/today", params={"store_id": store.id}).json()
    assert body["receptions_enabled"] is False
    assert body["receptions_today"] == []
    resp = admin_client.get("/api/v1/admin/today/receptions", params={"store_id": store.id, "format": "csv"})
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "FEATURE_DISABLED"


def test_today_blocks_are_scoped_to_the_org(admin_client: TestClient, store_b: Any) -> None:
    for path in ("sales-by-hour", "top-products", "receptions"):
        resp = admin_client.get(f"/api/v1/admin/today/{path}", params={"store_id": store_b.id})
        assert resp.status_code == 404, (path, resp.text)
