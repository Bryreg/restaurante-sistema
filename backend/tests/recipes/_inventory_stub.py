"""Implementación mínima y fiel del contrato de `app.inventory` (la firma de
`app/inventory/hooks.py` y los enums de `app/inventory/models.py` que la
misión publica al pie de la letra) para poder probar `app.recipes` de forma
aislada mientras `backend-inventario` no haya construido el dominio real.

Sólo se activa desde `conftest.py`, y sólo si `app.inventory` **no** es
importable todavía — en cuanto exista de verdad, estos tests corren contra el
dominio real sin tocar una línea acá ni en `app/recipes/**`. Este archivo no
es parte de la entrega de `app/recipes`: es un doble de prueba, vive en
`tests/recipes/**` (territorio propio) y nunca se importa desde `app/`.

Convención de signo asumida para `qty_base` en `record_movement` (no la fija
la misión explícitamente): **delta firmado** — positivo suma stock, negativo
resta. Es la más simple y la más consistente con `qty_delta` de
`POST /admin/inventory/adjustments` en el contrato de la API; `app/recipes`
la respeta en todos sus llamados (`produce()` resta insumos con signo
negativo y suma el lote con signo positivo). Si el dominio real de
`backend-inventario` elige otra convención, es un ajuste en los *callers* de
`app/recipes` (dentro de mi propio territorio), no en este contrato.
"""

from __future__ import annotations

import enum
from datetime import date, datetime
from typing import Any

from sqlalchemy import BigInteger, Boolean, Date, ForeignKey, Integer, String, Text, func, select
from sqlalchemy import Enum as SAEnum
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.orm import Session as OrmSession

from app.core.db import Base, UTCDateTime


class MovementCause(str, enum.Enum):
    SALE = "sale"
    PRODUCTION_IN = "production_in"
    PRODUCTION_OUT = "production_out"
    WASTE = "waste"
    NOTE_RETURN = "note_return"
    MANUAL_ADJUSTMENT = "manual_adjustment"
    PURCHASE = "purchase"
    COUNT_ADJUSTMENT = "count_adjustment"
    # Faltaba: el stub declaraba diez causas y el enum real tiene once. No
    # rompía nada todavía porque ningún test compara los dos por igualdad —
    # es el mismo espejo sin invariante que en este pedido se rompió cuatro
    # veces (H-0, H-8, H-11 y el par de invariantes contradictorios del
    # cliente), esperando al pedido que lo pise.
    RECEPTION_REVERSAL = "reception_reversal"
    TRANSFER_IN = "transfer_in"
    TRANSFER_OUT = "transfer_out"


class CostSource(str, enum.Enum):
    OFFICIAL = "official"
    WEIGHTED_AVERAGE = "weighted_average"
    LAST_PURCHASE = "last_purchase"
    ESTIMATED = "estimated"
    NONE = "none"


class Ingredient(Base):
    __tablename__ = "ingredients"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    organization_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), index=True)
    store_id: Mapped[int] = mapped_column(ForeignKey("stores.id"), index=True)
    name: Mapped[str] = mapped_column(String(200))
    category: Mapped[str] = mapped_column(String(100))
    base_unit: Mapped[str] = mapped_column(String(8))
    purchase_unit: Mapped[str] = mapped_column(String(20))
    purchase_factor: Mapped[int] = mapped_column(Integer, default=1)
    yield_pct: Mapped[int] = mapped_column(Integer, default=100)
    official_cost_micros: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    estimated_cost_micros: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    min_stock: Mapped[int] = mapped_column(BigInteger)
    lead_time_days: Mapped[int | None] = mapped_column(Integer, nullable=True)
    perishable: Mapped[bool] = mapped_column(Boolean, default=False)
    key_item: Mapped[bool] = mapped_column(Boolean, default=False)
    consumption_untracked: Mapped[bool] = mapped_column(Boolean, default=False)
    substitute_ingredient_id: Mapped[int | None] = mapped_column(ForeignKey("ingredients.id"), nullable=True)
    supplier_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime())
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime())


