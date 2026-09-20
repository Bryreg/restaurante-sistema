"""`GET /admin/tips/distribution/proposal` y `GET`/`PATCH
/admin/tips/settings` — D-3: los tres métodos, `by_hours` de default, y la
propuesta **nunca mueve plata** (no crea `TipPayout` ni
`TipPayoutDistribution` — esas tablas ya existen desde 1b-2 y su única
puerta de escritura es `app.shifts.tips.register_tip_payout`, que este
archivo nunca llama: la confirmación es `POST /admin/tips/payouts`,
publicado por `app.shifts`, no por este dominio).

`_make_product`/`_pay_with_tip` están duplicadas a propósito de
`tests/shifts/test_tips.py` (carpetas hermanas, mismo criterio del proyecto
— `tests/expenses/conftest.py` ya lo documenta así: cada una arma su propia
base sin imports cruzados entre carpetas de test).
"""

from __future__ import annotations

import uuid
from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.shifts.models import TipPayout, TipPayoutDistribution
from app.stores.models import Store
from tests.conftest import KNOWN_PINS

API = "/api/v1"


def idem() -> dict[str, str]:
    return {"Idempotency-Key": str(uuid.uuid4())}


def _make_product(db: Session, store: Store, *, price: int = 5000) -> int:
    from app.catalog.models import Category, Product
    from app.core import clock as clock_module

    now = clock_module.now_utc()
    category = Category(
        organization_id=store.organization_id, store_id=store.id, name="Bebidas", sort_order=0,
        default_course="beverage", default_station=None, active=True,
    )
    db.add(category)
    db.flush()
    product = Product(
        organization_id=store.organization_id, store_id=store.id, category_id=category.id, name="Gaseosa",
        description=None, station=None, default_course="beverage", price_dine_in=price, price_takeout=None,
        price_delivery=None, price_platform=None, tax_code="inc_8", active=True, available=True, daily_count=None,
        daily_remaining=None, unavailable_by_employee_id=None, unavailable_by_employee_name=None,
        unavailable_at=None, created_at=now, updated_at=now,
    )
    db.add(product)
    db.commit()
    db.refresh(product)
    return product.id


