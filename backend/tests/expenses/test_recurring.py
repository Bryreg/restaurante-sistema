"""c5 · Obligaciones recurrentes («armar el mes»), abonos, agenda de
vencimientos, INC del bimestre y nómina como obligación."""

from __future__ import annotations

from collections.abc import Callable
from datetime import date, datetime, timezone
from typing import Any
from uuid import uuid4

from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.expenses.models import Obligation, ObligationPayment
from app.payroll.models import PayrollRun
from app.stores.models import Store

API = "/api/v1"


def _idem() -> dict[str, str]:
    return {"Idempotency-Key": str(uuid4())}


def _template(admin_client: TestClient, store: Store, **overrides: Any) -> dict[str, Any]:
    body = {
        "category": "rent",
        "description": "Arriendo local",
        "amount": 3_000_000,
        "interval_months": 1,
        "due_day": 31,
        "start_month": "2026-01-01",
        **overrides,
    }
    resp = admin_client.post(f"{API}/admin/obligation-templates?store_id={store.id}", json=body, headers=_idem())
    assert resp.status_code == 201, resp.text
    return resp.json()


def _obligation(admin_client: TestClient, store: Store, *, amount: int = 1_000_000, due_date: str = "2026-01-20") -> dict[str, Any]:
    resp = admin_client.post(
        f"{API}/admin/obligations?store_id={store.id}",
        json={"category": "utilities", "description": "Energía", "amount": amount, "due_date": due_date},
        headers=_idem(),
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


# ---------------------------------------------------------------------------
# Plantillas y «armar el mes».
# ---------------------------------------------------------------------------


def test_generate_month_creates_due_copies_and_is_idempotent(
    admin_client: TestClient, store: Store, db: Session, clock: Any
) -> None:
    monthly = _template(admin_client, store)
    bimonthly = _template(
        admin_client, store, category="utilities", description="Agua", amount=180_000, interval_months=2, due_day=10
    )

    plan = admin_client.get(f"{API}/admin/obligations/month-plan", params={"store_id": store.id, "year": 2026, "month": 2})
    assert plan.status_code == 200, plan.text
    body = plan.json()
    # Febrero: el arriendo (mensual) sí, el agua (bimestral desde enero) no.
    assert [line["template_id"] for line in body["to_create"]] == [monthly["id"]]
    assert body["to_create"][0]["due_date"] == "2026-02-28", "el 31 se recorta al último día real de febrero"
    assert body["to_create_total"] == 3_000_000
    assert body["active_templates"] == 2

    first = admin_client.post(
        f"{API}/admin/obligations/generate-month?store_id={store.id}", json={"year": 2026, "month": 3}, headers=_idem()
    )
    assert first.status_code == 200, first.text
    created = first.json()["created"]
    assert {o["template_id"] for o in created} == {monthly["id"], bimonthly["id"]}
    assert all(o["period_month"] == "2026-03-01" for o in created)

    # Otra clave, mismo mes: no duplica nada (llave de negocio en la base).
    second = admin_client.post(
        f"{API}/admin/obligations/generate-month?store_id={store.id}", json={"year": 2026, "month": 3}, headers=_idem()
    )
    assert second.status_code == 200, second.text
    assert second.json()["created"] == []
    assert {line["template_id"] for line in second.json()["already_generated"]} == {monthly["id"], bimonthly["id"]}
    assert db.execute(select(func.count()).select_from(Obligation)).scalar_one() == 2


def test_a_cancelled_copy_is_not_reborn_when_the_month_is_built_again(admin_client: TestClient, store: Store) -> None:
    _template(admin_client, store)
    created = admin_client.post(
        f"{API}/admin/obligations/generate-month?store_id={store.id}", json={"year": 2026, "month": 4}, headers=_idem()
    ).json()["created"]
    cancel = admin_client.post(
        f"{API}/admin/obligations/{created[0]['id']}/cancel", json={"reason": "Abril no se cobró"}, headers=_idem()
    )
    assert cancel.status_code == 200, cancel.text

    again = admin_client.post(
        f"{API}/admin/obligations/generate-month?store_id={store.id}", json={"year": 2026, "month": 4}, headers=_idem()
    ).json()
    assert again["created"] == []
    assert again["already_generated"][0]["cancelled"] is True


def test_template_edits_apply_forward_and_deactivation_stops_generation(admin_client: TestClient, store: Store) -> None:
    tpl = _template(admin_client, store)
    jan = admin_client.post(
        f"{API}/admin/obligations/generate-month?store_id={store.id}", json={"year": 2026, "month": 1}, headers=_idem()
    ).json()["created"][0]

    patched = admin_client.patch(
        f"{API}/admin/obligation-templates/{tpl['id']}", json={"amount": 3_200_000}, headers=_idem()
    )
    assert patched.status_code == 200, patched.text
    feb = admin_client.post(
        f"{API}/admin/obligations/generate-month?store_id={store.id}", json={"year": 2026, "month": 2}, headers=_idem()
    ).json()["created"][0]
    assert feb["amount"] == 3_200_000
    listed = admin_client.get(f"{API}/admin/obligations", params={"store_id": store.id}).json()
    assert next(o for o in listed if o["id"] == jan["id"])["amount"] == 3_000_000, "lo ya generado no se toca"

    off = admin_client.post(
        f"{API}/admin/obligation-templates/{tpl['id']}/deactivate", json={"reason": "Nos mudamos"}, headers=_idem()
    )
    assert off.status_code == 200, off.text
    assert off.json()["active"] is False
    plan = admin_client.get(f"{API}/admin/obligations/month-plan", params={"store_id": store.id, "year": 2026, "month": 3})
    assert plan.json()["to_create"] == []
    assert plan.json()["active_templates"] == 0


def test_template_rejects_out_of_range_interval(admin_client: TestClient, store: Store) -> None:
    resp = admin_client.post(
        f"{API}/admin/obligation-templates?store_id={store.id}",
        json={"category": "rent", "description": "X", "amount": 1, "interval_months": 13, "due_day": 5, "start_month": "2026-01-01"},
        headers=_idem(),
    )
    assert resp.status_code in (400, 422), resp.text


# ---------------------------------------------------------------------------
# Abonos.
# ---------------------------------------------------------------------------


def test_partial_payments_track_paid_pending_and_status(admin_client: TestClient, store: Store) -> None:
    row = _obligation(admin_client, store, due_date="2099-01-01")
    first = admin_client.post(
        f"{API}/admin/obligations/{row['id']}/payments", json={"amount": 400_000, "source": "bank"}, headers=_idem()
    )
    assert first.status_code == 200, first.text
    assert (first.json()["status"], first.json()["paid_amount"], first.json()["pending_amount"]) == ("partial", 400_000, 600_000)

    too_much = admin_client.post(
        f"{API}/admin/obligations/{row['id']}/payments", json={"amount": 700_000, "source": "other"}, headers=_idem()
    )
    assert too_much.status_code == 400, too_much.text
    assert too_much.json()["error"]["code"] == "OBLIGATION_OVERPAYMENT"

    rest = admin_client.post(
        f"{API}/admin/obligations/{row['id']}/payments", json={"amount": 600_000, "source": "other"}, headers=_idem()
    )
    assert rest.status_code == 200, rest.text
    assert (rest.json()["status"], rest.json()["pending_amount"]) == ("paid", 0)
    assert rest.json()["settled_source"] == "other"

    payments = admin_client.get(f"{API}/admin/obligations/{row['id']}/payments").json()
    assert [(p["amount"], p["source"]) for p in payments] == [(400_000, "bank"), (600_000, "other")]

    voided = admin_client.post(
        f"{API}/admin/obligations/{row['id']}/payments/{payments[1]['id']}/void",
        json={"reason": "Transferencia rebotada"},
        headers=_idem(),
    )
    assert voided.status_code == 200, voided.text
    assert (voided.json()["status"], voided.json()["pending_amount"]) == ("partial", 600_000)
    assert voided.json()["settled_at"] is None


def test_settle_pays_only_what_is_left(admin_client: TestClient, store: Store, db: Session) -> None:
    row = _obligation(admin_client, store)
    admin_client.post(
        f"{API}/admin/obligations/{row['id']}/payments", json={"amount": 250_000, "source": "bank"}, headers=_idem()
    )
    settled = admin_client.post(f"{API}/admin/obligations/{row['id']}/settle", json={"source": "bank"}, headers=_idem())
    assert settled.status_code == 200, settled.text
    assert settled.json()["status"] == "paid"
    amounts = sorted(
        db.execute(select(ObligationPayment.amount).where(ObligationPayment.obligation_id == row["id"])).scalars()
    )
    assert amounts == [250_000, 750_000]


def test_an_obligation_with_payments_cannot_be_cancelled(admin_client: TestClient, store: Store) -> None:
    row = _obligation(admin_client, store)
    admin_client.post(
        f"{API}/admin/obligations/{row['id']}/payments", json={"amount": 1_000, "source": "bank"}, headers=_idem()
    )
    resp = admin_client.post(f"{API}/admin/obligations/{row['id']}/cancel", json={"reason": "x"}, headers=_idem())
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "OBLIGATION_HAS_PAYMENTS"


# ---------------------------------------------------------------------------
# Agenda.
# ---------------------------------------------------------------------------


def test_agenda_lists_window_and_all_overdue_with_pending_totals(
    admin_client: TestClient, store: Store, clock: Any
) -> None:
    clock.set(datetime(2026, 3, 10, 15, 0, tzinfo=timezone.utc))
    old = _obligation(admin_client, store, amount=500_000, due_date="2025-12-01")
    soon = _obligation(admin_client, store, amount=800_000, due_date="2026-03-25")
    later = _obligation(admin_client, store, amount=900_000, due_date="2026-05-01")
    admin_client.post(
        f"{API}/admin/obligations/{soon['id']}/payments", json={"amount": 300_000, "source": "bank"}, headers=_idem()
    )
    _template(admin_client, store, description="Arriendo", due_day=5, start_month="2026-04-01")

    a30 = admin_client.get(f"{API}/admin/obligations/agenda", params={"store_id": store.id, "days": 30})
    assert a30.status_code == 200, a30.text
    body = a30.json()
    assert body["today"] == "2026-03-10"
    assert [i["obligation_id"] for i in body["items"]] == [old["id"], soon["id"]]
    assert body["items"][0]["overdue"] is True and body["items"][0]["days_until_due"] < 0
    assert (body["overdue_count"], body["overdue_total"], body["upcoming_total"]) == (1, 500_000, 500_000)
    assert body["total_pending"] == 1_000_000
    assert [(line["due_date"], line["obligation_id"]) for line in body["not_generated"]] == [("2026-04-05", None)]

    a60 = admin_client.get(f"{API}/admin/obligations/agenda", params={"store_id": store.id, "days": 60}).json()
    assert later["id"] in [i["obligation_id"] for i in a60["items"]]


# ---------------------------------------------------------------------------
# INC del bimestre.
# ---------------------------------------------------------------------------


def test_consumption_tax_is_read_from_the_accountant_report_and_scheduled_once(
    admin_client: TestClient,
    device_client: TestClient,
    identify: Callable[..., Any],
    employees: Any,
    open_shift: Callable[..., dict[str, Any]],
    sell: Callable[..., Any],
    drink_product: Any,
    store: Store,
    clock: Any,
) -> None:
    open_shift()
    identify(device_client, employees["cashier"])
    sell(drink_product, qty=3)

    report = admin_client.get(
        f"{API}/admin/accountant-report", params={"store_id": store.id, "year": 2026, "bimester": 1}
    ).json()
    inc = next(r for r in report["summary"]["tax_by_rate"] if r["rate"] == 8)

    # Todavía en enero: el bimestre no cerró.
    open_bimester = admin_client.get(
        f"{API}/admin/obligations/consumption-tax", params={"store_id": store.id, "year": 2026, "bimester": 1}
    ).json()
    assert open_bimester["closed"] is False
    assert open_bimester["tax_amount"] == inc["tax"]
    early = admin_client.post(
        f"{API}/admin/obligations/consumption-tax/schedule?store_id={store.id}",
        json={"year": 2026, "bimester": 1},
        headers=_idem(),
    )
    assert early.status_code == 400, early.text
    assert early.json()["error"]["code"] == "BIMESTER_NOT_CLOSED"

    clock.set(datetime(2026, 3, 3, 15, 0, tzinfo=timezone.utc))
    preview = admin_client.get(f"{API}/admin/obligations/consumption-tax", params={"store_id": store.id}).json()
    assert (preview["year"], preview["bimester"], preview["closed"]) == (2026, 1, True)
    assert preview["due_date"] == "2026-03-08" and preview["due_day_is_default"] is True
    assert preview["scheduled"] is None

    first = admin_client.post(
        f"{API}/admin/obligations/consumption-tax/schedule?store_id={store.id}",
        json={"year": 2026, "bimester": 1},
        headers=_idem(),
    )
    assert first.status_code == 200, first.text
    obligation = first.json()["obligation"]
    assert first.json()["already_existed"] is False
    assert (obligation["category"], obligation["amount"], obligation["due_date"]) == ("consumption_tax", inc["tax"], "2026-03-08")
    assert (obligation["tax_year"], obligation["tax_bimester"]) == (2026, 1)

    again = admin_client.post(
        f"{API}/admin/obligations/consumption-tax/schedule?store_id={store.id}",
        json={"year": 2026, "bimester": 1, "amount": 999_999},
        headers=_idem(),
    )
    assert again.status_code == 200, again.text
    assert again.json()["already_existed"] is True
    assert again.json()["obligation"]["id"] == obligation["id"]


def test_consumption_tax_due_day_is_configurable_and_manual_amount_wins(
    admin_client: TestClient, store: Store, clock: Any
) -> None:
    clock.set(datetime(2026, 11, 20, 15, 0, tzinfo=timezone.utc))
    settings = admin_client.put(
        f"{API}/admin/obligations/settings?store_id={store.id}", json={"consumption_tax_due_day": 19}, headers=_idem()
    )
    assert settings.status_code == 200, settings.text
    assert settings.json()["effective_consumption_tax_due_day"] == 19

    # Sin ventas: no hay INC medido, y sin cifra a mano no se agenda un $0.
    empty = admin_client.get(f"{API}/admin/obligations/consumption-tax", params={"store_id": store.id}).json()
    assert (empty["year"], empty["bimester"]) == (2026, 5)
    assert empty["tax_amount"] is None and empty["reason"]
    assert empty["due_date"] == "2026-11-19"
    refused = admin_client.post(
        f"{API}/admin/obligations/consumption-tax/schedule?store_id={store.id}",
        json={"year": 2026, "bimester": 5},
        headers=_idem(),
    )
    assert refused.status_code == 400, refused.text
    assert refused.json()["error"]["code"] == "CONSUMPTION_TAX_UNAVAILABLE"

    manual = admin_client.post(
        f"{API}/admin/obligations/consumption-tax/schedule?store_id={store.id}",
        json={"year": 2025, "bimester": 6, "amount": 1_234_000},
        headers=_idem(),
    )
    assert manual.status_code == 200, manual.text
    # Nov–dic se declara en enero del año siguiente.
    assert manual.json()["obligation"]["due_date"] == "2026-01-19"
    assert manual.json()["obligation"]["amount"] == 1_234_000


def test_scheduled_payroll_and_consumption_tax_are_not_fixed_costs(
    admin_client: TestClient, store: Store, set_feature: Callable[..., None], clock: Any
) -> None:
    set_feature("payroll", False)
    clock.set(datetime(2026, 3, 3, 15, 0, tzinfo=timezone.utc))
    admin_client.post(
        f"{API}/admin/obligations/consumption-tax/schedule?store_id={store.id}",
        json={"year": 2026, "bimester": 1, "amount": 500_000, "due_date": "2026-03-10"},
        headers=_idem(),
    )
    profit = admin_client.get(
        f"{API}/admin/profit", params={"store_id": store.id, "from": "2026-03-01", "to": "2026-03-31"}
    ).json()
    assert profit["obligations"] == 0, "el INC agendado no es costo fijo: la venta neta ya se mide sin él"
    agenda = admin_client.get(f"{API}/admin/obligations/agenda", params={"store_id": store.id, "days": 30}).json()
    assert agenda["total_pending"] == 500_000


# ---------------------------------------------------------------------------
# Nómina.
# ---------------------------------------------------------------------------


def _run(db: Session, store: Store, *, employer_total: int | None, total: int | None) -> PayrollRun:
    row = PayrollRun(
        organization_id=store.organization_id,
        store_id=store.id,
        date_from=date(2026, 1, 1),
        date_to=date(2026, 1, 15),
        tables_used=[],
        total_amount=total,
        employer_total_amount=employer_total,
        all_available=True,
        computed_at=datetime(2026, 1, 15, 12, 0, tzinfo=timezone.utc),
    )
    db.add(row)
    db.commit()
    return row


def test_payroll_run_is_scheduled_by_its_employer_total_once(
    admin_client: TestClient, store: Store, db: Session, set_feature: Callable[..., None]
) -> None:
    set_feature("payroll", True)
    run = _run(db, store, employer_total=4_500_000, total=3_600_000)
    fallback = _run(db, store, employer_total=None, total=2_000_000)

    candidates = admin_client.get(f"{API}/admin/obligations/payroll-runs", params={"store_id": store.id})
    assert candidates.status_code == 200, candidates.text
    by_id = {c["payroll_run_id"]: c for c in candidates.json()}
    assert (by_id[run.id]["amount"], by_id[run.id]["amount_source"]) == (4_500_000, "employer_total")
    assert (by_id[fallback.id]["amount"], by_id[fallback.id]["amount_source"]) == (2_000_000, "total")

    first = admin_client.post(
        f"{API}/admin/obligations/payroll/schedule?store_id={store.id}", json={"payroll_run_id": run.id}, headers=_idem()
    )
    assert first.status_code == 200, first.text
    obligation = first.json()["obligation"]
    assert (obligation["category"], obligation["amount"], obligation["due_date"]) == ("payroll", 4_500_000, "2026-01-15")
    again = admin_client.post(
        f"{API}/admin/obligations/payroll/schedule?store_id={store.id}", json={"payroll_run_id": run.id}, headers=_idem()
    )
    assert again.json()["already_existed"] is True
    listed = admin_client.get(f"{API}/admin/obligations/payroll-runs", params={"store_id": store.id}).json()
    assert next(c for c in listed if c["payroll_run_id"] == run.id)["scheduled_obligation_id"] == obligation["id"]


def test_payroll_scheduling_requires_the_payroll_feature_and_a_total(
    admin_client: TestClient, store: Store, db: Session, set_feature: Callable[..., None]
) -> None:
    set_feature("payroll", True)
    run = _run(db, store, employer_total=None, total=None)
    resp = admin_client.post(
        f"{API}/admin/obligations/payroll/schedule?store_id={store.id}", json={"payroll_run_id": run.id}, headers=_idem()
    )
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "PAYROLL_RUN_WITHOUT_TOTAL"

    set_feature("payroll", False)
    off = admin_client.get(f"{API}/admin/obligations/payroll-runs", params={"store_id": store.id})
    assert off.status_code == 400, off.text
    assert off.json()["error"]["code"] == "FEATURE_DISABLED"


def test_new_routes_answer_feature_disabled_with_obligations_off(
    admin_client: TestClient, store: Store, set_feature: Callable[..., None]
) -> None:
    set_feature("money.obligations", False)
    for path, params in [
        ("/admin/obligations/agenda", {"store_id": store.id}),
        ("/admin/obligation-templates", {"store_id": store.id}),
        ("/admin/obligations/consumption-tax", {"store_id": store.id}),
    ]:
        resp = admin_client.get(f"{API}{path}", params=params)
        assert resp.status_code == 400, f"{path}: {resp.text}"
        assert resp.json()["error"]["code"] == "FEATURE_DISABLED"
