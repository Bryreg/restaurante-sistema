"""Las series «barra + raya» del panel (`app.reports.series`): cada dato viaja
con su raya ya calculada y con el lado de la raya decidido en el servidor.

Lo que se prueba, serie por serie, es que el dato es **el mismo** que ya
publica otra pantalla (Ventas por día, el esperado del turno, el libro de
inventario) y que la raya sale de Ajustes, no de una cifra quemada.

Excepción declarada a «todo entra por HTTP» (`docs/CONTEXTO-AGENTES.md §11`):
para tener ventas en dos días distintos se corre la `business_date` de un
comprobante ya emitido, y los movimientos del insumo se asientan con
`inventory.hooks.record_movement` (la única escritura del libro). Son
lecturas de libros: lo que se prueba es cómo se LEEN.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from typing import Any, get_args
from uuid import uuid4

from fastapi.testclient import TestClient
from sqlalchemy import update
from sqlalchemy.orm import Session

from app.core import tz
from app.fiscal.models import FiscalDocument
from app.reports import schemas, series_schemas
from app.shifts import service as shifts_service
from app.shifts.models import Shift
from tests.conftest import KNOWN_PINS
from tests.reports.conftest import idem_headers

API = "/api/v1"


def _overview(
    admin_client: TestClient, store_id: int | str, day: date
) -> dict[str, Any]:
    resp = admin_client.get(
        f"{API}/admin/reports/overview",
        params={"store_id": store_id, "from": day.isoformat(), "to": day.isoformat()},
    )
    assert resp.status_code == 200, resp.text
    body: dict[str, Any] = resp.json()
    return body


def _panel_store(admin_client: TestClient, store_id: int) -> dict[str, Any]:
    resp = admin_client.get(f"{API}/admin/panel", params={"store_id": store_id})
    assert resp.status_code == 200, resp.text
    [store] = resp.json()["stores"]
    return store  # type: ignore[no-any-return]


def _put_sales_settings(
    admin_client: TestClient, store_id: int, **changes: Any
) -> dict[str, Any]:
    current = admin_client.get(f"{API}/admin/stores/{store_id}/sales-settings").json()
    resp = admin_client.put(
        f"{API}/admin/stores/{store_id}/sales-settings", json={**current, **changes}
    )
    assert resp.status_code == 200, resp.text
    return resp.json()  # type: ignore[no-any-return]


def _open_dine_in_order(
    device_client: TestClient, product: Any, table_id: int
) -> dict[str, Any]:
    order = device_client.post(
        f"{API}/orders",
        json={"channel": "dine_in", "table_ids": [table_id]},
        headers=idem_headers(),
    )
    assert order.status_code == 201, order.text
    body = order.json()
    items = device_client.post(
        f"{API}/orders/{body['id']}/items",
        json={
            "expected_version": body["version"],
            "items": [{"product_id": product.id, "qty": 1}],
        },
        headers=idem_headers(),
    )
    assert items.status_code == 200, items.text
    return items.json()  # type: ignore[no-any-return]


# ---------------------------------------------------------------------------
# Contrato
# ---------------------------------------------------------------------------


def test_the_literal_mirror_for_the_client_says_the_same_as_the_series() -> None:
    """`schemas.py` espeja los literales de `series_schemas` para que el
    auditor de literales del frontend los cruce: el espejo no puede mentir."""
    assert set(get_args(schemas.SeriesBadSideLiteral)) == set(
        get_args(series_schemas.BadSide)
    )
    assert set(get_args(schemas.SeriesUnitLiteral)) == set(
        get_args(series_schemas.SeriesUnit)
    )
    assert set(get_args(schemas.DishMixGroupLiteral)) == set(
        get_args(series_schemas.DishMixGroup)
    )


def test_panel_assumptions_live_in_settings_with_defaults_and_survive_old_clients(
    admin_client: TestClient, store: Any
) -> None:
    body = admin_client.get(f"{API}/admin/stores/{store.id}/sales-settings").json()
    assert (
        body["margin_target_pct"],
        body["long_table_minutes"],
        body["late_ticket_minutes"],
        body["orders_per_waiter"],
    ) == (
        65,
        60,
        20,
        7,
    )
    saved = _put_sales_settings(
        admin_client, store.id, margin_target_pct=70, orders_per_waiter=5
    )
    assert saved["margin_target_pct"] == 70
    assert saved["orders_per_waiter"] == 5

    # Un cliente escrito antes de estos campos no los devuelve al default.
    old_body = {k: v for k, v in saved.items() if k not in series_panel_fields()}
    resp = admin_client.put(
        f"{API}/admin/stores/{store.id}/sales-settings", json=old_body
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["margin_target_pct"] == 70
    assert resp.json()["orders_per_waiter"] == 5

    # Validar antes de escribir: fuera de rango es 422 y no toca nada.
    bad = admin_client.put(
        f"{API}/admin/stores/{store.id}/sales-settings",
        json={**saved, "margin_target_pct": 150},
    )
    assert bad.status_code in (400, 422)
    assert (
        admin_client.get(f"{API}/admin/stores/{store.id}/sales-settings").json()[
            "margin_target_pct"
        ]
        == 70
    )


def series_panel_fields() -> tuple[str, ...]:
    from app.stores.schemas import PANEL_ASSUMPTION_FIELDS

    return PANEL_ASSUMPTION_FIELDS


# ---------------------------------------------------------------------------
# Informes
# ---------------------------------------------------------------------------


def test_daily_sales_compare_against_the_same_weekday_last_week(
    admin_client: TestClient,
    device_client: TestClient,
    open_shift: Any,
    sell: Any,
    main_product: Any,
    store: Any,
    db: Session,
    clock: Any,
) -> None:
    clock.set(datetime(2026, 9, 19, 18, 0, tzinfo=timezone.utc))
    open_shift()
    small = sell(main_product, qty=1)
    big = sell(main_product, qty=2)
    today = tz.today_business_date(store.cutoff_hour)
    last_week = today - timedelta(days=7)
    db.execute(
        update(FiscalDocument)
        .where(FiscalDocument.id == big["document"]["id"])
        .values(business_date=last_week)
    )
    db.commit()

    daily = _overview(admin_client, store.id, today)["series"]["daily_sales"]
    assert daily["unit"] == "cop" and daily["bad_side"] == "below"
    [point] = daily["points"]
    by_day = {
        r["key"]: r["net"]
        for r in admin_client.get(
            f"{API}/admin/sales",
            params={
                "store_id": store.id,
                "from": last_week.isoformat(),
                "to": today.isoformat(),
                "group_by": "business_date",
            },
        ).json()["rows"]
    }
    # El dato y la raya son las filas de Ventas por día: no hay otra suma.
    assert point["key"] == today.isoformat()
    assert point["value"] == by_day[today.isoformat()]
    assert point["reference"] == by_day[last_week.isoformat()]
    assert point["value"] < point["reference"]
    assert point["outside"] is True
    assert point["delta_bp"] is not None and point["delta_bp"] < 0
    assert point["now"] is True
    # Cambio intencional (pulido del panel): una comanda contra una no
    # sostiene un porcentaje. El punto trae su dato, su raya y su variación
    # igual, pero sale con `low_base` y no cuenta en «N de M días por
    # encima» (antes: `days_with_reference == 1`). El caso con base firme
    # lo cubre `test_daily_sales_with_enough_orders_counts_the_day`.
    assert point["low_base"] is True
    assert daily["days_with_reference"] == 0 and daily["days_above"] == 0
    assert daily["best_key"] is None
    assert small["document"]["id"] != big["document"]["id"]


def _sell_many(sell: Any, product: Any, n: int, *, qty: int = 1) -> list[dict[str, Any]]:
    return [sell(product, qty=qty) for _ in range(n)]


def test_daily_sales_with_enough_orders_counts_the_day(
    admin_client: TestClient,
    device_client: TestClient,
    open_shift: Any,
    sell: Any,
    main_product: Any,
    store: Any,
    db: Session,
    clock: Any,
) -> None:
    """Cinco comandas hoy (de 2) contra cinco la semana pasada (de 1): la
    base alcanza, el día cuenta y es «el mejor» porque creció."""
    clock.set(datetime(2026, 9, 19, 18, 0, tzinfo=timezone.utc))
    open_shift()
    _sell_many(sell, main_product, 5, qty=2)
    before = _sell_many(sell, main_product, 5, qty=1)
    today = tz.today_business_date(store.cutoff_hour)
    last_week = today - timedelta(days=7)
    db.execute(
        update(FiscalDocument)
        .where(FiscalDocument.id.in_([b["document"]["id"] for b in before]))
        .values(business_date=last_week)
    )
    db.commit()

    daily = _overview(admin_client, store.id, today)["series"]["daily_sales"]
    [point] = daily["points"]
    assert point["low_base"] is False
    assert point["delta_bp"] is not None and point["delta_bp"] > 0
    assert daily["days_with_reference"] == 1 and daily["days_above"] == 1
    assert daily["best_key"] == today.isoformat()


def test_daily_sales_zero_against_zero_is_not_a_day_above(
    admin_client: TestClient,
    open_shift: Any,
    store: Any,
    clock: Any,
) -> None:
    """Un turno abierto sin ventas: el día vale 0 (es un hecho) y su raya
    también. «0 ≥ 0» no es «por encima»: no hay contra qué."""
    clock.set(datetime(2026, 9, 19, 18, 0, tzinfo=timezone.utc))
    open_shift()
    today = tz.today_business_date(store.cutoff_hour)
    daily = _overview(admin_client, store.id, today)["series"]["daily_sales"]
    assert daily["days_above"] == 0
    assert daily["best_key"] is None


def test_daily_sales_without_last_week_is_null_not_zero(
    admin_client: TestClient,
    open_shift: Any,
    sell: Any,
    main_product: Any,
    store: Any,
    clock: Any,
) -> None:
    clock.set(datetime(2026, 9, 19, 18, 0, tzinfo=timezone.utc))
    open_shift()
    sell(main_product, qty=1)
    today = tz.today_business_date(store.cutoff_hour)
    [point] = _overview(admin_client, store.id, today)["series"]["daily_sales"][
        "points"
    ]
    assert point["value"] > 0
    # La sede no existía la semana pasada: sin raya, y nada de «+100 %».
    assert point["reference"] is None
    assert point["delta_bp"] is None
    assert point["outside"] is False


def test_category_margin_draws_the_target_from_settings_and_null_without_cost(
    admin_client: TestClient,
    open_shift: Any,
    sell: Any,
    main_product: Any,
    store: Any,
    clock: Any,
) -> None:
    clock.set(datetime(2026, 9, 19, 18, 0, tzinfo=timezone.utc))
    open_shift()
    sell(main_product, qty=1)
    today = tz.today_business_date(store.cutoff_hour)
    margin = _overview(admin_client, store.id, today)["series"]["category_margin"]
    assert margin["reference"] == 6_500
    [row] = margin["points"]
    # Sin ficha técnica no hay costo: el margen es «sin dato», nunca 100 %.
    assert row["value"] is None
    assert row["outside"] is False
    assert row["reference"] == 6_500

    _put_sales_settings(admin_client, store.id, margin_target_pct=70)
    assert (
        _overview(admin_client, store.id, today)["series"]["category_margin"][
            "reference"
        ]
        == 7_000
    )


def test_category_margin_is_margin_over_net_and_flags_under_target(
    admin_client: TestClient,
    open_shift: Any,
    sell: Any,
    main_product: Any,
    store: Any,
    clock: Any,
    set_recipe: Any,
    ingredient_seeded: Any,
) -> None:
    clock.set(datetime(2026, 9, 19, 18, 0, tzinfo=timezone.utc))
    set_recipe(
        main_product.id,
        [{"ingredient_id": ingredient_seeded.id, "qty": "1000", "unit": "g"}],
    )
    open_shift()
    sell(main_product, qty=1)
    today = tz.today_business_date(store.cutoff_hour)
    body = _overview(admin_client, store.id, today)
    [cat] = body["cost"]["by_category"]
    [row] = body["series"]["category_margin"]["points"]
    assert row["net"] == cat["net"]
    assert row["gross_margin"] == cat["gross_margin"]
    assert cat["gross_margin"] is not None and cat["net"] > 0
    # Puntos básicos half-up del margen sobre el neto de la misma fila.
    expected = (abs(cat["gross_margin"]) * 10_000 * 2 + cat["net"]) // (2 * cat["net"])
    assert abs(row["value"]) == expected
    assert row["outside"] is (row["value"] < 6_500)
    if row["outside"]:
        assert row["gap_bp"] == 6_500 - row["value"]
    # Subir la meta por encima del margen lo pinta del lado malo.
    _put_sales_settings(admin_client, store.id, margin_target_pct=100)
    [row] = _overview(admin_client, store.id, today)["series"]["category_margin"][
        "points"
    ]
    assert row["outside"] is True and row["gap_bp"] == 10_000 - row["value"]


def test_stores_week_only_with_all_stores(
    admin_client: TestClient,
    open_shift: Any,
    sell: Any,
    main_product: Any,
    store: Any,
    clock: Any,
) -> None:
    clock.set(datetime(2026, 9, 19, 18, 0, tzinfo=timezone.utc))
    open_shift()
    sell(main_product, qty=1)
    today = tz.today_business_date(store.cutoff_hour)
    assert _overview(admin_client, store.id, today)["series"]["stores_week"] is None
    body = _overview(admin_client, "all", today)
    [point] = body["series"]["stores_week"]["points"]
    [row] = body["by_store"]
    assert point["store_id"] == store.id
    assert point["value"] == row["net"]
    assert point["reference"] is None  # no operaba el período anterior
    # Sin ficha técnica no hay costo: el margen de la sede es «sin dato».
    assert point["margin_bp"] is None


def test_dish_mix_without_sales_says_why(
    admin_client: TestClient, store: Any, clock: Any
) -> None:
    """Sin ventas el mix dice por qué (con «Todas las sedes», ver
    `test_overview.test_all_stores_is_the_sum_of_each_store`)."""
    from app.reports import series

    clock.set(datetime(2026, 9, 19, 18, 0, tzinfo=timezone.utc))
    today = tz.today_business_date(store.cutoff_hour)
    mix = _overview(admin_client, store.id, today)["series"]["dish_mix"]
    assert mix["available"] is False
    assert mix["reason"] == series.DISH_MIX_NO_SALES_REASON
    assert mix["points"] == []


def test_dish_mix_is_the_menu_engineering_matrix(
    admin_client: TestClient,
    open_shift: Any,
    sell: Any,
    main_product: Any,
    store: Any,
    clock: Any,
    set_recipe: Any,
    ingredient_seeded: Any,
) -> None:
    """Auditoría u9: el «Mix de platos» ya no parte con su propia regla.
    Un plato con menos unidades que el mínimo de la ingeniería de menú no se
    ubica (muestra chica), y uno que sí lo alcanza lleva el cuadrante de la
    matriz: un solo plato es su propio promedio, «estrella» → `keep`."""
    from app.analytics.service import MENU_MIN_UNITS_DEFAULT
    from app.reports import series

    clock.set(datetime(2026, 9, 19, 18, 0, tzinfo=timezone.utc))
    set_recipe(
        main_product.id,
        [{"ingredient_id": ingredient_seeded.id, "qty": "1000", "unit": "g"}],
    )
    open_shift()
    sell(main_product, qty=2)
    today = tz.today_business_date(store.cutoff_hour)
    mix = _overview(admin_client, store.id, today)["series"]["dish_mix"]
    assert mix["available"] is False
    assert mix["reason"] == series.DISH_MIX_SMALL_SAMPLE_REASON
    assert mix["insufficient_sample"] == 1

    sell(main_product, qty=MENU_MIN_UNITS_DEFAULT)
    body = _overview(admin_client, store.id, today)
    mix = body["series"]["dish_mix"]
    [point] = mix["points"]
    assert point["key"] == str(main_product.id)
    assert point["units"] == 2 + MENU_MIN_UNITS_DEFAULT
    assert (point["classification"], point["group"]) == ("star", "keep")
    assert mix["avg_margin_per_unit"] == point["margin_per_unit"]
    # Un solo plato: toda la popularidad es suya (raya del 70 % en unidades).
    assert mix["avg_units"] == 15  # 7.000 bp × 22 u.
    # Con «Todas las sedes» de una organización de una sola sede, la matriz
    # es la de esa sede.
    all_body = _overview(admin_client, "all", today)
    assert all_body["store_ids"] == [store.id]
    assert all_body["series"]["dish_mix"]["points"] == mix["points"]


def test_peak_hours_are_dine_in_orders_against_waiters_on_shift(
    admin_client: TestClient,
    device_client: TestClient,
    identify: Any,
    employees: Any,
    open_shift: Any,
    main_product: Any,
    tables: Any,
    store: Any,
    db: Session,
    clock: Any,
) -> None:
    waiter = employees["operator"]
    waiter.puesto = "salon"
    db.commit()
    clock.set(datetime(2026, 9, 19, 16, 0, tzinfo=timezone.utc))  # 11:00 en Bogotá
    open_shift()
    clock.set(
        datetime(2026, 9, 19, 17, 10, tzinfo=timezone.utc)
    )  # 12:10: comanda sin mesero adentro
    identify(device_client, employees["cashier"])
    _open_dine_in_order(device_client, main_product, tables[0].id)
    clock.set(
        datetime(2026, 9, 19, 17, 40, tzinfo=timezone.utc)
    )  # 12:40: el mesero marca entrada
    identify(device_client, waiter)
    clock.set(datetime(2026, 9, 19, 18, 45, tzinfo=timezone.utc))  # 13:45
    today = tz.today_business_date(store.cutoff_hour)

    peak = _overview(admin_client, store.id, today)["series"]["peak_hours"]
    assert peak["available"] is True
    assert peak["orders_per_waiter"] == 7
    avg = peak["views"][0]
    assert avg["key"] == "avg" and avg["days"] == 1
    by_hour = {p["key"]: p for p in avg["points"]}
    assert list(by_hour) == [str(h) for h in range(11, 23)]
    assert by_hour["12"]["label"] == "12 p. m."
    # 12:30 sin meseros: la comanda pasa lo que el salón alcanza (0).
    assert by_hour["12"] | {"delta_bp": None} == by_hour["12"] | {
        "value": 1,
        "waiters": 0,
        "reference": 0,
        "outside": True,
        "delta_bp": None,
    }
    # 13:30 con un mesero: alcanza 7 comandas.
    assert (
        by_hour["13"]["value"],
        by_hour["13"]["waiters"],
        by_hour["13"]["reference"],
    ) == (0, 1, 7)
    assert by_hour["13"]["outside"] is False

    weekday_views = {v["key"]: v for v in peak["views"][1:]}
    assert len(weekday_views) == 7
    assert weekday_views["sat"]["days"] == 1  # 19 sep 2026 es sábado
    assert weekday_views["mon"]["days"] == 0
    assert all(p["value"] is None for p in weekday_views["mon"]["points"])

    _put_sales_settings(admin_client, store.id, orders_per_waiter=5)
    avg = _overview(admin_client, store.id, today)["series"]["peak_hours"]["views"][0]
    assert {p["key"]: p for p in avg["points"]}["13"]["reference"] == 5


# ---------------------------------------------------------------------------
# Ficha de turno: efectivo por hora
# ---------------------------------------------------------------------------


def test_cash_by_hour_is_compute_breakdown_read_hour_by_hour_with_pickups_marked(
    admin_client: TestClient,
    device_client: TestClient,
    open_shift: Any,
    sell: Any,
    main_product: Any,
    store: Any,
    db: Session,
    clock: Any,
    identify: Any,
    employees: Any,
) -> None:
    clock.set(datetime(2026, 9, 19, 12, 0, tzinfo=timezone.utc))  # 7:00 a. m.
    shift = open_shift()
    clock.set(datetime(2026, 9, 19, 13, 10, tzinfo=timezone.utc))  # 8:10
    identify(device_client, employees["cashier"])
    sell(main_product, qty=1)
    clock.set(datetime(2026, 9, 19, 14, 20, tzinfo=timezone.utc))  # 9:20
    identify(device_client, employees["cashier"])
    pickup = device_client.post(
        f"{API}/shifts/{shift['id']}/pickups",
        json={
            "amount": 50_000,
            "authorizer_pin": KNOWN_PINS["Admin"],
            "note": "banco",
            "photo": "retiro.jpg",
        },
        headers={"Idempotency-Key": str(uuid4())},
    )
    assert pickup.status_code in (200, 201), pickup.text
    clock.set(datetime(2026, 9, 19, 15, 30, tzinfo=timezone.utc))  # 10:30

    record = admin_client.get(f"{API}/admin/records/shift/{shift['id']}").json()
    cash = record["cash_by_hour"]
    assert cash["reference"] == 500_000  # umbral de retiro de la sede
    labels = [p["label"] for p in cash["points"]]
    assert labels == ["7 a. m.", "8 a. m.", "9 a. m.", "10 a. m."]
    values = [p["value"] for p in cash["points"]]
    assert values[0] == 200_000
    assert values[1] == 200_000 + 25_000
    assert values[2] == values[1] - 50_000
    assert cash["points"][2]["pickups"] == [50_000]
    assert cash["points"][3]["now"] is True
    # La última barra ES el esperado: la misma fórmula, sin otra cuenta.
    row = db.get(Shift, shift["id"])
    assert row is not None
    assert values[-1] == shifts_service.compute_breakdown(db, row)["expected"]
    assert values[-1] == _panel_store(admin_client, store.id)["cash"]["expected_cash"]
    assert cash["hours_over"] == 0

    # Bajar el umbral en Ajustes › Caja pinta las horas que lo pasan.
    settings = admin_client.get(f"{API}/admin/stores/{store.id}/cash-settings").json()
    resp = admin_client.put(
        f"{API}/admin/stores/{store.id}/cash-settings",
        json={**settings, "cash_pickup_threshold": 210_000},
    )
    assert resp.status_code == 200, resp.text
    cash = admin_client.get(f"{API}/admin/records/shift/{shift['id']}").json()[
        "cash_by_hour"
    ]
    assert [p["outside"] for p in cash["points"]] == [False, True, False, False]
    assert cash["hours_over"] == 1


def test_cash_by_hour_of_an_abandoned_shift_stops_where_the_cash_stopped_moving(
    admin_client: TestClient,
    device_client: TestClient,
    open_shift: Any,
    sell: Any,
    main_product: Any,
    store: Any,
    clock: Any,
    identify: Any,
    employees: Any,
) -> None:
    """Un turno abierto hace tres días dibujaba treinta columnas iguales.
    La serie se corta en la última hora con movimiento más una, y dice en
    palabras desde cuándo está abierto y dónde se cortó."""
    clock.set(datetime(2026, 9, 19, 12, 0, tzinfo=timezone.utc))  # 7:00 a. m.
    shift = open_shift()
    clock.set(datetime(2026, 9, 19, 13, 10, tzinfo=timezone.utc))  # 8:10
    identify(device_client, employees["cashier"])
    sell(main_product, qty=1)
    clock.set(datetime(2026, 9, 22, 15, 0, tzinfo=timezone.utc))  # tres días después

    cash = admin_client.get(f"{API}/admin/records/shift/{shift['id']}").json()["cash_by_hour"]
    assert cash["truncated"] is True
    assert [p["label"] for p in cash["points"]] == ["7 a. m.", "8 a. m.", "9 a. m."]
    # La última columna es la hora quieta que sigue al último movimiento.
    assert cash["points"][2]["value"] == cash["points"][1]["value"]
    reason = cash["truncated_reason"]
    assert "sáb 19 sep" in reason and "8 a. m." in reason
    assert "2026-09-19" not in reason

    # El semáforo dice la fecha como la lee el dueño, nunca en ISO.
    reasons = [r["text"] for r in _panel_store(admin_client, store.id)["reasons"]]
    stale = [t for t in reasons if t.startswith("Turno abandonado")]
    assert stale and "sáb 19 sep" in stale[0] and "2026-09-19" not in stale[0]


# ---------------------------------------------------------------------------
# Ficha de insumo: stock al cierre y proyección
# ---------------------------------------------------------------------------


def test_stock_by_day_reads_the_ledger_and_projects_the_average_use(
    admin_client: TestClient,
    ingredient_seeded: Any,
    set_feature: Any,
    admin_actor: Any,
    store: Any,
    db: Session,
    clock: Any,
) -> None:
    from app.inventory import hooks as inventory_hooks
    from app.inventory.models import CostSource, MovementCause

    set_feature("inventory.perpetual", True)
    clock.set(datetime(2026, 9, 19, 18, 0, tzinfo=timezone.utc))
    today = tz.today_business_date(store.cutoff_hour)
    ingredient_seeded.min_stock = 15_000_000  # 15 kg
    db.commit()

    def move(day: date, qty: int, cause: Any) -> None:
        inventory_hooks.record_movement(
            db,
            organization_id=store.organization_id,
            store_id=store.id,
            ingredient_id=ingredient_seeded.id,
            qty_base=qty,
            cause=cause,
            cost_micros=None,
            cost_source=CostSource.NONE,
            actor=admin_actor,
            business_date=day,
            at=datetime.combine(day, datetime.min.time(), tzinfo=timezone.utc)
            + timedelta(hours=18),
        )

    move(today - timedelta(days=10), 20_000_000, MovementCause.PURCHASE)
    for k in range(9, 0, -1):
        move(today - timedelta(days=k), -1_000_000, MovementCause.SALE)
    db.commit()

    body = admin_client.get(
        f"{API}/admin/records/ingredient/{ingredient_seeded.id}"
    ).json()
    stock = body["stock_by_day"]
    assert stock["available"] is True
    assert stock["min_stock"] == "15000"
    points = stock["points"]
    assert len(points) == 14 + 7
    closed, projected = points[:14], points[14:]
    # Antes del primer movimiento no hay libro: «sin dato», no 0.
    assert [p["qty"] for p in closed[:4]] == [None, None, None, None]
    assert closed[4]["qty"] == "20000"
    assert closed[-1]["qty"] == "11000"
    assert closed[-1]["business_date"] == (today - timedelta(days=1)).isoformat()
    # El último cierre es el stock del libro (nada se movió hoy).
    assert body["stock"] == "11000"
    assert all(p["future"] for p in projected) and not any(p["future"] for p in closed)
    assert projected[0]["now"] is True
    # 9 kg en 10 días con libro: 900 g por día.
    assert stock["daily_use"] == "900"
    assert projected[0]["qty"] == "10100"
    assert projected[-1]["qty"] == "4700"
    assert stock["below_min_on"] == (today - timedelta(days=5)).isoformat()
    assert stock["runs_out_on"] is None
    assert [p["outside"] for p in closed[4:10]] == [
        False,
        False,
        False,
        False,
        False,
        True,
    ]

    set_feature("inventory.perpetual", False)
    off = admin_client.get(
        f"{API}/admin/records/ingredient/{ingredient_seeded.id}"
    ).json()["stock_by_day"]
    assert off["available"] is False and off["reason"]
    assert off["points"] == []


# ---------------------------------------------------------------------------
# Hoy: los bullets
# ---------------------------------------------------------------------------


def test_today_bullets_tables_cash_sales_staff_and_kitchen(
    admin_client: TestClient,
    device_client: TestClient,
    open_shift: Any,
    main_product: Any,
    tables: Any,
    store: Any,
    clock: Any,
    set_feature: Any,
) -> None:
    clock.set(datetime(2026, 9, 19, 13, 0, tzinfo=timezone.utc))  # 8:00 a. m.
    open_shift()
    _open_dine_in_order(device_client, main_product, tables[0].id)
    clock.set(datetime(2026, 9, 19, 14, 1, tzinfo=timezone.utc))  # 61 min después

    panel = _panel_store(admin_client, store.id)
    bullets = panel["bullets"]
    # Caja: el esperado contra el umbral de retiro.
    assert bullets["cash"]["value"] == panel["cash"]["expected_cash"]
    assert bullets["cash"]["reference"] == 500_000
    assert bullets["cash"]["outside"] is False and bullets["cash"]["over_by"] is None
    # Ventas: la sede no operaba hace una semana → sin raya, con motivo.
    assert bullets["sales"]["reference"] is None and bullets["sales"]["reason"]
    # Mesas: 61 min contra la mesa larga de Ajustes (60).
    [table] = bullets["tables"]["points"]
    assert bullets["tables"]["reference"] == 60
    assert table["value"] == 61 and table["outside"] is True
    assert table["label"] == tables[0].number
    # Quién trabaja: 6 a. m. a 12 a. m.; lo que no pasó, marcado.
    staff = bullets["staff_by_hour"]["points"]
    assert [p["key"] for p in staff] == [str(h) for h in range(6, 24)]
    by_hour = {p["key"]: p for p in staff}
    assert by_hour["9"]["now"] is True
    assert by_hour["9"]["value"] == 1  # la cajera
    assert by_hour["7"]["value"] == 0 and by_hour["7"]["future"] is False
    assert all(by_hour[str(h)]["future"] for h in range(10, 24))

    _put_sales_settings(
        admin_client, store.id, long_table_minutes=90, late_ticket_minutes=15
    )
    bullets = _panel_store(admin_client, store.id)["bullets"]
    assert bullets["tables"]["reference"] == 90
    assert bullets["tables"]["points"][0]["outside"] is False
    assert bullets["tickets"]["reference"] == 15

    set_feature("kitchen.view", False)
    tickets = _panel_store(admin_client, store.id)["bullets"]["tickets"]
    assert tickets["available"] is False and tickets["reason"]


def test_today_cash_bullet_says_how_much_it_passes_the_threshold(
    admin_client: TestClient,
    open_shift: Any,
    store: Any,
    clock: Any,
) -> None:
    clock.set(datetime(2026, 9, 19, 13, 0, tzinfo=timezone.utc))
    open_shift()
    settings = admin_client.get(f"{API}/admin/stores/{store.id}/cash-settings").json()
    resp = admin_client.put(
        f"{API}/admin/stores/{store.id}/cash-settings",
        json={**settings, "cash_pickup_threshold": 150_000},
    )
    assert resp.status_code == 200, resp.text
    panel = _panel_store(admin_client, store.id)
    cash = panel["bullets"]["cash"]
    assert cash["value"] == 200_000
    assert cash["outside"] is True
    # Lo que pasa del umbral lo dice el servidor; y es el mismo hecho que el semáforo.
    assert cash["over_by"] == 50_000
    assert panel["cash"]["cash_over_threshold"] is True


def test_today_kitchen_tickets_against_the_late_ticket_limit(
    admin_client: TestClient,
    device_client: TestClient,
    open_shift: Any,
    main_product: Any,
    tables: Any,
    store: Any,
    clock: Any,
    set_feature: Any,
) -> None:
    set_feature("kitchen.view", True)
    clock.set(datetime(2026, 9, 19, 13, 0, tzinfo=timezone.utc))
    open_shift()
    order = _open_dine_in_order(device_client, main_product, tables[0].id)
    sent = device_client.post(
        f"{API}/orders/{order['id']}/send",
        json={"expected_version": order["version"]},
        headers=idem_headers(),
    )
    assert sent.status_code == 200, sent.text
    clock.set(datetime(2026, 9, 19, 13, 25, tzinfo=timezone.utc))
    tickets = _panel_store(admin_client, store.id)["bullets"]["tickets"]
    assert tickets["available"] is True
    assert tickets["reference"] == 20
    [ticket] = tickets["points"]
    assert ticket["value"] == 25 and ticket["outside"] is True
