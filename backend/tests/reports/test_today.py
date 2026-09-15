"""`GET /admin/today` (`docs/SPEC-NEGOCIO.md §9.3` "Hoy"): ventas por hora,
comandas abiertas con antigüedad (`order_unsent_too_long`/`order_unpaid_too_
long`), efectivo esperado y alertas — «sin datos» se dice, no se dibuja como
cero."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from fastapi.testclient import TestClient

from app.notifications.models import Notification
from tests.reports.conftest import idem_headers


def _notifications_of_type(db: Session, organization_id: int, ntype: str) -> list[Notification]:
    return list(
        db.execute(
            select(Notification).where(Notification.organization_id == organization_id, Notification.type == ntype)
        ).scalars()
    )


def test_no_open_shift_reports_null_expected_cash_not_zero(admin_client: TestClient, store: Any) -> None:
    resp = admin_client.get("/api/v1/admin/today", params={"store_id": store.id})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["expected_cash"] is None  # "nadie contó" != "$0"
    assert body["orders"] == 0
    assert body["gross"] == 0
    assert body["covers"] is None


def test_sale_shows_up_in_gross_net_and_hourly_bucket(
    admin_client: TestClient, device_client: TestClient, identify: Any, employees: Any, open_shift: Any,
    sell: Any, main_product: Any, store: Any,
) -> None:
    open_shift()
    identify(device_client, employees["cashier"])
    sell(main_product, qty=1)

    resp = admin_client.get("/api/v1/admin/today", params={"store_id": store.id})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["gross"] == 25_000
    assert body["net"] == 25_000 - 1_852
    assert body["orders"] == 1
    assert sum(h["gross"] for h in body["sales_by_hour"]) == body["gross"]
    # Turno abierto con la base fija ($200.000 default) más la venta en
    # efectivo: `expected_cash` ya no es `None`.
    assert body["expected_cash"] == 200_000 + 25_000


def _add_items(device_client: TestClient, order: dict[str, Any], items: list[dict[str, Any]]) -> dict[str, Any]:
    resp = device_client.post(
        f"/api/v1/orders/{order['id']}/items",
        json={"expected_version": order["version"], "items": items},
        headers=idem_headers(),
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def test_open_order_flags_unsent_and_unpaid_after_the_threshold(
    admin_client: TestClient, device_client: TestClient, identify: Any, employees: Any, open_shift: Any, set_feature: Any,
    main_product: Any, drink_product: Any, clock: Any, db: Any, org: Any, store: Any,
) -> None:
    set_feature("pos.pre_bill", True)
    clock.set(datetime(2026, 3, 1, 15, 0, tzinfo=timezone.utc))
    open_shift()
    identify(device_client, employees["operator"])

    # Comanda con un plato de cocina que nunca se envía.
    unsent = device_client.post("/api/v1/orders", json={"channel": "counter"}, headers=idem_headers()).json()
    unsent = _add_items(device_client, unsent, [{"product_id": main_product.id, "qty": 1}])

    # Comanda con la cuenta presentada y nunca cobrada. Se envía primero (un
    # producto sin estación pasa directo a `served`) para que no cuente
    # TAMBIÉN como "sin enviar" y contamine `unsent_count`.
    unpaid = device_client.post("/api/v1/orders", json={"channel": "counter"}, headers=idem_headers()).json()
    unpaid = _add_items(device_client, unpaid, [{"product_id": drink_product.id, "qty": 1}])
    sent = device_client.post(f"/api/v1/orders/{unpaid['id']}/send", json={"expected_version": unpaid["version"]}, headers=idem_headers())
    assert sent.status_code == 200, sent.text
    unpaid = sent.json()
    presented = device_client.post(
        f"/api/v1/orders/{unpaid['id']}/bill/present", json={"expected_version": unpaid["version"]}, headers=idem_headers()
    )
    assert presented.status_code == 200, presented.text

    clock.advance(minutes=25)

    resp = admin_client.get("/api/v1/admin/today", params={"store_id": store.id})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["unsent_count"] == 1
    assert body["unpaid_count"] == 1

    rows = {r["id"]: r for r in body["open_orders"]}
    assert rows[unsent["id"]]["unsent_flag"] is True
    assert rows[unsent["id"]]["unpaid_flag"] is False
    assert rows[unpaid["id"]]["unpaid_flag"] is True
    assert rows[unpaid["id"]]["minutes_since_bill_presented"] is not None

    assert len(_notifications_of_type(db, org.id, "order_unsent_too_long")) == 1
    assert len(_notifications_of_type(db, org.id, "order_unpaid_too_long")) == 1

    # Recargar la pantalla el mismo día no duplica (dedupe diario de `notify`).
    resp2 = admin_client.get("/api/v1/admin/today", params={"store_id": store.id})
    assert resp2.status_code == 200, resp2.text
    assert len(_notifications_of_type(db, org.id, "order_unsent_too_long")) == 1


def test_isolation_by_store(admin_client: TestClient, store_b: Any) -> None:
    resp = admin_client.get("/api/v1/admin/today", params={"store_id": store_b.id})
    # `store_b` es de OTRA organización (fixture `org_b`): 404, no 200.
    assert resp.status_code == 404, resp.text


def test_contingency_overdue_reaches_today_without_visiting_fiscal_documents(
    admin_client: TestClient, device_client: TestClient, identify: Any, employees: Any, open_shift: Any,
    sell: Any, drink_product: Any, clock: Any, db: Any, org: Any, store: Any,
) -> None:
    """Ronda 2 — B-3: `today_report` tiene que barrer la contingencia vencida
    (`app.fiscal.service.sweep_contingency_overdue`) ella misma — Hoy es la
    pantalla que el dueño abre primero, y hasta esta ronda el barrido sólo
    corría al entrar a `GET /admin/fiscal/documents`/`/export`
    (`app/fiscal/router.py`). Réplica reducida, en mi propio territorio, del
    test rojo de `tests/audit/test_reports_invariants.py::
    test_a_contingency_document_reaches_requiere_tu_atencion_without_going_looking_for_it`."""
    from app.fiscal.provider import FakeProvider, set_provider_override

    open_shift()
    identify(device_client, employees["cashier"])

    try:
        set_provider_override(FakeProvider(outcome="contingency"))
        contingente = sell(drink_product)
    finally:
        set_provider_override(None)
    assert contingente["document"]["dian_status"] == "contingency"

    # A las 47 h todavía no vence el plazo (art. 616-1 ET): no aparece.
    clock.advance(hours=47)
    hoy_47h = admin_client.get("/api/v1/admin/today", params={"store_id": store.id})
    assert hoy_47h.status_code == 200, hoy_47h.text
    tipos_47h = {a["type"] for a in hoy_47h.json()["alerts"]}
    assert "fiscal_contingency_overdue" not in tipos_47h, (
        f"a las 47 h todavía no venció el plazo de 48 h: {sorted(tipos_47h)}"
    )

    # A las 49 h (2 h más, 49 h totales) el barrido de Hoy tiene que
    # dispararla, sin que nadie haya entrado a Documentos fiscales.
    clock.advance(hours=2)
    hoy_49h = admin_client.get("/api/v1/admin/today", params={"store_id": store.id})
    assert hoy_49h.status_code == 200, hoy_49h.text
    tipos_49h = {a["type"] for a in hoy_49h.json()["alerts"]}
    assert "fiscal_contingency_overdue" in tipos_49h, (
        f"pasadas las 48 h, `GET /admin/today` tiene que traer la alerta sin que nadie "
        f"visite `GET /admin/fiscal/documents`: {sorted(tipos_49h)}"
    )

    assert len(_notifications_of_type(db, org.id, "fiscal_contingency_overdue")) == 1

    # Volver a entrar a Hoy no duplica la alerta (dedupe de
    # `sweep_contingency_overdue`, `dedupe_key=f"fiscal_contingency_overdue:
    # {document.id}"`).
    hoy_otra_vez = admin_client.get("/api/v1/admin/today", params={"store_id": store.id})
    assert hoy_otra_vez.status_code == 200, hoy_otra_vez.text
    assert len(_notifications_of_type(db, org.id, "fiscal_contingency_overdue")) == 1
    tipos_otra_vez = {a["type"] for a in hoy_otra_vez.json()["alerts"]}
    assert "fiscal_contingency_overdue" in tipos_otra_vez
