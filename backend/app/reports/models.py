"""Lo único que el dominio de reportes guarda: la meta de ventas del mes.

Todo lo demás de `app.reports` es derivado (lee snapshots de otros
dominios). La meta no: es una decisión del dueño, por sede y por mes
(«Informe del contador», decisión del dueño 2026-09: igual que café-sistema,
con meta mensual). `amount = NULL` es «sin meta» dicho a propósito para ese
mes — distinto de no haber escrito nada, que hereda la meta del último mes
que sí la tenía.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import CheckConstraint, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base, UTCDateTime


class SalesGoal(Base):
    __tablename__ = "sales_goals"
    __table_args__ = (
        # Dos «Guardar» a la vez no dejan dos metas para el mismo mes: el
        # segundo choca con este único y responde 409.
        UniqueConstraint("store_id", "year", "month", name="uq_sales_goals_store_month"),
        CheckConstraint("month >= 1 AND month <= 12", name="ck_sales_goals_month"),
        CheckConstraint("amount IS NULL OR amount > 0", name="ck_sales_goals_amount_positive"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    organization_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), nullable=False, index=True)
    store_id: Mapped[int] = mapped_column(ForeignKey("stores.id"), nullable=False, index=True)
    year: Mapped[int] = mapped_column(Integer, nullable=False)
    month: Mapped[int] = mapped_column(Integer, nullable=False)
    amount: Mapped[int | None] = mapped_column(Integer, nullable=True)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False)
    updated_by_employee_id: Mapped[int | None] = mapped_column(ForeignKey("employees.id"), nullable=True)
    updated_by_employee_name: Mapped[str | None] = mapped_column(String(200), nullable=True)
