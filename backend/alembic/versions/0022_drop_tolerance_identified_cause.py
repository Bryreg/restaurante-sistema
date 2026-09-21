"""Se va `store_cash_settings.tolerance_identified_cause`: un ajuste que el
dueño podía editar y que no hacía absolutamente nada.

El arqueo (§3.2) tiene **tres bandas con dos fronteras**: hasta
`tolerance_unknown_cause` se cierra con causa libre; encima, la causa debe ser
identificada; desde `critical_difference`, alerta crítica al administrador —y
nunca bloquea el cierre. Dos fronteras, dos columnas. La tercera nació con el
esquema (`0001_core`) describiendo la misma frontera que `critical_difference`
desde el otro lado, y `app/shifts/service.py` nunca la leyó: `_evaluate_close`
siempre se apoyó en las otras dos.

Editable y muerta es la peor combinación posible para un control de caja: el
dueño subía «Tolerancia con causa identificada» creyendo que corría el umbral
del arqueo, y el umbral no se movía ni un peso. Un control que miente sobre
lo que controla es peor que no tenerlo, porque se confía en él.

**No hay respaldo de datos que hacer.** No se migra ningún valor a otra
columna: lo que la columna guardaba no alimentaba ninguna decisión, así que no
hay información que perder. Lo que sí se conserva es la forma de volver: el
`downgrade` recrea la columna con su `NOT NULL` y su default de 100.000, el
mismo que traía `0001_core`, para que bajar de versión deje el esquema como
estaba y no una tabla a la que le falta una columna que el modelo viejo espera.

`batch_alter_table` porque SQLite necesita modo batch para `ALTER TABLE`
(igual que `0007` con `store_sales_settings.invoice_threshold_uvt`, la tabla
hermana); en Postgres —producción— baja a un `ALTER TABLE` liso. Nada apunta
a `store_cash_settings` con una FK, así que recrear la tabla en SQLite no
arrastra la cadena de dependencias que obligó a `0011` y a `0021` a esquivar
el batch.

Revision ID: 0022
Revises: 0021
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0022"
down_revision: str | None = "0021"
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    with op.batch_alter_table("store_cash_settings") as batch_op:
        batch_op.drop_column("tolerance_identified_cause")


def downgrade() -> None:
    # Reversa de verdad, no un `pass`: la columna vuelve tal como la creó
    # `0001_core` —entera, `NOT NULL`, default 100.000—. El `server_default`
    # no es decorativo: sin él, agregar una columna `NOT NULL` a una tabla con
    # filas falla, y `store_cash_settings` tiene una fila por sede.
    with op.batch_alter_table("store_cash_settings") as batch_op:
        batch_op.add_column(
            sa.Column(
                "tolerance_identified_cause",
                sa.Integer(),
                nullable=False,
                server_default="100000",
            )
        )
