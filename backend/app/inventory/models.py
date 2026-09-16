"""Insumos y el libro único de movimientos de inventario (SPEC-NEGOCIO
§4.1, §5.1, §5.2, §5.5; `features/fase-2-costo-inventario/spec.md`).

Convenciones heredadas (`docs/ESTADO.md`, `AGENTS.md`):
- `app.core.db.UTCDateTime` en todo `Mapped[datetime]`.
- Cantidades en `Integer`, en milésimas de la unidad base del insumo
  (`app.core.quantity.QTY_SCALE`); costos en `Integer`, en millonésimas de
  peso por unidad base entera (`app.core.quantity.COST_SCALE`). Nunca
  `float`, nunca `Decimal` persistido.
- Enums `native_enum=False`, comparados por valor.
- Todo modelo lleva `organization_id` y `store_id` (indexados).
- Nada se borra físicamente: `Ingredient.active` es baja lógica; los
  movimientos y las mermas son un libro append-only — no hay `active` ni
  `deleted_at` en ellos porque nunca se edita ni se borra una fila ya
  escrita, sólo se la revierte con un movimiento espejo (nota "vuelve") o se
  la corrige con un ajuste manual nuevo.
- `StockMovement.preparation_id` es `Integer` **sin FK dura**: `preparations`
  es tabla del dominio `recipes` (territorio de otro agente en este mismo
  pedido 2a) que puede no existir todavía cuando esta migración corre — el
  mismo patrón que `supplier_id` acá abajo y que `fiscal_range_id` usó antes
  de tener FK real en 1b-2 (`0007_fiscal_ranges_notes.py`, docstring). Cuando
  `app.recipes.models.Preparation` exista y esté en `MODEL_MODULES`, una
  migración de una línea la convierte en FK real.
"""

from __future__ import annotations

import enum
from datetime import date, datetime

import sqlalchemy as sa
from sqlalchemy import CheckConstraint, ForeignKey, Index
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base, UTCDateTime

ENUM_LENGTH = 32


def _enum(pyenum: type[enum.Enum], *, length: int = ENUM_LENGTH) -> sa.Enum:
    return sa.Enum(pyenum, native_enum=False, length=length, validate_strings=True)


# ---------------------------------------------------------------------------
# Enums publicados (contrato del equipo de 2a; no se renombran valores).
# ---------------------------------------------------------------------------


class BaseUnit(str, enum.Enum):
    G = "g"
    ML = "ml"
    UNIT = "unit"


class MovementCause(str, enum.Enum):
    """Causa tipada de un movimiento de inventario (SPEC-NEGOCIO §5.1). Se
    pasa siempre como este enum, **nunca se infiere de un texto** (en la
    referencia un motivo escrito distinto se leyó como fuga de $1.126.398)."""

    SALE = "sale"
    PRODUCTION_IN = "production_in"
    PRODUCTION_OUT = "production_out"
    VOID_AFTER_SEND = "void_after_send"
    WASTE = "waste"
    NOTE_RETURN = "note_return"
    MANUAL_ADJUSTMENT = "manual_adjustment"
    # Declaradas para que 2b no toque el enum; sin uso en 2a (compras,
    # conteos, traslados — no hay compras ni conteos todavía).
    PURCHASE = "purchase"
    COUNT_ADJUSTMENT = "count_adjustment"
    TRANSFER_IN = "transfer_in"
    TRANSFER_OUT = "transfer_out"


class CostSource(str, enum.Enum):
    """Origen del costo (SPEC-NEGOCIO §4.1). Sin costo es `cost_micros=None`
    con `cost_source=NONE` — nunca un cero mudo."""

    OFFICIAL = "official"
    # Declarados para que 2b no toque el enum; en 2a `resolve_ingredient_cost`
    # nunca los devuelve (no hay compras todavía para alimentarlos).
    WEIGHTED_AVERAGE = "weighted_average"
    LAST_PURCHASE = "last_purchase"
    ESTIMATED = "estimated"
    NONE = "none"


