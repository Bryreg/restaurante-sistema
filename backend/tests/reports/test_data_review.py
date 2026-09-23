"""Revisión de datos de septiembre de 2026 (informes del analista y del
científico): métricas de Ventas y Hoy corregidas y ampliadas. Cada test fija
el número correcto con cifras concretas — cambiar una métrica existente sin
un test que la fije es exactamente como se habían colado los errores.

Los documentos se «mueven» de día (`business_date`/`issued_at`) directo en
la base: el reporte lee SÓLO el comprobante emitido, así que es la forma más
corta de armar varios días sin simular cierres de turno."""

from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import Any

from fastapi.testclient import TestClient
from app.core.percent import format_pct_bp
from app.fiscal.models import FiscalDocument
from app.notifications.models import Notification
from app.shifts.models import Shift, ShiftStatus
from tests.reports.conftest import idem_headers

API = "/api/v1"
WIDE = {"from": "2020-01-01", "to": "2099-12-31"}
# Bandeja Paisa ($25.000, INC 8 % incluido): base 23.148 + impuesto 1.852.
BANDEJA_NET = 23_148


def _sales(admin_client: TestClient, store_id: int, group_by: str, **rango: str) -> dict[str, Any]:
    params = {"store_id": store_id, **(rango or WIDE), "group_by": group_by}
    resp = admin_client.get(f"{API}/admin/sales", params=params)
    assert resp.status_code == 200, resp.text
    body: dict[str, Any] = resp.json()
    return body


def _today(admin_client: TestClient, store_id: int) -> dict[str, Any]:
    resp = admin_client.get(f"{API}/admin/today", params={"store_id": store_id})
    assert resp.status_code == 200, resp.text
    body: dict[str, Any] = resp.json()
    return body


def _sell_with_covers(device_client: TestClient, product: Any, table_id: int, covers: int) -> dict[str, Any]:
    order = device_client.post(
        f"{API}/orders", json={"channel": "dine_in", "table_ids": [table_id], "covers": covers}, headers=idem_headers()
    )
    assert order.status_code == 201, order.text
    body = order.json()
    items = device_client.post(
        f"{API}/orders/{body['id']}/items",
        json={"expected_version": body["version"], "items": [{"product_id": product.id, "qty": 1}]},
        headers=idem_headers(),
    )
    assert items.status_code == 200, items.text
    body = items.json()
    total = body["totals"]["total"]
    pay: dict[str, Any] = {"pin": "1111", "splits": [{"method": "cash", "amount": total, "tendered": total}]}
    if body.get("tip") is not None:
        pay["tip"] = {"asked": True, "accepted": False, "modified": False, "amount": 0}
    resp = device_client.post(f"{API}/orders/{body['id']}/payments", json=pay, headers=idem_headers())
    assert resp.status_code == 201, resp.text
    return resp.json()


def _move_document(db: Any, payment: dict[str, Any], *, business_date: date, issued_at: datetime | None = None) -> None:
    doc = db.get(FiscalDocument, payment["document"]["id"])
    doc.business_date = business_date
    if issued_at is not None:
        doc.issued_at = issued_at
    db.commit()


def _clone_shift(db: Any, original: Shift, *, shift_id: int, opened_at: datetime, **extra: Any) -> Shift:
    columns = {c.name: getattr(original, c.name) for c in Shift.__table__.columns if c.name != "id"}
    columns.update(status=ShiftStatus.CLOSED, opened_at=opened_at, closed_at=opened_at + timedelta(hours=8))
    columns.update(extra)
    row = Shift(id=shift_id, **columns)
    db.add(row)
    db.flush()
    return row


# ---------------------------------------------------------------------------
# Científico #1 — ticket por comensal
# ---------------------------------------------------------------------------


def test_avg_per_cover_divides_only_the_net_of_orders_that_have_covers(
    admin_client: TestClient, device_client: TestClient, identify: Any, employees: Any, open_shift: Any,
    sell: Any, main_product: Any, tables: Any, store: Any,
) -> None:
    """Una mesa de 2 comensales ($23.148 neto) y una venta de mostrador sin
    comensales ($23.148 neto). El ticket por comensal es 23.148 ÷ 2 =
    11.574 — antes daba 46.296 ÷ 2 = 23.148 (el mostrador inflaba el
    numerador; en la operación simulada, $36.915 contra $25.402 reales)."""
    open_shift()
    identify(device_client, employees["cashier"])
    _sell_with_covers(device_client, main_product, tables[0].id, covers=2)
    sell(main_product, qty=1)

    total = _sales(admin_client, store.id, "business_date")["total"]
    assert total["net"] == 2 * BANDEJA_NET
    assert total["covers"] == 2
    assert total["avg_per_cover"] == 11_574
    assert total["avg_ticket"] == BANDEJA_NET  # el ticket por comanda sigue sobre todas

    hoy = _today(admin_client, store.id)
    assert hoy["covers"] == 2
    assert hoy["avg_per_cover"] == 11_574


