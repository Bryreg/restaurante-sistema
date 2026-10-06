"""Auditoría u9: una sola definición por concepto, y todas las pantallas la
leen.

(a) **La clasificación de un plato** (estrella / caballo de batalla /
enigma / perro) es la de `app.analytics.service.classify_dish`: la pestaña
«Ingeniería de menú», el resumen de Informes y el «Mix de platos» de
Informes tienen que decir lo mismo del mismo plato en el mismo período.

(b) **El ticket promedio** es `app.reports.service.average_ticket` (venta
neta sin impuesto ni propina ÷ comandas distintas con comprobante): «Hoy»,
«Ventas», «Informes», el informe del contador y la actividad por persona
tienen que dar la misma cifra para el mismo día."""

from __future__ import annotations

from typing import Any, Callable

from fastapi.testclient import TestClient

from app.catalog.models import Product
from app.core import tz
from app.stores.models import Store

API = "/api/v1"

#: El grupo del «Mix de platos» es el cuadrante con otro nombre.
_MIX_GROUP = {"star": "keep", "puzzle": "promote", "plowhorse": "reprice", "dog": "review"}


def _sell_menu(
    *,
    device_client: TestClient,
    identify: Any,
    employees: dict[str, Any],
    open_shift: Any,
    sell: Callable[..., Any],
    main_product: Product,
    second_product: Product,
    set_recipe: Callable[..., Any],
    create_ingredient: Callable[..., dict[str, Any]],
    enable_analytics: Callable[[], None],
) -> None:
    """Bandeja ($25.000, $1.000 de costo) 20 unidades en 4 comandas;
    Sancocho ($18.000, $100 de costo) 25 unidades en 5 comandas, más una
    comanda de 3 Sancochos (muestra que no cambia el cuadrante)."""
    enable_analytics()
    ing = create_ingredient(name="Insumo u9", official_cost="10")
    set_recipe(main_product.id, lines=[{"ingredient_id": ing["id"], "qty": "100", "unit": "g"}])
    set_recipe(second_product.id, lines=[{"ingredient_id": ing["id"], "qty": "10", "unit": "g"}])
    open_shift()
    for product, qty, times in ((main_product, 5, 4), (second_product, 5, 5), (second_product, 3, 1)):
        for _ in range(times):
            identify(device_client, employees["cashier"])
            sell(product, qty=qty)


def test_the_same_dish_has_the_same_class_on_every_screen(
    admin_client: TestClient,
    device_client: TestClient,
    identify: Any,
    employees: dict[str, Any],
    open_shift: Any,
    sell: Callable[..., Any],
    main_product: Product,
    second_product: Product,
    store: Store,
    set_recipe: Callable[..., Any],
    create_ingredient: Callable[..., dict[str, Any]],
    enable_analytics: Callable[[], None],
) -> None:
    _sell_menu(
        device_client=device_client, identify=identify, employees=employees, open_shift=open_shift, sell=sell,
        main_product=main_product, second_product=second_product, set_recipe=set_recipe,
        create_ingredient=create_ingredient, enable_analytics=enable_analytics,
    )
    day = tz.today_business_date(store.cutoff_hour).isoformat()
    period = {"store_id": store.id, "from": day, "to": day}

    menu = admin_client.get(f"{API}/admin/menu-engineering", params=period)
    assert menu.status_code == 200, menu.text
    menu_body = menu.json()
    classes = {str(r["product_id"]): r["classification"] for r in menu_body["rows"]}
    # Con números fijados: la Bandeja deja más por unidad que el promedio.
    assert classes == {str(main_product.id): "star", str(second_product.id): "plowhorse"}

    overview = admin_client.get(f"{API}/admin/reports/overview", params=period)
    assert overview.status_code == 200, overview.text
    body = overview.json()

    # «Mix de platos»: el mismo cuadrante, plato por plato, y las mismas rayas.
    mix = body["series"]["dish_mix"]
    assert mix["available"] is True
    assert {p["key"]: p["classification"] for p in mix["points"]} == classes
    assert {p["key"]: p["group"] for p in mix["points"]} == {k: _MIX_GROUP[c] for k, c in classes.items()}
    assert mix["avg_margin_per_unit"] == menu_body["avg_contribution_margin_per_unit"]
    rows = {str(r["product_id"]): r for r in menu_body["rows"]}
    for point in mix["points"]:
        assert point["units"] == rows[point["key"]]["qty_sold"]
        assert point["margin_per_unit"] == rows[point["key"]]["contribution_margin_per_unit"]

    # Resumen de Informes: los mismos recuentos por cuadrante.
    summary = body["menu_engineering"]
    assert summary["available"] is True
    counts = menu_body["counts_by_class"]
    for key in ("star", "plowhorse", "puzzle", "dog", "unclassified", "insufficient_sample"):
        assert summary[key] == counts[key], key


def test_the_same_day_has_the_same_average_ticket_on_every_screen(
    admin_client: TestClient,
    device_client: TestClient,
    identify: Any,
    employees: dict[str, Any],
    open_shift: Any,
    sell: Callable[..., Any],
    main_product: Product,
    second_product: Product,
    store: Store,
    set_recipe: Callable[..., Any],
    create_ingredient: Callable[..., dict[str, Any]],
    enable_analytics: Callable[[], None],
) -> None:
    _sell_menu(
        device_client=device_client, identify=identify, employees=employees, open_shift=open_shift, sell=sell,
        main_product=main_product, second_product=second_product, set_recipe=set_recipe,
        create_ingredient=create_ingredient, enable_analytics=enable_analytics,
    )
    business_date = tz.today_business_date(store.cutoff_hour)
    day = business_date.isoformat()

    today = admin_client.get(f"{API}/admin/today", params={"store_id": store.id})
    assert today.status_code == 200, today.text
    hoy = today.json()
    assert hoy["orders"] == 10
    # La definición: venta neta (sin impuesto ni propina) ÷ comandas, half-up.
    assert hoy["avg_ticket"] == (hoy["net"] * 2 + hoy["orders"]) // (hoy["orders"] * 2)
    expected = hoy["avg_ticket"]
    assert expected is not None

    sales = admin_client.get(
        f"{API}/admin/sales", params={"store_id": store.id, "from": day, "to": day, "group_by": "business_date"}
    )
    assert sales.status_code == 200, sales.text
    sales_body = sales.json()
    assert sales_body["total"]["avg_ticket"] == expected
    [sales_day] = [r for r in sales_body["rows"] if r["key"] == day]
    assert sales_day["avg_ticket"] == expected

    overview = admin_client.get(
        f"{API}/admin/reports/overview", params={"store_id": store.id, "from": day, "to": day}
    )
    assert overview.status_code == 200, overview.text
    assert overview.json()["total"]["avg_ticket"] == expected

    accountant = admin_client.get(
        f"{API}/admin/accountant-report",
        params={"store_id": store.id, "year": business_date.year, "month": business_date.month},
    )
    assert accountant.status_code == 200, accountant.text
    acc = accountant.json()
    [acc_day] = [d for d in acc["days"] if d["business_date"] == day]
    assert acc_day["orders_count"] == hoy["orders"]
    assert acc_day["avg_ticket"] == expected
    # Todas las ventas del mes son de hoy: el del período es el mismo.
    assert acc["summary"]["avg_ticket"] == expected

    activity = admin_client.get(
        f"{API}/admin/employees/{employees['cashier'].id}/activity",
        params={"store_id": store.id, "from": day, "to": day},
    )
    assert activity.status_code == 200, activity.text
    assert activity.json()["activity"]["sales"]["avg_ticket"] == expected