class WasteType(str, enum.Enum):
    """SPEC-NEGOCIO §5.5. **No existe `staff_meal`** acá: el consumo de
    personal es un canal de comanda (`OrderChannel.STAFF_MEAL` en
    `app.orders.models`, territorio ajeno) y descuenta inventario igual que
    una venta, nunca como merma."""

    EXPIRED = "expired"
    OVERPRODUCTION = "overproduction"
    KITCHEN_ERROR = "kitchen_error"
    BREAKAGE = "breakage"
    CUSTOMER_RETURN = "customer_return"
    TASTING = "tasting"
    COURTESY_NO_DISH = "courtesy_no_dish"
    UNIDENTIFIED = "unidentified"


# ---------------------------------------------------------------------------
# Insumos.
# ---------------------------------------------------------------------------


class Ingredient(Base):
    """Lo que se compra (SPEC-NEGOCIO §4.1). Por organización y sede, con
    baja lógica (`active`); nada de inventario se borra físicamente."""

    __tablename__ = "ingredients"

    id: Mapped[int] = mapped_column(primary_key=True)
    organization_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), index=True)
    store_id: Mapped[int] = mapped_column(ForeignKey("stores.id"), index=True)

    name: Mapped[str] = mapped_column(sa.String(200))
    category: Mapped[str | None] = mapped_column(sa.String(100), nullable=True)

    # Unidad de uso (la que ve la receta) y unidad de compra, con el factor
    # determinístico entre ambas (cuántas unidades BASE entran en UNA unidad
    # de compra: "1 caja x 24 unidades" -> purchase_factor=24 si base=unit;
    # "1 kg" -> purchase_factor=1000 si base=g). La conversión al recibir es
    # de `purchases` (2b); acá sólo se declara el factor.
    base_unit: Mapped[BaseUnit] = mapped_column(_enum(BaseUnit, length=8))
    purchase_unit: Mapped[str] = mapped_column(sa.String(50))
    purchase_factor: Mapped[int] = mapped_column(sa.Integer)

    # Rendimiento (SPEC-NEGOCIO §4.1): la receta expresa cantidad limpia; el
    # consumo teórico descuenta `apply_yield(qty, yield_pct)`
    # (`app.core.quantity`). 100 = sin merma de limpieza.
    yield_pct: Mapped[int] = mapped_column(sa.Integer, default=100)

    # Costo: oficial (lo fija el dueño) > estimado > sin costo, en 2a
    # (`resolve_ingredient_cost`, `app.inventory.hooks`). Millonésimas de
    # peso por unidad base ENTERA (`app.core.quantity.COST_SCALE`). `null` es
    # "sin costo todavía", nunca `0`.
    official_cost_micros: Mapped[int | None] = mapped_column(sa.BigInteger, nullable=True)
    estimated_cost_micros: Mapped[int | None] = mapped_column(sa.BigInteger, nullable=True)

    # Umbral de stock mínimo: OBLIGATORIO y > 0 (`400 MIN_STOCK_REQUIRED`
    # si no; en la referencia, 55 de 56 productos quedaron con el motor de
    # alertas apagado por no exigirlo). En milésimas de la unidad base, igual
    # escala que los movimientos.
    min_stock: Mapped[int] = mapped_column(sa.Integer)
    lead_time_days: Mapped[int | None] = mapped_column(sa.Integer, nullable=True)

    perishable: Mapped[bool] = mapped_column(sa.Boolean, default=False)
    key_item: Mapped[bool] = mapped_column(sa.Boolean, default=False)  # entra al conteo rápido (2b)
    active: Mapped[bool] = mapped_column(sa.Boolean, default=True)

    # Consumo no predecible (servilletas, sal, aceite de fritura): sin
    # receta, se mide entre dos conteos (2b). En 2a sólo se declara la
    # bandera; ningún consumo automático lo toca todavía.
    consumption_untracked: Mapped[bool] = mapped_column(sa.Boolean, default=False)

    # Sustituto opcional con un solo camino de consumo y cascada
    # (`app.inventory.hooks.resolve_consumption_target`): venta, cortesía,
    # staff_meal y producción llaman TODOS esa misma función, nunca cada uno
    # decide por su cuenta (en la referencia, dos caminos independientes
    # dejaron la leche entera en -4 y la deslactosada en +19).
    substitute_ingredient_id: Mapped[int | None] = mapped_column(
        ForeignKey("ingredients.id"), nullable=True
    )

    # `suppliers` es tabla de 2b y todavía no existe: `Integer` sin FK dura,
    # a propósito (mismo patrón que `fiscal_range_id` antes de 1b-2). Cuando
    # 2b cree `suppliers`, una migración de una línea agrega:
    #     supplier_id: Mapped[int | None] = mapped_column(ForeignKey("suppliers.id"), nullable=True)
    supplier_id: Mapped[int | None] = mapped_column(sa.Integer, nullable=True)

    created_at: Mapped[datetime] = mapped_column(UTCDateTime())
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime())

    __table_args__ = (
        CheckConstraint("min_stock > 0", name="ck_ingredients_min_stock_positive"),
        CheckConstraint("purchase_factor > 0", name="ck_ingredients_purchase_factor_positive"),
        CheckConstraint(
            "yield_pct >= 1 AND yield_pct <= 100", name="ck_ingredients_yield_pct_range"
        ),
        Index("ix_ingredients_store_active", "store_id", "active"),
        Index("ix_ingredients_store_key_item", "store_id", "key_item"),
    )