# ---------------------------------------------------------------------------
# Científico #2 y #13 — orden de las filas
# ---------------------------------------------------------------------------


def test_group_by_shift_is_ordered_by_real_opening_not_by_label_text(
    db: Any, admin_client: TestClient, device_client: TestClient, identify: Any, employees: Any, open_shift: Any,
    sell: Any, main_product: Any, store: Any,
) -> None:
    """Turnos #1, #2 y #10 abiertos en ese orden. Ordenando la etiqueta
    como texto salía «#1, #10, #2» y la línea de tiempo terminaba en el
    turno equivocado."""
    open_shift()
    identify(device_client, employees["cashier"])
    ventas = [sell(main_product, qty=1) for _ in range(3)]
    original = db.get(Shift, db.get(FiscalDocument, ventas[0]["document"]["id"]).shift_id)
    base = original.opened_at
    dos = _clone_shift(db, original, shift_id=original.id + 1, opened_at=base + timedelta(days=1))
    diez = _clone_shift(db, original, shift_id=original.id + 9, opened_at=base + timedelta(days=2))
    db.get(FiscalDocument, ventas[1]["document"]["id"]).shift_id = dos.id
    db.get(FiscalDocument, ventas[2]["document"]["id"]).shift_id = diez.id
    db.commit()

    rows = _sales(admin_client, store.id, "shift")["rows"]
    assert [r["key"] for r in rows] == [str(original.id), str(dos.id), str(diez.id)]


def test_nominal_group_bys_are_ordered_by_net_descending(
    admin_client: TestClient, device_client: TestClient, identify: Any, employees: Any, open_shift: Any,
    sell: Any, main_product: Any, drink_product: Any, tables: Any, store: Any,
) -> None:
    """Canal: la mesa vende $25.000 y el mostrador $5.000 — mesa primero,
    aunque alfabéticamente «counter» vaya antes que «dine_in»."""
    open_shift()
    identify(device_client, employees["cashier"])
    sell(drink_product, qty=1)  # mostrador: $5.000
    sell(main_product, qty=1, channel="dine_in", table_ids=[tables[0].id])  # mesa: $25.000
    rows = _sales(admin_client, store.id, "channel")["rows"]
    assert [r["key"] for r in rows] == ["dine_in", "counter"]


# ---------------------------------------------------------------------------
# Períodos vacíos: días y horas con 0 explícito
# ---------------------------------------------------------------------------


def test_business_date_returns_every_day_from_first_activity_to_today_with_explicit_zero(
    db: Any, admin_client: TestClient, device_client: TestClient, identify: Any, employees: Any,
    open_shift: Any, sell: Any, main_product: Any, store: Any, clock: Any,
) -> None:
    """Reloj: 15-ene-2026 07:00 en Bogotá (día operativo 15). Una venta el
    15 (día abierto) y otra movida al 12 (día SIN turno). El rango ancho
    2020-2099 devuelve 12, 13, 14 y 15 —no 29.000 filas, no sólo los dos
    días con venta—: 13 y 14 con `net=0` y `operated=False`."""
    open_shift()
    identify(device_client, employees["cashier"])
    sell(main_product, qty=1)
    movida = sell(main_product, qty=1)
    _move_document(db, movida, business_date=date(2026, 1, 12))

    body = _sales(admin_client, store.id, "business_date")
    rows = body["rows"]
    assert [r["key"] for r in rows] == ["2026-01-12", "2026-01-13", "2026-01-14", "2026-01-15"]
    assert [r["net"] for r in rows] == [BANDEJA_NET, 0, 0, BANDEJA_NET]
    assert [r["operated"] for r in rows] == [False, False, False, True]
    vacio = rows[1]
    assert vacio["orders"] == 0
    assert vacio["avg_ticket"] is None  # sin divisor: null, no 0
    assert vacio["costed_pct"] is None
    assert [r["share_bp"] for r in rows] == [5_000, 0, 0, 5_000]
    assert sum(r["net"] for r in rows) == body["total"]["net"]