class StockMovement(Base):
    __tablename__ = "stock_movements"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    organization_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), index=True)
    store_id: Mapped[int] = mapped_column(ForeignKey("stores.id"), index=True)
    ingredient_id: Mapped[int | None] = mapped_column(ForeignKey("ingredients.id"), nullable=True, index=True)
    preparation_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    qty_base: Mapped[int] = mapped_column(BigInteger)
    cause: Mapped[str] = mapped_column(String(20))
    cost_micros: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    cost_source: Mapped[str] = mapped_column(String(20))
    employee_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    employee_name: Mapped[str | None] = mapped_column(String(200), nullable=True)
    business_date: Mapped[date] = mapped_column(Date)
    at: Mapped[datetime] = mapped_column(UTCDateTime())
    ref_type: Mapped[str | None] = mapped_column(String(40), nullable=True)
    ref_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)


def record_movement(
    db: OrmSession,
    *,
    organization_id: int,
    store_id: int,
    ingredient_id: int | None = None,
    preparation_id: int | None = None,
    qty_base: int,
    cause: MovementCause,
    cost_micros: int | None,
    cost_source: CostSource,
    actor: Any,
    business_date: date,
    at: datetime,
    ref_type: str | None = None,
    ref_id: int | None = None,
    note: str | None = None,
) -> StockMovement:
    row = StockMovement(
        organization_id=organization_id,
        store_id=store_id,
        ingredient_id=ingredient_id,
        preparation_id=preparation_id,
        qty_base=qty_base,
        cause=cause.value if isinstance(cause, MovementCause) else str(cause),
        cost_micros=cost_micros,
        cost_source=cost_source.value if isinstance(cost_source, CostSource) else str(cost_source),
        employee_id=getattr(actor, "employee_id", None),
        employee_name=getattr(actor, "employee_name", None),
        business_date=business_date,
        at=at,
        ref_type=ref_type,
        ref_id=ref_id,
        note=note,
    )
    db.add(row)
    db.flush()
    return row


def resolve_ingredient_cost(db: OrmSession, ingredient: Ingredient) -> tuple[int | None, CostSource]:
    if ingredient.official_cost_micros is not None:
        return ingredient.official_cost_micros, CostSource.OFFICIAL
    if ingredient.estimated_cost_micros is not None:
        return ingredient.estimated_cost_micros, CostSource.ESTIMATED
    return None, CostSource.NONE


def current_stock(
    db: OrmSession, *, store_id: int, ingredient_id: int | None = None, preparation_id: int | None = None
) -> int:
    stmt = select(func.coalesce(func.sum(StockMovement.qty_base), 0)).where(StockMovement.store_id == store_id)
    if ingredient_id is not None:
        stmt = stmt.where(StockMovement.ingredient_id == ingredient_id)
    if preparation_id is not None:
        stmt = stmt.where(StockMovement.preparation_id == preparation_id)
    return int(db.execute(stmt).scalar_one())


def get_ingredient(db: OrmSession, *, store_id: int, ingredient_id: int) -> Ingredient | None:
    ingredient = db.get(Ingredient, ingredient_id)
    if ingredient is None or ingredient.store_id != store_id:
        return None
    return ingredient


def resolve_consumption_target(
    db: OrmSession, ingredient: Ingredient, qty_base: int
) -> list[tuple[Ingredient, int]]:
    """Espejo simplificado del contrato real de `backend-inventario`: toma
    de cada insumo hasta su stock disponible antes de caer al sustituto."""
    if qty_base <= 0:
        return []
    chain: list[tuple[Ingredient, int]] = []
    current: Ingredient | None = ingredient
    remaining = qty_base
    visited: set[int] = set()
    while current is not None and current.id not in visited and remaining > 0:
        visited.add(current.id)
        if current.substitute_ingredient_id is None:
            chain.append((current, remaining))
            remaining = 0
            break
        available = current_stock(db, store_id=current.store_id, ingredient_id=current.id)
        take = max(0, min(remaining, available))
        if take > 0:
            chain.append((current, take))
            remaining -= take
        if remaining <= 0:
            break
        current = get_ingredient(db, store_id=current.store_id, ingredient_id=current.substitute_ingredient_id)
    if remaining > 0:
        if chain:
            last_ingredient, last_qty = chain[-1]
            chain[-1] = (last_ingredient, last_qty + remaining)
        else:
            chain.append((ingredient, remaining))
    return chain
