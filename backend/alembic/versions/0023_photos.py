"""`photos`: las fotos de soporte en su propia tabla.

Las pantallas mandan la foto como *data URL* (cientos de kilobytes) y cada
dominio la guardaba tal cual en una columna `String(500)`: movimientos de
caja, retiros, relevos, conteos de cierre, consignaciones, recepciones y
mermas. En Postgres el `INSERT` fallaba por largo —una foto real nunca llegó
a guardarse en producción— y SQLite, que no hace cumplir el largo, lo
escondía en desarrollo y en los tests.

Esas columnas no cambian: ahora guardan la dirección de la foto
(`/api/v1/photos/<id>`), que sí cabe. No hay datos que migrar, porque ninguna
foto real pudo guardarse antes.

Revision ID: 0023
Revises: 0022
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0023"
down_revision: str | None = "0022"
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    op.create_table(
        "photos",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("organization_id", sa.Integer(), sa.ForeignKey("organizations.id"), nullable=False),
        sa.Column("store_id", sa.Integer(), sa.ForeignKey("stores.id"), nullable=True),
        sa.Column("content_type", sa.String(length=32), nullable=False),
        sa.Column("size_bytes", sa.Integer(), nullable=False),
        sa.Column("data", sa.LargeBinary(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_photos_organization_id", "photos", ["organization_id"])


def downgrade() -> None:
    op.drop_index("ix_photos_organization_id", table_name="photos")
    op.drop_table("photos")