def test_group_by_hour_returns_24_hours_from_the_store_cutoff(
    admin_client: TestClient, device_client: TestClient, identify: Any, employees: Any, open_shift: Any,
    sell: Any, main_product: Any, store: Any, clock: Any,
) -> None:
    open_shift()
    identify(device_client, employees["cashier"])
    sell(main_product, qty=1)  # 07:00 en Bogotá

    body = _sales(admin_client, store.id, "hour")
    keys = [r["key"] for r in body["rows"]]
    assert keys == [str(h) for h in [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 0, 1, 2, 3, 4, 5]]
    by_hour = {r["key"]: r for r in body["rows"]}
    assert by_hour["7"]["net"] == BANDEJA_NET
    assert by_hour["7"]["label"] == "07:00"
    assert by_hour["23"]["net"] == 0 and by_hour["23"]["orders"] == 0
    assert sum(r["gross"] for r in body["rows"]) == body["total"]["gross"]


def test_today_sales_by_hour_has_24_buckets_with_pending_future_hours(
    admin_client: TestClient, device_client: TestClient, identify: Any, employees: Any, open_shift: Any,
    sell: Any, main_product: Any, store: Any, clock: Any,
) -> None:
    open_shift()
    identify(device_client, employees["cashier"])
    sell(main_product, qty=1)

    horas = _today(admin_client, store.id)["sales_by_hour"]
    assert [h["hour"] for h in horas][:3] == [6, 7, 8]
    assert len(horas) == 24
    por_hora = {h["hour"]: h for h in horas}
    assert por_hora[7] == {"hour": 7, "gross": 25_000, "net": BANDEJA_NET, "orders": 1, "pending": False}
    assert por_hora[6] == {"hour": 6, "gross": 0, "net": 0, "orders": 0, "pending": False}
    assert por_hora[8]["pending"] is True, "las 08:00 todavía no pasaron: su 0 no es un resultado"
    assert por_hora[5]["pending"] is True


# ---------------------------------------------------------------------------
# Científico #10 — medio de pago
# ---------------------------------------------------------------------------


def test_group_by_method_counts_payments_not_duplicated_orders_and_has_share(
    admin_client: TestClient, device_client: TestClient, identify: Any, employees: Any, open_shift: Any,
    sell: Any, main_product: Any, store: Any,
) -> None:
    """Una comanda de $25.000 pagada $15.000 en efectivo + $10.000 con
    tarjeta, y otra de $25.000 toda en efectivo. Efectivo: 2 pagos, tarjeta:
    1 pago; el total sigue en 2 comandas y 3 pagos. Participación del neto:
    efectivo 40.000/50.000 = 8.000 bp, tarjeta 2.000 bp."""
    open_shift()
    identify(device_client, employees["cashier"])
    order = device_client.post(f"{API}/orders", json={"channel": "counter"}, headers=idem_headers()).json()
    order = device_client.post(
        f"{API}/orders/{order['id']}/items",
        json={"expected_version": order["version"], "items": [{"product_id": main_product.id, "qty": 1}]},
        headers=idem_headers(),
    ).json()
    pay: dict[str, Any] = {
        "pin": "1111",
        "splits": [{"method": "cash", "amount": 15_000, "tendered": 15_000}, {"method": "card", "amount": 10_000}],
    }
    if order.get("tip") is not None:
        pay["tip"] = {"asked": True, "accepted": False, "modified": False, "amount": 0}
    assert device_client.post(f"{API}/orders/{order['id']}/payments", json=pay, headers=idem_headers()).status_code == 201
    sell(main_product, qty=1)

    body = _sales(admin_client, store.id, "method")
    rows = {r["key"]: r for r in body["rows"]}
    assert [r["key"] for r in body["rows"]] == ["cash", "card"]  # neto descendente
    assert rows["cash"]["orders"] == rows["cash"]["payments"] == 2
    assert rows["card"]["orders"] == rows["card"]["payments"] == 1
    assert body["total"]["orders"] == 2
    assert body["total"]["payments"] == 3
    assert rows["cash"]["gross"] == 40_000 and rows["card"]["gross"] == 10_000
    assert rows["cash"]["share_bp"] == 8_000 and rows["card"]["share_bp"] == 2_000
    for fila in rows.values():
        assert fila["costed_pct"] is None, "un medio de pago no tiene ficha: null, no 0 %"
        assert fila["covers"] is None and fila["avg_per_cover"] is None
    assert rows["card"]["avg_ticket"] == rows["card"]["net"]  # un solo pago
    assert body["total"]["share_bp"] is None


