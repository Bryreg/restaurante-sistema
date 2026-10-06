"""El libro del banco completo (c2, 0046): salidas, ancla, cuentas, 4×1000 y
proyección. Todo entra por la puerta real (HTTP)."""

from __future__ import annotations

from collections.abc import Callable
from datetime import timedelta
from typing import Any

from fastapi.testclient import TestClient

from tests.banking.conftest import idem, today_business_date

API = "/api/v1"


def _ledger(client: TestClient, store: Any, **extra: Any) -> dict:
    bd = today_business_date(store)
    params = {"store_id": store.id, "from": (bd - timedelta(days=5)).isoformat(), "to": bd.isoformat(), **extra}
    resp = client.get(f"{API}/admin/bank/ledger", params=params)
    assert resp.status_code == 200, resp.text
    return resp.json()


def _position(client: TestClient, store: Any) -> dict:
    resp = client.get(f"{API}/admin/bank/position", params={"store_id": store.id})
    assert resp.status_code == 200, resp.text
    return resp.json()


def _post(client: TestClient, path: str, store: Any, body: dict) -> Any:
    return client.post(f"{API}{path}", params={"store_id": store.id}, json=body, headers=idem())


def test_without_anchor_there_is_no_balance_and_the_default_account_is_virtual(
    admin_client: TestClient, store: Any
) -> None:
    accounts = admin_client.get(f"{API}/admin/bank/accounts", params={"store_id": store.id}).json()
    assert accounts == [
        {
            "id": None,
            "name": "Cuenta principal",
            "is_default": True,
            "gmf_exempt": False,
            "receives_transfers": False,
            "active": True,
        }
    ]
    pos = _position(admin_client, store)
    assert pos["total"] is None  # null no es 0
    assert pos["total_reason"]
    assert pos["accounts"][0]["balance"] is None
    assert pos["accounts"][0]["reason"]


def test_the_ledger_runs_from_the_anchor_with_outflows_and_gmf(
    admin_client: TestClient, set_feature: Callable[..., None], store: Any
) -> None:
    set_feature("money.obligations", True, store_id=store.id)
    bd = today_business_date(store)
    yesterday = bd - timedelta(days=1)

    anchor = _post(admin_client, "/admin/bank/anchors", store, {"balance": 1_000_000, "balance_date": yesterday.isoformat()})
    assert anchor.status_code == 201, anchor.text

    dep = _post(admin_client, "/admin/deposits", store, {"amount": 200_000, "receipt_photo": "c.jpg", "business_date": bd.isoformat()})
    assert dep.status_code == 201, dep.text

    exp = _post(
        admin_client,
        "/admin/expenses",
        store,
        {"category": "utilities", "description": "Internet", "amount": 100_000, "business_date": bd.isoformat(), "source": "bank"},
    )
    assert exp.status_code == 201, exp.text
    # Un gasto pagado del cajón (o de otro lado) no es del banco.
    other = _post(
        admin_client,
        "/admin/expenses",
        store,
        {"category": "other", "description": "Hielo", "amount": 5_000, "business_date": bd.isoformat(), "source": "other"},
    )
    assert other.status_code == 201, other.text

    obl = _post(
        admin_client,
        "/admin/obligations",
        store,
        {"category": "rent", "description": "Arriendo", "amount": 300_000, "due_date": bd.isoformat()},
    )
    assert obl.status_code == 201, obl.text
    settled = admin_client.post(
        f"{API}/admin/obligations/{obl.json()['id']}/settle", json={"source": "bank"}, headers=idem()
    )
    assert settled.status_code == 200, settled.text

    payroll = _post(
        admin_client,
        "/admin/bank/movements",
        store,
        {"direction": "out", "cause": "payroll", "amount": 250_000, "description": "Nómina quincena"},
    )
    assert payroll.status_code == 201, payroll.text

    body = _ledger(admin_client, store)
    kinds = sorted(e["kind"] for e in body["entries"])
    assert kinds == ["deposit", "expense", "movement", "obligation"]
    by_kind = {e["kind"]: e for e in body["entries"]}
    assert by_kind["expense"]["gmf"] == 400  # 100.000 × 4 / 1.000
    assert by_kind["expense"]["net_effect"] == -100_400
    assert by_kind["deposit"]["gmf"] == 0
    assert by_kind["deposit"]["net_effect"] == 200_000
    t = body["totals"]
    assert t["inflows"] == 200_000
    assert t["outflows"] == 100_000 + 300_000 + 250_000
    assert t["gmf"] == 400 + 1_200 + 1_000
    assert t["net"] == t["inflows"] - t["outflows"] - t["gmf"]

    expected = 1_000_000 + 200_000 - 650_000 - 2_600
    assert body["entries"][-1]["balance_after"] == expected
    pos = _position(admin_client, store)
    assert pos["total"] == expected
    account = pos["accounts"][0]
    assert account["anchor_balance"] == 1_000_000
    assert account["anchor_age_days"] == 1
    assert account["balance"] == expected


