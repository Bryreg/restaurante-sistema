"""Informe del contador «igual que café-sistema» (decisión del dueño
2026-09), con meta mensual y sin nómina: por día operativo, lo cobrado partido
en efectivo / tarjeta / transferencia / otros, total, acumulado, facturas,
ticket promedio y, encima de café, base, impuesto, notas crédito y propinas.
Todo lo calcula el servidor (la interfaz sólo pinta): promedios, participación,
deltas contra el mes anterior y el avance de la meta.
"""

from __future__ import annotations

from datetime import date, datetime, timezone
from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.audit.models import AuditLog
from app.fiscal.models import FiscalDocument
from app.reports import accountant
from app.reports.models import SalesGoal
from app.stores.models import Store
from tests.reports.conftest import idem_headers

API = "/api/v1/admin/accountant-report"


def _move(db: Session, document_id: int, business_date: date) -> None:
    """Lleva un documento a otro día operativo (armar un mes sin abrir y
    cerrar treinta turnos). El informe lee `business_date` del documento."""
    db.execute(update(FiscalDocument).where(FiscalDocument.id == document_id).values(business_date=business_date))
    db.commit()


def _pay_with(db: Session, document_id: int, method: str) -> None:
    """Cambia el medio congelado en el documento (el `sell` de la carpeta
    cobra en efectivo con «recibido», que el datáfono no admite)."""
    doc = db.get(FiscalDocument, document_id)
    assert doc is not None
    doc.payments_snapshot = [{**split, "method": method, "tendered": None, "change": 0} for split in doc.payments_snapshot]
    db.commit()


def _sell_three(
    db: Session, sell: Any, product: Any, *, tip_on_first: int = 0
) -> list[dict[str, Any]]:
    """Tres ventas de $25.000: dos el 3 de marzo (efectivo y datáfono), una el
    10 de marzo (efectivo), y una el 15 de febrero (efectivo, el mes
    anterior)."""
    a = sell(product, qty=1, tip_amount=tip_on_first)
    b = sell(product, qty=1)
    c = sell(product, qty=1)
    d = sell(product, qty=1)
    _move(db, a["document"]["id"], date(2026, 3, 3))
    _move(db, b["document"]["id"], date(2026, 3, 3))
    _pay_with(db, b["document"]["id"], "card")
    _move(db, c["document"]["id"], date(2026, 3, 10))
    _move(db, d["document"]["id"], date(2026, 2, 15))
    return [a, b, c, d]


def test_per_day_split_by_method_totals_and_averages(
    admin_client: TestClient, device_client: TestClient, identify: Any, employees: Any, open_shift: Any,
    sell: Any, main_product: Any, clock: Any, store: Store, db: Session,
) -> None:
    clock.set(datetime(2026, 4, 20, 15, 0, tzinfo=timezone.utc))  # marzo ya cerrado
    open_shift()
    identify(device_client, employees["cashier"])
    _sell_three(db, sell, main_product, tip_on_first=2_000)

    resp = admin_client.get(API, params={"store_id": store.id, "year": 2026, "month": 3})
    assert resp.status_code == 200, resp.text
    body = resp.json()

    days = body["days"]
    assert [d["business_date"] for d in days] == ["2026-03-03", "2026-03-10"]
    first, second = days
    assert (first["cash"], first["card"], first["transfer"], first["other"]) == (25_000, 25_000, 0, 0)
    assert first["total"] == 50_000
    assert first["cumulative"] == 50_000
    assert first["documents_count"] == 2
    # Ticket promedio = el de «Hoy» (`service.average_ticket`): venta neta
    # sin impuesto ni propina ÷ comandas. $25.000 con INC 8 % → 23.148.
    assert first["orders_count"] == 2
    assert first["avg_ticket"] == 23_148
    # Lo fiscal que café no tenía: base + impuesto reproducen la venta, y la
    # propina va aparte (no suma al total).
    assert first["base"] + first["tax"] == 50_000
    assert first["tax"] == 1_852 * 2
    assert first["tips"] == 2_000
    assert first["credit_notes"] == 0
    assert second["cumulative"] == 75_000

    s = body["summary"]
    assert s["total"] == 75_000
    assert (s["cash"], s["card"], s["transfer"], s["other"]) == (50_000, 25_000, 0, 0)
    assert s["documents_count"] == 3
    assert s["days_with_sales"] == 2
    assert s["days_in_period"] == 31  # mes cerrado: todos sus días
    assert s["avg_daily_with_sales"] == 37_500
    assert s["avg_daily_calendar"] == 2_419  # 75.000 / 31, half-up
    assert s["orders_count"] == 3
    assert s["avg_ticket"] == 23_148  # 69.444 ÷ 3
    assert s["tips"] == 2_000
    shares = {m["method"]: m["share_bp"] for m in s["shares"]}
    assert shares == {"cash": 6_667, "card": 3_333, "transfer": 0, "other": 0}
    assert s["best_day"] == {"business_date": "2026-03-03", "total": 50_000}
    assert s["worst_day"] == {"business_date": "2026-03-10", "total": 25_000}
    assert s["tax_by_rate"] == [{"rate": 8, "base": s["base"], "tax": s["tax"]}]

    # El contrato de antes sigue igual (lo leen otras pantallas y tests).
    assert body["documents_total_base"] + body["documents_total_tax"] == 75_000
    assert body["tips_total"] == 2_000


