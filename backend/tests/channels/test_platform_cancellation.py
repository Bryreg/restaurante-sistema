"""Cancelar una venta de plataforma después de preparar = VENTA COMPENSADA,
**nunca una merma**.

Renglón textual del checklist: «Cancelar una venta de plataforma después de
preparar compensa la VENTA y no genera merma (test: el reporte de mermas no
la incluye y el inventario NO se repone)».

El insumo ya se descontó al enviar (2a) y **se queda descontado**: el plato
se cocinó de verdad. Lo que se compensa es el cobro. Confundirlo falsearía
el KPI de mermas ÷ compras que 2b acaba de construir.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.channels.models import LedgerEntryKind, PlatformCommission, PlatformReceivable
from app.core.modules import find_spec_safe
from app.fiscal.models import FiscalDocument
from app.orders.models import Order, OrderItem, OrderItemStatus, OrderStatus
from tests.channels.conftest import idem


def _stock_snapshot(db: Session) -> list[tuple[int, int]]:
    """Saldo del libro por insumo. Si `app.inventory` no está montado, el
    invariante se reduce a "no se creó ninguna merma", que igual se prueba."""
    if find_spec_safe("app.inventory.models") is None:
        return []
    import importlib

    inv = importlib.import_module("app.inventory.models")
    rows = db.execute(
        select(inv.StockMovement.ingredient_id, func.sum(inv.StockMovement.qty_base)).group_by(
            inv.StockMovement.ingredient_id
        )
    ).all()
    return sorted((int(i), int(q or 0)) for i, q in rows)


def _waste_count(db: Session) -> int:
    if find_spec_safe("app.inventory.models") is None:
        return 0
    import importlib

    inv = importlib.import_module("app.inventory.models")
    return int(db.execute(select(func.count()).select_from(inv.Waste)).scalar_one())


def test_cancelling_after_preparing_compensates_the_sale_without_a_waste(
    platform_order: Any, pay: Any, admin_client: Any, store: Any, db: Session
) -> None:
    order = platform_order()
    total = order["totals"]["total"]
    assert pay(order, splits=[{"method": "platform", "amount": total}]).status_code == 201
    db.expire_all()

    stock_before = _stock_snapshot(db)
    wastes_before = _waste_count(db)

    resp = admin_client.post(
        f"/api/v1/admin/platform-cancellations?store_id={store.id}",
        json={"order_id": order["id"], "reason": "El cliente canceló en la app después de preparado"},
        headers=idem(),
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    db.expire_all()

    # 1. NO es una merma y NO repone inventario. Los dos, explícitos en el
    #    contrato de salida y en la base.
    assert body["restocked"] is False
    assert body["waste_created"] is False
    assert _waste_count(db) == wastes_before, "la cancelación creó una merma"
    assert _stock_snapshot(db) == stock_before, (
        "la cancelación repuso inventario: el insumo ya se consumió al enviar y se queda descontado"
    )

    # 2. Se compensó la VENTA: hay una nota contra el documento original, y
    #    el original quedó `reversed` (no borrado).
    assert body["note_document_id"] is not None
    note = db.get(FiscalDocument, body["note_document_id"])
    assert note is not None
    assert note.reverses_document_id is not None
    original = db.get(FiscalDocument, note.reverses_document_id)
    assert original is not None
    assert original.status == "reversed"
    assert note.total == original.total

    # 3. La cuenta por cobrar y la comisión se compensaron, sin borrarse.
    receivable = db.execute(
        select(PlatformReceivable).where(PlatformReceivable.order_id == order["id"])
    ).scalar_one()
    assert receivable.status.value == "reversed"
    assert receivable.amount == total, "la fila original no se reescribió"

    commissions = list(
        db.execute(
            select(PlatformCommission).where(PlatformCommission.order_id == order["id"])
        ).scalars()
    )
    assert len(commissions) == 2
    kinds = {c.kind for c in commissions}
    assert kinds == {LedgerEntryKind.CHARGE, LedgerEntryKind.REVERSAL}
    charge = next(c for c in commissions if c.kind == LedgerEntryKind.CHARGE)
    reversal = next(c for c in commissions if c.kind == LedgerEntryKind.REVERSAL)
    assert reversal.amount == charge.amount
    assert reversal.commission_bp == charge.commission_bp, "compensa con el porcentaje CONGELADO"

    # 4. La comanda la marcó su propio dueño (CONTRATO C4), y los ítems
    #    quedaron intactos: lo que se preparó, se preparó.
    assert body["order_marked"] is True
    row = db.get(Order, order["id"])
    assert row is not None
    # Se afirma sobre el EFECTO estable del CONTRATO C4 (sello, motivo y
    # "ya no es una venta viva"), no sobre el nombre del miembro del enum:
    # ese nombre es territorio de `backend-canales-comanda` y un test ajeno
    # que lo fija a mano es el espejo frágil que 2b pagó cuatro veces.
    assert row.platform_cancelled_at is not None
    assert row.platform_cancel_reason == "El cliente canceló en la app después de preparado"
    assert row.status not in (OrderStatus.OPEN, OrderStatus.TO_PAY, OrderStatus.PAID)
    items = list(db.execute(select(OrderItem).where(OrderItem.order_id == order["id"])).scalars())
    assert items
    assert all(i.status != OrderItemStatus.VOIDED for i in items)


def test_cancelling_an_uncharged_platform_order_still_creates_no_waste(
    platform_order: Any, admin_client: Any, store: Any, db: Session
) -> None:
    """Si la comanda todavía no tiene documento fiscal, la cancelación
    IGUAL no genera merma ni repone inventario. Explícito en el código y
    acá."""
    order = platform_order()
    db.expire_all()
    stock_before = _stock_snapshot(db)
    wastes_before = _waste_count(db)

    resp = admin_client.post(
        f"/api/v1/admin/platform-cancellations?store_id={store.id}",
        json={"order_id": order["id"], "reason": "La plataforma canceló antes de cobrar"},
        headers=idem(),
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    db.expire_all()

    assert body["note_document_id"] is None
    assert body["receivable_reversed_id"] is None
    assert body["restocked"] is False
    assert body["waste_created"] is False
    assert _waste_count(db) == wastes_before
    assert _stock_snapshot(db) == stock_before

    row = db.get(Order, order["id"])
    assert row is not None
    assert row.platform_cancelled_at is not None
    assert row.status not in (OrderStatus.OPEN, OrderStatus.TO_PAY, OrderStatus.PAID)


def test_the_note_never_returns_anything_to_stock(
    platform_order: Any, pay: Any, admin_client: Any, store: Any, db: Session
) -> None:
    """`returns_to_stock=False` en TODAS las líneas, explícito.

    El default de `NoteLineIn` es `True` ("vuelve"), que es el correcto para
    una devolución de mostrador. Acá confiar en un default sería justo cómo
    se cuela un bug de inventario que nadie ve hasta el conteo.
    """
    order = platform_order()
    total = order["totals"]["total"]
    assert pay(order, splits=[{"method": "platform", "amount": total}]).status_code == 201
    db.expire_all()

    resp = admin_client.post(
        f"/api/v1/admin/platform-cancellations?store_id={store.id}",
        json={"order_id": order["id"], "reason": "Cancelada tras preparar"},
        headers=idem(),
    )
    assert resp.status_code == 201, resp.text

    if find_spec_safe("app.inventory.models") is None:  # pragma: no cover
        return
    import importlib

    inv = importlib.import_module("app.inventory.models")
    note_returns = db.execute(
        select(func.count())
        .select_from(inv.StockMovement)
        .where(inv.StockMovement.cause == inv.MovementCause.NOTE_RETURN)
    ).scalar_one()
    assert int(note_returns) == 0, "la nota de la cancelación devolvió producto al inventario"


def test_cancelling_a_non_platform_order_is_a_business_rule_not_a_500(
    device_client: Any,
    identify: Any,
    employees: dict,
    open_shift: Any,
    drink_product: Any,
    platform: Any,
    channels_on: None,
    admin_client: Any,
    store: Any,
) -> None:
    open_shift()
    identify(device_client, employees["cashier"])
    created = device_client.post("/api/v1/orders", json={"channel": "counter"}, headers=idem())
    assert created.status_code == 201, created.text
    order = created.json()

    resp = admin_client.post(
        f"/api/v1/admin/platform-cancellations?store_id={store.id}",
        json={"order_id": order["id"], "reason": "no corresponde"},
        headers=idem(),
    )
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "NOT_A_PLATFORM_ORDER"
