"""Fichas técnicas, preparaciones y `recipe_effect` de modificadores
(`docs/SPEC-NEGOCIO.md §4.2` y `§4.3`, pedido 2a).

Convenciones heredadas de 1a/1b (`AGENTS.md`, `docs/ESTADO.md`):
- Toda tabla lleva `organization_id`/`store_id` propios, indexados.
- `app.core.db.UTCDateTime` en todo `Mapped[datetime]`; enums `native_enum=False`.
- Baja lógica siempre (`active`); nada se borra físicamente.
- Atribución con FK real (`*_employee_id`) + nombre congelado.
- Cantidades y costos en enteros: `qty_base` en milésimas de la unidad base
  del componente (`QTY_SCALE` de `app.core.quantity`), `cost_micros` en
  millonésimas de peso por unidad base entera (`COST_SCALE`). `BigInteger`
  porque un costo en micros de una preparación cara cruza fácil los ~2.1e9 que
  entran en un `Integer` de 4 bytes (Postgres) — un detalle que la spec no
  menciona pero que revienta en producción si se usa `Integer` a secas.

Dos FK "cruzadas" a un dominio hermano que esta fase construye en paralelo
(`app.inventory`, migración `0008`, `backend-inventario`): `ingredients.id`
(insumo) y, en `modifier_option_recipe_effects`, `modifier_options.id` (carta,
territorio de nadie en este pedido — ver `docs/ESTADO.md`). Son FK reales
("hacelo bien de una", como pide la misión: nada de `Integer` pelado tipo
`fiscal_range_id` en 1b-2) porque la migración `0009` de este dominio declara
`down_revision = "0008"`: para cuando esta migración corre, `ingredients` ya
existe.
"""

from __future__ import annotations

import enum
from datetime import date, datetime
from typing import Any

import sqlalchemy as sa
from sqlalchemy import CheckConstraint, ForeignKey, Index, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base, UTCDateTime

ENUM_LENGTH = 20


def _enum(pyenum: type[enum.Enum], *, length: int = ENUM_LENGTH) -> sa.Enum:
    return sa.Enum(pyenum, native_enum=False, length=length, validate_strings=True)


class PrepMode(str, enum.Enum):
    """Dos modos EXCLUYENTES (§4.2). `EXPLODED` es el default: obligar al modo
    lote para todo mata el módulo (si nadie registra el caldo de cada mañana,
    la preparación queda negativa y "el dueño sale a buscar un ladrón")."""

    BATCH = "batch"
    EXPLODED = "exploded"


class RecipeEffectType(str, enum.Enum):
    ADD = "add"
    REMOVE = "remove"
    REPLACE = "replace"


BASE_UNIT_VALUES = ("g", "ml", "unit")


# ---------------------------------------------------------------------------
# Preparaciones (§4.2)
# ---------------------------------------------------------------------------


class Preparation(Base):
    """La salsa, el caldo, la masa. `standard_yield_qty` está en milésimas de
    `standard_yield_unit` (misma convención que cualquier `qty_base`): "esta
    receta rinde X" en la unidad en la que la preparación se cuenta y se
    consume. No versiona (a diferencia de `Recipe`): un `PrepBatch` congela su
    propio costo real al producir, así que cambiar las líneas de la
    preparación hoy no revalora un lote ya producido — no hace falta guardar
    una `PreparationVersion` separada para eso."""

    __tablename__ = "preparations"

    id: Mapped[int] = mapped_column(primary_key=True)
    organization_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), index=True)
    store_id: Mapped[int] = mapped_column(ForeignKey("stores.id"), index=True)

    name: Mapped[str] = mapped_column(sa.String(200))
    mode: Mapped[PrepMode] = mapped_column(_enum(PrepMode), default=PrepMode.EXPLODED)

    standard_yield_qty: Mapped[int] = mapped_column(sa.BigInteger)
    standard_yield_unit: Mapped[str] = mapped_column(sa.String(8))
    process_loss_pct: Mapped[int] = mapped_column(sa.Integer, default=0)
    shelf_life_days: Mapped[int | None] = mapped_column(sa.Integer, nullable=True)

    active: Mapped[bool] = mapped_column(sa.Boolean, default=True)

    created_at: Mapped[datetime] = mapped_column(UTCDateTime())
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime())

    __table_args__ = (
        CheckConstraint("standard_yield_qty > 0", name="ck_preparations_yield_qty_positive"),
        CheckConstraint(
            "standard_yield_unit in ('g','ml','unit')", name="ck_preparations_yield_unit_valid"
        ),
        CheckConstraint(
            "process_loss_pct >= 0 AND process_loss_pct <= 100",
            name="ck_preparations_process_loss_pct_range",
        ),
        Index("ix_preparations_store_active", "store_id", "active"),
    )