def _pay_with_tip(device_client: TestClient, product_id: int, *, method: str, tip_amount: int) -> Any:
    order = device_client.post("/api/v1/orders", json={"channel": "counter"}, headers=idem()).json()
    order = device_client.post(
        f"/api/v1/orders/{order['id']}/items",
        json={"expected_version": order["version"], "items": [{"product_id": product_id, "qty": 1}]},
        headers=idem(),
    ).json()
    resp = device_client.post(
        f"/api/v1/orders/{order['id']}/payments",
        json={
            "pin": "1111",
            "tip": {"asked": True, "accepted": tip_amount > 0, "modified": False, "amount": tip_amount},
            "splits": [{"method": method, "amount": order["totals"]["total"] + tip_amount}],
        },
        headers=idem(),
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def _worked(device_client: TestClient, roster_action: Any, *, shift_id: int, employee: Any, clock: Any, hours: float) -> None:
    roster_action(device_client, shift_id=shift_id, employee_id=employee.id, action="in", pin=KNOWN_PINS[employee.name])
    clock.advance(hours=hours)
    roster_action(device_client, shift_id=shift_id, employee_id=employee.id, action="out", pin=KNOWN_PINS[employee.name])


def _denoms(total: int) -> dict[str, Any]:
    from app.core.money import DENOMINATIONS

    rest = total
    items: list[dict[str, int]] = []
    for value in sorted(DENOMINATIONS, reverse=True):
        count, rest = divmod(rest, value)
        if count:
            items.append({"value": value, "count": count})
    assert rest == 0, f"{total} no es representable con denominaciones colombianas"
    return {"denominations": items, "total": total}


def _close_shift(device_client: TestClient, *, shift_id: int) -> None:
    """Cierra el turno por la puerta real (a ciegas, los tres pasos) — sólo
    los turnos **CERRADOS** entran en `resolve_period_shift_ids`
    (`app.payroll.service`, iteración 2). El conteo no necesita ser exacto:
    la diferencia se lee del paso 2 (nunca se deriva acá) y se confirma con
    causa tipada si no da exacto — a este test sólo le importa que el turno
    quede `CLOSED`."""
    count_resp = device_client.post(
        f"{API}/shifts/{shift_id}/close/count",
        json={"counted_cash": _denoms(200_000), "tips_cash_out": 0, "photo": "data:image/png;base64,AAAA"},
        headers=idem(),
    )
    assert count_resp.status_code == 201, count_resp.text
    count_id = count_resp.json()["count_id"]
    review = device_client.get(f"{API}/shifts/{shift_id}/close/{count_id}/review")
    assert review.status_code == 200, review.text
    diff = review.json()["difference"]
    # "unrecorded_sale": el conteo de este fixture ignora a propósito la venta
    # y la propina en efectivo (sólo cuenta la base) para no tener que
    # derivar el esperado acá; el motivo real de la diferencia es justamente
    # esa venta, así que es la causa tipada correcta, no "unknown"
    # (`requires_identified_cause` la rechaza si la diferencia es grande).
    extra: dict[str, Any] = {"cause": "unrecorded_sale", "note": "cierre de fixture (iteración 2)"} if diff != 0 else {}
    confirm = device_client.post(
        f"{API}/shifts/{shift_id}/close/{count_id}/confirm",
        json={"difference_seen": diff, "closes_day": True, **extra},
    )
    assert confirm.status_code == 200, confirm.text


def _setup_shift_with_tip(
    admin_client: TestClient,
    device_client: TestClient,
    open_shift: Any,
    identify: Any,
    db: Session,
    store: Store,
    *,
    set_feature: Any,
    tip_amount: int = 4000,
) -> dict[str, Any]:
    set_feature("fiscal.dee_pos", False)  # evita depender de un FiscalRange vigente (territorio ajeno)
    product_id = _make_product(db, store)
    shift = open_shift()  # ya identifica a la cajera antes de abrir (fixture compartida)
    _pay_with_tip(device_client, product_id, method="cash", tip_amount=tip_amount)
    return shift


def test_by_hours_is_the_default_and_splits_proportionally(
    device_client: TestClient, admin_client: TestClient, open_shift: Any, identify: Any, employees: dict[str, Any],
    db: Session, store: Store, set_feature: Any, clock: Any, roster_action: Any,
) -> None:
    shift = _setup_shift_with_tip(admin_client, device_client, open_shift, identify, db, store, set_feature=set_feature, tip_amount=4000)
    operator = employees["operator"]
    operator2 = employees["operator2"]
    cashier = employees["cashier"]
    # `open_shift()` agrega sola a la cajera (responsable de caja) al
    # roster (`app.shifts.service.open_shift` -> `hooks.
    # on_employee_identified`), y no hay forma de sacarla por acá (el
    # responsable de caja "no sale por acá", CST/`NOT_CASH_RESPONSIBLE`):
    # es una TERCERA persona legítima del reparto, con sus minutos desde
    # que abre el turno hasta que se consulta la propuesta — 4h en este
    # test (1h del operador + 3h de operator2, sin más avances de reloj).
    _worked(device_client, roster_action, shift_id=shift["id"], employee=operator, clock=clock, hours=1)
    _worked(device_client, roster_action, shift_id=shift["id"], employee=operator2, clock=clock, hours=3)

    resp = admin_client.get(
        f"{API}/admin/tips/distribution/proposal",
        params={
            "store_id": store.id,
            "shift_id": [shift["id"]],
            "from": shift["business_date"],
            "to": shift["business_date"],
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["method"] == "by_hours"  # default de D-3, nadie configuró `tips/settings` todavía
    assert body["total"] == 4000
    rows = {r["employee_id"]: r for r in body["rows"]}
    # Pesos: cajera 240 min, operador 60 min, operator2 180 min (480 en
    # total) -> proporcional a 4000: 2000 / 500 / 1500.
    assert rows[cashier.id]["amount"] == 2000
    assert rows[operator.id]["amount"] == 500
    assert rows[operator2.id]["amount"] == 1500
    assert sum(r["amount"] for r in body["rows"]) == 4000


def test_equal_shares(
    device_client: TestClient, admin_client: TestClient, open_shift: Any, identify: Any, employees: dict[str, Any],
    db: Session, store: Store, set_feature: Any, clock: Any, roster_action: Any,
) -> None:
    shift = _setup_shift_with_tip(admin_client, device_client, open_shift, identify, db, store, set_feature=set_feature, tip_amount=4000)
    operator = employees["operator"]
    operator2 = employees["operator2"]
    cashier = employees["cashier"]  # ver el comentario de `test_by_hours...`: también participa
    _worked(device_client, roster_action, shift_id=shift["id"], employee=operator, clock=clock, hours=1)
    _worked(device_client, roster_action, shift_id=shift["id"], employee=operator2, clock=clock, hours=3)

    resp = admin_client.get(
        f"{API}/admin/tips/distribution/proposal",
        params={
            "store_id": store.id,
            "shift_id": [shift["id"]],
            "method": "equal_shares",
            "from": shift["business_date"],
            "to": shift["business_date"],
        },
    )
    body = resp.json()
    rows = {r["employee_id"]: r for r in body["rows"]}
    # Partes iguales entre 3 personas: 4000 // 3 = 1333, resto 1 -> el
    # residuo (`app.orders.money.prorate`) va a la primera en orden
    # alfabético de nombre ("Cashier" < "Operator" < "Operator2").
    assert rows[cashier.id]["amount"] == 1334
    assert rows[operator.id]["amount"] == 1333
    assert rows[operator2.id]["amount"] == 1333
    assert sum(r["amount"] for r in body["rows"]) == 4000


def test_by_area(
    device_client: TestClient, admin_client: TestClient, open_shift: Any, identify: Any, employees: dict[str, Any],
    db: Session, store: Store, set_feature: Any, clock: Any, roster_action: Any,
) -> None:
    shift = _setup_shift_with_tip(admin_client, device_client, open_shift, identify, db, store, set_feature=set_feature, tip_amount=4000)
    operator = employees["operator"]
    operator2 = employees["operator2"]
    operator3 = employees["operator3"]
    cashier = employees["cashier"]  # ver el comentario de `test_by_hours...`: también participa, SIN área asignada
    _worked(device_client, roster_action, shift_id=shift["id"], employee=operator, clock=clock, hours=1)
    _worked(device_client, roster_action, shift_id=shift["id"], employee=operator2, clock=clock, hours=1)
    _worked(device_client, roster_action, shift_id=shift["id"], employee=operator3, clock=clock, hours=1)

    for emp, area in ((operator, "cocina"), (operator2, "cocina"), (operator3, "salon")):
        resp = admin_client.post(
            f"{API}/admin/payroll/areas", params={"store_id": store.id}, json={"employee_id": emp.id, "area": area}, headers=idem()
        )
        assert resp.status_code == 200, resp.text

    resp = admin_client.get(
        f"{API}/admin/tips/distribution/proposal",
        params={
            "store_id": store.id,
            "shift_id": [shift["id"]],
            "method": "by_area",
            "from": shift["business_date"],
            "to": shift["business_date"],
        },
    )
    body = resp.json()
    rows = {r["employee_id"]: r for r in body["rows"]}
    # Tres áreas: "cocina" (operator, operator2), "salon" (operator3) y
    # "sin área" (la cajera, que nadie asignó — nadie queda afuera del
    # reparto por falta de configuración). 4000 // 3 = 1333, resto 1 ->
    # a la primera en orden alfabético ("cocina"): 1334/1333/1333. Dentro de
    # "cocina" (pareja), 1334 se parte exacto: 667/667.
    assert rows[operator.id]["amount"] == 667
    assert rows[operator2.id]["amount"] == 667
    assert rows[operator3.id]["amount"] == 1333
    assert rows[cashier.id]["amount"] == 1333
    assert sum(r["amount"] for r in body["rows"]) == 4000


def test_proposal_never_writes_anything(
    device_client: TestClient, admin_client: TestClient, open_shift: Any, identify: Any, employees: dict[str, Any],
    db: Session, store: Store, set_feature: Any, clock: Any, roster_action: Any,
) -> None:
    shift = _setup_shift_with_tip(admin_client, device_client, open_shift, identify, db, store, set_feature=set_feature, tip_amount=4000)
    operator = employees["operator"]
    _worked(device_client, roster_action, shift_id=shift["id"], employee=operator, clock=clock, hours=1)

    before_payouts = db.execute(select(TipPayout)).scalars().all()
    before_lines = db.execute(select(TipPayoutDistribution)).scalars().all()

    resp = admin_client.get(
        f"{API}/admin/tips/distribution/proposal",
        params={
            "store_id": store.id,
            "shift_id": [shift["id"]],
            "from": shift["business_date"],
            "to": shift["business_date"],
        },
    )
    assert resp.status_code == 200, resp.text

    after_payouts = db.execute(select(TipPayout)).scalars().all()
    after_lines = db.execute(select(TipPayoutDistribution)).scalars().all()
    assert len(after_payouts) == len(before_payouts)
    assert len(after_lines) == len(before_lines)


def test_proposal_unknown_shift_is_404(admin_client: TestClient, store: Store) -> None:
    # `from`/`to` son requeridos por la firma pero no se usan en esta rama
    # (el override explícito de `shift_id` manda) — cualquier fecha válida
    # sirve; el test clock arranca en 2026-01-15 (`tests/conftest.py`).
    resp = admin_client.get(
        f"{API}/admin/tips/distribution/proposal",
        params={"store_id": store.id, "shift_id": [999_999], "from": "2026-01-15", "to": "2026-01-15"},
    )
    assert resp.status_code == 404, resp.text


def test_proposal_by_period_matches_proposal_by_shift_id(
    device_client: TestClient, admin_client: TestClient, open_shift: Any, identify: Any, employees: dict[str, Any],
    db: Session, store: Store, set_feature: Any, clock: Any, roster_action: Any,
) -> None:
    """Iteración 2, C2/H-2: la pantalla manda `{store_id, from, to}` — SIN
    `shift_id` — porque `frontend/src/api/payroll.ts::getTipsDistributionProposal`
    nunca conoce el id del turno de antemano. Antes de este ajuste el
    endpoint exigía `shift_id` sí o sí y esto devolvía `422` siempre; este es
    el test que no existía y por eso nadie lo vio (spec.md, ajuste de
    iteración 2, punto 8)."""
    shift = _setup_shift_with_tip(admin_client, device_client, open_shift, identify, db, store, set_feature=set_feature, tip_amount=4000)
    operator = employees["operator"]
    operator2 = employees["operator2"]
    cashier = employees["cashier"]
    _worked(device_client, roster_action, shift_id=shift["id"], employee=operator, clock=clock, hours=1)
    _worked(device_client, roster_action, shift_id=shift["id"], employee=operator2, clock=clock, hours=3)
    identify(device_client, cashier)  # "salir" del roster (arriba) puede dejar a nadie identificado en el dispositivo
    _close_shift(device_client, shift_id=shift["id"])  # sólo turnos CERRADOS entran en la resolución por período

    resp = admin_client.get(
        f"{API}/admin/tips/distribution/proposal",
        params={"store_id": store.id, "from": shift["business_date"], "to": shift["business_date"]},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["available"] is True
    assert body["method"] == "by_hours"
    assert body["shift_ids"] == [shift["id"]]  # el cliente los necesita para POST /admin/tips/payouts
    rows = {r["employee_id"]: r for r in body["rows"]}
    # Mismo reparto que `test_by_hours_is_the_default_and_splits_proportionally`,
    # pasando por la puerta de período en vez de `shift_id` explícito.
    assert rows[cashier.id]["amount"] == 2000
    assert rows[operator.id]["amount"] == 500
    assert rows[operator2.id]["amount"] == 1500
    assert body["total"] == 4000


def test_proposal_empty_range_is_available_false_with_reason(admin_client: TestClient, store: Store) -> None:
    """Rango sin ningún turno cerrado -> `available: false` con motivo en
    palabras, NUNCA `422` y NUNCA `200` con `rows: []`/`available: true`
    (regla de null-con-motivo; spec.md, ajuste de iteración 2, punto 6)."""
    resp = admin_client.get(
        f"{API}/admin/tips/distribution/proposal",
        params={"store_id": store.id, "from": "2020-01-01", "to": "2020-01-01"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["available"] is False
    assert body["reason"]
    assert body["rows"] == []
    assert body["shift_ids"] == []
    assert body["total"] == 0
    assert body["method"] == "by_hours"  # sigue nombrando el método resuelto (default D-3), aunque no haya con qué calcular


def test_settings_default_and_patch(admin_client: TestClient, store: Store) -> None:
    resp = admin_client.get(f"{API}/admin/tips/settings", params={"store_id": store.id})
    assert resp.status_code == 200, resp.text
    assert resp.json()["method"] == "by_hours"

    patch_resp = admin_client.patch(
        f"{API}/admin/tips/settings", params={"store_id": store.id}, json={"method": "equal_shares"}, headers=idem()
    )
    assert patch_resp.status_code == 200, patch_resp.text
    assert patch_resp.json()["method"] == "equal_shares"

    resp = admin_client.get(f"{API}/admin/tips/settings", params={"store_id": store.id})
    assert resp.json()["method"] == "equal_shares"


def test_tips_feature_gate(admin_client: TestClient, store: Store, set_feature: Any) -> None:
    set_feature("pos.tips", False)
    resp = admin_client.get(f"{API}/admin/tips/settings", params={"store_id": store.id})
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "FEATURE_DISABLED"

    set_feature("pos.tips", True)
    resp = admin_client.get(f"{API}/admin/tips/settings", params={"store_id": store.id})
    assert resp.status_code == 200, resp.text
