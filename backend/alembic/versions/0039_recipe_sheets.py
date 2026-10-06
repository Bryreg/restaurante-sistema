"""Ficha de chef y alérgenos.

Pedido del dueño (2026-10-06): cada plato debe poder descargar su receta para
que los chefs la tengan en físico, con lo que la alta cocina necesita además
de los componentes.

- `recipe_sheets`: la ficha de un plato o de una preparación (método paso a
  paso, porción, estación, tiempo, montaje, notas del chef, foto). No toca el
  costo ni el inventario.
- `ingredients.allergens`: los alérgenos del insumo; las fichas los heredan.

Suma una tabla: el conteo pasa de 117 a 118.

Revision ID: 0039
Revises: 0038
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0039"
down_revision = "0038"
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    op.add_column("ingredients", sa.Column("allergens", sa.String(200), nullable=True))
    op.create_table(
        "recipe_sheets",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("organization_id", sa.Integer(), sa.ForeignKey("organizations.id"), nullable=False),
        sa.Column("store_id", sa.Integer(), sa.ForeignKey("stores.id"), nullable=False),
        sa.Column("product_id", sa.Integer(), sa.ForeignKey("products.id"), nullable=True, unique=True),
        sa.Column("preparation_id", sa.Integer(), sa.ForeignKey("preparations.id"), nullable=True, unique=True),
        sa.Column("method_steps", sa.Text(), nullable=True),
        sa.Column("portion", sa.String(120), nullable=True),
        sa.Column("station", sa.String(20), nullable=True),
        sa.Column("prep_minutes", sa.Integer(), nullable=True),
        sa.Column("plating_notes", sa.Text(), nullable=True),
        sa.Column("chef_notes", sa.Text(), nullable=True),
        sa.Column("photo_url", sa.String(500), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_by_employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=True),
        sa.Column("updated_by_employee_name", sa.String(200), nullable=True),
        sa.CheckConstraint(
            "(product_id IS NOT NULL AND preparation_id IS NULL) OR "
            "(product_id IS NULL AND preparation_id IS NOT NULL)",
            name="ck_recipe_sheets_exactly_one_owner",
        ),
        sa.CheckConstraint("prep_minutes IS NULL OR prep_minutes >= 0", name="ck_recipe_sheets_minutes_nonneg"),
    )
    op.create_index("ix_recipe_sheets_organization_id", "recipe_sheets", ["organization_id"])
    op.create_index("ix_recipe_sheets_store_id", "recipe_sheets", ["store_id"])


def downgrade() -> None:
    op.drop_index("ix_recipe_sheets_store_id", table_name="recipe_sheets")
    op.drop_index("ix_recipe_sheets_organization_id", table_name="recipe_sheets")
    op.drop_table("recipe_sheets")
    with op.batch_alter_table("ingredients") as batch:
        batch.drop_column("allergens")