# ---------------------------------------------------------------------------
# Comparación contra el período anterior
# ---------------------------------------------------------------------------


def test_sales_total_carries_the_previous_period_of_the_same_length(
    db: Any, admin_client: TestClient, device_client: TestClient, identify: Any, employees: Any,
    open_shift: Any, sell: Any, main_product: Any, store: Any, clock: Any,
) -> None:
    """Semana 9-15 de enero: $46.296 neto en 1 comanda. Semana anterior
    (2-8): $23.148 en 1 comanda, el 8. Neto +100 % (10.000 bp), comandas
    +0, ticket +100 %. La sede empezó el 8: el período anterior es parcial."""
    open_shift()
    identify(device_client, employees["cashier"])
    sell(main_product, qty=2)
    anterior = sell(main_product, qty=1)
    _move_document(db, anterior, business_date=date(2026, 1, 8))

    prev = _sales(admin_client, store.id, "business_date", **{"from": "2026-01-09", "to": "2026-01-15"})["total"]["previous_period"]
    assert prev == {
        "date_from": "2026-01-02",
        "date_to": "2026-01-08",
        "net": BANDEJA_NET,
        "orders": 1,
        "avg_ticket": BANDEJA_NET,
        "delta_bp": 10_000,
        "orders_delta_bp": 0,
        "avg_ticket_delta_bp": 10_000,
        "partial": True,
        "null_reason": None,
    }

    # Un día sin ventas antes: neto 0 es un hecho, pero no hay divisor.
    solo_hoy = _sales(admin_client, store.id, "business_date", **{"from": "2026-01-14", "to": "2026-01-14"})
    assert solo_hoy["total"]["previous_period"]["net"] == 0
    assert solo_hoy["total"]["previous_period"]["delta_bp"] is None

    # Antes de que la sede existiera: null con motivo, nunca «vendió $0».
    viejo = _sales(admin_client, store.id, "business_date", **{"from": "2025-01-08", "to": "2025-01-14"})
    assert viejo["total"]["previous_period"]["net"] is None
    assert viejo["total"]["previous_period"]["null_reason"]
    assert viejo["rows"] == []


def test_today_compares_against_same_weekday_last_week_up_to_the_same_hour(
    db: Any, admin_client: TestClient, device_client: TestClient, identify: Any, employees: Any,
    open_shift: Any, sell: Any, main_product: Any, store: Any, clock: Any,
) -> None:
    """Hoy 15-ene 07:00 (Bogotá): $46.296 neto. Jueves pasado (8-ene): una
    venta de $23.148 a las 06:00 (antes de la misma hora) y otra a las 09:00
    (después). La comparación cuenta sólo la primera: +100 %. La serie de
    referencia es el día completo (las dos). Ayer (14) no hubo nada: cierre
    en $0 con `operated=False`."""
    open_shift()
    identify(device_client, employees["cashier"])
    sell(main_product, qty=2)
    now = clock.now()
    antes = sell(main_product, qty=1)
    despues = sell(main_product, qty=1)
    _move_document(db, antes, business_date=date(2026, 1, 8), issued_at=now - timedelta(days=7, hours=1))
    _move_document(db, despues, business_date=date(2026, 1, 8), issued_at=now - timedelta(days=7) + timedelta(hours=2))

    hoy = _today(admin_client, store.id)
    assert hoy["net"] == 2 * BANDEJA_NET
    comp = hoy["comparison"]
    assert comp["reference_business_date"] == "2026-01-08"
    assert comp["net"] == BANDEJA_NET
    assert comp["orders"] == 1
    assert comp["delta_bp"] == 10_000
    assert comp["orders_delta_bp"] == 0
    assert comp["reference_operated"] is False
    assert comp["null_reason"] is None

    ref = {h["hour"]: h for h in hoy["sales_by_hour_reference"]}
    assert len(ref) == 24
    assert ref[6]["net"] == BANDEJA_NET and ref[9]["net"] == BANDEJA_NET
    assert sum(h["net"] for h in hoy["sales_by_hour_reference"]) == 2 * BANDEJA_NET
    assert all(h["pending"] is False for h in hoy["sales_by_hour_reference"])

    assert hoy["yesterday_close"] == {
        "business_date": "2026-01-14", "net": 0, "orders": 0, "avg_ticket": None, "operated": False,
    }


