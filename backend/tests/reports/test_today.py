"""`GET /admin/today` (`docs/SPEC-NEGOCIO.md §9.3` "Hoy"): ventas por hora,
comandas abiertas con antigüedad (`order_unsent_too_long`/`order_unpaid_too_
long`), efectivo esperado y alertas — «sin datos» se dice, no se dibuja como
cero."""

from __future__ import annotations

from datetime import date, datetime, timezone
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


# ---------------------------------------------------------------------------
# Pedido 2b (`backend-lectura-contrato`): los tres grupos nuevos de alertas
# de «Hoy» — lotes por vencer/vencidos, cuentas por pagar vencidas y
# pendientes de revisión, y "inventario no confiable". Cada uno respeta
# `find_spec_safe` **y** `features.is_enabled` (`_hooks_if_enabled`): con la
# flag apagada, lista vacía / `None` — nunca una alarma que la sede no puede
# resolver.
# ---------------------------------------------------------------------------


def test_ingredient_alert_quantities_are_published_as_decimal_strings(
    admin_client: TestClient, store: Any, ingredient_seeded: Any
) -> None:
    """Deuda cerrada (`outputs-2a/ENTREGA.md § 5`, A-5): `qty_base`/
    `min_stock` en `app.reports.schemas` salían como `int` en milésimas
    crudas; acá tienen que ser texto decimal, igual que
    `app.inventory.schemas`. `ingredient_seeded` nace sin movimientos
    (`current_stock == 0`) y con `min_stock == 5000` milésimas (5 g): dispara
    `ingredients_below_min` sin necesidad de vender nada."""
    resp = admin_client.get("/api/v1/admin/today", params={"store_id": store.id})
    assert resp.status_code == 200, resp.text
    row = next(r for r in resp.json()["ingredients_below_min"] if r["ingredient_id"] == ingredient_seeded.id)
    assert row["qty_base"] == "0"
    assert row["min_stock"] == "5"
    assert isinstance(row["qty_base"], str)
    assert isinstance(row["min_stock"], str)


def test_negative_stock_alert_quantities_are_published_as_decimal_strings(
    db: Any, admin_client: TestClient, store: Any, ingredient_seeded: Any, admin_actor: Any
) -> None:
    from app.core import clock
    from app.inventory import hooks as inventory_hooks
    from app.inventory.models import CostSource, MovementCause

    inventory_hooks.record_movement(
        db,
        organization_id=store.organization_id,
        store_id=store.id,
        ingredient_id=ingredient_seeded.id,
        qty_base=-2000,
        cause=MovementCause.MANUAL_ADJUSTMENT,
        cost_micros=None,
        cost_source=CostSource.NONE,
        actor=admin_actor,
        business_date=clock.now_utc().date(),
        at=clock.now_utc(),
    )
    db.commit()

    resp = admin_client.get("/api/v1/admin/today", params={"store_id": store.id})
    assert resp.status_code == 200, resp.text
    row = next(r for r in resp.json()["ingredients_negative"] if r["ingredient_id"] == ingredient_seeded.id)
    assert row["qty_base"] == "-2"
    assert row["min_stock"] == "5"


def test_lots_alert_respects_flag_and_reports_expiring_and_expired(
    db: Any, admin_client: TestClient, store: Any, ingredient_seeded: Any, set_feature: Any
) -> None:
    from datetime import timedelta

    from app.core import clock
    from app.inventory import hooks as inventory_hooks
    from app.inventory.models import CostSource

    today = clock.now_utc().date()

    def _make_lot(expires_at: Any) -> Any:
        return inventory_hooks.create_stock_batch(
            db,
            organization_id=store.organization_id,
            store_id=store.id,
            ingredient_id=ingredient_seeded.id,
            qty_base=1000,
            unit_cost_micros=1_000_000,
            cost_source=CostSource.OFFICIAL,
            expires_at=expires_at,
            received_at=clock.now_utc(),
            business_date=today,
            source_type="test",
            source_id=1,
        )

    expiring = _make_lot(today + timedelta(days=3))
    expired = _make_lot(today - timedelta(days=1))
    db.commit()

    set_feature("inventory.lots", False, store_id=store.id)
    resp_off = admin_client.get("/api/v1/admin/today", params={"store_id": store.id})
    assert resp_off.status_code == 200, resp_off.text
    assert resp_off.json()["lots_expiring_or_expired"] == [], (
        "con `inventory.lots` apagada la sede no puede resolver esta alerta"
    )

    set_feature("inventory.lots", True, store_id=store.id)
    resp_on = admin_client.get("/api/v1/admin/today", params={"store_id": store.id})
    assert resp_on.status_code == 200, resp_on.text
    by_id = {row["batch_id"]: row for row in resp_on.json()["lots_expiring_or_expired"]}
    assert by_id[expiring.id]["status"] == "expiring"
    assert by_id[expired.id]["status"] == "expired"
    assert by_id[expiring.id]["qty_base"] == "1"  # texto decimal, no milésimas crudas


