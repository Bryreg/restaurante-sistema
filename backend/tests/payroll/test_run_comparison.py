"""Liquidación en contexto (informe de visualización #14): % de la nómina
sobre la venta neta del mismo período y comparación contra la liquidación
anterior. Las liquidaciones se insertan tal cual (su total ya lo prueba
`test_runs.py`) y la venta neta se fija en el `hooks` de `reports`, la única
puerta por la que `payroll` la lee: acá se prueba la cuenta, no el motor."""

from __future__ import annotations

from datetime import date, datetime, timezone
from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.payroll.models import PayrollRun

API = "/api/v1"


def _run(db: Session, store: Any, *, date_from: date, date_to: date, total: int | None, at: datetime) -> PayrollRun:
    row = PayrollRun(
        organization_id=store.organization_id, store_id=store.id, date_from=date_from, date_to=date_to,
        tables_used=[], total_amount=total, all_available=total is not None,
        reason=None if total is not None else "Falta tarifa", computed_at=at,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def _fixed_sales(monkeypatch: Any, net_by_period: dict[tuple[date, date], int]) -> None:
    from app.reports import hooks as reports_hooks

    def _fake(db: Any, *, store_id: int, date_from: date, date_to: date) -> reports_hooks.PeriodSales:
        net = net_by_period.get((date_from, date_to), 0)
        return reports_hooks.PeriodSales(net=net, orders=1 if net else 0, theoretical_cost=None, costed_pct=None)

    monkeypatch.setattr(reports_hooks, "period_sales", _fake)


def test_run_publishes_payroll_share_of_sales_and_delta_against_the_previous_run(
    admin_client: TestClient, db: Session, store: Any, monkeypatch: Any
) -> None:
    march = (date(2026, 3, 1), date(2026, 3, 15))
    february = (date(2026, 2, 15), date(2026, 2, 28))
    _fixed_sales(monkeypatch, {march: 1_000_000, february: 900_000})
    at = datetime(2026, 3, 16, 12, 0, tzinfo=timezone.utc)
    # Dos liquidaciones del mismo período anterior: cuenta la última calculada.
    _run(db, store, date_from=february[0], date_to=february[1], total=999_999, at=at.replace(day=1))
    previous = _run(db, store, date_from=february[0], date_to=february[1], total=250_000, at=at.replace(day=2))
    current = _run(db, store, date_from=march[0], date_to=march[1], total=300_000, at=at)

    body = admin_client.get(f"{API}/admin/payroll/runs/{current.id}", params={"store_id": store.id}).json()
    assert body["net_sales"] == 1_000_000
    assert body["payroll_pct_of_sales_bp"] == 3_000  # 300.000 / 1.000.000
    assert body["payroll_pct_reason"] is None
    assert body["previous_run_id"] == previous.id
    assert body["previous_date_from"] == "2026-02-15"
    assert body["previous_date_to"] == "2026-02-28"
    assert body["previous_total"] == 250_000
    assert body["delta_bp"] == 2_000  # +20 %, con signo
    assert body["previous_reason"] is None

    first = admin_client.get(f"{API}/admin/payroll/runs/{previous.id}", params={"store_id": store.id}).json()
    assert first["payroll_pct_of_sales_bp"] == 2_778  # 250.000 / 900.000 = 27,777… %
    assert first["previous_run_id"] is None
    assert first["delta_bp"] is None
    assert first["previous_reason"]

    # Sin `store_id` (así lo llama `getPayrollRun` del cliente): antes 422.
    bare = admin_client.get(f"{API}/admin/payroll/runs/{current.id}")
    assert bare.status_code == 200, bare.text
    assert bare.json()["delta_bp"] == 2_000
    assert admin_client.get(f"{API}/admin/payroll/runs/999999").status_code == 404

    listed = {r["id"]: r for r in admin_client.get(f"{API}/admin/payroll/runs", params={"store_id": store.id}).json()}
    assert listed[current.id]["payroll_pct_of_sales_bp"] == 3_000
    assert listed[current.id]["delta_bp"] == 2_000


def test_run_share_is_null_with_reason_without_sales_or_without_total(
    admin_client: TestClient, db: Session, store: Any, monkeypatch: Any
) -> None:
    _fixed_sales(monkeypatch, {})
    at = datetime(2026, 3, 16, 12, 0, tzinfo=timezone.utc)
    lower = _run(db, store, date_from=date(2026, 2, 1), date_to=date(2026, 2, 14), total=200_000, at=at)
    no_sales = _run(db, store, date_from=date(2026, 3, 1), date_to=date(2026, 3, 15), total=150_000, at=at)
    no_total = _run(db, store, date_from=date(2026, 4, 1), date_to=date(2026, 4, 15), total=None, at=at)

    body = admin_client.get(f"{API}/admin/payroll/runs/{no_sales.id}", params={"store_id": store.id}).json()
    assert body["net_sales"] == 0
    assert body["payroll_pct_of_sales_bp"] is None
    assert body["payroll_pct_reason"]
    assert body["previous_run_id"] == lower.id
    assert body["delta_bp"] == -2_500  # bajó 25 %: el signo lo dice

    body = admin_client.get(f"{API}/admin/payroll/runs/{no_total.id}", params={"store_id": store.id}).json()
    assert body["payroll_pct_of_sales_bp"] is None
    assert body["payroll_pct_reason"]
    assert body["previous_total"] == 150_000
    assert body["delta_bp"] is None
    assert body["previous_reason"]
