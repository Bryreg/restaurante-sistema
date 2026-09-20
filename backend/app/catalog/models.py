"""Carta plana: categorías, productos, modificadores, combos y menú del día
(`docs/SPEC-NEGOCIO.md §4.3`, sólo la parte que entra en el pedido 1a — sin
recetas ni costos, que llegan en fase 2).

Convenciones (vinculantes, `features/fase-1a-cimientos/CONTRATO-INTERNO.md §2`):
- Todo modelo lleva `organization_id` **y** `store_id`, ambos indexados: toda
  consulta filtra por los dos sin necesidad de un join a `stores`.
- Dinero en `Integer` (pesos enteros): `price_dine_in`, `price_takeout`,
  `price_delivery`, `price_platform`, `price_delta`, `Combo.price`.
- Baja lógica siempre (`active`); nada se borra físicamente.
- Quien marca algo no disponible queda registrado con FK real
  (`unavailable_by_employee_id`) + nombre congelado, nunca sólo un timestamp.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import (
    JSON,
    Boolean,
    CheckConstraint,
    ForeignKey,
    Index,
    Integer,
    String,
)
from sqlalchemy import Enum as SAEnum
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base, UTCDateTime

TAX_CODE_VALUES = ("inc_8", "iva_19", "excluded")


class Category(Base):
    """Categoría de la carta (entradas, sopas, bebidas...). Configurable por
    sede; `default_course`/`default_station` son el valor que toma un producto
    nuevo de esta categoría si no lo pisa explícitamente."""

    __tablename__ = "categories"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    organization_id: Mapped[int] = mapped_column(
        ForeignKey("organizations.id"), nullable=False, index=True
    )
    store_id: Mapped[int] = mapped_column(ForeignKey("stores.id"), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(150), nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    default_course: Mapped[str | None] = mapped_column(String(50), nullable=True)
    default_station: Mapped[str | None] = mapped_column(String(50), nullable=True)
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    __table_args__ = (Index("ix_categories_store_active", "store_id", "active"),)


class Product(Base):
    """Un plato vendible. Sin ficha técnica ni costo en esta fase (llegan con
    `catalog.recipes` en fase 2): ningún esquema de respuesta de este módulo
    tiene un campo `cost`/`margin`/`unit_cost` (SPEC-NEGOCIO §2.2, §4.3)."""

    __tablename__ = "products"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    organization_id: Mapped[int] = mapped_column(
        ForeignKey("organizations.id"), nullable=False, index=True
    )
    store_id: Mapped[int] = mapped_column(ForeignKey("stores.id"), nullable=False, index=True)
    category_id: Mapped[int] = mapped_column(ForeignKey("categories.id"), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    station: Mapped[str | None] = mapped_column(String(50), nullable=True)
    default_course: Mapped[str | None] = mapped_column(String(50), nullable=True)

    # Precio por canal: mesa obligatorio, los demás caen al de mesa en la
    # respuesta de `GET /catalog` (nunca en la fila cruda que ve el admin).
    price_dine_in: Mapped[int] = mapped_column(Integer, nullable=False)
    price_takeout: Mapped[int | None] = mapped_column(Integer, nullable=True)
    price_delivery: Mapped[int | None] = mapped_column(Integer, nullable=True)
    price_platform: Mapped[int | None] = mapped_column(Integer, nullable=True)

    tax_code: Mapped[str] = mapped_column(
        SAEnum(*TAX_CODE_VALUES, name="product_tax_code", native_enum=False, length=16),
        nullable=False,
    )

    # Pedido 2c (§4.3, "el cargo de domicilio es una línea de la comanda, no
    # un campo"): el cargo de domicilio se modela como un producto REAL de
    # la carta —mismo criterio que SPEC-NEGOCIO §3.3 ya usaba para "no existe
    # producto de precio abierto: si hace falta, es un producto real creado
    # por el administrador"— marcado con esta bandera, en vez de una tabla de
    # configuración nueva en `app.stores` (territorio ajeno de este pedido).
    # `app.orders.service.create_order` lo busca (`app.catalog.service.
    # get_delivery_fee_product`) y lo agrega como ítem al crear una comanda
    # `delivery`; nunca lo agrega el operador a mano
    # (`app.orders.service._build_product_item` lo rechaza con
    # `DELIVERY_FEE_NOT_ORDERABLE`) y `GET /catalog` lo excluye del menú del
    # dispositivo. A lo sumo un producto activo con esta bandera por sede
    # (`app.catalog.service._assert_single_delivery_fee`, `409` si se intenta
    # un segundo). Sin ficha técnica: nunca se le crea una receta, así que
    # `_freeze_item_consumption` lo deja en `unit_cost=None`/`cost_source=None`
    # por el camino normal de "cobertura de recetas" (§4.3), nunca un cero
    # mudo.
    is_delivery_fee: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    # Agotados del día (SPEC-NEGOCIO §3.3 "Agotado del día («86»)"): `available`
    # es el interruptor visible; el contador es opcional y, al llegar a cero,
    # 1b lo pasa a `available=False` al enviar (acá sólo se declara el campo y
    # el setter; el descuento en el envío es del pedido 1b).
    available: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    daily_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    daily_remaining: Mapped[int | None] = mapped_column(Integer, nullable=True)
    unavailable_by_employee_id: Mapped[int | None] = mapped_column(
        ForeignKey("employees.id"), nullable=True
    )
    unavailable_by_employee_name: Mapped[str | None] = mapped_column(String(200), nullable=True)
    unavailable_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)

    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False)

    __table_args__ = (
        CheckConstraint("price_dine_in >= 0", name="ck_products_price_dine_in_nonneg"),
        CheckConstraint(
            "price_takeout IS NULL OR price_takeout >= 0", name="ck_products_price_takeout_nonneg"
        ),
        CheckConstraint(
            "price_delivery IS NULL OR price_delivery >= 0", name="ck_products_price_delivery_nonneg"
        ),
        CheckConstraint(
            "price_platform IS NULL OR price_platform >= 0", name="ck_products_price_platform_nonneg"
        ),
        CheckConstraint(
            "daily_count IS NULL OR daily_count >= 0", name="ck_products_daily_count_nonneg"
        ),
        CheckConstraint(
            "daily_remaining IS NULL OR daily_remaining >= 0", name="ck_products_daily_remaining_nonneg"
        ),
        Index("ix_products_store_active", "store_id", "active"),
    )


class ModifierGroup(Base):
    """Grupo de modificadores de un producto (`required`, `min`, `max`)."""

    __tablename__ = "modifier_groups"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    organization_id: Mapped[int] = mapped_column(
        ForeignKey("organizations.id"), nullable=False, index=True
    )
    store_id: Mapped[int] = mapped_column(ForeignKey("stores.id"), nullable=False, index=True)
    product_id: Mapped[int] = mapped_column(ForeignKey("products.id"), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(150), nullable=False)
    required: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    min: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    max: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    __table_args__ = (
        CheckConstraint("min >= 0", name="ck_modifier_groups_min_nonneg"),
        CheckConstraint("max >= min", name="ck_modifier_groups_max_ge_min"),
    )


class ModifierOption(Base):
    """Opción dentro de un grupo de modificadores. `recipe_effect` queda
    siempre `NULL` en esta fase (SPEC-NEGOCIO §4.3: "nulo en fase 1b"; llega en
    fase 2 con `catalog.recipes`) — el modelo ya tiene la columna para no
    migrar de nuevo cuando llegue."""

    __tablename__ = "modifier_options"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    organization_id: Mapped[int] = mapped_column(
        ForeignKey("organizations.id"), nullable=False, index=True
    )
    store_id: Mapped[int] = mapped_column(ForeignKey("stores.id"), nullable=False, index=True)
    modifier_group_id: Mapped[int] = mapped_column(
        ForeignKey("modifier_groups.id"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(150), nullable=False)
    price_delta: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    available: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    unavailable_by_employee_id: Mapped[int | None] = mapped_column(
        ForeignKey("employees.id"), nullable=True
    )
    unavailable_by_employee_name: Mapped[str | None] = mapped_column(String(200), nullable=True)
    unavailable_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    recipe_effect: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)


class Combo(Base):
    """Precio fijo con grupos de opción; el menú del día («corrientazo») es
    un `Combo` más (sin campo propio que lo distinga: lo que lo hace "menú del
    día" es que sus opciones se curan a diario con `PUT .../today`, detrás de
    `pos.daily_menu`). `schedule` = `{"days": [0..6], "from": "HH:MM", "to":
    "HH:MM"}`; `days` usa la convención de `date.weekday()` (0 = lunes, 6 =
    domingo) — igual que en todo el backend, nunca 0 = domingo."""

    __tablename__ = "combos"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    organization_id: Mapped[int] = mapped_column(
        ForeignKey("organizations.id"), nullable=False, index=True
    )
    store_id: Mapped[int] = mapped_column(ForeignKey("stores.id"), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    price: Mapped[int] = mapped_column(Integer, nullable=False)
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    schedule: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False)

    __table_args__ = (
        CheckConstraint("price >= 0", name="ck_combos_price_nonneg"),
        Index("ix_combos_store_active", "store_id", "active"),
    )


class ComboGroup(Base):
    """Componente del combo (p. ej. "sopa", "principio", "proteína", "jugo")."""

    __tablename__ = "combo_groups"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    organization_id: Mapped[int] = mapped_column(
        ForeignKey("organizations.id"), nullable=False, index=True
    )
    store_id: Mapped[int] = mapped_column(ForeignKey("stores.id"), nullable=False, index=True)
    combo_id: Mapped[int] = mapped_column(ForeignKey("combos.id"), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(150), nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)


class ComboOption(Base):
    """Una opción concreta de un `ComboGroup`, siempre ligada a un `Product`
    real (no tiene nombre propio: en la respuesta se usa el del producto).

    Dos banderas independientes:
    - `active_today`: si la opción es parte del menú de hoy ("armar el menú
      de hoy" la prende o apaga en bloque vía `PUT .../today`); una opción con
      `active_today=False` no aparece en `GET /catalog`.
    - `available_today`: si, estando activa hoy, se agotó (agotado del día);
      se muestra en la respuesta para las opciones que sí están activas.
    """

    __tablename__ = "combo_options"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    organization_id: Mapped[int] = mapped_column(
        ForeignKey("organizations.id"), nullable=False, index=True
    )
    store_id: Mapped[int] = mapped_column(ForeignKey("stores.id"), nullable=False, index=True)
    combo_group_id: Mapped[int] = mapped_column(
        ForeignKey("combo_groups.id"), nullable=False, index=True
    )
    product_id: Mapped[int] = mapped_column(ForeignKey("products.id"), nullable=False, index=True)
    active_today: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    available_today: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    unavailable_by_employee_id: Mapped[int | None] = mapped_column(
        ForeignKey("employees.id"), nullable=True
    )
    unavailable_by_employee_name: Mapped[str | None] = mapped_column(String(200), nullable=True)
    unavailable_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