def test_today_without_history_has_null_comparison_with_reason(
    admin_client: TestClient, store: Any, clock: Any
) -> None:
    hoy = _today(admin_client, store.id)
    assert hoy["comparison"]["net"] is None
    assert hoy["comparison"]["delta_bp"] is None
    assert hoy["comparison"]["null_reason"]
    assert hoy["sales_by_hour_reference"] == []
    assert hoy["yesterday_close"] is None


# ---------------------------------------------------------------------------
# «Qué se vendió»: group_by=product|category
# ---------------------------------------------------------------------------


def test_group_by_product_and_category_report_units_and_net_descending(
    db: Any, admin_client: TestClient, device_client: TestClient, identify: Any, employees: Any, open_shift: Any,
    sell: Any, main_product: Any, drink_product: Any, store: Any,
) -> None:
    """3 gaseosas ($15.000) y 1 bandeja ($25.000): bandeja primero por neto.
    Renombrar el plato después no mueve la etiqueta (nombre congelado)."""
    open_shift()
    identify(device_client, employees["cashier"])
    sell(drink_product, qty=3)
    sell(main_product, qty=1)
    main_product.name = "Bandeja (nombre nuevo)"
    db.commit()

    body = _sales(admin_client, store.id, "product")
    rows = body["rows"]
    assert [r["label"] for r in rows] == ["Bandeja Paisa", "Gaseosa"]
    bandeja, gaseosa = rows
    assert bandeja["units"] == 1 and gaseosa["units"] == 3
    assert bandeja["net"] == BANDEJA_NET and bandeja["gross"] == 25_000
    assert gaseosa["gross"] == 15_000
    assert bandeja["orders"] == 1 and gaseosa["orders"] == 1
    assert sum(r["gross"] for r in rows) == body["total"]["gross"]
    assert sum(r["net"] for r in rows) == body["total"]["net"]
    assert sum(r["share_bp"] for r in rows) == 10_000
    for fila in rows:
        assert fila["tips"] is None, "la propina no es de un plato"
        assert fila["theoretical_cost"] is None  # sin ficha: null, no 0
        assert fila["costed_pct"] == 0
        assert fila["avg_ticket"] is None and fila["covers"] is None

    cats = _sales(admin_client, store.id, "category")["rows"]
    assert [(r["label"], r["units"]) for r in cats] == [("Platos", 1), ("Bebidas", 3)]


# ---------------------------------------------------------------------------
# Analista #4 — riel «Requiere tu atención»
# ---------------------------------------------------------------------------


def _notification(db: Any, store: Any, *, type: str, level: str, payload: dict[str, Any], at: datetime) -> None:
    db.add(
        Notification(
            organization_id=store.organization_id, store_id=store.id, type=type, level=level,
            title=type, body=type, payload=payload, dedupe_key=None, read_at=None, created_at=at,
        )
    )


