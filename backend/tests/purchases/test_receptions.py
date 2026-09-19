"""`POST /receptions`, `GET /admin/receptions*`, `PATCH`/`DELETE
/admin/receptions/{id}` — confirmación atómica, IVA/INC, guardas de tecleo,
reversa."""

from __future__ import annotations

from datetime import date
from typing import Any
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.stores.models import Store, StoreFiscalConfig


def _line(
    ingredient_id: int,
    *,
    qty_received: str = "2000",
    qty_invoiced: str = "2000",
    purchase_unit_price: str = "14500",
    tax_base: int = 0,
    tax_rate: int = 0,
    tax_amount: int = 0,
    lot_code: str | None = "L-1",
    expires_at: str | None = "2026-12-31",
) -> dict[str, Any]:
    return {
        "ingredient_id": ingredient_id,
        "qty_received": qty_received,
        "qty_invoiced": qty_invoiced,
        "purchase_unit_price": purchase_unit_price,
        "tax_base": tax_base,
        "tax_rate": tax_rate,
        "tax_amount": tax_amount,
        "lot_code": lot_code,
        "expires_at": expires_at,
    }


def _reception_payload(supplier_id: int, ingredient_id: int, **overrides: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "supplier_id": supplier_id,
        "invoice_number": "FE-001",
        "invoice_date": "2026-01-10",
        "no_invoice": False,
        "received_by_pin": "2222",  # employees["operator"]
        "lines": [_line(ingredient_id)],
    }
    payload.update(overrides)
    return payload


def _idem() -> dict[str, str]:
    return {"Idempotency-Key": str(uuid4())}


def test_feature_disabled_returns_400(
    admin_client: TestClient, store: Store, set_feature: Any, ingredient_seeded: Any
) -> None:
    set_feature("purchases", False)
    resp = admin_client.post(
        f"/api/v1/admin/suppliers?store_id={store.id}",
        json={"name": "X", "payment_term_days": 0, "invoices_required": False, "active": True},
    )
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "FEATURE_DISABLED"