def test_current_month_divides_by_elapsed_days_and_deltas_are_server_side(
    admin_client: TestClient, device_client: TestClient, identify: Any, employees: Any, open_shift: Any,
    sell: Any, main_product: Any, clock: Any, store: Store, db: Session,
) -> None:
    clock.set(datetime(2026, 3, 10, 18, 0, tzinfo=timezone.utc))  # 10 de marzo, en curso
    open_shift()
    identify(device_client, employees["cashier"])
    _sell_three(db, sell, main_product)

    body = admin_client.get(API, params={"store_id": store.id, "year": 2026, "month": 3}).json()
    s = body["summary"]
    assert s["days_in_period"] == 10
    assert s["avg_daily_calendar"] == 7_500

    cmp = body["comparison"]
    assert cmp["previous_year"] == 2026 and cmp["previous_period"] == 2
    assert cmp["previous_label"] == "Febrero 2026"
    assert cmp["total"] == {"previous": 25_000, "pct": 200}
    assert cmp["avg_ticket"] == {"previous": 23_148, "pct": 0}
    assert cmp["avg_daily_with_sales"] == {"previous": 25_000, "pct": 50}

    # Febrero contra enero (sin ventas): el delta es `null`, no «+100 %».
    feb = admin_client.get(API, params={"store_id": store.id, "year": 2026, "month": 2}).json()
    assert feb["comparison"]["total"] == {"previous": 0, "pct": None}
    assert feb["comparison"]["avg_ticket"] == {"previous": None, "pct": None}


def test_empty_month_says_null_never_zero(admin_client: TestClient, store: Store) -> None:
    body = admin_client.get(API, params={"store_id": store.id, "year": 2026, "month": 1}).json()
    s = body["summary"]
    assert body["days"] == []
    assert s["total"] == 0
    assert s["avg_ticket"] is None
    assert s["avg_daily_with_sales"] is None
    assert s["best_day"] is None and s["worst_day"] is None
    assert all(m["share_bp"] is None for m in s["shares"])


def test_a_credit_note_is_listed_apart_and_the_reversed_sale_leaves_the_total(
    admin_client: TestClient, device_client: TestClient, identify: Any, employees: Any, open_shift: Any,
    sell: Any, main_product: Any, clock: Any, store: Store,
) -> None:
    clock.set(datetime(2026, 4, 5, 15, 0, tzinfo=timezone.utc))
    open_shift()
    identify(device_client, employees["cashier"])
    kept = sell(main_product, qty=1)
    voided = sell(main_product, qty=1)
    note = admin_client.post(
        f"/api/v1/admin/documents/{voided['document']['id']}/notes",
        json={"kind": "adjustment", "reason": "Producto no entregado",
              "lines": [{"item_id": voided["order"]["items"][0]["id"], "used": True}]},
        headers=idem_headers(),
    )
    assert note.status_code == 201, note.text
    assert kept["document"]["id"]

    body = admin_client.get(API, params={"store_id": store.id, "year": 2026, "month": 4}).json()
    (day,) = body["days"]
    assert day["documents_count"] == 1
    assert day["total"] == 25_000  # el reversado ya no suma
    assert day["credit_notes"] == 25_000
    assert body["summary"]["credit_notes"] == 25_000


