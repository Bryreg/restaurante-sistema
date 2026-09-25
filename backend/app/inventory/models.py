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
    # `VOID_AFTER_SEND` existió declarada en la ronda 1 de 2b y se SACÓ en la
    # ronda 2 (decisión del Maestro sobre el hallazgo H-3): el razonamiento de
    # no producirla es correcto (`app/orders/service.py::_resolve_waste_stub`
    # — producirla exigiría un par alta+baja cuya mitad negativa dispararía
    # una segunda depleción FEFO real sobre cantidad ya consumida), pero un
    # enum no puede seguir declarando una causa que nadie escribe nunca: eso
    # deja al lector del contrato suponiendo mermas por anulación agrupables
    # por causa que no existen. Si `app.orders` alguna vez necesita
    # producirla de verdad, se reintroduce junto con quien la escriba.
    WASTE = "waste"
    NOTE_RETURN = "note_return"
    MANUAL_ADJUSTMENT = "manual_adjustment"
    # `PURCHASE` y `COUNT_ADJUSTMENT` ya estaban declaradas desde 2a (sin uso
    # hasta ahora); 2b las produce de verdad (recepciones y aplicar un
    # conteo) y agrega `RECEPTION_REVERSAL` (§5.6: eliminar una recepción es
    # una reversa con causa, nunca un `DELETE` de filas — "nada financiero se
    # borra"). `TRANSFER_IN`/`TRANSFER_OUT` siguen sin uso: no hay traslados
    # entre sedes todavía (fase 3).
    PURCHASE = "purchase"
    COUNT_ADJUSTMENT = "count_adjustment"
    RECEPTION_REVERSAL = "reception_reversal"
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
    una venta, nunca como merma — la comida del personal que es un plato de
    la carta sigue siendo una comanda `staff_meal`.

    Los dos últimos (rutina del turno, 2026-09-25) NO son pérdidas: son
    salidas explicadas que se registran por la misma pantalla porque es la
    misma persona, con el mismo PIN, sacando insumo del mismo depósito.
    `EXPLAINED_WASTE_TYPES` los nombra; todo reporte de pérdida (merma ÷
    compras, alerta de merma alta, salud del control, varianza) los excluye.

    - `INTERNAL_USE` («Consumo interno»): insumo que se usa sin venderse ni
      perderse — el dueño se lleva algo, una reunión. Pide QUIÉN
      (`consumer_employee_id` o `consumer_name`).
    - `TRANSFER_OUT` («Traslado a otra sede»): pide la sede destino, de la
      misma organización. Su movimiento es `MovementCause.TRANSFER_OUT`, y la
      sede destino lo recibe como `TRANSFER_IN` al mismo costo."""

    EXPIRED = "expired"
    OVERPRODUCTION = "overproduction"
    KITCHEN_ERROR = "kitchen_error"
    BREAKAGE = "breakage"
    CUSTOMER_RETURN = "customer_return"
    TASTING = "tasting"
    COURTESY_NO_DISH = "courtesy_no_dish"
    UNIDENTIFIED = "unidentified"
    INTERNAL_USE = "internal_use"
    TRANSFER_OUT = "transfer_out"


#: Salidas que no son pérdida. Ningún reporte de merma las suma.
EXPLAINED_WASTE_TYPES: frozenset[WasteType] = frozenset({WasteType.INTERNAL_USE, WasteType.TRANSFER_OUT})
#: El complemento: lo que sí se perdió.
LOSS_WASTE_TYPES: frozenset[WasteType] = frozenset(set(WasteType) - EXPLAINED_WASTE_TYPES)


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

    # Consumo interno (`type=internal_use`): QUIÉN se lo llevó. Un empleado
    # (FK real + nombre congelado en `consumer_name`) o un texto libre
    # («dueño», «reunión de socios») sólo en `consumer_name`. Obligatorio
    # para ese tipo; `None` para los demás.
    consumer_employee_id: Mapped[int | None] = mapped_column(ForeignKey("employees.id"), nullable=True)
    consumer_name: Mapped[str | None] = mapped_column(sa.String(200), nullable=True)

    # Traslado (`type=transfer_out`): la sede destino, de la MISMA
    # organización. La salida queda en ESTA sede; la entrada la escribe la
    # sede destino al recibir (`receive_transfer`), al mismo costo, sobre el
    # insumo equivalente que elige quien recibe (los insumos son por sede).
    destination_store_id: Mapped[int | None] = mapped_column(ForeignKey("stores.id"), nullable=True)
    received_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    received_business_date: Mapped[date | None] = mapped_column(sa.Date, nullable=True)
    received_ingredient_id: Mapped[int | None] = mapped_column(ForeignKey("ingredients.id"), nullable=True)
    received_movement_id: Mapped[int | None] = mapped_column(ForeignKey("stock_movements.id"), nullable=True)
    received_by_employee_id: Mapped[int | None] = mapped_column(ForeignKey("employees.id"), nullable=True)
    received_by_employee_name: Mapped[str | None] = mapped_column(sa.String(200), nullable=True)

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
        Index("ix_wastes_destination_received", "destination_store_id", "received_at"),
    )


# ---------------------------------------------------------------------------
# Lotes de compra (SPEC-NEGOCIO §5.7; pedido 2b, decisión de arquitectura #1).
#
# `StockBatch` vive ACÁ, en `inventory`, no en `purchases`: es lo que permite
# que la jerarquía de costo completa (`resolve_ingredient_cost`) quede dentro
# de un solo dominio sin importar nada de compras. Es una entidad DISTINTA de
# `app.recipes.models.PrepBatch` (el lote que produce una preparación) —
# glosario de `docs/ESTADO.md`: "lote" (`stock_batch`) es de compra,
# "preparación / lote" (`prep_batch`) es de producción.
# ---------------------------------------------------------------------------


class StockBatch(Base):
    """Un lote de compra: nace de UNA línea de una recepción confirmada
    (`app.purchases`, vía `app.inventory.hooks.create_stock_batch` — nunca
    `db.add(StockBatch(...))` fuera de ahí, mismo principio que
    `record_movement`). `qty_received` es inmutable (lo que entró);
    `qty_remaining` es lo que queda, decrementado por
    `app.inventory.hooks.consume_lots_fefo` (FEFO, §5.7) y puesto a `0` por
    `app.inventory.hooks.reverse_stock_batch` cuando se revierte la
    recepción que lo originó (nunca un `DELETE`: `reversed_at` queda como el
    rastro de que se anuló, "nada financiero se borra").

    **El promedio ponderado NO se guarda acá ni en ningún lado**: se deriva
    leyendo estas filas (`app.inventory.hooks.weighted_average_cost_micros`,
    decisión de arquitectura #2 del pedido 2b) — la misma regla que ya rige
    el saldo de una cuenta por pagar y los saldos de caja: una sola
    matemática, una sola fuente de verdad."""

    __tablename__ = "stock_batches"

    id: Mapped[int] = mapped_column(primary_key=True)
    organization_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), index=True)
    store_id: Mapped[int] = mapped_column(ForeignKey("stores.id"), index=True)
    ingredient_id: Mapped[int] = mapped_column(ForeignKey("ingredients.id"), index=True)

    qty_received: Mapped[int] = mapped_column(sa.Integer)
    qty_remaining: Mapped[int] = mapped_column(sa.Integer)

    # Costo por unidad base ENTERA (`app.core.quantity.COST_SCALE`), YA con
    # el IVA bajo INC sumado como mayor valor del costo cuando corresponda
    # (SPEC-NEGOCIO §4.1) — esa suma la hace `app.purchases` al llamar acá;
    # este módulo guarda el número que le pasan, no lo recalcula.
    unit_cost_micros: Mapped[int] = mapped_column(sa.BigInteger)
    cost_source: Mapped[CostSource] = mapped_column(_enum(CostSource, length=20))

    lot_code: Mapped[str | None] = mapped_column(sa.String(100), nullable=True)
    # `NULL` = nunca vence (SPEC-NEGOCIO §5.7): el FEFO lo ordena al final,
    # nunca al principio (`consume_lots_fefo`).
    expires_at: Mapped[date | None] = mapped_column(sa.Date, nullable=True)

    received_at: Mapped[datetime] = mapped_column(UTCDateTime())
    business_date: Mapped[date] = mapped_column(sa.Date)

    # Sin FK dura a propósito: `purchases` (recepciones) es territorio de
    # otro agente de este mismo pedido 2b y su tabla `receptions` puede no
    # existir todavía cuando esta migración corre — mismo patrón que
    # `Ingredient.supplier_id` (`app/inventory/models.py`, arriba) y que
    # `StockMovement.preparation_id` antes de que `recipes` existiera en 2a.
    # `source_type` es `"reception"` desde `app.purchases`, o `"seed"` desde
    # el seed de desarrollo de este mismo archivo.
    source_type: Mapped[str] = mapped_column(sa.String(30))
    source_id: Mapped[int] = mapped_column(sa.Integer)

    # `NULL` = vigente. Puesto por `reverse_stock_batch`; nunca por un
    # `UPDATE` a mano. Un lote reversado se excluye de FEFO, del promedio
    # ponderado, de "última compra" y de `GET /admin/lots`.
    reversed_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)

    __table_args__ = (
        CheckConstraint("qty_received > 0", name="ck_stock_batches_qty_received_positive"),
        CheckConstraint("qty_remaining >= 0", name="ck_stock_batches_qty_remaining_nonneg"),
        CheckConstraint("qty_remaining <= qty_received", name="ck_stock_batches_qty_remaining_le_received"),
        CheckConstraint("unit_cost_micros >= 0", name="ck_stock_batches_unit_cost_nonneg"),
        Index("ix_stock_batches_store_ingredient_expiry", "store_id", "ingredient_id", "expires_at"),
        Index("ix_stock_batches_store_ingredient_received", "store_id", "ingredient_id", "received_at"),
        Index("ix_stock_batches_source", "source_type", "source_id"),
    )


# ---------------------------------------------------------------------------
# Conteos a ciegas y varianza (SPEC-NEGOCIO §5.4).
# ---------------------------------------------------------------------------


class StockCountScope(str, enum.Enum):
    KEY_ITEMS = "key_items"
    FULL = "full"


class StockCountStatus(str, enum.Enum):
    OPEN = "open"
    APPLIED = "applied"


class StockCount(Base):
    """Un conteo (SPEC-NEGOCIO §5.4): `key_items` toma los insumos con
    `Ingredient.key_item = True`; `full`, todos los activos. `opened_at` es
    **el instante del conteo** (lo que la spec llama "el instante del
    conteo", distinto de cuándo se aplica): tanto `apply_count`
    (`app.inventory.service`) como la varianza miden entradas/salidas desde
    ACÁ, nunca desde `applied_at`. Mientras `status = "open"` es un conteo a
    ciegas: ninguna ruta de captura devuelve el stock teórico."""

    __tablename__ = "stock_counts"

    id: Mapped[int] = mapped_column(primary_key=True)
    organization_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), index=True)
    store_id: Mapped[int] = mapped_column(ForeignKey("stores.id"), index=True)

    scope: Mapped[StockCountScope] = mapped_column(_enum(StockCountScope, length=16))
    status: Mapped[StockCountStatus] = mapped_column(
        _enum(StockCountStatus, length=16), default=StockCountStatus.OPEN
    )

    opened_at: Mapped[datetime] = mapped_column(UTCDateTime())
    business_date: Mapped[date] = mapped_column(sa.Date)
    opened_by_employee_id: Mapped[int] = mapped_column(ForeignKey("employees.id"))
    opened_by_employee_name: Mapped[str] = mapped_column(sa.String(200))

    applied_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    applied_by_employee_id: Mapped[int | None] = mapped_column(ForeignKey("employees.id"), nullable=True)
    applied_by_employee_name: Mapped[str | None] = mapped_column(sa.String(200), nullable=True)

    __table_args__ = (
        Index("ix_stock_counts_store_status", "store_id", "status"),
        Index("ix_stock_counts_store_scope_opened", "store_id", "scope", "opened_at"),
    )


class StockCountLine(Base):
    """Un renglón de conteo, uno por insumo incluido. `qty_counted` es
    `NULL` hasta que alguien lo cuenta; `was_counted` lo escribe la persona
    que cuenta, **renglón por renglón** — no existe una acción que marque
    todos los renglones de una vez (SPEC-NEGOCIO §5.4: "no existe 'todo
    coincide'"; en la referencia esa marca borró un faltante real de
    −10.065 g). Un guardado parcial (`PUT /admin/counts/{id}/lines` con sólo
    algunos renglones) no toca los que no vinieron; un valor con
    `was_counted = True` nunca se pisa con un valor `False` después (un
    borrador no revierte una confirmación)."""

    __tablename__ = "stock_count_lines"

    id: Mapped[int] = mapped_column(primary_key=True)
    count_id: Mapped[int] = mapped_column(ForeignKey("stock_counts.id"), index=True)
    ingredient_id: Mapped[int] = mapped_column(ForeignKey("ingredients.id"), index=True)

    qty_counted: Mapped[int | None] = mapped_column(sa.Integer, nullable=True)
    was_counted: Mapped[bool] = mapped_column(sa.Boolean, default=False)
    counted_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)

    __table_args__ = (
        sa.UniqueConstraint("count_id", "ingredient_id", name="uq_stock_count_lines_count_ingredient"),
        CheckConstraint("qty_counted IS NULL OR qty_counted >= 0", name="ck_stock_count_lines_qty_nonneg"),
        Index("ix_stock_count_lines_ingredient", "ingredient_id"),
    )


# ---------------------------------------------------------------------------
# Umbrales de varianza (configuración de sede que vive en `inventory` —
# decisión de arquitectura #4 del pedido 2b: NO toca `app.stores`, que es el
# modelo compartido donde 1b-2 dejó un campo escrito a medias en tres capas).
# ---------------------------------------------------------------------------


class StoreInventorySettings(Base):
    """Semáforo de varianza (SPEC-NEGOCIO §5.4/§9.3), con defaults de
    industria (`< 2` puntos verde, `2–4` revisar, `>= 4` rojo) que **nunca**
    se hardcodean en el cálculo — `app.inventory.service.variance_report` los
    lee de acá. En puntos básicos (× 100: `2.00 %` = `200`) para no usar
    `float` (AGENTS.md, "cantidades sin float en ninguna parte")."""

    __tablename__ = "store_inventory_settings"

    store_id: Mapped[int] = mapped_column(ForeignKey("stores.id"), primary_key=True)
    variance_yellow_threshold_bp: Mapped[int] = mapped_column(sa.Integer, default=200)
    variance_red_threshold_bp: Mapped[int] = mapped_column(sa.Integer, default=400)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime())

    __table_args__ = (
        CheckConstraint("variance_yellow_threshold_bp > 0", name="ck_store_inv_settings_yellow_positive"),
        CheckConstraint(
            "variance_red_threshold_bp > variance_yellow_threshold_bp",
            name="ck_store_inv_settings_red_gt_yellow",
        ),
    )


# ---------------------------------------------------------------------------
# Conteo corto por área (`inventory.shift_counts`, 2026-09-25).
#
# Como en los restaurantes grandes: cada área responde por lo suyo. El del
# bar cuenta licores, el de cocina carnes y vegetales; la caja ya tiene su
# conteo (base al abrir y cierre a ciegas) y no pasa por acá. Se cuenta al
# abrir (quien entra, a ciegas) y al cerrar (quien sale). Nada de esto toca
# el libro de movimientos: un conteo corto NO ajusta el stock (eso lo hace
# el conteo completo con `apply_count`); sólo mide contra lo que el libro
# dice que debería haber, y avisa.
#
# Áreas, miembros y artículos se desactivan, nunca se borran; los conteos y
# los pedidos de recuento son append-only.
# ---------------------------------------------------------------------------


class AreaCountMoment(str, enum.Enum):
    OPENING = "opening"  # al abrir: cuenta quien entra
    CLOSING = "closing"  # al cerrar: cuenta quien sale
    SPOT = "spot"  # recuento sorpresa pedido por el administrador


class AreaRecountStatus(str, enum.Enum):
    PENDING = "pending"
    ANSWERED = "answered"


class CountArea(Base):
    """Un área de conteo de una sede (Bar, Cocina). El administrador la crea,
    la renombra o la desactiva; nunca se borra (sus conteos la nombran)."""

    __tablename__ = "count_areas"

    id: Mapped[int] = mapped_column(primary_key=True)
    organization_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), index=True)
    store_id: Mapped[int] = mapped_column(ForeignKey("stores.id"), index=True)
    name: Mapped[str] = mapped_column(sa.String(80))
    active: Mapped[bool] = mapped_column(sa.Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime())
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime())

    __table_args__ = (sa.UniqueConstraint("store_id", "name", name="uq_count_areas_store_name"),)


class CountAreaMember(Base):
    """De qué área es una persona en una sede. **Una sola** por persona y sede
    (`uq_count_area_members_store_employee`): cambiarla de área pisa la fila
    (con auditoría del antes y el después); sacarla la deja `active=False`."""

    __tablename__ = "count_area_members"

    id: Mapped[int] = mapped_column(primary_key=True)
    organization_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), index=True)
    store_id: Mapped[int] = mapped_column(ForeignKey("stores.id"), index=True)
    area_id: Mapped[int] = mapped_column(ForeignKey("count_areas.id"), index=True)
    employee_id: Mapped[int] = mapped_column(ForeignKey("employees.id"), index=True)
    employee_name: Mapped[str] = mapped_column(sa.String(200))
    active: Mapped[bool] = mapped_column(sa.Boolean, default=True)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime())

    __table_args__ = (
        sa.UniqueConstraint("store_id", "employee_id", name="uq_count_area_members_store_employee"),
    )


class CountAreaItem(Base):
    """Un artículo clave de un área: el insumo que esa área cuenta. **Un
    insumo se cuenta en un solo área** por sede
    (`uq_count_area_items_store_ingredient`): contado a medias en dos áreas,
    ninguna de las dos cifras se podría comparar con el libro, que lleva un
    solo saldo por insumo."""

    __tablename__ = "count_area_items"

    id: Mapped[int] = mapped_column(primary_key=True)
    organization_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), index=True)
    store_id: Mapped[int] = mapped_column(ForeignKey("stores.id"), index=True)
    area_id: Mapped[int] = mapped_column(ForeignKey("count_areas.id"), index=True)
    ingredient_id: Mapped[int] = mapped_column(ForeignKey("ingredients.id"), index=True)
    position: Mapped[int] = mapped_column(sa.Integer, default=0)
    active: Mapped[bool] = mapped_column(sa.Boolean, default=True)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime())

    __table_args__ = (
        sa.UniqueConstraint("store_id", "ingredient_id", name="uq_count_area_items_store_ingredient"),
    )


class AreaRecountRequest(Base):
    """«Recontá estos 1–5 artículos»: lo pide el administrador a un área; le
    aparece como pendiente en el POS de esa área, y la respuesta (a ciegas)
    es un `AreaCount` con `moment=spot` que apunta acá."""

    __tablename__ = "area_recount_requests"

    id: Mapped[int] = mapped_column(primary_key=True)
    organization_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), index=True)
    store_id: Mapped[int] = mapped_column(ForeignKey("stores.id"), index=True)
    area_id: Mapped[int] = mapped_column(ForeignKey("count_areas.id"), index=True)
    # Los insumos a recontar, en el orden en que se pidieron (1 a 5 ids).
    ingredient_ids: Mapped[list[int]] = mapped_column(sa.JSON)
    note: Mapped[str | None] = mapped_column(sa.String(300), nullable=True)
    status: Mapped[AreaRecountStatus] = mapped_column(
        _enum(AreaRecountStatus, length=16), default=AreaRecountStatus.PENDING
    )
    requested_at: Mapped[datetime] = mapped_column(UTCDateTime())
    business_date: Mapped[date] = mapped_column(sa.Date)
    requested_by_employee_id: Mapped[int] = mapped_column(ForeignKey("employees.id"))
    requested_by_employee_name: Mapped[str] = mapped_column(sa.String(200))
    answered_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)

    __table_args__ = (Index("ix_area_recount_requests_store_status", "store_id", "status"),)


class AreaCount(Base):
    """Un conteo corto de un área: quién contó, cuándo y en qué momento
    (`opening`, `closing` o `spot`). Append-only: si alguien se equivoca,
    cuenta de nuevo y **manda el último** del mismo momento y día; el
    anterior queda en el historial. El área se congela por nombre
    (`area_name`) porque el administrador la puede renombrar después."""

    __tablename__ = "area_counts"

    id: Mapped[int] = mapped_column(primary_key=True)
    organization_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), index=True)
    store_id: Mapped[int] = mapped_column(ForeignKey("stores.id"), index=True)
    area_id: Mapped[int] = mapped_column(ForeignKey("count_areas.id"), index=True)
    area_name: Mapped[str] = mapped_column(sa.String(80))
    moment: Mapped[AreaCountMoment] = mapped_column(_enum(AreaCountMoment, length=16))
    recount_request_id: Mapped[int | None] = mapped_column(
        ForeignKey("area_recount_requests.id"), nullable=True, unique=True
    )
    counted_at: Mapped[datetime] = mapped_column(UTCDateTime())
    business_date: Mapped[date] = mapped_column(sa.Date)
    employee_id: Mapped[int] = mapped_column(ForeignKey("employees.id"))
    employee_name: Mapped[str] = mapped_column(sa.String(200))

    __table_args__ = (
        Index("ix_area_counts_store_date", "store_id", "business_date"),
        Index("ix_area_counts_area_counted", "area_id", "counted_at"),
        CheckConstraint(
            "(moment = 'SPOT' AND recount_request_id IS NOT NULL) "
            "OR (moment != 'SPOT' AND recount_request_id IS NULL)",
            name="ck_area_counts_spot_has_request",
        ),
    )


class AreaCountLine(Base):
    """Un renglón de un conteo corto. `qty_base` en milésimas de la unidad
    base (`app.core.quantity`), convertido UNA vez en el servidor desde lo
    que la persona tecleó en su unidad cómoda (`entered_qty` + `entered_unit`,
    guardados tal cual: «2.3 botella»)."""

    __tablename__ = "area_count_lines"

    id: Mapped[int] = mapped_column(primary_key=True)
    count_id: Mapped[int] = mapped_column(ForeignKey("area_counts.id"), index=True)
    ingredient_id: Mapped[int] = mapped_column(ForeignKey("ingredients.id"), index=True)
    qty_base: Mapped[int] = mapped_column(sa.Integer)
    entered_qty: Mapped[str] = mapped_column(sa.String(20))
    entered_unit: Mapped[str] = mapped_column(sa.String(50))

    __table_args__ = (
        sa.UniqueConstraint("count_id", "ingredient_id", name="uq_area_count_lines_count_ingredient"),
        CheckConstraint("qty_base >= 0", name="ck_area_count_lines_qty_nonneg"),
    )


class AreaCountSettings(Base):
    """El umbral de aviso del conteo corto, por sede. Un artículo se marca
    cuando su diferencia supera **las dos** fronteras configuradas: el
    porcentaje de lo esperado (puntos básicos) **y** el monto en pesos. Una
    frontera en `NULL` no se exige. Sin costo conocido, manda sólo el
    porcentaje. Defaults: 2 % y $ 20.000. Nunca bloquea nada: sólo avisa."""

    __tablename__ = "area_count_settings"

    store_id: Mapped[int] = mapped_column(ForeignKey("stores.id"), primary_key=True)
    threshold_pct_bp: Mapped[int | None] = mapped_column(sa.Integer, nullable=True)
    threshold_amount: Mapped[int | None] = mapped_column(sa.Integer, nullable=True)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime())

    __table_args__ = (
        CheckConstraint(
            "threshold_pct_bp IS NULL OR threshold_pct_bp > 0", name="ck_area_count_settings_pct_positive"
        ),
        CheckConstraint(
            "threshold_amount IS NULL OR threshold_amount > 0", name="ck_area_count_settings_amount_positive"
        ),
    )
