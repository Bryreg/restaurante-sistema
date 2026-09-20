"""D-2 (`features/fase-3-dinero-control/spec.md § 1`, `backend-obligaciones`
— única excepción de territorio autorizada sobre `app/purchases/`): la
recepción gana `invoice_total` (lo que dice el papel); `payables` gana los
tres campos de confirmación de diferencia (`discrepancy_confirmed*`), mismo
patrón que `price_confirmed*` de `0011_purchases.py`.

Sólo `ADD COLUMN`, nunca `batch_alter_table`: no se toca ninguna columna
existente ni su `CHECK` (`docs/CONTEXTO-AGENTES.md §12`). Todas nullable con
`server_default` donde aplica, así que corre limpio sobre filas que ya
existen (ninguna recepción/cuenta por pagar previa tiene diferencia que
confirmar).

Revision ID: 0019
Revises: 0018
Create Date: 2026-09-20
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0019"
down_revision: str | None = "0018"
branch_labels: Sequence[str] | None = None
depends_on: Sequence[str] | None = None


_FK_DISCREPANCY_CONFIRMED_BY = "fk_payables_discrepancy_confirmed_by_employee_id"


def upgrade() -> None:
    op.add_column("receptions", sa.Column("invoice_total", sa.Integer(), nullable=True))

    op.add_column(
        "payables", sa.Column("discrepancy_confirmed", sa.Boolean(), nullable=False, server_default=sa.false())
    )
    # ADD COLUMN sin la FK inline: SQLite no soporta agregar una columna CON
    # constraint por ALTER (`NotImplementedError`) fuera de `batch_alter_table`,
    # que a su vez rompe en Postgres (docs/CONTEXTO-AGENTES.md §12, error
    # repetido nº4). La columna se agrega plana acá y la FK real se crea aparte,
    # sólo en motores que la soportan por ALTER — el modelo (app/purchases/models.py:271)
    # sigue declarando la FK, consistente con sus hermanos (152/155/163/173/260).
    op.add_column(
        "payables",
        sa.Column("discrepancy_confirmed_by_employee_id", sa.Integer(), nullable=True),
    )
    if op.get_bind().dialect.name != "sqlite":
        op.create_foreign_key(
            _FK_DISCREPANCY_CONFIRMED_BY,
            "payables",
            "employees",
            ["discrepancy_confirmed_by_employee_id"],
            ["id"],
        )
    op.add_column("payables", sa.Column("discrepancy_confirmed_by_employee_name", sa.String(200), nullable=True))


def downgrade() -> None:
    op.drop_column("payables", "discrepancy_confirmed_by_employee_name")
    if op.get_bind().dialect.name != "sqlite":
        op.drop_constraint(_FK_DISCREPANCY_CONFIRMED_BY, "payables", type_="foreignkey")
    op.drop_column("payables", "discrepancy_confirmed_by_employee_id")
    op.drop_column("payables", "discrepancy_confirmed")
    op.drop_column("receptions", "invoice_total")
