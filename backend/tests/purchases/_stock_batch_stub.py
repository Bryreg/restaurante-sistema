"""Doble mínimo y fiel a la firma publicada de `create_stock_batch`/
`reverse_stock_batch` (contrato vinculante de la misión de este agente, ver
`app/purchases/hooks.py`) para poder probar `app.purchases` de punta a punta
mientras `backend-inventario` no las construya en `app/inventory/hooks.py`.

Sólo se activa desde `tests/purchases/conftest.py`, y sólo si esas dos
funciones **todavía no existen** en el módulo real — en cuanto aterricen,
`conftest.py` no parchea nada y estos tests corren contra el dominio real
sin tocar una línea acá. Mismo patrón de convergencia que
`tests/recipes/_inventory_stub.py` usó en 2a.

**No es parte de la entrega de `app.purchases`**: vive en
`tests/purchases/**` (territorio propio) y nunca se importa desde `app/`.
Tabla propia (`test_purchases_stub_stock_batches`, nunca `stock_batches`)
para no chocar con la tabla real el día que exista.

Convención asumida (no la fija la misión explícitamente): un lote "se
consumió en parte" cuando `consumed_qty_base != 0` — el test que ejercita
`409 LOT_CONSUMED` llama `mark_consumed_for_test` para simularlo
directamente, sin necesitar que `inventory.counts`/`inventory.lots` existan
de verdad."""

from __future__ import annotations

from datetime import date, datetime
from typing import Any

import sqlalchemy as sa
from sqlalchemy.orm import Mapped, Session, mapped_column

from app.core.db import Base, UTCDateTime
from app.core.errors import AppError


class StubStockBatch(Base):
    __tablename__ = "test_purchases_stub_stock_batches"

    id: Mapped[int] = mapped_column(primary_key=True)
    organization_id: Mapped[int] = mapped_column(sa.Integer)
    store_id: Mapped[int] = mapped_column(sa.Integer)
    ingredient_id: Mapped[int] = mapped_column(sa.Integer)
    qty_base: Mapped[int] = mapped_column(sa.Integer)
    unit_cost_micros: Mapped[int] = mapped_column(sa.BigInteger)
    cost_source: Mapped[str] = mapped_column(sa.String(20))
    lot_code: Mapped[str | None] = mapped_column(sa.String(80), nullable=True)
    expires_at: Mapped[date | None] = mapped_column(sa.Date, nullable=True)
    received_at: Mapped[datetime] = mapped_column(UTCDateTime())
    business_date: Mapped[date] = mapped_column(sa.Date)
    source_type: Mapped[str] = mapped_column(sa.String(40))
    source_id: Mapped[int] = mapped_column(sa.Integer)
    consumed_qty_base: Mapped[int] = mapped_column(sa.Integer, default=0)
    reversed: Mapped[bool] = mapped_column(sa.Boolean, default=False)


def create_stock_batch(
    db: Session,
    *,
    organization_id: int,
    store_id: int,
    ingredient_id: int,
    qty_base: int,
    unit_cost_micros: int,
    cost_source: Any,
    lot_code: str | None = None,
    expires_at: date | None = None,
    received_at: datetime,
    business_date: date,
    source_type: str,
    source_id: int,
) -> StubStockBatch:
    row = StubStockBatch(
        organization_id=organization_id,
        store_id=store_id,
        ingredient_id=ingredient_id,
        qty_base=qty_base,
        unit_cost_micros=unit_cost_micros,
        cost_source=cost_source.value if hasattr(cost_source, "value") else str(cost_source),
        lot_code=lot_code,
        expires_at=expires_at,
        received_at=received_at,
        business_date=business_date,
        source_type=source_type,
        source_id=source_id,
        consumed_qty_base=0,
        reversed=False,
    )
    db.add(row)
    db.flush()
    return row


def reverse_stock_batch(db: Session, *, batch_id: int) -> None:
    row = db.get(StubStockBatch, batch_id)
    if row is None:
        return
    if row.consumed_qty_base != 0:
        raise AppError(
            code="LOT_CONSUMED",
            message="El lote ya se consumió en parte; no se puede revertir la recepción",
            status=409,
        )
    row.reversed = True
    db.flush()


def mark_consumed_for_test(db: Session, *, batch_id: int, qty_base: int) -> None:
    row = db.get(StubStockBatch, batch_id)
    assert row is not None
    row.consumed_qty_base += qty_base
    db.flush()
