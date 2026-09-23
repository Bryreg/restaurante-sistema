"""Confiabilidad de proveedores POR INSUMO (informe científico #5, analista
#9) y resumen de cuentas por pagar (analista #8).

La confiabilidad vieja sumaba gramos con unidades y comparaba cada precio
contra el promedio de TODOS los insumos del período, con `//` que trunca y
`abs` que borra si el precio subió o bajó. Estos tests fijan la matemática
nueva con números concretos."""

from __future__ import annotations

from collections.abc import Callable
from datetime import date, datetime, timezone
from typing import Any
from uuid import uuid4

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.stores.models import Store


def _idem() -> dict[str, str]:
    return {"Idempotency-Key": str(uuid4())}


def _supplier(admin_client: TestClient, store: Store, *, name: str, nit: str | None) -> dict[str, Any]:
    resp = admin_client.post(
        f"/api/v1/admin/suppliers?store_id={store.id}",
        json={"name": name, "nit": nit, "payment_term_days": 30, "invoices_required": False, "active": True},
    )
    assert resp.status_code == 201, resp.text
    return dict(resp.json())


def _line(ingredient_id: int, *, received: str, invoiced: str, price: str, lot: str) -> dict[str, Any]:
    return {
        "ingredient_id": ingredient_id,
        "qty_received": received,
        "qty_invoiced": invoiced,
        "purchase_unit_price": price,
        "tax_base": 0,
        "tax_rate": 0,
        "tax_amount": 0,
        "lot_code": lot,
        "expires_at": "2026-06-01",
    }


def _receive(admin_client: TestClient, store: Store, supplier_id: int, lines: list[dict[str, Any]]) -> dict[str, Any]:
    resp = admin_client.post(
        f"/api/v1/receptions?store_id={store.id}",
        json={
            "supplier_id": supplier_id,
            "invoice_number": f"FE-{uuid4().hex[:6]}",
            "invoice_date": "2026-01-05",
            "no_invoice": False,
            "received_by_pin": "2222",
            "lines": lines,
        },
        headers=_idem(),
    )
    assert resp.status_code == 201, resp.text
    return dict(resp.json())