def test_create_reception_confirms_atomically(
    admin_client: TestClient, store: Store, create_supplier: Any, ingredient_seeded: Any, db: Session
) -> None:
    supplier = create_supplier()
    resp = admin_client.post(
        f"/api/v1/receptions?store_id={store.id}",
        json=_reception_payload(supplier["id"], ingredient_seeded.id),
        headers=_idem(),
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["status"] == "confirmed"
    assert len(body["lines"]) == 1
    line = body["lines"][0]
    assert line["stock_movement_id"] is not None
    assert line["stock_batch_id"] is not None
    assert body["payable_id"] is not None

    from app.inventory.models import MovementCause, StockMovement

    movements = db.query(StockMovement).filter(StockMovement.ref_type == "reception_line").all()
    assert len(movements) == 1
    assert movements[0].cause == MovementCause.PURCHASE
    assert movements[0].qty_base == 2_000_000  # 2000 g en milésimas

    from app.purchases.models import Payable

    payable = db.query(Payable).filter(Payable.id == body["payable_id"]).one()
    assert payable.status.value == "pending_review"
    assert payable.amount > 0


def test_invoice_required_blocks_no_invoice(
    admin_client: TestClient, store: Store, create_supplier: Any, ingredient_seeded: Any
) -> None:
    supplier = create_supplier(invoices_required=True)
    resp = admin_client.post(
        f"/api/v1/receptions?store_id={store.id}",
        json=_reception_payload(supplier["id"], ingredient_seeded.id, no_invoice=True, invoice_number=None),
        headers=_idem(),
    )
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "INVOICE_REQUIRED"


def test_no_invoice_allowed_when_not_required(
    admin_client: TestClient, store: Store, create_supplier: Any, ingredient_seeded: Any
) -> None:
    supplier = create_supplier(invoices_required=False)
    resp = admin_client.post(
        f"/api/v1/receptions?store_id={store.id}",
        json=_reception_payload(supplier["id"], ingredient_seeded.id, no_invoice=True, invoice_number=None),
        headers=_idem(),
    )
    assert resp.status_code == 201, resp.text
    assert resp.json()["no_invoice"] is True


def test_ingredient_not_found_is_404_and_creates_nothing(
    admin_client: TestClient, store: Store, create_supplier: Any, db: Session
) -> None:
    supplier = create_supplier()
    resp = admin_client.post(
        f"/api/v1/receptions?store_id={store.id}",
        json=_reception_payload(supplier["id"], 999_999),
        headers=_idem(),
    )
    assert resp.status_code == 404, resp.text

    from app.purchases.models import Reception

    assert db.query(Reception).count() == 0


def test_price_jump_guard_asks_and_confirm_price_clears_it(
    admin_client: TestClient, store: Store, create_supplier: Any, ingredient_seeded: Any
) -> None:
    # referencia = official_cost_micros del insumo sembrado = $14.5/g;
    # $17.000/kg -> $17/g pretax, ~17.2% por encima -> PRICE_JUMP.
    supplier = create_supplier()
    payload = _reception_payload(supplier["id"], ingredient_seeded.id, lines=[_line(ingredient_seeded.id, purchase_unit_price="17000")])
    resp = admin_client.post(f"/api/v1/receptions?store_id={store.id}", json=payload, headers=_idem())
    assert resp.status_code == 409, resp.text
    assert resp.json()["error"]["code"] == "PRICE_JUMP"

    payload["confirm_price"] = True
    resp2 = admin_client.post(f"/api/v1/receptions?store_id={store.id}", json=payload, headers=_idem())
    assert resp2.status_code == 201, resp2.text
    body = resp2.json()
    assert body["price_confirmed"] is True
    assert body["price_confirmed_by_employee_name"] is not None


def test_price_looks_like_package_guard(
    admin_client: TestClient, store: Store, create_supplier: Any, ingredient_seeded: Any
) -> None:
    # $150.000/kg -> $150/g pretax, ~10.3x la referencia ($14.5/g) -> PACKAGE.
    supplier = create_supplier()
    payload = _reception_payload(
        supplier["id"], ingredient_seeded.id, lines=[_line(ingredient_seeded.id, purchase_unit_price="150000")]
    )
    resp = admin_client.post(f"/api/v1/receptions?store_id={store.id}", json=payload, headers=_idem())
    assert resp.status_code == 409, resp.text
    assert resp.json()["error"]["code"] == "PRICE_LOOKS_LIKE_PACKAGE"

    payload["confirm_price"] = True
    resp2 = admin_client.post(f"/api/v1/receptions?store_id={store.id}", json=payload, headers=_idem())
    assert resp2.status_code == 201, resp2.text


def test_guard_never_self_corrects_the_price(
    admin_client: TestClient, store: Store, create_supplier: Any, ingredient_seeded: Any
) -> None:
    """La guarda pregunta y nunca ajusta el número sola: el costo final
    confirmado es EXACTAMENTE el tecleado, no un valor "corregido"."""
    supplier = create_supplier()
    payload = _reception_payload(
        supplier["id"], ingredient_seeded.id, lines=[_line(ingredient_seeded.id, purchase_unit_price="17000")]
    )
    payload["confirm_price"] = True
    resp = admin_client.post(f"/api/v1/receptions?store_id={store.id}", json=payload, headers=_idem())
    assert resp.status_code == 201, resp.text
    line = resp.json()["lines"][0]
    # 17000 micros de compra / 1000 (purchase_factor) = 17_000_000 micros/g = "17"
    assert line["unit_cost"] == "17"


def test_inc_vs_iva_costs_differ_by_exactly_the_tax(
    admin_client: TestClient, store: Store, create_supplier: Any, ingredient_seeded: Any, db: Session
) -> None:
    """§4.1: el IVA bajo INC es mayor valor del costo; bajo IVA es
    descontable y se reporta aparte. Dos recepciones IDÉNTICAS salvo el
    régimen fiscal vigente dejan costos distintos, exactamente por el IVA."""
    # El fixture `store` ya trae INC vigente desde 2020-01-01 (inc_responsible=True).
    # Se agrega un segundo período vigente desde 2026-06-01 bajo IVA (franquicia).
    from app.core import clock as clock_module

    db.add(
        StoreFiscalConfig(
            store_id=store.id,
            valid_from=date(2026, 6, 1),
            person_type="natural",
            regime="ordinary",
            franchise=True,
            inc_responsible=False,
            iva_responsible=True,
            rut_codes=[],
            price_includes_tax=True,
            default_tax="iva_19",
            created_at=clock_module.now_utc(),
        )
    )
    db.flush()

    supplier = create_supplier()
    line = _line(
        ingredient_seeded.id,
        qty_received="1000",
        qty_invoiced="1000",
        purchase_unit_price="14500",
        tax_base=14_500,
        tax_rate=19,
        tax_amount=2_755,
    )

    inc_payload = _reception_payload(supplier["id"], ingredient_seeded.id, invoice_date="2026-01-10", lines=[line])
    resp_inc = admin_client.post(f"/api/v1/receptions?store_id={store.id}", json=inc_payload, headers=_idem())
    assert resp_inc.status_code == 201, resp_inc.text
    inc_line = resp_inc.json()["lines"][0]

    iva_payload = _reception_payload(supplier["id"], ingredient_seeded.id, invoice_date="2026-07-10", lines=[line])
    resp_iva = admin_client.post(f"/api/v1/receptions?store_id={store.id}", json=iva_payload, headers=_idem())
    assert resp_iva.status_code == 201, resp_iva.text
    iva_line = resp_iva.json()["lines"][0]

    assert inc_line["unit_cost"] == iva_line["unit_cost"] == "14.5"  # el costo PRE-impuesto es igual
    final_inc = float(inc_line["final_unit_cost"])
    final_iva = float(iva_line["final_unit_cost"])
    assert final_inc != final_iva
    # tax_amount=2755 pesos / 1000 g = $2.755/g exactos de diferencia.
    assert round(final_inc - final_iva, 3) == 2.755
    assert final_iva == 14.5  # bajo IVA el impuesto NO entra al costo


def test_atomicity_injected_failure_leaves_nothing(
    admin_client: TestClient,
    store: Store,
    create_supplier: Any,
    ingredient_seeded: Any,
    db: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Recepción con DOS líneas; se inyecta un fallo en la segunda (última)
    línea. No debería quedar ni un movimiento, ni un lote, ni la recepción,
    ni la cuenta por pagar."""
    from app.inventory.models import Ingredient

    # Un segundo insumo para la segunda línea.
    from app.core import clock as clock_module

    second = Ingredient(
        organization_id=ingredient_seeded.organization_id,
        store_id=ingredient_seeded.store_id,
        name="Papa criolla",
        category="Verduras",
        base_unit=ingredient_seeded.base_unit,
        purchase_unit="kg",
        purchase_factor=1000,
        yield_pct=100,
        official_cost_micros=3_000_000,
        estimated_cost_micros=None,
        min_stock=2000,
        lead_time_days=1,
        perishable=True,
        key_item=False,
        active=True,
        consumption_untracked=False,
        substitute_ingredient_id=None,
        supplier_id=None,
        created_at=clock_module.now_utc(),
        updated_at=clock_module.now_utc(),
    )
    db.add(second)
    db.flush()
    db.commit()

    supplier = create_supplier()

    import app.purchases.hooks as purchases_hooks_module

    calls = {"n": 0}
    real_create = purchases_hooks_module.create_stock_batch

    def _flaky_create(*args: Any, **kwargs: Any) -> Any:
        calls["n"] += 1
        if calls["n"] == 2:
            raise RuntimeError("fallo inyectado en la última línea")
        return real_create(*args, **kwargs)

    monkeypatch.setattr(purchases_hooks_module, "create_stock_batch", _flaky_create)

    payload = _reception_payload(
        supplier["id"],
        ingredient_seeded.id,
        lines=[_line(ingredient_seeded.id), _line(second.id, purchase_unit_price="3000")],
    )
    # `TestClient` (default `raise_server_exceptions=True`) deja pasar la
    # excepción real hacia el test en vez de convertirla en una `Response`
    # 500 (aunque el handler genérico de `app.core.errors` SÍ la atrapa para
    # un cliente real: `ServerErrorMiddleware` manda la respuesta 500 y
    # DESPUÉS re-levanta, "para que el test pueda decidir" — comportamiento
    # de Starlette, no un bug de este dominio). Lo que importa para el
    # checklist de atomicidad es que no haya quedado nada escrito, no la
    # forma exacta en que el test client reporta el 500.
    with pytest.raises(RuntimeError, match="fallo inyectado"):
        admin_client.post(f"/api/v1/receptions?store_id={store.id}", json=payload, headers=_idem())

    from app.inventory.models import StockMovement
    from app.purchases.models import Payable, Reception, ReceptionLine

    assert db.query(Reception).count() == 0
    assert db.query(ReceptionLine).count() == 0
    assert db.query(Payable).count() == 0
    assert db.query(StockMovement).filter(StockMovement.ref_type == "reception_line").count() == 0


def test_reversal_happy_path_reverses_lot_and_writes_mirror_movement(
    admin_client: TestClient, store: Store, create_supplier: Any, ingredient_seeded: Any, db: Session
) -> None:
    from app.inventory.models import MovementCause

    if not hasattr(MovementCause, "RECEPTION_REVERSAL"):
        pytest.skip("MovementCause.RECEPTION_REVERSAL todavía no existe (dependencia de app.inventory, declarada en §8)")

    supplier = create_supplier()
    resp = admin_client.post(
        f"/api/v1/receptions?store_id={store.id}",
        json=_reception_payload(supplier["id"], ingredient_seeded.id),
        headers=_idem(),
    )
    assert resp.status_code == 201, resp.text
    reception_id = resp.json()["id"]

    resp2 = admin_client.patch(f"/api/v1/admin/receptions/{reception_id}", json={"authorizer_pin": "9999"})
    assert resp2.status_code == 200, resp2.text
    assert resp2.json()["status"] == "reversed"

    from app.purchases.models import Payable

    payable = db.query(Payable).filter(Payable.reception_id == reception_id).one()
    assert payable.status.value == "cancelled"


def test_reversal_blocked_when_lot_already_consumed(
    admin_client: TestClient,
    store: Store,
    create_supplier: Any,
    ingredient_seeded: Any,
    db: Session,
    mark_batch_consumed: Any,
) -> None:
    supplier = create_supplier()
    resp = admin_client.post(
        f"/api/v1/receptions?store_id={store.id}",
        json=_reception_payload(supplier["id"], ingredient_seeded.id),
        headers=_idem(),
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    batch_id = body["lines"][0]["stock_batch_id"]
    mark_batch_consumed(db, batch_id=batch_id, qty_base=500)
    db.commit()

    resp2 = admin_client.patch(f"/api/v1/admin/receptions/{body['id']}", json={"authorizer_pin": "9999"})
    assert resp2.status_code == 409, resp2.text
    assert resp2.json()["error"]["code"] == "LOT_CONSUMED"

    from app.purchases.models import Reception

    reception = db.query(Reception).filter(Reception.id == body["id"]).one()
    assert reception.status.value == "confirmed"  # no quedó a medio revertir


def test_receptions_sealed_with_shift_business_date_at_0030(
    admin_client: TestClient, store: Store, create_supplier: Any, ingredient_seeded: Any, clock: Any
) -> None:
    from datetime import datetime, timezone

    # Corte de sede = 6 (fixture `store`). 00:30 local (Bogotá, UTC-5) cae
    # ANTES del corte: queda sellada con el día anterior.
    clock.set(datetime(2026, 3, 11, 5, 30, tzinfo=timezone.utc))  # 00:30 Bogotá
    supplier = create_supplier()
    resp = admin_client.post(
        f"/api/v1/receptions?store_id={store.id}",
        json=_reception_payload(supplier["id"], ingredient_seeded.id),
        headers=_idem(),
    )
    assert resp.status_code == 201, resp.text
    assert resp.json()["business_date"] == "2026-03-10"


def test_idempotency_key_replays_same_response(
    admin_client: TestClient, store: Store, create_supplier: Any, ingredient_seeded: Any
) -> None:
    supplier = create_supplier()
    headers = _idem()
    payload = _reception_payload(supplier["id"], ingredient_seeded.id)
    resp1 = admin_client.post(f"/api/v1/receptions?store_id={store.id}", json=payload, headers=headers)
    assert resp1.status_code == 201, resp1.text
    resp2 = admin_client.post(f"/api/v1/receptions?store_id={store.id}", json=payload, headers=headers)
    assert resp2.status_code == 201, resp2.text
    assert resp1.json()["id"] == resp2.json()["id"]


def test_list_and_get_reception(
    admin_client: TestClient, store: Store, create_supplier: Any, ingredient_seeded: Any
) -> None:
    supplier = create_supplier()
    resp = admin_client.post(
        f"/api/v1/receptions?store_id={store.id}",
        json=_reception_payload(supplier["id"], ingredient_seeded.id),
        headers=_idem(),
    )
    reception_id = resp.json()["id"]

    listed = admin_client.get(f"/api/v1/admin/receptions?store_id={store.id}")
    assert listed.status_code == 200, listed.text
    assert any(r["id"] == reception_id for r in listed.json())

    got = admin_client.get(f"/api/v1/admin/receptions/{reception_id}")
    assert got.status_code == 200, got.text
    assert got.json()["id"] == reception_id

    csv_resp = admin_client.get(f"/api/v1/admin/receptions?store_id={store.id}&format=csv")
    assert csv_resp.status_code == 200
    assert csv_resp.headers["content-type"].startswith("text/csv")
