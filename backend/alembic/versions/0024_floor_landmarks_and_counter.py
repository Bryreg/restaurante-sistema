"""Referencias del salón y barra: las dos piezas que faltaban del plano `m2b`.

`zones.landmarks` — los rótulos que ayudan a ubicarse en el plano
(«Entrada», «Ventanal / Calle 63», «Paso a cocina»). Son DATO y no texto fijo
en la pantalla: el ventanal de Chapinero da a la Calle 63 y el de otra sede
no, y un plano con la calle equivocada es peor que uno sin calle.

Se guardan en una sola columna de texto separados por `|`, no en una tabla
aparte: son dos o tres rótulos por zona, sin identidad propia, que nadie
consulta ni ordena por separado. El separador es la barra y no la coma porque
una referencia real la lleva adentro («Terraza, lado norte»).

`tables.is_counter` — la mesa es una BARRA. `m2b` la dibuja como una tira con
un punto por puesto en vez de una tarjeta, pero sigue siendo una fila de
`tables`: se abre, se cobra y se cierra igual. Por eso una bandera y no una
tabla nueva — lo único distinto es cómo se ve.

Las dos nacen nullable / con default, así que ninguna sede existente necesita
tocar nada: sin referencias el plano se dibuja como hasta ahora, y sin barras
no hay ninguna tira.

Revision ID: 0024
Revises: 0023
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0024"
down_revision: str | None = "0023"
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    with op.batch_alter_table("zones") as batch_op:
        batch_op.add_column(sa.Column("landmarks", sa.String(length=300), nullable=True))
    with op.batch_alter_table("tables") as batch_op:
        # `server_default` no es decorativo: sin él, agregar una columna
        # `NOT NULL` a una tabla con filas falla, y `tables` tiene una fila
        # por mesa de cada sede.
        batch_op.add_column(
            sa.Column("is_counter", sa.Boolean(), nullable=False, server_default=sa.false())
        )


def downgrade() -> None:
    with op.batch_alter_table("tables") as batch_op:
        batch_op.drop_column("is_counter")
    with op.batch_alter_table("zones") as batch_op:
        batch_op.drop_column("landmarks")
