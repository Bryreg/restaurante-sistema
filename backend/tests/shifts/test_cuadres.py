"""Cuadres (Caja › Dinero, como el café — decisión del dueño, 2026-09-29).

- La cronología del turno trae de cada movimiento la nota, la foto y, si fue
  un pago a proveedor, **a quién** (por `app.purchases.hooks`).
- `GET /admin/cuadres` publica una tarjeta por turno: la línea de números,
  los cuadres (Inicial, Cierre…) «contó / debía» con su diferencia y su
  desglose —con las salidas una por una—, quién estuvo, los movimientos de
  caja y el desempeño por responsable. Todo calculado en el servidor.
- Las descargas son CSV para Excel en español: `;`, BOM y encabezados en
  español.
"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.auth.deps import Actor
from app.core import clock
from app.purchases.models import ReceptionDraft, ReceptionDraftStatus, Supplier
from app.shifts import hooks
from tests.shifts.conftest import idem

API = "/api/v1"
# El cajón abre vacío: sin días por consignar no debería haber nada
# («igual al café», la única apertura), así que el cuadre inicial cuadra.
BASE = 0


def _denoms(total: int) -> dict[str, Any]:
    return {"denominations": [{"value": 1_000, "count": total // 1_000}], "total": total}


def _supplier_payment(db: Session, cashier: Any, amount: int) -> int:
    """Un pago de contado a «Lácteos del Valle» desde el cajón, registrado en
    el POS al recibir la mercancía (recepción por completar)."""
    movement = hooks.register_supplier_payment_expense(
        db,
        organization_id=cashier.organization_id,
        store_id=cashier.store_id,
        amount=amount,
        actor=Actor(
            kind="device",
            organization_id=cashier.organization_id,
            store_id=cashier.store_id,
            employee_id=cashier.id,
            employee_name=cashier.name,
            role=cashier.role,
        ),
        note="Leche y queso",
    )
    now = clock.now_utc()
    supplier = Supplier(
        organization_id=cashier.organization_id,
        store_id=cashier.store_id,
        name="Lácteos del Valle",
        payment_term_days=0,
        invoices_required=True,
        active=True,
        created_at=now,
        updated_at=now,
    )
    db.add(supplier)
    db.flush()
    db.add(
        ReceptionDraft(
            organization_id=cashier.organization_id,
            store_id=cashier.store_id,
            supplier_id=supplier.id,
            photo="factura.jpg",
            status=ReceptionDraftStatus.PENDING,
            cash_paid_amount=amount,
            cash_movement_id=movement.id,
            created_by_employee_id=cashier.id,
            created_by_employee_name=cashier.name,
            created_at=now,
            business_date=now.date(),
        )
    )
    db.commit()
    return movement.id


def _setup_day(db: Session, device_client: TestClient, open_shift: Any, employees: dict) -> int:
    shift = open_shift(total=BASE)
    _supplier_payment(db, employees["cashier"], 30_000)
    resp = device_client.post(
        f"{API}/shifts/{shift['id']}/cash-movements",
        json={
            "kind": "expense",
            "cause": "petty_expense",
            "amount": 10_000,
            "note": "hielo",
            "receipt_photo": "hielo.jpg",
        },
        headers=idem(),
    )
    assert resp.status_code == 201, resp.text
    resp = device_client.post(
        f"{API}/shifts/{shift['id']}/cash-movements",
        json={"kind": "income", "cause": "other_income", "amount": 50_000, "note": "venta"},
        headers=idem(),
    )
    assert resp.status_code == 201, resp.text
    # Esperado: 0 − 30.000 − 10.000 + 50.000 = 10.000; cuenta 5.000. Cierre
    # a ciegas en tres pasos, la única manera de cerrar.
    count = device_client.post(
        f"{API}/shifts/{shift['id']}/close/count",
        json={"counted_cash": _denoms(5_000), "tips_cash_out": 0, "photo": "cierre.jpg"},
        headers=idem(),
    )
    assert count.status_code == 201, count.text
    count_id = count.json()["count_id"]
    close = device_client.post(
        f"{API}/shifts/{shift['id']}/close/{count_id}/confirm",
        json={"difference_seen": -5_000, "closes_day": True, "cause": "counting_error", "note": "faltaron cinco mil"},
    )
    assert close.status_code == 200, close.text
    return int(shift["id"])


def test_the_timeline_says_who_was_paid_with_note_and_photo(
    db: Session, admin_client: TestClient, device_client: TestClient, open_shift: Any, employees: dict, set_feature: Any, store: Any
) -> None:
    shift_id = _setup_day(db, device_client, open_shift, employees)

    events = admin_client.get(f"{API}/admin/shifts/{shift_id}/timeline").json()
    movements = [e for e in events if e["kind"] == "movement"]
    proveedor = next(e for e in movements if e["data"]["cause"] == "supplier_payment")
    assert proveedor["data"]["supplier_name"] == "Lácteos del Valle"
    assert proveedor["data"]["note"] == "Leche y queso"
    assert "Lácteos del Valle" in proveedor["summary"]
    hielo = next(e for e in movements if e["data"]["cause"] == "petty_expense")
    assert (hielo["data"]["note"], hielo["data"]["photo"], hielo["data"]["supplier_name"]) == ("hielo", "hielo.jpg", None)


def test_the_cuadres_card_has_counts_desglose_movements_and_performance(
    db: Session, admin_client: TestClient, device_client: TestClient, open_shift: Any, employees: dict, set_feature: Any, store: Any
) -> None:
    shift_id = _setup_day(db, device_client, open_shift, employees)

    resp = admin_client.get(f"{API}/admin/cuadres", params={"store_id": store.id, "status": "closed"})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    card = next(c for c in body["shifts"] if c["shift_id"] == shift_id)
    assert card["status"] == "closed"
    assert card["opening_cash_total"] == BASE
    assert card["close_photo"] == "cierre.jpg"

    kinds = [c["kind"] for c in card["cuadres"]]
    assert kinds == ["opening", "close"]
    inicial, cierre = card["cuadres"]
    assert (inicial["counted"], inicial["expected"], inicial["difference"]) == (BASE, BASE, 0)
    assert (cierre["counted"], cierre["expected"], cierre["difference"]) == (5_000, 10_000, -5_000)
    d = cierre["desglose"]
    assert (d["base"], d["incomes"], d["expenses"], d["expected"], d["counted"], d["difference"]) == (
        BASE,
        50_000,
        40_000,
        10_000,
        5_000,
        -5_000,
    )
    assert sorted(line["amount"] for line in d["expense_lines"]) == [10_000, 30_000]

    salidas = [(m["direction"], m["concept"], m["supplier_name"], m["amount"]) for m in card["movements"]]
    assert ("out", "Pago a proveedor", "Lácteos del Valle", -30_000) in salidas
    assert ("out", "Gasto menor", None, -10_000) in salidas
    assert ("in", "Otro ingreso", None, 50_000) in salidas
    assert [p["name"] for p in card["people"]] == [employees["cashier"].name]

    perf = {p["name"]: p for p in body["performance"]}
    cashier = perf[employees["cashier"].name]
    assert (cashier["cuadres"], cashier["with_difference"], cashier["diff_total"], cashier["worst_difference"]) == (
        2,
        1,
        -5_000,
        -5_000,
    )

    abiertos = admin_client.get(f"{API}/admin/cuadres", params={"store_id": store.id, "status": "open"}).json()
    assert abiertos["shifts"] == []


def test_the_downloads_are_csv_for_excel_in_spanish(
    db: Session, admin_client: TestClient, device_client: TestClient, open_shift: Any, employees: dict, set_feature: Any, store: Any
) -> None:
    _setup_day(db, device_client, open_shift, employees)

    for export, header in (
        ("cuadres", "Fecha;Turno;Estado;Cuadre;Hora;Responsable;Contó;Debía;Diferencia;Causa;Nota;Foto"),
        ("movements", "Fecha;Turno;Hora;Tipo;Concepto;Proveedor;Quién;Monto;Nota;Foto"),
        ("performance", "Responsable;Cuadres;Con diferencia;Diferencia total;Peor diferencia"),
    ):
        resp = admin_client.get(
            f"{API}/admin/cuadres", params={"store_id": store.id, "format": "csv", "export": export}
        )
        assert resp.status_code == 200, resp.text
        assert resp.headers["content-type"].startswith("text/csv")
        text = resp.content.decode("utf-8")
        assert text.startswith("﻿"), "con BOM, para que Excel lea las tildes"
        assert text.lstrip("﻿").splitlines()[0] == header
    movimientos = admin_client.get(
        f"{API}/admin/cuadres", params={"store_id": store.id, "format": "csv", "export": "movements"}
    ).content.decode("utf-8")
    assert "Lácteos del Valle" in movimientos
