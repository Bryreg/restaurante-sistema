"""El costo real en Utilidad (h12) y el estado de resultados de 12 meses con
presupuesto por renglón (h7): `GET /admin/profit`, `GET
/admin/profit/monthly`, `PUT /admin/profit/budget`."""

from __future__ import annotations

from collections.abc import Callable
from datetime import date
from typing import Any
from uuid import uuid4

from fastapi.testclient import TestClient
from sqlalchemy import select

from app.audit.models import AuditLog
from app.stores.models import Store
from tests.payroll.conftest import bogota_utc

API = "/api/v1"


def _idem() -> dict[str, str]:
    return {"Idempotency-Key": str(uuid4())}


# ---------------------------------------------------------------------------
# h12 · Utilidad con costo real al lado del teórico.
# ---------------------------------------------------------------------------


def test_profit_publishes_the_real_cost_next_to_the_theoretical_and_says_which_one_it_uses(
    admin_client: TestClient, store: Store, set_feature: Callable[..., None]
) -> None:
    set_feature("payroll", False)
    resp = admin_client.get(f"{API}/admin/profit", params={"store_id": store.id, "from": "2026-03-01", "to": "2026-03-31"})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["profit_cost_basis"] == "theoretical"
    # Sin dos conteos completos no hay costo real: `None` con motivo, no $0.
    assert body["cost_real"] is None and body["cost_real_reason"]
    assert body["cost_difference"] is None
    assert body["profit_with_real_cost"] is None
    assert body["variance_days_covered"] == 0 and body["days_in_period"] == 31
    assert body["previous_period"]["profit_cost_basis"] == "theoretical"


def test_cost_of_goods_uses_the_real_cost_only_when_the_counts_cover_the_whole_period(db: Any, store: Store) -> None:
    from app.expenses.service import SalesCost, cost_of_goods
    from app.inventory.hooks import CountWindowVariance

    sc = SalesCost(net_sales=100_000, orders=10, cost=30_000, costed_pct=100, cost_reason=None)
    windows = [CountWindowVariance(date(2026, 3, 1), date(2026, 3, 11), value=2_000, uncosted_ingredients=0)]

    covered = cost_of_goods(db, store=store, date_from=date(2026, 3, 1), date_to=date(2026, 3, 10), sc=sc, windows=windows)
    assert covered.theoretical == 30_000 and covered.variance == 2_000
    assert covered.real == 32_000 and covered.basis == "real" and covered.amount == 32_000
    assert covered.real_reason is None

    partial = cost_of_goods(db, store=store, date_from=date(2026, 3, 1), date_to=date(2026, 3, 15), sc=sc, windows=windows)
    assert partial.real is None and partial.basis == "theoretical" and partial.amount == 30_000
    assert partial.variance_days_covered == 10 and "10 de los 15" in (partial.real_reason or "")

    low_coverage = SalesCost(net_sales=100_000, orders=10, cost=30_000, costed_pct=60, cost_reason="faltan fichas")
    none = cost_of_goods(db, store=store, date_from=date(2026, 3, 1), date_to=date(2026, 3, 10), sc=low_coverage, windows=windows)
    assert none.amount is None and none.basis is None and none.reason == "faltan fichas"


# ---------------------------------------------------------------------------
# h7 · Estado de resultados de 12 meses con presupuesto.
# ---------------------------------------------------------------------------


def _pnl(admin_client: TestClient, store: Store) -> dict[str, Any]:
    resp = admin_client.get(f"{API}/admin/profit/monthly", params={"store_id": store.id, "year": 2026, "month": 3})
    assert resp.status_code == 200, resp.text
    return resp.json()  # type: ignore[no-any-return]


def _row(body: dict[str, Any], key: str) -> dict[str, Any]:
    return next(r for r in body["rows"] if r["key"] == key)


def _budget(admin_client: TestClient, store: Store, line: str, amount: int | None, month: int = 3) -> None:
    resp = admin_client.put(
        f"{API}/admin/profit/budget",
        params={"store_id": store.id},
        json={"year": 2026, "month": month, "line": line, "amount": amount},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"store_id": store.id, "year": 2026, "month": month, "line": line, "amount": amount}