def test_payables_alerts_respect_flag_and_show_overdue_and_pending_review(
    db: Any, admin_client: TestClient, store: Any, ingredient_seeded: Any, admin_actor: Any, set_feature: Any
) -> None:
    from datetime import date, timedelta

    from app.purchases import service as purchases_service
    from app.purchases.schemas import ReceptionIn, ReceptionLineIn, SupplierIn

    supplier = purchases_service.create_supplier(
        db, store=store, data=SupplierIn(name="Proveedor Hoy", payment_term_days=0, invoices_required=False)
    )
    db.commit()

    reception = purchases_service.create_reception(
        db,
        actor=admin_actor,
        store=store,
        payload=ReceptionIn(
            supplier_id=supplier.id,
            invoice_date=date.today() - timedelta(days=10),  # payment_term_days=0 -> due_date vencido
            no_invoice=True,
            received_by_pin="9999",
            lines=[
                ReceptionLineIn(
                    ingredient_id=ingredient_seeded.id,
                    qty_received="10",
                    qty_invoiced="10",
                    purchase_unit_price="14500",
                    tax_base=0,
                    tax_rate=0,
                    tax_amount=0,
                )
            ],
        ),
    )
    db.commit()

    set_feature("purchases", False, store_id=store.id)
    resp_off = admin_client.get("/api/v1/admin/today", params={"store_id": store.id})
    assert resp_off.status_code == 200, resp_off.text
    body_off = resp_off.json()
    assert body_off["payables_overdue"] == []
    assert body_off["payables_pending_review_count"] == 0

    set_feature("purchases", True, store_id=store.id)
    resp_on = admin_client.get("/api/v1/admin/today", params={"store_id": store.id})
    assert resp_on.status_code == 200, resp_on.text
    body_on = resp_on.json()
    assert body_on["payables_pending_review_count"] == 1  # nace en `pending_review`
    overdue_ids = {row["payable_id"] for row in body_on["payables_overdue"]}
    assert reception.id  # smoke: la recepción se confirmó
    from sqlalchemy import select

    from app.purchases.models import Payable

    payable = db.execute(select(Payable).where(Payable.reception_id == reception.id)).scalars().one()
    assert payable.id in overdue_ids


def test_inventory_unreliable_reflects_flag_and_last_full_count(
    db: Any, admin_client: TestClient, store: Any, admin_actor: Any, set_feature: Any
) -> None:
    from datetime import timedelta

    from app.core import clock
    from app.inventory.models import StockCount, StockCountScope, StockCountStatus

    set_feature("inventory.variance", False, store_id=store.id)
    resp_off = admin_client.get("/api/v1/admin/today", params={"store_id": store.id})
    assert resp_off.status_code == 200, resp_off.text
    body_off = resp_off.json()
    assert body_off["inventory_unreliable"] is None, "con la flag apagada no hay nada que afirmar, ni `true` ni `false`"
    assert body_off["days_since_last_full_count"] is None

    set_feature("inventory.variance", True, store_id=store.id)
    resp_never = admin_client.get("/api/v1/admin/today", params={"store_id": store.id})
    assert resp_never.status_code == 200, resp_never.text
    body_never = resp_never.json()
    assert body_never["inventory_unreliable"] is True, "sin ningún conteo completo aplicado, no hay línea de base"
    assert body_never["days_since_last_full_count"] is None  # nunca un número inventado

    now = clock.now_utc()
    count = StockCount(
        organization_id=store.organization_id,
        store_id=store.id,
        scope=StockCountScope.FULL,
        status=StockCountStatus.APPLIED,
        opened_at=now - timedelta(days=20),
        business_date=(now - timedelta(days=20)).date(),
        opened_by_employee_id=admin_actor.employee_id,
        opened_by_employee_name=admin_actor.employee_name,
        applied_at=now - timedelta(days=20),
        applied_by_employee_id=admin_actor.employee_id,
        applied_by_employee_name=admin_actor.employee_name,
    )
    db.add(count)
    db.commit()

    resp_stale = admin_client.get("/api/v1/admin/today", params={"store_id": store.id})
    body_stale = resp_stale.json()
    assert body_stale["inventory_unreliable"] is True
    assert body_stale["days_since_last_full_count"] == 20

    count.applied_at = now - timedelta(days=3)
    db.add(count)
    db.commit()

    resp_fresh = admin_client.get("/api/v1/admin/today", params={"store_id": store.id})
    body_fresh = resp_fresh.json()
    assert body_fresh["inventory_unreliable"] is False
    assert body_fresh["days_since_last_full_count"] == 3


