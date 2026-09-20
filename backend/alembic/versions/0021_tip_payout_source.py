"""De dónde salió la plata de un reparto de propinas pagado en efectivo (A-3).

`app.banking.service.owner_hand` restaba de la mano del dueño **todo**
`TipPayout` con `method="cash"` del período. Pero un reparto pagado **del
cajón** ya redujo el `to_deposit` de ese turno, y `withdrawn_from_shift_close`
suma justamente ese `to_deposit`: la misma plata se restaba dos veces.

El sesgo iba al lado tolerado (mostraba MENOS plata en la mano de la que
había), que es por qué no rompía ninguna identidad publicada y el invariante
del auditor estaba verde. Pero seguía siendo un número equivocado en pantalla.

**El respaldo no inventa el pasado.** Las filas que ya existen se marcan
`unknown`, no `owner_hand`: quien las registró nunca declaró de dónde salió la
plata, y ponerle una respuesta sería afirmar algo que nadie dijo. `unknown` se
trata **como si fuera de la mano** —el sesgo que muestra menos plata, el único
que este proyecto tolera— y `GET /admin/bank/owner-hand` publica cuántas son,
para que la suposición quede a la vista en vez de escondida en un default.

Revision ID: 0021
Revises: 0020
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0021"
down_revision: str | None = "0020"
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    # El `server_default` es lo que hace el respaldo: marca `unknown` todas las
    # filas que ya existen, en la misma sentencia, sin un `UPDATE` aparte.
    #
    # **Y se queda.** El primer intento lo sacaba enseguida con un
    # `alter_column(server_default=None)`, para que el único default fuera el
    # del modelo. Eso funciona en Postgres y **rompe en SQLite**, que no
    # soporta `ALTER COLUMN ... DROP DEFAULT` — el reflejo exacto del defecto
    # que dejó la fase 2 sin desplegar, con los motores invertidos. La salida
    # habitual, `batch_alter_table`, recrea la tabla, y `tip_payout_
    # distributions.payout_id` apunta acá: en Postgres eso obliga a soltar la
    # PK, que es literalmente el problema de `0011`.
    #
    # Que convivan los dos defaults es inofensivo **porque nunca compiten**:
    # toda inserción pasa por `register_tip_payout`, que siempre escribe
    # `paid_from` explícitamente. El default del servidor sólo existió durante
    # esta migración; el del modelo (`OWNER_HAND`) sólo cubre a quien
    # construya un `TipPayout` a mano sin decir el origen.
    # **`"UNKNOWN"` en mayúsculas, y esto no es un detalle de estilo.**
    #
    # `_enum(...)` de `app/shifts/models.py` construye
    # `sa.Enum(pyenum, native_enum=False)`, y SQLAlchemy guarda el **NOMBRE**
    # del miembro, no su `.value`: la columna contiene `UNKNOWN`, no
    # `unknown`. La primera versión de esta migración sembró `"unknown"` y
    # **toda fila respaldada reventaba al leerse** con
    # `LookupError: 'unknown' is not among the defined enum values`.
    #
    # Ningún test lo veía: todos crean repartos por la API, que escribe la
    # columna a través del ORM. La única forma de verlo era correr la cadena
    # sobre una fila insertada ANTES de la columna, que es exactamente lo que
    # hace `test_a3_a_row_that_predates_the_column_reads_back_as_unknown`.
    op.add_column(
        "tip_payouts",
        sa.Column("paid_from", sa.String(16), nullable=False, server_default="UNKNOWN"),
    )


def downgrade() -> None:
    op.drop_column("tip_payouts", "paid_from")