def test_method_groups_follow_code_then_dian_code() -> None:
    assert accountant.method_group({"method": "cash"}) == "cash"
    assert accountant.method_group({"method": "card"}) == "card"
    assert accountant.method_group({"method": "nequi"}) == "transfer"
    assert accountant.method_group({"method": "daviplata"}) == "transfer"
    assert accountant.method_group({"method": "transfer"}) == "transfer"
    assert accountant.method_group({"method": "bono_x", "dian_code": "48"}) == "card"
    assert accountant.method_group({"method": "rappi", "dian_code": "ZZZ"}) == "other"


def test_delta_pct_rounds_half_up_with_sign() -> None:
    assert accountant.delta_pct(150, 100) == 50
    assert accountant.delta_pct(50, 100) == -50
    assert accountant.delta_pct(1, 3) == -67
    assert accountant.delta_pct(100, 0) is None
    assert accountant.delta_pct(None, 100) is None


# ---------------------------------------------------------------------------
# La meta del mes.
# ---------------------------------------------------------------------------


def test_goal_crud_progress_inheritance_and_audit(
    admin_client: TestClient, device_client: TestClient, identify: Any, employees: Any, open_shift: Any,
    sell: Any, main_product: Any, clock: Any, store: Store, db: Session,
) -> None:
    clock.set(datetime(2026, 4, 20, 15, 0, tzinfo=timezone.utc))
    open_shift()
    identify(device_client, employees["cashier"])
    _sell_three(db, sell, main_product)

    none_yet = admin_client.get(API, params={"store_id": store.id, "year": 2026, "month": 3}).json()["goal"]
    assert none_yet["amount"] is None and none_yet["progress_bp"] is None and none_yet["editable"] is True

    put = admin_client.put(f"{API}/goal", json={"store_id": store.id, "year": 2026, "month": 3, "amount": 100_000})
    assert put.status_code == 200, put.text
    assert put.json()["amount"] == 100_000 and put.json()["source"] == "month"
    # La respuesta del PUT ya trae el avance contra lo cobrado del mes: la
    # interfaz pinta la barra sin hacer la cuenta.
    assert put.json()["progress_bp"] == 7_500 and put.json()["remaining"] == 25_000

    goal = admin_client.get(API, params={"store_id": store.id, "year": 2026, "month": 3}).json()["goal"]
    assert goal["progress_bp"] == 7_500
    assert goal["bar_bp"] == 7_500
    assert goal["remaining"] == 25_000
    assert goal["met"] is False

    # Abril no tiene la suya: hereda la de marzo, y lo dice.
    april = admin_client.get(f"{API}/goal", params={"store_id": store.id, "year": 2026, "month": 4}).json()
    assert april["amount"] == 100_000 and april["source"] == "inherited" and april["inherited_from"] == "2026-03"

    # Bajarla hasta cumplirla: la barra topa en 100 %, lo que falta es 0.
    admin_client.put(f"{API}/goal", json={"store_id": store.id, "year": 2026, "month": 3, "amount": 50_000})
    goal = admin_client.get(API, params={"store_id": store.id, "year": 2026, "month": 3}).json()["goal"]
    assert goal["progress_bp"] == 15_000 and goal["bar_bp"] == 10_000
    assert goal["remaining"] == 0 and goal["met"] is True

    # 0 = sin meta para ese mes (y abril, que heredaba, se queda sin meta).
    cleared = admin_client.put(f"{API}/goal", json={"store_id": store.id, "year": 2026, "month": 3, "amount": 0})
    assert cleared.status_code == 200 and cleared.json()["amount"] is None
    april = admin_client.get(f"{API}/goal", params={"store_id": store.id, "year": 2026, "month": 4}).json()
    assert april["amount"] is None

    rows = list(db.execute(select(SalesGoal).where(SalesGoal.store_id == store.id)).scalars())
    assert len(rows) == 1, "una fila por sede y mes: guardar tres veces no duplica"
    audits = list(db.execute(select(AuditLog).where(AuditLog.entity == "sales_goal")).scalars())
    assert [a.action for a in audits] == ["create", "update", "update"]


