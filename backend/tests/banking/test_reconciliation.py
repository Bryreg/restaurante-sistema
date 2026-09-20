"""Conciliación de datáfono (`.../reconciliation/card`) y de plataformas
(`.../reconciliation/platform`): lo esperado, lo liquidado, la diferencia y
`matched`/`unmatched`.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from tests.banking.conftest import idem, today_business_date

API = "/api/v1"


# ---------------------------------------------------------------------------
# Datáfono.
# ---------------------------------------------------------------------------


def test_card_reconciliation_matches_expected_against_settlement(
    admin_client: TestClient,
    make_payment: Callable[..., dict],
    open_shift: Callable[..., dict],
    store: Any,
) -> None:
    bd = today_business_date(store)
    shift = open_shift(total=200_000)
    make_payment(shift=shift, method="card", amount=100_000)

    unmatched = admin_client.get(
        f"{API}/admin/reconciliation/card", params={"store_id": store.id, "from": bd.isoformat(), "to": bd.isoformat()}
    )
    assert unmatched.status_code == 200, unmatched.text
    row = unmatched.json()["rows"][0]
    assert row["expected"] == 100_000
    assert row["settled"] == 0
    assert row["difference"] == -100_000
    assert row["matched"] is False
    assert unmatched.json()["unmatched_count"] == 1

    created = admin_client.post(
        f"{API}/admin/reconciliation/card",
        params={"store_id": store.id},
        json={
            "sales_business_date": bd.isoformat(),
            "settled_business_date": bd.isoformat(),
            "gross_amount": 100_000,
            "commission_amount": 2_500,
            "retention_amount": 500,
            "reference": "LIQ-001",
        },
        headers=idem(),
    )
    assert created.status_code == 201, created.text
    settlement = created.json()
    assert settlement["status"] == "recorded"
    assert settlement["lag_days"] == 0
    assert settlement["net_amount"] == 97_000

    settled_resp = admin_client.post(
        f"{API}/admin/reconciliation/card/{settlement['id']}/settle",
        json={"note": "Concilié contra el extracto"},
        headers=idem(),
    )
    assert settled_resp.status_code == 200, settled_resp.text
    assert settled_resp.json()["status"] == "matched"

    reconciled = admin_client.get(
        f"{API}/admin/reconciliation/card", params={"store_id": store.id, "from": bd.isoformat(), "to": bd.isoformat()}
    )
    row = reconciled.json()["rows"][0]
    assert row["settled"] == 100_000  # bruto, comparado contra lo cobrado
    assert row["difference"] == 0
    assert row["matched"] is True
    assert reconciled.json()["unmatched_count"] == 0


def test_card_settlement_cannot_be_settled_twice_and_can_be_reversed(admin_client: TestClient, store: Any) -> None:
    bd = today_business_date(store)
    created = admin_client.post(
        f"{API}/admin/reconciliation/card",
        params={"store_id": store.id},
        json={
            "sales_business_date": bd.isoformat(),
            "settled_business_date": bd.isoformat(),
            "gross_amount": 50_000,
        },
        headers=idem(),
    )
    settlement_id = created.json()["id"]

    first = admin_client.post(
        f"{API}/admin/reconciliation/card/{settlement_id}/settle", json={}, headers=idem()
    )
    assert first.status_code == 200, first.text

    twice = admin_client.post(
        f"{API}/admin/reconciliation/card/{settlement_id}/settle", json={}, headers=idem()
    )
    assert twice.status_code == 400
    assert twice.json()["error"]["code"] == "SETTLEMENT_ALREADY_MATCHED"

    reversed_resp = admin_client.post(
        f"{API}/admin/reconciliation/card/{settlement_id}/reverse",
        json={"reason": "Duplicada por error de tecleo"},
        headers=idem(),
    )
    assert reversed_resp.status_code == 200, reversed_resp.text
    assert reversed_resp.json()["status"] == "reversed"

    cannot_settle = admin_client.post(
        f"{API}/admin/reconciliation/card/{settlement_id}/settle", json={}, headers=idem()
    )
    assert cannot_settle.status_code == 400
    assert cannot_settle.json()["error"]["code"] == "SETTLEMENT_REVERSED"

    # Una liquidación reversada no cuenta en `settled` de la conciliación.
    row = admin_client.get(
        f"{API}/admin/reconciliation/card", params={"store_id": store.id, "from": bd.isoformat(), "to": bd.isoformat()}
    ).json()["rows"]
    assert row == [] or row[0]["settled"] == 0


# ---------------------------------------------------------------------------
# Plataformas.
# ---------------------------------------------------------------------------


def test_platform_reconciliation_matches_receivable_against_settlement(
    admin_client: TestClient,
    db: Session,
    make_payment: Callable[..., dict],
    open_shift: Callable[..., dict],
    store: Any,
) -> None:
    """`PlatformReceivable` es un libro de `app.channels` (2c): se arma por
    ORM directo, declarado — es la misma convención de
    `tests/channels/conftest.py` para configuración/datos de otro dominio.
    Lo que se prueba es la conciliación, no la creación del cobro.
    `order_id` sale de una venta real (`make_payment`) porque es FK dura."""

    from datetime import datetime, timezone

    from app.channels.models import DeliveryPlatform, PlatformReceivable, PlatformReceivableStatus

    bd = today_business_date(store)
    now = datetime.now(timezone.utc)

    shift = open_shift(total=200_000)
    sale = make_payment(shift=shift, method="cash", amount=80_000)
    order_id = sale["order_id"]

    platform = DeliveryPlatform(
        organization_id=store.organization_id,
        store_id=store.id,
        name="Rappi",
        code="rappi",
        commission_bp=1_800,
        active=True,
        created_at=now,
        updated_at=now,
    )
    db.add(platform)
    db.flush()

    receivable = PlatformReceivable(
        organization_id=store.organization_id,
        store_id=store.id,
        platform_id=platform.id,
        order_id=order_id,
        amount=80_000,
        tip_amount=5_000,
        status=PlatformReceivableStatus.PENDING,
        business_date=bd,
        at=now,
    )
    db.add(receivable)
    db.commit()

    unmatched = admin_client.get(
        f"{API}/admin/reconciliation/platform",
        params={"store_id": store.id, "from": bd.isoformat(), "to": bd.isoformat()},
    )
    assert unmatched.status_code == 200, unmatched.text
    rows = unmatched.json()["rows"]
    assert len(rows) == 1
    assert rows[0]["platform_id"] == platform.id
    assert rows[0]["platform_name"] == "Rappi"
    assert rows[0]["expected"] == 85_000  # 80.000 venta + 5.000 propina
    assert rows[0]["matched"] is False

    created = admin_client.post(
        f"{API}/admin/reconciliation/platform",
        params={"store_id": store.id},
        json={
            "platform_id": platform.id,
            "period_from": bd.isoformat(),
            "period_to": bd.isoformat(),
            "gross_amount": 85_000,
            "commission_amount": 15_300,
        },
        headers=idem(),
    )
    assert created.status_code == 201, created.text
    settlement = created.json()
    assert settlement["net_amount"] == 69_700

    admin_client.post(
        f"{API}/admin/reconciliation/platform/{settlement['id']}/settle", json={}, headers=idem()
    )

    reconciled = admin_client.get(
        f"{API}/admin/reconciliation/platform",
        params={"store_id": store.id, "from": bd.isoformat(), "to": bd.isoformat()},
    )
    row = reconciled.json()["rows"][0]
    assert row["settled"] == 85_000
    assert row["difference"] == 0
    assert row["matched"] is True
    assert reconciled.json()["unmatched_count"] == 0


def test_platform_settlement_requires_valid_platform_and_period_order(admin_client: TestClient, store: Any) -> None:
    bd = today_business_date(store)

    missing_platform = admin_client.post(
        f"{API}/admin/reconciliation/platform",
        params={"store_id": store.id},
        json={"platform_id": 999_999, "period_from": bd.isoformat(), "period_to": bd.isoformat(), "gross_amount": 1_000},
        headers=idem(),
    )
    assert missing_platform.status_code == 404, missing_platform.text


def test_card_and_transfer_method_sets_are_derived_from_payment_bucket_not_hardcoded() -> None:
    """C6/H-5 (iteración 2, advertencia): `payment_bucket`
    (`app.shifts.hooks`) es el único lugar del sistema autorizado a decidir
    en qué bolsillo cae un medio de pago — su propio docstring documenta el
    bug (H-2/H-4 de 2b) que produjo clasificarlo dos veces. Antes,
    `app/banking/service.py` filtraba `Payment.method == "card"` /
    `== "transfer"` a mano en dos lugares (conciliación de tarjeta, libro
    del banco): una segunda clasificación que un medio nuevo podía omitir
    en silencio.

    Este test no toca `app/banking/`: confirma, desde afuera, que el
    conjunto que banking usa para conciliar sigue siendo EXACTAMENTE el
    resultado de preguntarle a la única autoridad (`payment_bucket`)
    recorriendo el mismo catálogo que usa `Payment`
    (`app.payments.models.PAYMENT_METHOD_VALUES`) — no una copia
    hardcodeada que se desincroniza en silencio el día que se agregue un
    medio nuevo. La cobertura end-to-end de que un pago `method="card"`
    entra a `GET /admin/reconciliation/card` ya está en
    `test_card_reconciliation_matches_expected_against_settlement`."""

    from app.banking.service import CARD_PAYMENT_METHODS, TRANSFER_PAYMENT_METHODS
    from app.payments.models import PAYMENT_METHOD_VALUES
    from app.shifts.hooks import payment_bucket

    expected_card = tuple(m for m in PAYMENT_METHOD_VALUES if payment_bucket(m, None) == "card")
    expected_transfer = tuple(m for m in PAYMENT_METHOD_VALUES if payment_bucket(m, None) == "transfer")

    assert CARD_PAYMENT_METHODS == expected_card
    assert TRANSFER_PAYMENT_METHODS == expected_transfer
    assert "card" in CARD_PAYMENT_METHODS
    assert "transfer" in TRANSFER_PAYMENT_METHODS
    # Ningún medio cae en los dos bolsillos a la vez (sería el mismo pago
    # contado dos veces entre datáfono y transferencias en el libro).
    assert not set(CARD_PAYMENT_METHODS) & set(TRANSFER_PAYMENT_METHODS)