def test_anchor_is_end_of_day_and_same_day_entries_do_not_count_again(
    admin_client: TestClient, store: Any
) -> None:
    bd = today_business_date(store)
    _post(admin_client, "/admin/deposits", store, {"amount": 50_000, "receipt_photo": "c.jpg", "business_date": bd.isoformat()})
    anchor = _post(admin_client, "/admin/bank/anchors", store, {"balance": 500_000})
    assert anchor.status_code == 201, anchor.text
    assert _position(admin_client, store)["total"] == 500_000
    entry = _ledger(admin_client, store)["entries"][0]
    assert entry["balance_after"] is None


def test_gmf_exempt_account_and_multiple_accounts(admin_client: TestClient, store: Any) -> None:
    main = _post(admin_client, "/admin/bank/accounts", store, {"name": "Bancolombia", "gmf_exempt": True})
    assert main.status_code == 201, main.text
    assert main.json()["is_default"] is True  # la primera reemplaza a la virtual
    nequi = _post(admin_client, "/admin/bank/accounts", store, {"name": "Nequi", "receives_transfers": True})
    assert nequi.status_code == 201, nequi.text
    assert nequi.json()["is_default"] is False
    dup = _post(admin_client, "/admin/bank/accounts", store, {"name": "nequi"})
    assert dup.status_code == 400
    assert dup.json()["error"]["code"] == "BANK_ACCOUNT_NAME_TAKEN"

    bd = today_business_date(store)
    for account in (main.json(), nequi.json()):
        r = _post(
            admin_client,
            "/admin/bank/anchors",
            store,
            {"account_id": account["id"], "balance": 100_000, "balance_date": (bd - timedelta(days=1)).isoformat()},
        )
        assert r.status_code == 201, r.text

    fee = _post(
        admin_client,
        "/admin/bank/movements",
        store,
        {"direction": "out", "cause": "other", "amount": 10_000, "description": "Pago"},
    )
    assert fee.status_code == 201, fee.text
    move = _post(
        admin_client,
        "/admin/bank/movements",
        store,
        {
            "account_id": nequi.json()["id"],
            "counter_account_id": main.json()["id"],
            "direction": "out",
            "cause": "account_transfer",
            "amount": 20_000,
            "description": "Paso a Bancolombia",
        },
    )
    assert move.status_code == 201, move.text

    pos = _position(admin_client, store)
    balances = {a["account"]["name"]: a["balance"] for a in pos["accounts"]}
    # Bancolombia exenta: sale 10.000 sin GMF, entra el traslado de 20.000.
    assert balances["Bancolombia"] == 100_000 - 10_000 + 20_000
    # Nequi no exenta: el traslado paga su 4×1000 (80).
    assert balances["Nequi"] == 100_000 - 20_000 - 80
    assert pos["total"] == balances["Bancolombia"] + balances["Nequi"]

    only_nequi = _ledger(admin_client, store, account_id=nequi.json()["id"])
    assert [e["direction"] for e in only_nequi["entries"]] == ["out"]


def test_a_derived_entry_can_be_moved_to_another_account(admin_client: TestClient, store: Any) -> None:
    bd = today_business_date(store)
    _post(admin_client, "/admin/bank/accounts", store, {"name": "Bancolombia"})
    nequi = _post(admin_client, "/admin/bank/accounts", store, {"name": "Nequi"}).json()
    dep = _post(admin_client, "/admin/deposits", store, {"amount": 30_000, "receipt_photo": "c.jpg", "business_date": bd.isoformat()})
    resp = _post(
        admin_client,
        "/admin/bank/assignments",
        store,
        {"source_kind": "deposit", "source_id": dep.json()["id"], "account_id": nequi["id"]},
    )
    assert resp.status_code == 200, resp.text
    entry = _ledger(admin_client, store)["entries"][0]
    assert entry["account_name"] == "Nequi"
    assert entry["assignable"] is True

    missing = _post(
        admin_client, "/admin/bank/assignments", store, {"source_kind": "expense", "source_id": 999_999, "account_id": nequi["id"]}
    )
    assert missing.status_code == 404