def test_today_and_control_health_agree_exactly_at_the_14_day_boundary(
    db: Any, admin_client: TestClient, store: Any, admin_actor: Any, set_feature: Any, clock: Any,
) -> None:
    """RONDA 2 (hallazgo H-4, el test nombrado que la cierra). En ronda 1
    `GET /admin/today` (`app.reports.service._inventory_reliability`) y
    `GET /admin/control-health` (`app.inventory.service.control_health`)
    calculaban los días desde el último conteo completo con DOS matemáticas
    distintas: acá restando instantes UTC crudos (`(now - last_applied)
    .days`), allá con fecha de negocio. Después del hallazgo, las dos leen
    la MISMA fuente, una sola vez (`app.inventory.hooks.
    inventory_staleness`), y esta función ya no calcula nada por su cuenta.

    Este test prueba el borde exacto donde las dos matemáticas viejas
    discrepaban: con el `cutoff_hour` real de la sede (6, hora de Bogotá,
    `America/Bogota` = UTC-5 todo el año) y el reloj fijo en un instante
    que en Bogotá cae DESPUÉS del corte de un día operativo, pero que en
    UTC YA es el día calendario siguiente.

    Se arma así: el último conteo completo se aplicó el 1° de marzo de
    2026 a las 23:00 hora de Bogotá (día operativo 1° de marzo — 23 >= 6,
    no cruza medianoche hacia atrás). El reloj se fija el 16 de marzo a
    las 20:00 hora de Bogotá (día operativo 16 de marzo, mismo criterio):
    **15 días de negocio después, exacto**. Ese mismo instante, en UTC
    (Bogotá + 5 horas), cae el 17 de marzo a la 01:00 — un día calendario
    UTC completo por delante del día operativo de Bogotá. Restar esos dos
    instantes UTC crudos (`(now - last_applied).days`, la matemática que
    Ronda 2 borró de `_inventory_reliability`) da **14** días completos,
    no 15 — justo POR DEBAJO del umbral de 14 días (`unreliable=False`,
    resultado viejo y equivocado), mientras la fecha de negocio correcta
    YA cruzó el umbral (`unreliable=True`). Verificado a mano antes de
    escribir esta prueba: `tz.business_date_for` da una diferencia de 15
    días de negocio; `(now - last_applied).days` sobre los mismos dos
    instantes da 14 — la discrepancia exacta que este test existe para que
    no pueda volver.

    Si algún día una de las dos rutas vuelve a calcular por su cuenta en
    vez de leer `inventory_staleness`, este test detecta la discrepancia
    ANTES que un dueño de restaurante vea "Hoy" decir "confiable" y "Salud
    del control" decir lo contrario en la misma pantalla."""
    set_feature("inventory.variance", True, store_id=store.id)

    from app.inventory.models import StockCount, StockCountScope, StockCountStatus

    last_applied_utc = datetime(2026, 3, 2, 4, 0, tzinfo=timezone.utc)  # Bogotá: 1° mar 2026, 23:00
    count = StockCount(
        organization_id=store.organization_id,
        store_id=store.id,
        scope=StockCountScope.FULL,
        status=StockCountStatus.APPLIED,
        opened_at=last_applied_utc,
        business_date=date(2026, 3, 1),
        opened_by_employee_id=admin_actor.employee_id,
        opened_by_employee_name=admin_actor.employee_name,
        applied_at=last_applied_utc,
        applied_by_employee_id=admin_actor.employee_id,
        applied_by_employee_name=admin_actor.employee_name,
    )
    db.add(count)
    db.commit()

    # Bogotá: 16 mar 2026, 20:00 -> UTC: 17 mar 2026, 01:00 (ya es "el día
    # calendario siguiente" en UTC, aunque el día operativo de Bogotá sigue
    # siendo el 16).
    clock.set(datetime(2026, 3, 17, 1, 0, tzinfo=timezone.utc))

    resp_today = admin_client.get("/api/v1/admin/today", params={"store_id": store.id})
    assert resp_today.status_code == 200, resp_today.text
    body_today = resp_today.json()

    resp_health = admin_client.get("/api/v1/admin/control-health", params={"store_id": store.id})
    assert resp_health.status_code == 200, resp_health.text
    body_health = resp_health.json()

    assert body_today["days_since_last_full_count"] == 15, (
        f"fecha de negocio: 15 días exactos — dio {body_today['days_since_last_full_count']} "
        "(¿volvió a restar instantes UTC crudos?)"
    )
    assert body_today["inventory_unreliable"] is True, body_today
    assert body_health["days_since_full_count"] == 15, (
        f"fecha de negocio: 15 días exactos — dio {body_health['days_since_full_count']} "
        "(¿volvió a restar instantes UTC crudos?)"
    )
    assert body_health["inventory_unreliable"] is True, body_health

    # La aserción central del hallazgo: las dos rutas, sobre el mismo caso,
    # dicen EXACTAMENTE lo mismo — nunca dos matemáticas.
    assert body_today["days_since_last_full_count"] == body_health["days_since_full_count"]
    assert body_today["inventory_unreliable"] == body_health["inventory_unreliable"]