def _unit_ingredient(db: Session, store: Store) -> Any:
    """Un insumo contado en UNIDADES (el sembrado es en gramos): sumar sus
    cantidades con las del otro no tiene sentido, y es justo lo que la
    versión vieja hacía."""
    from app.core import clock as clock_module
    from app.inventory.models import BaseUnit, Ingredient

    now = clock_module.now_utc()
    row = Ingredient(
        organization_id=store.organization_id, store_id=store.id, name="Botella de aceite", category="Abarrotes",
        base_unit=BaseUnit.UNIT, purchase_unit="unidad", purchase_factor=1, yield_pct=100,
        official_cost_micros=20_000_000_000, estimated_cost_micros=None, min_stock=1000, lead_time_days=2,
        perishable=False, key_item=False, active=True, consumption_untracked=False, substitute_ingredient_id=None,
        supplier_id=None, created_at=now, updated_at=now,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def test_reliability_is_computed_per_ingredient_with_signed_drift_and_money_weighted_median(
    admin_client: TestClient,
    store: Store,
    db: Session,
    ingredient_seeded: Any,
    enable_purchases: Callable[[], None],
    clock: Any,
) -> None:
    enable_purchases()
    clock.set(datetime(2026, 1, 10, 12, 0, tzinfo=timezone.utc))
    bottles = _unit_ingredient(db, store)
    supplier = _supplier(admin_client, store, name="Mayorista Central", nit="900555111")
    idle = _supplier(admin_client, store, name="Abastos Quietos", nit="900555222")

    # Pechuga (g): 1.000 g a $14.500/kg, luego 900 de 1.000 g a $15.225/kg (+5 %).
    # Aceite (unidad): 10 de 10 a $20.000, luego 10 de 10 a $18.000 (−10 %).
    _receive(admin_client, store, supplier["id"], [
        _line(ingredient_seeded.id, received="1000", invoiced="1000", price="14500", lot="A1"),
        _line(bottles.id, received="10", invoiced="10", price="20000", lot="B1"),
    ])
    _receive(admin_client, store, supplier["id"], [
        _line(ingredient_seeded.id, received="900", invoiced="1000", price="15225", lot="A2"),
        _line(bottles.id, received="10", invoiced="10", price="18000", lot="B2"),
    ])

    single = admin_client.get(f"/api/v1/admin/suppliers/{supplier['id']}/reliability?from=2026-01-01&to=2026-01-31")
    assert single.status_code == 200, single.text
    body = single.json()
    by_id = {row["ingredient_id"]: row for row in body["ingredients"]}

    chicken = by_id[ingredient_seeded.id]
    assert chicken["received_over_invoiced_bp"] == 9_500  # 1.900 g de 2.000 g
    assert chicken["price_drift_bp"] == 500  # +5 %, con signo
    assert chicken["n_price_comparisons"] == 1
    assert chicken["spend"] == 28_203  # 14.500 + 13.702,5, redondeado una vez

    oil = by_id[bottles.id]
    assert oil["received_over_invoiced_bp"] == 10_000
    assert oil["price_drift_bp"] == -1_000  # −10 %: bajó, y el signo lo dice
    assert oil["spend"] == 380_000

    # El aceite pesa $380.000 contra $28.203: la mediana ponderada por plata
    # es la suya. La cuenta vieja (1.900 g + 20 u) / (2.000 g + 20 u) daba 95 %.
    assert body["received_over_invoiced_bp"] == 10_000
    assert body["received_over_invoiced_pct"] == 100
    assert body["price_drift_bp"] == -1_000
    assert body["avg_price_drift_pct"] == -10
    assert body["n_receptions"] == body["receptions"] == 2
    assert body["n_ingredients"] == 2
    assert body["invoice_share_bp"] == 10_000
    # Ordenados por plata: el que más pesa primero.
    assert [row["ingredient_id"] for row in body["ingredients"]] == [bottles.id, ingredient_seeded.id]

    everyone = admin_client.get(
        "/api/v1/admin/suppliers/reliability", params={"store_id": store.id, "from": "2026-01-01", "to": "2026-01-31"}
    )
    assert everyone.status_code == 200, everyone.text
    rows = everyone.json()["rows"]
    assert [row["name"] for row in rows] == ["Abastos Quietos", "Mayorista Central"]
    quiet, busy = rows
    assert quiet["supplier_id"] == idle["id"]
    assert quiet["n_receptions"] == 0
    assert quiet["received_over_invoiced_bp"] is None
    assert quiet["price_drift_bp"] is None
    assert quiet["ingredients"] == []
    assert busy["price_drift_bp"] == body["price_drift_bp"]
    assert busy["received_over_invoiced_bp"] == body["received_over_invoiced_bp"]


def test_price_drift_compares_against_the_previous_reception_even_before_the_window(
    admin_client: TestClient,
    store: Store,
    ingredient_seeded: Any,
    enable_purchases: Callable[[], None],
    clock: Any,
) -> None:
    enable_purchases()
    supplier = _supplier(admin_client, store, name="Pollos del Llano", nit="900555333")
    clock.set(datetime(2025, 12, 20, 12, 0, tzinfo=timezone.utc))
    _receive(admin_client, store, supplier["id"], [_line(ingredient_seeded.id, received="1000", invoiced="1000", price="14500", lot="D1")])
    clock.set(datetime(2026, 1, 10, 12, 0, tzinfo=timezone.utc))
    _receive(admin_client, store, supplier["id"], [_line(ingredient_seeded.id, received="1000", invoiced="1000", price="13775", lot="D2")])

    body = admin_client.get(f"/api/v1/admin/suppliers/{supplier['id']}/reliability?from=2026-01-01&to=2026-01-31").json()
    assert body["n_receptions"] == 1
    assert body["price_drift_bp"] == -500  # 13.775 contra 14.500 de diciembre: −5 %


def test_payables_summary_totals_aging_and_suppliers(
    admin_client: TestClient,
    store: Store,
    db: Session,
    ingredient_seeded: Any,
    enable_purchases: Callable[[], None],
    clock: Any,
) -> None:
    """Hoy = 2026-01-15 (reloj de prueba). Cuatro cuentas, una por
    proveedor, con vencimientos armados a propósito en cada tramo."""
    from app.purchases.models import Payable

    enable_purchases()
    specs = [
        ("Al día pronto", "1000", date(2026, 1, 20)),  # $14.500, vence en 5 días
        ("Vencida reciente", "2000", date(2026, 1, 10)),  # $29.000, 5 días vencida
        ("Vencida vieja", "3000", date(2025, 11, 1)),  # $43.500, 75 días vencida
        ("Al día lejos", "500", date(2026, 3, 1)),  # $7.250, vence en marzo
    ]
    supplier_ids: dict[str, int] = {}
    for idx, (name, qty, due) in enumerate(specs):
        supplier = _supplier(admin_client, store, name=name, nit=f"90066600{idx}")
        supplier_ids[name] = supplier["id"]
        reception = _receive(admin_client, store, supplier["id"], [
            _line(ingredient_seeded.id, received=qty, invoiced=qty, price="14500", lot=f"P{idx}")
        ])
        payable = db.get(Payable, reception["payable_id"])
        assert payable is not None
        payable.due_date = due
    db.commit()

    resp = admin_client.get("/api/v1/admin/payables/summary", params={"store_id": store.id})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["as_of"] == "2026-01-15"
    assert body["total_open"] == 14_500 + 29_000 + 43_500 + 7_250
    assert body["total_overdue"] == 29_000 + 43_500
    assert body["due_next_7_days"] == 14_500
    assert body["open_count"] == 4
    assert body["overdue_count"] == 2
    assert body["aging"] == [
        {"bucket": "current", "amount": 21_750, "count": 2},
        {"bucket": "1_30", "amount": 29_000, "count": 1},
        {"bucket": "31_60", "amount": 0, "count": 0},
        {"bucket": "over_60", "amount": 43_500, "count": 1},
    ]
    assert body["by_supplier"] == [
        {"supplier_id": supplier_ids["Vencida vieja"], "name": "Vencida vieja", "open": 43_500, "overdue": 43_500},
        {"supplier_id": supplier_ids["Vencida reciente"], "name": "Vencida reciente", "open": 29_000, "overdue": 29_000},
        {"supplier_id": supplier_ids["Al día pronto"], "name": "Al día pronto", "open": 14_500, "overdue": 0},
        {"supplier_id": supplier_ids["Al día lejos"], "name": "Al día lejos", "open": 7_250, "overdue": 0},
    ]

    # La cabecera no puede contradecir a la tabla: las mismas vencidas.
    listed = admin_client.get(f"/api/v1/admin/payables?store_id={store.id}").json()
    assert sum(1 for p in listed if p["overdue"]) == body["overdue_count"]


def test_payables_summary_without_payables_is_all_zero(
    admin_client: TestClient, store: Store, enable_purchases: Callable[[], None]
) -> None:
    """Sin cuentas, deber $0 es un hecho (no se debe nada), no un «sin dato»."""
    enable_purchases()
    body = admin_client.get("/api/v1/admin/payables/summary", params={"store_id": store.id}).json()
    assert body["total_open"] == 0
    assert body["by_supplier"] == []
    assert [a["count"] for a in body["aging"]] == [0, 0, 0, 0]