def test_cash_differences_collapse_into_one_summary_alert_with_amount(
    db: Any, admin_client: TestClient, device_client: TestClient, identify: Any, employees: Any,
    open_shift: Any, sell: Any, main_product: Any, store: Any, clock: Any,
) -> None:
    """Tres cierres de la misma cajera: −$18.000, −$2.000 y +$5.000 (uno
    crítico) más la racha. En vez de cuatro tarjetas sueltas, UNA:
    «3 cierres de caja con diferencia», faltante −$50.000 en 2 y sobrante
    $35.000 en 1, neto −$15.000 en `amount`, y la racha con nombre."""
    open_shift()
    identify(device_client, employees["cashier"])
    venta = sell(main_product, qty=1)
    original = db.get(Shift, db.get(FiscalDocument, venta["document"]["id"]).shift_id)
    now = clock.now()
    # Las tres pasan la tolerancia de la sede ($ 20.000 por defecto): la
    # racha usa la regla de turnos (`shifts.hooks.difference_streak`), que
    # no cuenta lo tolerado.
    diffs = [-28_000, -22_000, 35_000]
    clones = [
        _clone_shift(db, original, shift_id=original.id + 1 + i, opened_at=now - timedelta(days=3 - i), difference=d)
        for i, d in enumerate(diffs)
    ]
    for clone, diff in zip(clones, diffs):
        _notification(db, store, type="cash_difference", level="warning", payload={"shift_id": clone.id, "difference": diff}, at=now)
    _notification(db, store, type="cash_difference_critical", level="critical", payload={"shift_id": clones[0].id, "difference": -18_000}, at=now)
    _notification(db, store, type="difference_streak", level="warning", payload={"employee_id": original.cash_responsible_id, "shift_id": clones[-1].id}, at=now)
    # Un aviso crítico sin plata: va DESPUÉS del resumen crítico con plata.
    _notification(db, store, type="fiscal_contingency_overdue", level="critical", payload={}, at=now + timedelta(minutes=5))
    db.commit()

    alerts = _today(admin_client, store.id)["alerts"]
    types = [a["type"] for a in alerts]
    assert not {"cash_difference", "cash_difference_critical", "difference_streak"} & set(types)
    assert types.count("cash_diff_summary") == 1
    assert types.index("cash_diff_summary") < types.index("fiscal_contingency_overdue")
    resumen = alerts[types.index("cash_diff_summary")]
    assert resumen["level"] == "critical"
    assert resumen["title"] == "3 cierres de caja con diferencia"
    assert resumen["amount"] == -15_000
    payload = resumen["payload"]
    assert (payload["shortage_count"], payload["shortage_total"]) == (2, -50_000)
    assert (payload["surplus_count"], payload["surplus_total"]) == (1, 35_000)
    assert payload["critical_count"] == 1
    assert payload["streaks"] == [
        {"employee_id": original.cash_responsible_id, "employee_name": original.cash_responsible_name, "streak": 3}
    ]
    assert "Faltante -$ 50.000 en 2 cierres; sobrante $ 35.000 en 1 cierre." in resumen["body"]
    assert f"{original.cash_responsible_name} lleva 3 cierres seguidos con diferencia." in resumen["body"]
    otro = alerts[types.index("fiscal_contingency_overdue")]
    assert otro["amount"] is None


def test_negative_stock_is_valued_and_overdue_payables_are_totalled(
    db: Any, admin_client: TestClient, store: Any, ingredient_seeded: Any, admin_actor: Any, set_feature: Any
) -> None:
    """−2 g de pechuga a $14,5/g (costo oficial 14.500.000 micros/g) =
    $29 en juego. Cuentas vencidas: el total es la suma de saldos, hecha en
    el servidor (el cliente no suma plata)."""
    from app.core import clock
    from app.inventory import hooks as inventory_hooks
    from app.inventory.models import CostSource, MovementCause

    inventory_hooks.record_movement(
        db, organization_id=store.organization_id, store_id=store.id, ingredient_id=ingredient_seeded.id,
        qty_base=-2000, cause=MovementCause.MANUAL_ADJUSTMENT, cost_micros=None, cost_source=CostSource.NONE,
        actor=admin_actor, business_date=clock.now_utc().date(), at=clock.now_utc(),
    )
    db.commit()
    set_feature("purchases", True, store_id=store.id)

    hoy = _today(admin_client, store.id)
    fila = next(r for r in hoy["ingredients_negative"] if r["ingredient_id"] == ingredient_seeded.id)
    assert fila["amount"] == 29
    assert hoy["ingredients_negative_amount"] == 29
    assert hoy["ingredients_negative_unvalued"] == 0
    assert hoy["payables_overdue_total"] == 0, "función encendida y nada vencido: $0 es un hecho"
    set_feature("purchases", False, store_id=store.id)
    assert _today(admin_client, store.id)["payables_overdue_total"] is None, "función apagada: null, no $0"

    ingredient_seeded.official_cost_micros = None
    db.commit()
    sin_costo = _today(admin_client, store.id)
    assert sin_costo["ingredients_negative_amount"] is None, "sin costo: null, no $0"
    assert sin_costo["ingredients_negative_unvalued"] == 1


# ---------------------------------------------------------------------------
# Formato es-CO de porcentajes
# ---------------------------------------------------------------------------


def test_format_pct_bp_writes_colombian_percentages() -> None:
    fino = " "
    assert format_pct_bp(1234) == f"12,3{fino}%"
    assert format_pct_bp(1234, decimals=2) == f"12,34{fino}%"
    assert format_pct_bp(1250, decimals=0) == f"13{fino}%"
    assert format_pct_bp(-450) == f"-4,5{fino}%"
    assert format_pct_bp(1_234_567) == f"12.345,7{fino}%"
    assert "." not in format_pct_bp(1234)
