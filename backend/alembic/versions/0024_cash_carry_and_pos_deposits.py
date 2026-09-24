"""La plata de días anteriores en el cajón, y consignar desde el POS.

El dueño decidió (2026-09-24) que la venta todavía sin consignar se queda en
el mismo cajón, como en café-sistema, y que quien tiene la caja puede
consignar desde el POS con confirmación del administrador.

- `shift_carry_ins`: qué turnos con saldo por consignar marcó quien abrió
  como físicamente presentes en el cajón, con el saldo de ese instante.
- `bank_deposits`: `source` (`admin`/`pos`), `from_shift_id` (el cajón del
  que salió la plata) y quién y cuándo la confirmó.

**Respaldo**: las consignaciones que ya existen las registró el
administrador, así que nacen `source='admin'` (el `server_default`) y
confirmadas en el instante en que se consignaron.

Sin `batch_alter_table`: `bank_deposit_allocations` apunta a
`bank_deposits`, y recrear la tabla es el problema de `0011`/`0021`. Se
agregan columnas sueltas, que las dos bases aceptan, y las dos llaves
foráneas nuevas se crean aparte **sólo en Postgres** (producción): SQLite no
sabe agregar una restricción a una tabla existente sin recrearla.

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
    op.create_table(
        "shift_carry_ins",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("organization_id", sa.Integer(), sa.ForeignKey("organizations.id"), nullable=False),
        sa.Column("store_id", sa.Integer(), sa.ForeignKey("stores.id"), nullable=False),
        sa.Column("shift_id", sa.Integer(), sa.ForeignKey("shifts.id"), nullable=False),
        sa.Column("source_shift_id", sa.Integer(), sa.ForeignKey("shifts.id"), nullable=False),
        sa.Column("amount", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("shift_id", "source_shift_id", name="uq_shift_carry_ins_shift_source"),
        sa.CheckConstraint("amount > 0", name="ck_shift_carry_ins_amount_positive"),
        sa.CheckConstraint("shift_id <> source_shift_id", name="ck_shift_carry_ins_not_self"),
    )
    op.create_index("ix_shift_carry_ins_organization_id", "shift_carry_ins", ["organization_id"])
    op.create_index("ix_shift_carry_ins_shift_id", "shift_carry_ins", ["shift_id"])

    op.add_column("bank_deposits", sa.Column("source", sa.String(8), nullable=False, server_default="admin"))
    op.add_column("bank_deposits", sa.Column("from_shift_id", sa.Integer(), nullable=True))
    op.add_column("bank_deposits", sa.Column("confirmed_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("bank_deposits", sa.Column("confirmed_by_employee_id", sa.Integer(), nullable=True))
    op.add_column("bank_deposits", sa.Column("confirmed_by_employee_name", sa.String(200), nullable=True))
    op.create_index("ix_bank_deposits_from_shift_id", "bank_deposits", ["from_shift_id"])
    if op.get_bind().dialect.name != "sqlite":
        op.create_foreign_key(
            "fk_bank_deposits_from_shift_id", "bank_deposits", "shifts", ["from_shift_id"], ["id"]
        )
        op.create_foreign_key(
            "fk_bank_deposits_confirmed_by_employee_id",
            "bank_deposits",
            "employees",
            ["confirmed_by_employee_id"],
            ["id"],
        )
    # Las que ya existen las registró el administrador: confirmadas al consignarse.
    op.execute("UPDATE bank_deposits SET confirmed_at = deposited_at WHERE confirmed_at IS NULL")


def downgrade() -> None:
    if op.get_bind().dialect.name != "sqlite":
        op.drop_constraint("fk_bank_deposits_confirmed_by_employee_id", "bank_deposits", type_="foreignkey")
        op.drop_constraint("fk_bank_deposits_from_shift_id", "bank_deposits", type_="foreignkey")
    op.drop_index("ix_bank_deposits_from_shift_id", table_name="bank_deposits")
    op.drop_column("bank_deposits", "confirmed_by_employee_name")
    op.drop_column("bank_deposits", "confirmed_by_employee_id")
    op.drop_column("bank_deposits", "confirmed_at")
    op.drop_column("bank_deposits", "from_shift_id")
    op.drop_column("bank_deposits", "source")
    op.drop_index("ix_shift_carry_ins_shift_id", table_name="shift_carry_ins")
    op.drop_index("ix_shift_carry_ins_organization_id", table_name="shift_carry_ins")
    op.drop_table("shift_carry_ins")