def test_monthly_pnl_has_twelve_months_with_the_profit_of_each(
    admin_client: TestClient, store: Store, set_feature: Callable[..., None], clock: Any
) -> None:
    set_feature("payroll", False)
    clock.set(bogota_utc(2026, 3, 20, 12, 0))
    admin_client.post(
        f"{API}/admin/obligations?store_id={store.id}",
        json={"category": "rent", "description": "Arriendo de marzo", "amount": 2_000_000, "due_date": "2026-03-05"},
        headers=_idem(),
    )
    admin_client.post(
        f"{API}/admin/expenses?store_id={store.id}",
        json={"category": "utilities", "description": "Agua", "amount": 200_000, "business_date": "2026-02-10", "source": "bank"},
        headers=_idem(),
    )

    body = _pnl(admin_client, store)
    months = body["months"]
    assert len(months) == 12
    assert (months[0]["year"], months[0]["month"]) == (2025, 4)
    assert months[-1]["label"] == "mar 2026" and months[-1]["in_progress"] is True
    assert months[-1]["date_to"] == "2026-03-20"
    assert months[-2]["in_progress"] is False and months[-2]["date_to"] == "2026-02-28"
    assert [r["key"] for r in body["rows"]] == ["net_sales", "cost", "payroll", "obligations", "expenses", "profit"]

    assert _row(body, "obligations")["cells"][-1]["amount"] == 2_000_000
    assert _row(body, "expenses")["cells"][-2]["amount"] == 200_000
    profit = _row(body, "profit")
    assert profit["cells"][-1]["amount"] == -2_000_000
    assert profit["cells"][-2]["amount"] == -200_000
    assert profit["total"]["amount"] == -2_200_000
    assert profit["budgetable"] is False
    # Cada mes es la utilidad de la pestaña Utilidad para ese rango.
    feb = admin_client.get(f"{API}/admin/profit", params={"store_id": store.id, "from": "2026-02-01", "to": "2026-02-28"}).json()
    assert profit["cells"][-2]["amount"] == feb["profit"]


def test_budget_variance_is_decided_by_the_server_on_the_bad_side(
    db: Any, admin_client: TestClient, store: Store, set_feature: Callable[..., None], clock: Any
) -> None:
    set_feature("payroll", False)
    clock.set(bogota_utc(2026, 3, 20, 12, 0))
    admin_client.post(
        f"{API}/admin/obligations?store_id={store.id}",
        json={"category": "rent", "description": "Arriendo", "amount": 2_000_000, "due_date": "2026-03-05"},
        headers=_idem(),
    )
    _budget(admin_client, store, "obligations", 1_500_000)
    _budget(admin_client, store, "net_sales", 1_000_000)

    body = _pnl(admin_client, store)
    obligations = _row(body, "obligations")["cells"][-1]
    assert obligations == {
        "amount": 2_000_000, "budget": 1_500_000, "variance": 500_000, "variance_bp": 3_333, "outside": True,
    }
    sales = _row(body, "net_sales")["cells"][-1]
    assert sales["variance"] == -1_000_000 and sales["outside"] is True
    # La utilidad presupuestada sólo existe con los cinco renglones.
    assert _row(body, "profit")["cells"][-1]["budget"] is None

    for line in ("cost", "payroll", "expenses"):
        _budget(admin_client, store, line, 0)
    profit = _row(_pnl(admin_client, store), "profit")["cells"][-1]
    assert profit["budget"] == 1_000_000 - 1_500_000
    assert profit["variance"] == -2_000_000 - (1_000_000 - 1_500_000)
    assert profit["outside"] is True

    # Quitar un presupuesto lo deja en `None`, y queda en el historial.
    _budget(admin_client, store, "obligations", None)
    assert _row(_pnl(admin_client, store), "obligations")["cells"][-1]["budget"] is None
    audits = db.execute(select(AuditLog).where(AuditLog.entity == "pnl_budget")).scalars().all()
    assert len(audits) == 6
    assert audits[-1].before == {"amount": 1_500_000} and audits[-1].after["amount"] is None


def test_budget_rejects_the_profit_line_and_negative_amounts(admin_client: TestClient, store: Store) -> None:
    for payload in (
        {"year": 2026, "month": 3, "line": "profit", "amount": 10},
        {"year": 2026, "month": 3, "line": "cost", "amount": -1},
        {"year": 2026, "month": 13, "line": "cost", "amount": 1},
    ):
        resp = admin_client.put(f"{API}/admin/profit/budget", params={"store_id": store.id}, json=payload)
        assert resp.status_code in (400, 422), resp.text


def test_monthly_pnl_and_budget_follow_the_obligations_function(
    admin_client: TestClient, store: Store, set_feature: Callable[..., None]
) -> None:
    set_feature("money.obligations", False)
    resp = admin_client.get(f"{API}/admin/profit/monthly", params={"store_id": store.id, "year": 2026, "month": 3})
    assert resp.status_code == 400 and resp.json()["error"]["code"] == "FEATURE_DISABLED"
    resp = admin_client.put(
        f"{API}/admin/profit/budget", params={"store_id": store.id}, json={"year": 2026, "month": 3, "line": "cost", "amount": 1}
    )
    assert resp.status_code == 400 and resp.json()["error"]["code"] == "FEATURE_DISABLED"


def test_monthly_pnl_downloads_as_csv(admin_client: TestClient, store: Store, set_feature: Callable[..., None]) -> None:
    set_feature("payroll", False)
    resp = admin_client.get(
        f"{API}/admin/profit/monthly", params={"store_id": store.id, "year": 2026, "month": 3, "format": "csv"}
    )
    assert resp.status_code == 200, resp.text
    assert resp.headers["content-type"].startswith("text/csv")
    assert "Renglón" in resp.text and "Utilidad" in resp.text