class PreparationLine(Base):
    """Línea de la receta propia de una preparación: insumo **o** otra
    preparación (nunca los dos, nunca ninguno). `preparation_id` es la
    preparación DUEÑA de la línea; `component_preparation_id` es la
    preparación que se consume como insumo (evita la colisión de nombre que
    habría hecho ambiguo el mismo campo para "dueño" y "componente")."""

    __tablename__ = "preparation_lines"

    id: Mapped[int] = mapped_column(primary_key=True)
    preparation_id: Mapped[int] = mapped_column(ForeignKey("preparations.id"), index=True)
    ingredient_id: Mapped[int | None] = mapped_column(
        ForeignKey("ingredients.id"), nullable=True, index=True
    )
    component_preparation_id: Mapped[int | None] = mapped_column(
        ForeignKey("preparations.id"), nullable=True, index=True
    )
    qty_base: Mapped[int] = mapped_column(sa.BigInteger)
    unit: Mapped[str] = mapped_column(sa.String(8))

    __table_args__ = (
        CheckConstraint(
            "(ingredient_id IS NOT NULL AND component_preparation_id IS NULL) OR "
            "(ingredient_id IS NULL AND component_preparation_id IS NOT NULL)",
            name="ck_preparation_lines_exactly_one_component",
        ),
        CheckConstraint("qty_base > 0", name="ck_preparation_lines_qty_positive"),
    )


class PrepBatch(Base):
    """Un lote producido en modo `batch` (§4.2): `production_out` de sus
    insumos + `production_in` del lote, los dos vía `record_movement` (única
    escritura de inventario). El stock de la preparación en 2a es agregado
    (`current_stock(preparation_id=...)`, suma de movimientos) — no hay FIFO
    por lote todavía: eso es `inventory.lots`/§5.7, alcance de 2b. "Cerrar los
    lotes abiertos" al cambiar de modo (§4.2) es, acá, marcar con
    `closed_at`/`closed_by_*` los lotes de esta preparación que no estén ya
    cerrados y emitir un único `count_adjustment` que lleva el stock agregado
    de la preparación a cero."""

    __tablename__ = "prep_batches"

    id: Mapped[int] = mapped_column(primary_key=True)
    organization_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), index=True)
    store_id: Mapped[int] = mapped_column(ForeignKey("stores.id"), index=True)
    preparation_id: Mapped[int] = mapped_column(ForeignKey("preparations.id"), index=True)

    qty_expected: Mapped[int] = mapped_column(sa.BigInteger)
    qty_real: Mapped[int] = mapped_column(sa.BigInteger)
    unit: Mapped[str] = mapped_column(sa.String(8))
    # |real - expected| / expected, en centésimas de punto porcentual (15.00% = 1500).
    variance_pct_x100: Mapped[int] = mapped_column(sa.Integer)
    variance_alert: Mapped[bool] = mapped_column(sa.Boolean, default=False)

    total_cost_micros: Mapped[int | None] = mapped_column(sa.BigInteger, nullable=True)
    unit_cost_micros: Mapped[int | None] = mapped_column(sa.BigInteger, nullable=True)
    cost_source: Mapped[str] = mapped_column(sa.String(20))

    expiry_date: Mapped[date | None] = mapped_column(sa.Date, nullable=True)

    produced_by_employee_id: Mapped[int] = mapped_column(ForeignKey("employees.id"))
    produced_by_employee_name: Mapped[str] = mapped_column(sa.String(200))
    produced_at: Mapped[datetime] = mapped_column(UTCDateTime())
    business_date: Mapped[date] = mapped_column(sa.Date)
    note: Mapped[str | None] = mapped_column(sa.Text, nullable=True)

    closed_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    closed_by_employee_id: Mapped[int | None] = mapped_column(ForeignKey("employees.id"), nullable=True)
    closed_by_employee_name: Mapped[str | None] = mapped_column(sa.String(200), nullable=True)
    closed_reason: Mapped[str | None] = mapped_column(sa.String(200), nullable=True)

    __table_args__ = (
        CheckConstraint("qty_expected > 0", name="ck_prep_batches_qty_expected_positive"),
        CheckConstraint("qty_real >= 0", name="ck_prep_batches_qty_real_nonneg"),
        Index("ix_prep_batches_prep_produced", "preparation_id", "produced_at"),
    )