def test_goal_rejects_bad_input_and_foreign_store(admin_client: TestClient, store: Store, store_b: Store) -> None:
    negative = admin_client.put(f"{API}/goal", json={"store_id": store.id, "year": 2026, "month": 3, "amount": -1})
    assert negative.status_code == 400 and negative.json()["error"]["code"] == "VALIDATION_ERROR"
    bad_month = admin_client.put(f"{API}/goal", json={"store_id": store.id, "year": 2026, "month": 13, "amount": 1})
    assert bad_month.status_code == 400
    foreign = admin_client.put(f"{API}/goal", json={"store_id": store_b.id, "year": 2026, "month": 3, "amount": 1})
    assert foreign.status_code == 404


def test_all_stores_adds_up_and_the_goal_is_not_editable(
    admin_client: TestClient, store: Store, db: Session,
) -> None:
    body = admin_client.get(API, params={"store_id": "all", "year": 2026, "month": 3})
    assert body.status_code == 200, body.text
    data = body.json()
    assert data["all_stores"] is True and data["store_id"] is None
    assert data["goal"]["editable"] is False

    admin_client.put(f"{API}/goal", json={"store_id": store.id, "year": 2026, "month": 3, "amount": 80_000})
    data = admin_client.get(API, params={"store_id": "all", "year": 2026, "month": 3}).json()
    assert data["goal"]["amount"] == 80_000 and data["goal"]["source"] == "sum"


def test_bimester_keeps_working_without_a_monthly_goal(admin_client: TestClient, store: Store) -> None:
    body = admin_client.get(API, params={"store_id": store.id, "year": 2026, "bimester": 2}).json()
    assert body["goal"] is None
    assert body["comparison"]["previous_label"] == "Enero – Febrero 2026"


# ---------------------------------------------------------------------------
# El «Excel».
# ---------------------------------------------------------------------------


def test_csv_is_semicolon_bom_spanish_headers_and_total_row(
    admin_client: TestClient, device_client: TestClient, identify: Any, employees: Any, open_shift: Any,
    sell: Any, main_product: Any, clock: Any, store: Store, db: Session,
) -> None:
    clock.set(datetime(2026, 4, 20, 15, 0, tzinfo=timezone.utc))
    open_shift()
    identify(device_client, employees["cashier"])
    _sell_three(db, sell, main_product, tip_on_first=2_000)

    resp = admin_client.get(API, params={"store_id": store.id, "year": 2026, "month": 3, "format": "csv"})
    assert resp.status_code == 200, resp.text
    assert resp.headers["content-type"].startswith("text/csv")
    assert resp.headers["content-disposition"] == 'attachment; filename="informe-contador-2026-03.csv"'
    raw = resp.content
    assert raw.startswith(b"\xef\xbb\xbf"), "sin BOM, Excel abre las tildes rotas"
    lines = raw.decode("utf-8-sig").splitlines()
    assert lines[0] == (
        "Dia operativo;Efectivo;Tarjeta;Transferencia;Otros;Total Diario;Acumulado Mes;"
        "Facturas;Ticket Promedio;Base;Impuesto;Notas credito;Propinas"
    )
    first = lines[1].split(";")
    assert first[:9] == ["2026-03-03", "25000", "25000", "0", "0", "50000", "50000", "2", "23148"]
    assert first[12] == "2000"
    total = lines[-1].split(";")
    assert total[0] == "TOTAL"
    assert total[5] == "75000" and total[6] == "" and total[7] == "3"
    assert len(lines) == 4  # cabecera + 2 días + TOTAL