# ---------------------------------------------------------------------------
# El libro único de movimientos.
# ---------------------------------------------------------------------------


class StockMovement(Base):
    """Un movimiento del libro perpetuo teórico (SPEC-NEGOCIO §5.1). **La
    única función que escribe acá es `app.inventory.hooks.record_movement`**
    — ni siquiera este mismo dominio hace `db.add(StockMovement(...))` en
    otro lugar. `qty_base` lleva signo: negativo = salida, positivo =
    entrada. Insumo **o** preparación, exactamente uno."""

    __tablename__ = "stock_movements"

    id: Mapped[int] = mapped_column(primary_key=True)
    organization_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), index=True)
    store_id: Mapped[int] = mapped_column(ForeignKey("stores.id"), index=True)

    ingredient_id: Mapped[int | None] = mapped_column(
        ForeignKey("ingredients.id"), nullable=True, index=True
    )
    # Sin FK dura: ver docstring del módulo.
    preparation_id: Mapped[int | None] = mapped_column(sa.Integer, nullable=True, index=True)

    qty_base: Mapped[int] = mapped_column(sa.Integer)
    cause: Mapped[MovementCause] = mapped_column(_enum(MovementCause))

    cost_micros: Mapped[int | None] = mapped_column(sa.BigInteger, nullable=True)
    cost_source: Mapped[CostSource] = mapped_column(_enum(CostSource, length=20))

    employee_id: Mapped[int] = mapped_column(ForeignKey("employees.id"))
    employee_name: Mapped[str] = mapped_column(sa.String(200))

    at: Mapped[datetime] = mapped_column(UTCDateTime())
    # Fecha operativa de negocio (`app.core.tz.business_date_for`), en
    # columna propia -- nunca derivada de `at` en una consulta.
    business_date: Mapped[date] = mapped_column(sa.Date)

    ref_type: Mapped[str | None] = mapped_column(sa.String(40), nullable=True)
    ref_id: Mapped[int | None] = mapped_column(sa.Integer, nullable=True)
    note: Mapped[str | None] = mapped_column(sa.Text, nullable=True)

    __table_args__ = (
        CheckConstraint(
            "(ingredient_id IS NOT NULL AND preparation_id IS NULL) "
            "OR (ingredient_id IS NULL AND preparation_id IS NOT NULL)",
            name="ck_stock_movements_target_exactly_one",
        ),
        CheckConstraint("qty_base != 0", name="ck_stock_movements_qty_base_nonzero"),
        CheckConstraint(
            "(cost_micros IS NULL AND cost_source = 'NONE') "
            "OR (cost_micros IS NOT NULL AND cost_source != 'NONE')",
            name="ck_stock_movements_cost_source_consistent",
        ),
        Index("ix_stock_movements_store_ingredient_at", "store_id", "ingredient_id", "at"),
        Index("ix_stock_movements_store_prep_at", "store_id", "preparation_id", "at"),
        Index("ix_stock_movements_store_date_cause", "store_id", "business_date", "cause"),
        Index("ix_stock_movements_ref", "ref_type", "ref_id"),
    )


