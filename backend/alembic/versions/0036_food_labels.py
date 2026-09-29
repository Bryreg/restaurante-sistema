"""Etiquetas de cocina con QR (`inventory.labels`).

Pedido del dueño (2026-09-29): «cada insumo debe estar guardado con su
etiqueta de lote y fecha de vencimiento». Lo más difícil de controlar en
cocina es lo ABIERTO y lo PRODUCIDO: la fecha del proveedor ya se guarda en
el lote (`stock_batches.expires_at`), pero la bolsa abierta y el tarro de
salsa no tenían fecha propia.

- `food_labels`: cada etiqueta impresa es un recipiente, con su código (el
  del QR), el «usar antes de» congelado y de dónde salió, quién la hizo y
  cómo terminó (se acabó / se botó, con la merma a la que apunta).
- `label_settings`: el tamaño del rollo de la impresora de la sede.
- `ingredients.opened_shelf_life_days`: cuántos días dura abierto.

Suma dos tablas: el conteo pasa de 114 a 116.

Revision ID: 0036
Revises: 0035
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0036"
down_revision = "0035"
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    op.add_column("ingredients", sa.Column("opened_shelf_life_days", sa.Integer(), nullable=True))

    op.create_table(
        "food_labels",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("organization_id", sa.Integer(), sa.ForeignKey("organizations.id"), nullable=False),
        sa.Column("store_id", sa.Integer(), sa.ForeignKey("stores.id"), nullable=False),
        sa.Column("code", sa.String(16), nullable=False),
        sa.Column("kind", sa.String(20), nullable=False),
        sa.Column("ingredient_id", sa.Integer(), sa.ForeignKey("ingredients.id"), nullable=True),
        sa.Column("preparation_id", sa.Integer(), sa.ForeignKey("preparations.id"), nullable=True),
        sa.Column("stock_batch_id", sa.Integer(), sa.ForeignKey("stock_batches.id"), nullable=True),
        sa.Column("prep_batch_id", sa.Integer(), sa.ForeignKey("prep_batches.id"), nullable=True),
        sa.Column(
            "reception_draft_line_id", sa.Integer(), sa.ForeignKey("reception_draft_lines.id"), nullable=True
        ),
        sa.Column("item_name", sa.String(200), nullable=False),
        sa.Column("lot_code", sa.String(100), nullable=True),
        sa.Column("qty_text", sa.String(40), nullable=True),
        sa.Column("note", sa.String(200), nullable=True),
        sa.Column("made_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("business_date", sa.Date(), nullable=False),
        sa.Column("use_by", sa.Date(), nullable=True),
        sa.Column("use_by_source", sa.String(20), nullable=True),
        sa.Column("employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=False),
        sa.Column("employee_name", sa.String(200), nullable=False),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("closed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("closed_by_employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=True),
        sa.Column("closed_by_employee_name", sa.String(200), nullable=True),
        sa.Column("waste_id", sa.Integer(), sa.ForeignKey("wastes.id"), nullable=True),
        sa.Column("print_count", sa.Integer(), nullable=False),
        sa.Column("last_printed_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("code", name="uq_food_labels_code"),
        sa.CheckConstraint("(ingredient_id IS NULL) <> (preparation_id IS NULL)", name="ck_food_labels_one_item"),
        sa.CheckConstraint("print_count >= 1", name="ck_food_labels_print_count_positive"),
    )
    op.create_index("ix_food_labels_organization_id", "food_labels", ["organization_id"])
    op.create_index("ix_food_labels_store_id", "food_labels", ["store_id"])
    op.create_index("ix_food_labels_ingredient_id", "food_labels", ["ingredient_id"])
    op.create_index("ix_food_labels_preparation_id", "food_labels", ["preparation_id"])
    op.create_index("ix_food_labels_stock_batch_id", "food_labels", ["stock_batch_id"])
    op.create_index("ix_food_labels_prep_batch_id", "food_labels", ["prep_batch_id"])
    op.create_index("ix_food_labels_reception_draft_line_id", "food_labels", ["reception_draft_line_id"])
    op.create_index("ix_food_labels_store_status_use_by", "food_labels", ["store_id", "status", "use_by"])
    op.create_index("ix_food_labels_store_date", "food_labels", ["store_id", "business_date"])

    op.create_table(
        "label_settings",
        sa.Column("store_id", sa.Integer(), sa.ForeignKey("stores.id"), primary_key=True),
        sa.Column("width_mm", sa.Integer(), nullable=False, server_default="50"),
        sa.Column("height_mm", sa.Integer(), nullable=False, server_default="30"),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("width_mm >= 25 AND width_mm <= 120", name="ck_label_settings_width_range"),
        sa.CheckConstraint("height_mm >= 15 AND height_mm <= 120", name="ck_label_settings_height_range"),
    )


def downgrade() -> None:
    op.drop_table("label_settings")
    for name in (
        "ix_food_labels_store_date",
        "ix_food_labels_store_status_use_by",
        "ix_food_labels_reception_draft_line_id",
        "ix_food_labels_prep_batch_id",
        "ix_food_labels_stock_batch_id",
        "ix_food_labels_preparation_id",
        "ix_food_labels_ingredient_id",
        "ix_food_labels_store_id",
        "ix_food_labels_organization_id",
    ):
        op.drop_index(name, table_name="food_labels")
    op.drop_table("food_labels")
    with op.batch_alter_table("ingredients") as batch:
        batch.drop_column("opened_shelf_life_days")
