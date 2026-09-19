"""Fixtures propias de `tests/purchases/**`.

`"purchases"` ya está en `app.main.DOMAINS`/`app.core.models_registry
.MODEL_MODULES` (Paso 0 de este territorio), así que el router se monta
solo a través de `app.main.create_app()` — a diferencia de
`tests/inventory/conftest.py` en 2a, acá no hace falta montarlo a mano.

**Convergencia con `app.inventory`**: `create_stock_batch`/
`reverse_stock_batch` (`app/inventory/hooks.py`) son territorio de
`backend-inventario`, en construcción en paralelo en este mismo pedido 2b.
Si todavía no existen, este conftest parchea un doble fiel a su contrato
(`tests/purchases/_stock_batch_stub.py`) DIRECTO sobre el módulo real
`app.inventory.hooks` — sólo mientras dure este proceso de pytest (que,
según la regla de verificación de este agente, corre nada más
`tests/purchases tests/shifts`, así que no interfiere con la suite de
`inventory`). En cuanto la dependencia aterrice, `_STUB_ACTIVE` da `False` y
no se toca nada: los tests pasan a ejercitar el camino real sin cambiar una
línea acá.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

import app.inventory.hooks as inventory_hooks_module
from app.stores.models import Store

_STUB_ACTIVE = not hasattr(inventory_hooks_module, "create_stock_batch")

if _STUB_ACTIVE:
    from tests.purchases import _stock_batch_stub

    inventory_hooks_module.create_stock_batch = _stock_batch_stub.create_stock_batch  # type: ignore[attr-defined]
    inventory_hooks_module.reverse_stock_batch = _stock_batch_stub.reverse_stock_batch  # type: ignore[attr-defined]


@pytest.fixture()
def stock_batch_stub_active() -> bool:
    """Para que un test declare explícitamente "esto depende del doble" y se
    lea con claridad en un reporte de cobertura, no para condicionar
    aserciones."""
    return _STUB_ACTIVE


@pytest.fixture()
def mark_batch_consumed() -> Callable[..., None]:
    """Simula "este lote ya se consumió en parte" para probar el 409
    `LOT_CONSUMED` de la reversa, sin necesitar que `inventory.counts`/
    `inventory.lots` corran una venta real primero. Funciona contra el
    `StockBatch` real (decrementa `qty_remaining`, el campo que
    `reverse_stock_batch` mira de verdad) o contra el doble
    (`consumed_qty_base`), lo que esté activo."""

    def _mark(db: Any, *, batch_id: int, qty_base: int) -> None:
        if not _STUB_ACTIVE:
            from app.inventory.models import StockBatch

            row = db.get(StockBatch, batch_id)
            assert row is not None
            row.qty_remaining = max(0, row.qty_remaining - qty_base)
            db.flush()
            return
        from tests.purchases._stock_batch_stub import mark_consumed_for_test

        mark_consumed_for_test(db, batch_id=batch_id, qty_base=qty_base)

    return _mark


@pytest.fixture()
def enable_purchases(set_feature: Callable[..., None]) -> Callable[[], None]:
    def _enable() -> None:
        set_feature("catalog.recipes", True)
        set_feature("inventory.perpetual", True)
        set_feature("purchases", True)

    return _enable


@pytest.fixture()
def create_supplier(admin_client: TestClient, store: Store, enable_purchases: Callable[[], None]) -> Callable[..., dict[str, Any]]:
    def _create(
        *,
        name: str = "Distribuidora La Sabana",
        nit: str | None = "900123456-1",
        payment_term_days: int = 30,
        invoices_required: bool = True,
        active: bool = True,
    ) -> dict[str, Any]:
        enable_purchases()
        resp = admin_client.post(
            f"/api/v1/admin/suppliers?store_id={store.id}",
            json={
                "name": name,
                "nit": nit,
                "payment_term_days": payment_term_days,
                "contact_name": "Carlos Ruiz",
                "contact_phone": "3001234567",
                "invoices_required": invoices_required,
                "active": active,
            },
        )
        assert resp.status_code == 201, resp.text
        return resp.json()

    return _create


@pytest.fixture()
def create_payable(admin_client: TestClient, store: Store, create_supplier: Callable[..., Any], ingredient_seeded: Any) -> Callable[..., dict[str, Any]]:
    """Una cuenta por pagar real, nacida de una recepción confirmada — que es
    el único camino por el que existe una.

    Vivía dentro de `test_payables.py`. Se movió acá cuando
    `test_payment_history.py` la necesitó: dos copias de una fixture se
    separan sin avisar, y este pedido ya gastó cuatro hallazgos en
    contratos duplicados que se desincronizaron."""
    def _create(*, amount_line_pesos: str = "14500", qty: str = "1000") -> dict[str, Any]:
        supplier = create_supplier()
        payload = {
            "supplier_id": supplier["id"],
            "invoice_number": "FE-9",
            "invoice_date": "2026-01-05",
            "no_invoice": False,
            "received_by_pin": "2222",
            "lines": [
                {
                    "ingredient_id": ingredient_seeded.id,
                    "qty_received": qty,
                    "qty_invoiced": qty,
                    "purchase_unit_price": amount_line_pesos,
                    "tax_base": 0,
                    "tax_rate": 0,
                    "tax_amount": 0,
                    "lot_code": "L-9",
                    "expires_at": "2026-06-01",
                }
            ],
        }
        resp = admin_client.post(f"/api/v1/receptions?store_id={store.id}", json=payload, headers={"Idempotency-Key": str(uuid4())})
        assert resp.status_code == 201, resp.text
        body = resp.json()
        payable = admin_client.get(f"/api/v1/admin/payables?store_id={store.id}").json()
        row = next(p for p in payable if p["id"] == body["payable_id"])
        return row

    return _create