# ---------------------------------------------------------------------------
# Mermas.
# ---------------------------------------------------------------------------


class Waste(Base):
    """Una merma (SPEC-NEGOCIO §5.5): siempre genera exactamente un
    `StockMovement` (`cause=WASTE`, `ref_type="waste"`, `ref_id=Waste.id`),
    escrito por `app.inventory.hooks.record_movement` desde
    `app.inventory.service.register_waste` — nunca a mano."""

    __tablename__ = "wastes"

    id: Mapped[int] = mapped_column(primary_key=True)
    organization_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), index=True)
    store_id: Mapped[int] = mapped_column(ForeignKey("stores.id"), index=True)

    type: Mapped[WasteType] = mapped_column(_enum(WasteType, length=20))

    ingredient_id: Mapped[int | None] = mapped_column(
        ForeignKey("ingredients.id"), nullable=True, index=True
    )
    # Sin FK dura: ver docstring del módulo.
    preparation_id: Mapped[int | None] = mapped_column(sa.Integer, nullable=True, index=True)

    qty_base: Mapped[int] = mapped_column(sa.Integer)  # siempre positivo (cantidad perdida)
    cost_micros: Mapped[int | None] = mapped_column(sa.BigInteger, nullable=True)
    cost_source: Mapped[CostSource] = mapped_column(_enum(CostSource, length=20))

    # Responsable con PIN (SPEC-NEGOCIO §5.5): FK real + nombre congelado,
    # igual que cualquier atribución del proyecto. Puede ser distinto de
    # quien registra la merma en el dispositivo (un cocinero puede reportar
    # la merma de otro turno con su propio PIN).
    employee_id: Mapped[int] = mapped_column(ForeignKey("employees.id"))
    employee_name: Mapped[str] = mapped_column(sa.String(200))

    note: Mapped[str | None] = mapped_column(sa.Text, nullable=True)
    photo_url: Mapped[str | None] = mapped_column(sa.String(500), nullable=True)

    at: Mapped[datetime] = mapped_column(UTCDateTime())
    business_date: Mapped[date] = mapped_column(sa.Date)

    stock_movement_id: Mapped[int | None] = mapped_column(
        ForeignKey("stock_movements.id"), nullable=True
    )

    __table_args__ = (
        CheckConstraint(
            "(ingredient_id IS NOT NULL AND preparation_id IS NULL) "
            "OR (ingredient_id IS NULL AND preparation_id IS NOT NULL)",
            name="ck_wastes_target_exactly_one",
        ),
        CheckConstraint("qty_base > 0", name="ck_wastes_qty_base_positive"),
        CheckConstraint(
            "(cost_micros IS NULL AND cost_source = 'NONE') "
            "OR (cost_micros IS NOT NULL AND cost_source != 'NONE')",
            name="ck_wastes_cost_source_consistent",
        ),
        Index("ix_wastes_store_date_type", "store_id", "business_date", "type"),
        Index("ix_wastes_store_ingredient_date", "store_id", "ingredient_id", "business_date"),
    )
