"""Modelos de `labels`: la etiqueta de cocina y el tamaño de la impresora.

Una etiqueta es UN recipiente: la bolsa de queso abierta, el tarro de salsa,
la caja recibida. Cada copia impresa es una fila propia con su código, porque
cada recipiente se acaba o se bota por su lado.

El «usar antes de» lo calcula el servidor al imprimir y queda congelado en la
fila (`use_by`, con `use_by_source` que dice de dónde salió): cambiar después
los días de vida del insumo no le mueve la fecha a una etiqueta ya pegada.

Una etiqueta no mueve inventario al crearse: abrir un empaque no es consumir
(el consumo lo descuenta la receta, FEFO). Sí lo mueve al **botarla**: eso es
una merma (`app.inventory.service.register_waste`), a la que la etiqueta
apunta por `waste_id`.

Nada se borra: una etiqueta que se acabó o se botó queda con quién y cuándo.
"""

from __future__ import annotations

import enum
from datetime import date, datetime

import sqlalchemy as sa
from sqlalchemy import CheckConstraint, ForeignKey, Index
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base, UTCDateTime


def _enum(pyenum: type[enum.Enum], *, length: int = 20) -> sa.Enum:
    return sa.Enum(pyenum, native_enum=False, length=length, validate_strings=True)


class LabelKind(str, enum.Enum):
    RECEIVED = "received"  # llegó del proveedor (un lote de una recepción)
    OPENED = "opened"  # se abrió un empaque
    PRODUCED = "produced"  # salió de producción (un lote de una preparación)


class LabelStatus(str, enum.Enum):
    ACTIVE = "active"  # está en la cocina
    USED_UP = "used_up"  # se acabó
    DISCARDED = "discarded"  # se botó (merma)


class UseBySource(str, enum.Enum):
    SUPPLIER = "supplier"  # el vencimiento del lote del proveedor
    OPENED_SHELF_LIFE = "opened_shelf_life"  # los días que dura abierto el insumo
    PREP_SHELF_LIFE = "prep_shelf_life"  # la vida útil de la preparación
    MANUAL = "manual"  # quien imprimió eligió una fecha más corta (o no había regla)


class FoodLabel(Base):
    __tablename__ = "food_labels"

    id: Mapped[int] = mapped_column(primary_key=True)
    organization_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), index=True)
    store_id: Mapped[int] = mapped_column(ForeignKey("stores.id"), index=True)
    # Lo que va en el QR y debajo, legible: 8 caracteres sin letras que se
    # confundan (sin 0/O, 1/I/L).
    code: Mapped[str] = mapped_column(sa.String(16), unique=True)
    kind: Mapped[LabelKind] = mapped_column(_enum(LabelKind))

    ingredient_id: Mapped[int | None] = mapped_column(ForeignKey("ingredients.id"), nullable=True, index=True)
    preparation_id: Mapped[int | None] = mapped_column(ForeignKey("preparations.id"), nullable=True, index=True)
    stock_batch_id: Mapped[int | None] = mapped_column(ForeignKey("stock_batches.id"), nullable=True, index=True)
    prep_batch_id: Mapped[int | None] = mapped_column(ForeignKey("prep_batches.id"), nullable=True, index=True)
    # Lo recibido en la tablet queda como borrador hasta que el administrador
    # lo completa (y sólo entonces nace el lote): la cocina etiqueta en la
    # puerta, desde el renglón del borrador, que ya trae lote y vencimiento.
    reception_draft_line_id: Mapped[int | None] = mapped_column(
        ForeignKey("reception_draft_lines.id"), nullable=True, index=True
    )

    # Congelados al imprimir: la etiqueta pegada no cambia si el insumo cambia.
    item_name: Mapped[str] = mapped_column(sa.String(200))
    lot_code: Mapped[str | None] = mapped_column(sa.String(100), nullable=True)
    # Lo que contiene el recipiente, como se escribe en cocina («1 kg»,
    # «2 tarros»). Informativo: no mueve inventario.
    qty_text: Mapped[str | None] = mapped_column(sa.String(40), nullable=True)
    note: Mapped[str | None] = mapped_column(sa.String(200), nullable=True)

    made_at: Mapped[datetime] = mapped_column(UTCDateTime())
    business_date: Mapped[date] = mapped_column(sa.Date)
    # `NULL` sólo en lo recibido sin vencimiento del proveedor (un bulto de
    # arroz): se imprime «Sin vencimiento». Lo abierto y lo producido siempre
    # tienen fecha.
    use_by: Mapped[date | None] = mapped_column(sa.Date, nullable=True)
    use_by_source: Mapped[UseBySource | None] = mapped_column(_enum(UseBySource), nullable=True)

    employee_id: Mapped[int] = mapped_column(ForeignKey("employees.id"))
    employee_name: Mapped[str] = mapped_column(sa.String(200))

    status: Mapped[LabelStatus] = mapped_column(_enum(LabelStatus), default=LabelStatus.ACTIVE)
    closed_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    closed_by_employee_id: Mapped[int | None] = mapped_column(ForeignKey("employees.id"), nullable=True)
    closed_by_employee_name: Mapped[str | None] = mapped_column(sa.String(200), nullable=True)
    waste_id: Mapped[int | None] = mapped_column(ForeignKey("wastes.id"), nullable=True)

    print_count: Mapped[int] = mapped_column(sa.Integer, default=1)
    last_printed_at: Mapped[datetime] = mapped_column(UTCDateTime())

    __table_args__ = (
        CheckConstraint(
            "(ingredient_id IS NULL) <> (preparation_id IS NULL)",
            name="ck_food_labels_one_item",
        ),
        CheckConstraint("print_count >= 1", name="ck_food_labels_print_count_positive"),
        Index("ix_food_labels_store_status_use_by", "store_id", "status", "use_by"),
        Index("ix_food_labels_store_date", "store_id", "business_date"),
    )


class LabelSettings(Base):
    """El tamaño de la etiqueta de la impresora de la sede (Ajustes ›
    Inventario › Etiquetas). Sin fila = 50 × 30 mm, el rollo más común."""

    __tablename__ = "label_settings"

    store_id: Mapped[int] = mapped_column(ForeignKey("stores.id"), primary_key=True)
    width_mm: Mapped[int] = mapped_column(sa.Integer, default=50, server_default="50")
    height_mm: Mapped[int] = mapped_column(sa.Integer, default=30, server_default="30")
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime())

    __table_args__ = (
        CheckConstraint("width_mm >= 25 AND width_mm <= 120", name="ck_label_settings_width_range"),
        CheckConstraint("height_mm >= 15 AND height_mm <= 120", name="ck_label_settings_height_range"),
    )
