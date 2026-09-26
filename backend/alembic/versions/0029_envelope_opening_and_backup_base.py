"""El cajón abre con los sobres por consignar, y la base de respaldo aparte.

Decisiones del dueño (2026-09-26), a imagen de café-sistema:

1. **La apertura es el cuadre de los sobres.** Quien abre elige qué sobres de
   días por consignar va a trabajar en el turno y cuenta cada uno aparte, a
   ciegas; el cajón abre SÓLO con eso. Ya no hay «base fija» en el cajón.
2. **La base de respaldo** es plata aparte, con monto fijo por sede, que no
   entra al cuadre. Si la plata de los sobres no alcanza, el cajero toma de
   la base con autorización de un supervisor o administrador, y la devuelve
   el mismo día antes del conteo de cierre. El custodio la verifica aparte.

La palabra «base» significa UNA sola cosa desde acá: la base de respaldo. El
incidente del café (la base de emergencia mezclada con la plata consignable
pidió consignar $697.900 en vez de $197.900) es exactamente lo que esto evita.

Esquema:

- `shifts.opening_mode` y `shifts.opening_fixed_base`: la regla con que abrió
  cada turno y la base fija que tenía que dejar en el cajón. **Respaldo**: los
  turnos existentes quedan `fixed_base` con la base fija de su sede (la misma
  cifra con que se calcularon; los cerrados ya tienen `to_deposit` congelado y
  nada se recalcula). Ningún número histórico cambia.
- `store_cash_settings.opening_mode`: cómo abre cada sede. **Respaldo**: toda
  sede existente pasa a `envelopes` (la decisión del dueño), y si su monto de
  base de respaldo (`cash_reserve_default`) estaba en 0, hereda la base fija:
  es la misma plata, que deja de vivir en el cajón y pasa a guardarse aparte.
  El dueño la corrige en Ajustes › Caja si no es así. Un turno que esté
  abierto durante el deploy sigue con su regla hasta cerrar.
- `shift_opening_counts`: el conteo de apertura por sobres, sellado.
- `cash_reserve_movements` y `cash_reserve_checks`: el libro de la base de
  respaldo (tomar / devolver) y sus verificaciones por el custodio.

Columnas sueltas sin `batch_alter_table`; las tablas nuevas llevan sus llaves
foráneas desde el `create_table` (tabla nueva, las dos bases lo aceptan).

**Numeración**: `0029` nació en paralelo sobre `0027`; al integrar se
re-encadenó: `0027 → 0028_attendance → 0029 → 0030_area_count_per_item`.

Revision ID: 0029
Revises: 0028
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0029"
down_revision: str | None = "0028"
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    op.add_column(
        "shifts", sa.Column("opening_mode", sa.String(16), nullable=False, server_default="fixed_base")
    )
    op.add_column("shifts", sa.Column("opening_fixed_base", sa.Integer(), nullable=False, server_default="0"))
    op.add_column(
        "store_cash_settings",
        sa.Column("opening_mode", sa.String(16), nullable=False, server_default="fixed_base"),
    )

    # Los turnos que ya existen abrieron con la base fija de su sede: se
    # congela en el turno la misma cifra que su cierre usó (o usará).
    op.execute(
        "UPDATE shifts SET opening_fixed_base = COALESCE("
        "(SELECT s.opening_cash_fixed FROM store_cash_settings s WHERE s.store_id = shifts.store_id), 200000)"
    )
    # La decisión del dueño, para toda sede existente. La base fija deja el
    # cajón y pasa a ser la base de respaldo (sólo si ésta no tenía monto).
    op.execute(
        "UPDATE store_cash_settings SET "
        "cash_reserve_default = CASE WHEN cash_reserve_default = 0 THEN opening_cash_fixed ELSE cash_reserve_default END, "
        "opening_mode = 'envelopes'"
    )

    op.create_table(
        "shift_opening_counts",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("organization_id", sa.Integer(), sa.ForeignKey("organizations.id"), nullable=False),
        sa.Column("store_id", sa.Integer(), sa.ForeignKey("stores.id"), nullable=False),
        sa.Column("shift_id", sa.Integer(), sa.ForeignKey("shifts.id"), nullable=True),
        sa.Column("envelopes", sa.JSON(), nullable=False),
        sa.Column("expected_total", sa.Integer(), nullable=False),
        sa.Column("counted_total", sa.Integer(), nullable=False),
        sa.Column("counted_by_employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=False),
        sa.Column("counted_by_employee_name", sa.String(200), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("superseded", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.CheckConstraint("expected_total >= 0", name="ck_shift_opening_counts_expected_nonneg"),
        sa.CheckConstraint("counted_total >= 0", name="ck_shift_opening_counts_counted_nonneg"),
    )
    op.create_index("ix_shift_opening_counts_organization_id", "shift_opening_counts", ["organization_id"])
    op.create_index("ix_shift_opening_counts_store_id", "shift_opening_counts", ["store_id"])
    op.create_index("ix_shift_opening_counts_shift_id", "shift_opening_counts", ["shift_id"])

    op.create_table(
        "cash_reserve_movements",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("organization_id", sa.Integer(), sa.ForeignKey("organizations.id"), nullable=False),
        sa.Column("store_id", sa.Integer(), sa.ForeignKey("stores.id"), nullable=False),
        sa.Column("shift_id", sa.Integer(), sa.ForeignKey("shifts.id"), nullable=False),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("amount", sa.Integer(), nullable=False),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=False),
        sa.Column("employee_name", sa.String(200), nullable=False),
        sa.Column("authorized_by_employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=True),
        sa.Column("authorized_by_employee_name", sa.String(200), nullable=True),
        sa.Column("at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("reversed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("reversed_reason", sa.Text(), nullable=True),
        sa.Column("reversed_by_employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=True),
        sa.Column("reversed_by_employee_name", sa.String(200), nullable=True),
        sa.CheckConstraint("amount > 0", name="ck_cash_reserve_movements_amount_positive"),
    )
    op.create_index("ix_cash_reserve_movements_organization_id", "cash_reserve_movements", ["organization_id"])
    op.create_index("ix_cash_reserve_movements_store_id", "cash_reserve_movements", ["store_id"])
    op.create_index("ix_cash_reserve_movements_shift_id", "cash_reserve_movements", ["shift_id"])
    op.create_index("ix_cash_reserve_movements_shift_at", "cash_reserve_movements", ["shift_id", "at"])

    op.create_table(
        "cash_reserve_checks",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("organization_id", sa.Integer(), sa.ForeignKey("organizations.id"), nullable=False),
        sa.Column("store_id", sa.Integer(), sa.ForeignKey("stores.id"), nullable=False),
        sa.Column("shift_id", sa.Integer(), sa.ForeignKey("shifts.id"), nullable=True),
        sa.Column("reserve_amount", sa.Integer(), nullable=False),
        sa.Column("loans_outstanding", sa.Integer(), nullable=False),
        sa.Column("expected", sa.Integer(), nullable=False),
        sa.Column("counted", sa.Integer(), nullable=False),
        sa.Column("denominations", sa.JSON(), nullable=False),
        sa.Column("difference", sa.Integer(), nullable=False),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=False),
        sa.Column("employee_name", sa.String(200), nullable=False),
        sa.Column("at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("counted >= 0", name="ck_cash_reserve_checks_counted_nonneg"),
    )
    op.create_index("ix_cash_reserve_checks_organization_id", "cash_reserve_checks", ["organization_id"])
    op.create_index("ix_cash_reserve_checks_store_id", "cash_reserve_checks", ["store_id"])
    op.create_index("ix_cash_reserve_checks_store_at", "cash_reserve_checks", ["store_id", "at"])


def downgrade() -> None:
    op.drop_index("ix_cash_reserve_checks_store_at", table_name="cash_reserve_checks")
    op.drop_index("ix_cash_reserve_checks_store_id", table_name="cash_reserve_checks")
    op.drop_index("ix_cash_reserve_checks_organization_id", table_name="cash_reserve_checks")
    op.drop_table("cash_reserve_checks")
    op.drop_index("ix_cash_reserve_movements_shift_at", table_name="cash_reserve_movements")
    op.drop_index("ix_cash_reserve_movements_shift_id", table_name="cash_reserve_movements")
    op.drop_index("ix_cash_reserve_movements_store_id", table_name="cash_reserve_movements")
    op.drop_index("ix_cash_reserve_movements_organization_id", table_name="cash_reserve_movements")
    op.drop_table("cash_reserve_movements")
    op.drop_index("ix_shift_opening_counts_shift_id", table_name="shift_opening_counts")
    op.drop_index("ix_shift_opening_counts_store_id", table_name="shift_opening_counts")
    op.drop_index("ix_shift_opening_counts_organization_id", table_name="shift_opening_counts")
    op.drop_table("shift_opening_counts")
    # `cash_reserve_default` no se devuelve a 0: la cifra que heredó de la
    # base fija sigue siendo verdad sobre la plata, y la regla anterior la
    # ignora igual (sólo leía `opening_cash_fixed`, que nunca se tocó).
    op.drop_column("store_cash_settings", "opening_mode")
    op.drop_column("shifts", "opening_fixed_base")
    op.drop_column("shifts", "opening_mode")