# ---------------------------------------------------------------------------
# Fichas técnicas de los platos (§4.3) — versionadas.
# ---------------------------------------------------------------------------


class Recipe(Base):
    """Una por producto (único por sede+producto). `current_version = 0`
    significa "sin ficha guardada todavía" (cobertura: el producto no
    descuenta nada). "Productos sin receta, como una gaseosa, consumen un
    insumo uno a uno" (§4.3) no es un camino especial: es una ficha normal de
    **una sola línea** (`qty=1` en la unidad base del insumo), guardada por
    el mismo `PUT /admin/products/{id}/recipe` — el contrato de la API no
    declara una ruta ni un campo aparte para "insumo directo", así que no
    hace falta un segundo modelo de datos para lo mismo."""

    __tablename__ = "recipes"

    id: Mapped[int] = mapped_column(primary_key=True)
    organization_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), index=True)
    store_id: Mapped[int] = mapped_column(ForeignKey("stores.id"), index=True)
    product_id: Mapped[int] = mapped_column(ForeignKey("products.id"), index=True, unique=True)
    current_version: Mapped[int] = mapped_column(sa.Integer, default=0)

    created_at: Mapped[datetime] = mapped_column(UTCDateTime())
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime())


class RecipeVersion(Base):
    """Una fila por versión guardada; **nunca se borra ni se pisa** (regla
    dura del snapshot): `OrderItem.recipe_version` de 1b apunta al número de
    versión, y esta tabla es lo que hace que ese número siga resolviendo a
    algo después de guardar una versión nueva."""

    __tablename__ = "recipe_versions"

    id: Mapped[int] = mapped_column(primary_key=True)
    recipe_id: Mapped[int] = mapped_column(ForeignKey("recipes.id"), index=True)
    version: Mapped[int] = mapped_column(sa.Integer)

    created_at: Mapped[datetime] = mapped_column(UTCDateTime())
    created_by_employee_id: Mapped[int | None] = mapped_column(ForeignKey("employees.id"), nullable=True)
    created_by_employee_name: Mapped[str | None] = mapped_column(sa.String(200), nullable=True)

    __table_args__ = (UniqueConstraint("recipe_id", "version", name="uq_recipe_versions_recipe_version"),)


class RecipeLine(Base):
    """Línea de una versión de ficha: insumo **o** preparación, cantidad y
    unidad. El costo NO se guarda acá (se calcula al vuelo, ver `cost.py`):
    lo único que se congela para siempre es lo que compra `RecipeVersion`
    (qué componentes y cuánto), no el costo — el costo del plato *propaga*
    cuando cambia el costo de un insumo, y eso sólo tiene sentido si se
    recalcula, nunca si se guarda fijo en la línea."""

    __tablename__ = "recipe_lines"

    id: Mapped[int] = mapped_column(primary_key=True)
    recipe_version_id: Mapped[int] = mapped_column(ForeignKey("recipe_versions.id"), index=True)
    ingredient_id: Mapped[int | None] = mapped_column(
        ForeignKey("ingredients.id"), nullable=True, index=True
    )
    preparation_id: Mapped[int | None] = mapped_column(
        ForeignKey("preparations.id"), nullable=True, index=True
    )
    qty_base: Mapped[int] = mapped_column(sa.BigInteger)
    unit: Mapped[str] = mapped_column(sa.String(8))

    __table_args__ = (
        CheckConstraint(
            "(ingredient_id IS NOT NULL AND preparation_id IS NULL) OR "
            "(ingredient_id IS NULL AND preparation_id IS NOT NULL)",
            name="ck_recipe_lines_exactly_one_component",
        ),
        CheckConstraint("qty_base > 0", name="ck_recipe_lines_qty_positive"),
    )