def test_writes_are_validated_and_voids_never_delete(admin_client: TestClient, store: Any) -> None:
    bd = today_business_date(store)
    future = _post(admin_client, "/admin/bank/anchors", store, {"balance": 1, "balance_date": (bd + timedelta(days=1)).isoformat()})
    assert future.status_code == 400
    assert future.json()["error"]["code"] == "BANK_ANCHOR_FUTURE_DATE"

    wrong = _post(admin_client, "/admin/bank/movements", store, {"direction": "in", "cause": "payroll", "amount": 1, "description": "x"})
    assert wrong.status_code == 400
    assert wrong.json()["error"]["code"] == "BANK_MOVEMENT_CAUSE_DIRECTION"

    mv = _post(admin_client, "/admin/bank/movements", store, {"direction": "in", "cause": "owner_contribution", "amount": 5_000, "description": "Aporte"})
    assert mv.status_code == 201, mv.text
    voided = admin_client.post(
        f"{API}/admin/bank/movements/{mv.json()['id']}/void", params={"store_id": store.id}, json={"reason": "duplicado"}, headers=idem()
    )
    assert voided.status_code == 200, voided.text
    assert voided.json()["voided_reason"] == "duplicado"
    assert _ledger(admin_client, store)["entries"] == []

    anchor = _post(admin_client, "/admin/bank/anchors", store, {"balance": 10})
    void = admin_client.post(
        f"{API}/admin/bank/anchors/{anchor.json()['id']}/void", params={"store_id": store.id}, json={"reason": "mal"}, headers=idem()
    )
    assert void.status_code == 200, void.text
    anchors = admin_client.get(f"{API}/admin/bank/anchors", params={"store_id": store.id}).json()
    assert len(anchors) == 1 and anchors[0]["voided_at"] is not None
    assert _position(admin_client, store)["total"] is None


def test_projection_from_scheduled_obligations(
    admin_client: TestClient, set_feature: Callable[..., None], store: Any
) -> None:
    set_feature("money.obligations", True, store_id=store.id)
    bd = today_business_date(store)
    _post(admin_client, "/admin/bank/anchors", store, {"balance": 1_000_000})
    _post(
        admin_client,
        "/admin/obligations",
        store,
        {"category": "rent", "description": "Arriendo vencido", "amount": 100_000, "due_date": (bd - timedelta(days=3)).isoformat()},
    )
    resp = admin_client.get(f"{API}/admin/bank/projection", params={"store_id": store.id, "months": 2})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["starting_balance"] == 1_000_000
    assert body["overdue_obligations"] == 100_000
    # Sin meses completos con entradas: no se inventa lo que entra.
    assert body["history_months"] == 0
    assert body["avg_monthly_inflows"] is None
    assert body["reason"]
    assert 2 <= len(body["months"]) <= 3
    assert body["months"][0]["scheduled_obligations"] == 100_000
    assert all(m["closing_balance"] is None for m in body["months"])

    too_many = admin_client.get(f"{API}/admin/bank/projection", params={"store_id": store.id, "months": 4})
    assert too_many.status_code in (400, 422)


def test_new_bank_routes_require_money_bank(admin_client: TestClient, set_feature: Callable[..., None], store: Any) -> None:
    set_feature("money.bank", False, store_id=store.id)
    for resp in (
        admin_client.get(f"{API}/admin/bank/position", params={"store_id": store.id}),
        admin_client.get(f"{API}/admin/bank/projection", params={"store_id": store.id}),
        admin_client.get(f"{API}/admin/bank/accounts", params={"store_id": store.id}),
        _post(admin_client, "/admin/bank/anchors", store, {"balance": 1}),
    ):
        assert resp.status_code == 400, resp.text
        assert resp.json()["error"]["code"] == "FEATURE_DISABLED"
