"""Plataformas, comisiones, cuenta por cobrar y liquidación del efectivo de
domicilios (pedido 2c, `backend-dinero-canales`): `delivery_platforms`,
`delivery_settlements`, `platform_receivables`, `platform_commissions`, más
cuatro columnas en `payments`.

DDL escrito a mano (Postgres-first), como `0008` … `0012`: un índice por FK
y por filtro de pantalla, `CheckConstraint` para las mismas reglas que valida
el modelo.

**`CashMovementCause.DELIVERY_SETTLEMENT` no requiere DDL.** `_enum`
(`app/shifts/models.py`) no pide `create_constraint`, así que
`cash_movements.cause` es un `VARCHAR(32)` pelado en los dos motores: el
valor nuevo entra sin tocar la tabla. Es la lección que `0011_purchases.py`
dejó escrita después de que su `batch_alter_table(recreate="always")`
rompiera `alembic upgrade head` contra Postgres real
(`DependentObjectsStillExist`), sin que ninguna suite sobre SQLite pudiera
verlo. **No se recrea nada acá.**

**Las cuatro columnas nuevas de `payments` son `Integer` sin FK dura, y eso
lo decidió un error real, no una preferencia.** `ALTER TABLE ... ADD COLUMN
... REFERENCES` no lo soporta el dialecto SQLite de Alembic:

    NotImplementedError: No support for ALTER of constraints in SQLite
    dialect. Please refer to the batch mode feature ...

Y la salida que el propio mensaje propone —`batch_alter_table`, que copia y
recrea `payments`— es EXACTAMENTE el DDL que esta migración no puede hacer:
recrear una tabla referenciada es lo que rompió `0011_purchases.py` contra
Postgres real (`DependentObjectsStillExist`), porque
`platform_receivables.payment_id` (creada acá arriba) depende del índice de
la clave primaria de `payments`. Entre una FK declarativa y una cadena de
migraciones que corre en los dos motores, manda la cadena. Precedente del
repo para lo mismo: `reception_lines.stock_batch_id` (`0011`) y
`StockMovement.preparation_id` (`0008`). El modelo declara las mismas
columnas igual (`sa.Integer`), así que DDL y modelos dicen lo mismo —que es
lo que cobra `tests/audit/test_migration_invariants.py`.

Las tablas NUEVAS sí llevan todas sus FK reales: `create_table` no tiene
esta limitación en ningún motor.

Revision ID: 0014
Revises: 0013
Create Date: 2026-09-19
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

from app.channels.models import (
    DeliverySettlementStatus,
    LedgerEntryKind,
    PlatformReceivableStatus,
)

# revision identifiers, used by Alembic.
revision: str = "0014"
# `0013` la escribe `backend-canales-comanda` en este mismo pedido (precio
# por canal, domicilio, curso). No se renumera ni se toca ninguna ajena.
down_revision: str | None = "0013"
branch_labels: Sequence[str] | None = None
depends_on: Sequence[str] | None = None


def _enum(pyenum: type, *, length: int = 32) -> sa.Enum:
    return sa.Enum(pyenum, native_enum=False, length=length, validate_strings=True)


def upgrade() -> None:
    # -- delivery_platforms ----------------------------------------------
    op.create_table(
        "delivery_platforms",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("organization_id", sa.Integer(), sa.ForeignKey("organizations.id"), nullable=False),
        sa.Column("store_id", sa.Integer(), sa.ForeignKey("stores.id"), nullable=False),
        sa.Column("name", sa.String(120), nullable=False),
        sa.Column("code", sa.String(40), nullable=False),
        # Puntos básicos ENTEROS: 100 = 1 %. Nunca `Float`.
        sa.Column("commission_bp", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("commission_bp >= 0", name="ck_delivery_platforms_commission_nonneg"),
        sa.CheckConstraint("commission_bp <= 10000", name="ck_delivery_platforms_commission_max"),
    )
    op.create_index("ix_delivery_platforms_organization_id", "delivery_platforms", ["organization_id"])
    op.create_index("ix_delivery_platforms_store_id", "delivery_platforms", ["store_id"])
    op.create_index("ix_delivery_platforms_store_active", "delivery_platforms", ["store_id", "active"])
    # Índice único PARCIAL: un código por sede entre las activas. La baja
    # lógica tiene que permitir volver a dar de alta el mismo código.
    op.create_index(
        "uq_delivery_platforms_store_code",
        "delivery_platforms",
        ["store_id", "code"],
        unique=True,
        sqlite_where=sa.text("active = 1"),
        postgresql_where=sa.text("active"),
    )

    # -- delivery_settlements --------------------------------------------
    op.create_table(
        "delivery_settlements",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("organization_id", sa.Integer(), sa.ForeignKey("organizations.id"), nullable=False),
        sa.Column("store_id", sa.Integer(), sa.ForeignKey("stores.id"), nullable=False),
        sa.Column("courier_employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=False),
        sa.Column("courier_employee_name", sa.String(200), nullable=False),
        sa.Column("shift_id", sa.Integer(), sa.ForeignKey("shifts.id"), nullable=False),
        sa.Column("cash_movement_id", sa.Integer(), sa.ForeignKey("cash_movements.id"), nullable=True),
        sa.Column("amount", sa.Integer(), nullable=False),
        sa.Column("tip_amount", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("payments_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("status", _enum(DeliverySettlementStatus), nullable=False),
        sa.Column("note", sa.String(400), nullable=True),
        sa.Column("business_date", sa.Date(), nullable=False),
        sa.Column("at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=False),
        sa.Column("employee_name", sa.String(200), nullable=False),
        sa.Column("voided_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("voided_reason", sa.String(400), nullable=True),
        sa.Column("voided_by_employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=True),
        sa.Column("voided_by_employee_name", sa.String(200), nullable=True),
        sa.Column("void_shift_id", sa.Integer(), sa.ForeignKey("shifts.id"), nullable=True),
        sa.Column("void_cash_movement_id", sa.Integer(), sa.ForeignKey("cash_movements.id"), nullable=True),
        sa.CheckConstraint("amount >= 0", name="ck_delivery_settlements_amount_nonneg"),
        sa.CheckConstraint("tip_amount >= 0", name="ck_delivery_settlements_tip_nonneg"),
        sa.CheckConstraint("payments_count >= 0", name="ck_delivery_settlements_count_nonneg"),
    )
    op.create_index("ix_delivery_settlements_organization_id", "delivery_settlements", ["organization_id"])
    op.create_index("ix_delivery_settlements_store_id", "delivery_settlements", ["store_id"])
    op.create_index("ix_delivery_settlements_shift_id", "delivery_settlements", ["shift_id"])
    op.create_index(
        "ix_delivery_settlements_courier_employee_id", "delivery_settlements", ["courier_employee_id"]
    )
    op.create_index(
        "ix_delivery_settlements_cash_movement_id", "delivery_settlements", ["cash_movement_id"]
    )
    op.create_index(
        "ix_delivery_settlements_void_cash_movement_id", "delivery_settlements", ["void_cash_movement_id"]
    )
    op.create_index("ix_delivery_settlements_business_date", "delivery_settlements", ["business_date"])
    op.create_index("ix_delivery_settlements_store_status", "delivery_settlements", ["store_id", "status"])
    op.create_index(
        "ix_delivery_settlements_courier", "delivery_settlements", ["courier_employee_id", "business_date"]
    )

    # -- platform_receivables --------------------------------------------
    op.create_table(
        "platform_receivables",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("organization_id", sa.Integer(), sa.ForeignKey("organizations.id"), nullable=False),
        sa.Column("store_id", sa.Integer(), sa.ForeignKey("stores.id"), nullable=False),
        sa.Column("platform_id", sa.Integer(), sa.ForeignKey("delivery_platforms.id"), nullable=False),
        sa.Column("order_id", sa.Integer(), sa.ForeignKey("orders.id"), nullable=False),
        sa.Column("document_id", sa.Integer(), sa.ForeignKey("fiscal_documents.id"), nullable=True),
        sa.Column("payment_id", sa.Integer(), sa.ForeignKey("payments.id"), nullable=True),
        sa.Column("shift_id", sa.Integer(), sa.ForeignKey("shifts.id"), nullable=True),
        sa.Column("external_id", sa.String(120), nullable=True),
        sa.Column("amount", sa.Integer(), nullable=False),
        sa.Column("tip_amount", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("status", _enum(PlatformReceivableStatus), nullable=False),
        sa.Column("business_date", sa.Date(), nullable=False),
        sa.Column("at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=True),
        sa.Column("employee_name", sa.String(200), nullable=True),
        sa.Column("reversed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("reversed_reason", sa.String(400), nullable=True),
        sa.Column("reversed_by_employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=True),
        sa.Column("reversed_by_employee_name", sa.String(200), nullable=True),
        sa.CheckConstraint("amount >= 0", name="ck_platform_receivables_amount_nonneg"),
        sa.CheckConstraint("tip_amount >= 0", name="ck_platform_receivables_tip_nonneg"),
    )
    op.create_index("ix_platform_receivables_organization_id", "platform_receivables", ["organization_id"])
    op.create_index("ix_platform_receivables_store_id", "platform_receivables", ["store_id"])
    op.create_index("ix_platform_receivables_platform_id", "platform_receivables", ["platform_id"])
    op.create_index("ix_platform_receivables_order_id", "platform_receivables", ["order_id"])
    op.create_index("ix_platform_receivables_document_id", "platform_receivables", ["document_id"])
    op.create_index("ix_platform_receivables_payment_id", "platform_receivables", ["payment_id"])
    op.create_index("ix_platform_receivables_shift_id", "platform_receivables", ["shift_id"])
    op.create_index("ix_platform_receivables_business_date", "platform_receivables", ["business_date"])
    op.create_index("ix_platform_receivables_store_status", "platform_receivables", ["store_id", "status"])
    op.create_index(
        "ix_platform_receivables_platform_date", "platform_receivables", ["platform_id", "business_date"]
    )

    # -- platform_commissions --------------------------------------------
    op.create_table(
        "platform_commissions",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("organization_id", sa.Integer(), sa.ForeignKey("organizations.id"), nullable=False),
        sa.Column("store_id", sa.Integer(), sa.ForeignKey("stores.id"), nullable=False),
        sa.Column("platform_id", sa.Integer(), sa.ForeignKey("delivery_platforms.id"), nullable=False),
        sa.Column("order_id", sa.Integer(), sa.ForeignKey("orders.id"), nullable=False),
        sa.Column("document_id", sa.Integer(), sa.ForeignKey("fiscal_documents.id"), nullable=True),
        sa.Column("receivable_id", sa.Integer(), sa.ForeignKey("platform_receivables.id"), nullable=True),
        sa.Column("kind", _enum(LedgerEntryKind), nullable=False),
        sa.Column("base_amount", sa.Integer(), nullable=False),
        sa.Column("commission_bp", sa.Integer(), nullable=False),
        sa.Column("amount", sa.Integer(), nullable=False),
        sa.Column("business_date", sa.Date(), nullable=False),
        sa.Column("at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("reason", sa.String(400), nullable=True),
        sa.Column("employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=True),
        sa.Column("employee_name", sa.String(200), nullable=True),
        sa.CheckConstraint("base_amount >= 0", name="ck_platform_commissions_base_nonneg"),
        sa.CheckConstraint("commission_bp >= 0", name="ck_platform_commissions_bp_nonneg"),
        sa.CheckConstraint("amount >= 0", name="ck_platform_commissions_amount_nonneg"),
    )
    op.create_index("ix_platform_commissions_organization_id", "platform_commissions", ["organization_id"])
    op.create_index("ix_platform_commissions_store_id", "platform_commissions", ["store_id"])
    op.create_index("ix_platform_commissions_platform_id", "platform_commissions", ["platform_id"])
    op.create_index("ix_platform_commissions_order_id", "platform_commissions", ["order_id"])
    op.create_index("ix_platform_commissions_document_id", "platform_commissions", ["document_id"])
    op.create_index("ix_platform_commissions_receivable_id", "platform_commissions", ["receivable_id"])
    op.create_index("ix_platform_commissions_business_date", "platform_commissions", ["business_date"])
    op.create_index(
        "ix_platform_commissions_platform_date", "platform_commissions", ["platform_id", "business_date"]
    )
    op.create_index(
        "ix_platform_commissions_store_date", "platform_commissions", ["store_id", "business_date"]
    )

    # -- payments: el bolsillo del efectivo y la plataforma ---------------
    # `op.add_column` puro: NADA de `batch_alter_table`/`recreate` sobre
    # `payments`. Recrearla en Postgres obligaría a soltar su clave
    # primaria, de la que dependen `platform_receivables.payment_id` (acá
    # arriba) y todo lo que ya apunta a ella — el mismo
    # `DependentObjectsStillExist` que `0011` documentó. Las cuatro columnas
    # son nullable y sin default, así que SQLite también las agrega en
    # caliente (incluida la que lleva `REFERENCES`: SQLite lo admite
    # mientras el default sea `NULL`).
    op.add_column("payments", sa.Column("delivery_courier_employee_id", sa.Integer(), nullable=True))
    op.add_column("payments", sa.Column("delivery_courier_employee_name", sa.String(200), nullable=True))
    op.add_column("payments", sa.Column("delivery_settlement_id", sa.Integer(), nullable=True))
    op.add_column("payments", sa.Column("platform_id", sa.Integer(), nullable=True))
    op.create_index(
        "ix_payments_delivery_courier_employee_id", "payments", ["delivery_courier_employee_id"]
    )
    op.create_index("ix_payments_delivery_settlement_id", "payments", ["delivery_settlement_id"])
    op.create_index("ix_payments_platform_id", "payments", ["platform_id"])
    op.create_index(
        "ix_payments_delivery_pending", "payments", ["shift_id", "delivery_courier_employee_id"]
    )


def downgrade() -> None:
    op.drop_index("ix_payments_delivery_pending", table_name="payments")
    op.drop_index("ix_payments_platform_id", table_name="payments")
    op.drop_index("ix_payments_delivery_settlement_id", table_name="payments")
    op.drop_index("ix_payments_delivery_courier_employee_id", table_name="payments")
    op.drop_column("payments", "platform_id")
    op.drop_column("payments", "delivery_settlement_id")
    op.drop_column("payments", "delivery_courier_employee_name")
    op.drop_column("payments", "delivery_courier_employee_id")

    op.drop_table("platform_commissions")
    op.drop_table("platform_receivables")
    op.drop_table("delivery_settlements")
    op.drop_table("delivery_platforms")