# ---------------------------------------------------------------------------
# `recipe_effect` de las opciones de modificador (§4.3) — tabla propia de
# este dominio: `app/catalog/**` es de sólo lectura para este pedido, así que
# el efecto no vive en la columna JSON `ModifierOption.recipe_effect` (que
# queda `NULL` para siempre, territorio ajeno) sino acá, con FK real a
# `modifier_options.id`.
# ---------------------------------------------------------------------------


class ModifierOptionRecipeEffect(Base):
    """Una por opción (a lo sumo una configuración de efecto por opción)."""

    __tablename__ = "modifier_option_recipe_effects"

    id: Mapped[int] = mapped_column(primary_key=True)
    organization_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), index=True)
    store_id: Mapped[int] = mapped_column(ForeignKey("stores.id"), index=True)
    modifier_option_id: Mapped[int] = mapped_column(
        ForeignKey("modifier_options.id"), index=True, unique=True
    )
    effect: Mapped[RecipeEffectType] = mapped_column(_enum(RecipeEffectType))

    created_at: Mapped[datetime] = mapped_column(UTCDateTime())
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime())


class ModifierOptionRecipeEffectLine(Base):
    """Línea del efecto. `replaces_ingredient_id`/`replaces_preparation_id`
    sólo se usan con `effect = replace` (decisión de esquema documentada en
    `cost.py`/el entregable: sin un "qué reemplaza" explícito, `replace` sería
    indistinguible de `add`) — con `add`/`remove` quedan `NULL`."""

    __tablename__ = "modifier_option_recipe_effect_lines"

    id: Mapped[int] = mapped_column(primary_key=True)
    effect_id: Mapped[int] = mapped_column(ForeignKey("modifier_option_recipe_effects.id"), index=True)
    ingredient_id: Mapped[int | None] = mapped_column(
        ForeignKey("ingredients.id"), nullable=True, index=True
    )
    preparation_id: Mapped[int | None] = mapped_column(
        ForeignKey("preparations.id"), nullable=True, index=True
    )
    qty_base: Mapped[int] = mapped_column(sa.BigInteger)
    unit: Mapped[str] = mapped_column(sa.String(8))

    replaces_ingredient_id: Mapped[int | None] = mapped_column(
        ForeignKey("ingredients.id"), nullable=True, index=True
    )
    replaces_preparation_id: Mapped[int | None] = mapped_column(
        ForeignKey("preparations.id"), nullable=True, index=True
    )

    __table_args__ = (
        CheckConstraint(
            "(ingredient_id IS NOT NULL AND preparation_id IS NULL) OR "
            "(ingredient_id IS NULL AND preparation_id IS NOT NULL)",
            name="ck_modifier_effect_lines_exactly_one_component",
        ),
        CheckConstraint("qty_base > 0", name="ck_modifier_effect_lines_qty_positive"),
        CheckConstraint(
            "NOT (replaces_ingredient_id IS NOT NULL AND replaces_preparation_id IS NOT NULL)",
            name="ck_modifier_effect_lines_replaces_at_most_one",
        ),
    )


ModelClasses: tuple[type[Any], ...] = (
    Preparation,
    PreparationLine,
    PrepBatch,
    Recipe,
    RecipeVersion,
    RecipeLine,
    ModifierOptionRecipeEffect,
    ModifierOptionRecipeEffectLine,
)
