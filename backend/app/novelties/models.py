"""Modelos de `novelties`: la novedad del turno.

Una novedad es lo que pasó en el turno y alguien tiene que saber («se dañó la
nevera», «faltó un mesero», «un cliente se quejó»). La registra quien está en
el turno, con su PIN (`employee_id` FK real + nombre congelado). La que
**requiere seguimiento** queda abierta y se ve en el POS de todo turno
siguiente hasta que alguien la **resuelve** con una nota; una urgente siempre
requiere seguimiento (el servicio lo fuerza: una urgencia que desaparece al
cambiar de turno no avisó a nadie).

Convenciones heredadas: `UTCDateTime` en todo instante; fecha operativa en
columna propia; enums no nativos sin CHECK. **Nada se borra ni se edita**: una
novedad resuelta queda con quién, cuándo y la nota de cómo se resolvió.
"""

from __future__ import annotations

import enum
from datetime import date, datetime

import sqlalchemy as sa
from sqlalchemy import ForeignKey, Index
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base, UTCDateTime


def _enum(pyenum: type[enum.Enum], *, length: int = 16) -> sa.Enum:
    return sa.Enum(pyenum, native_enum=False, length=length, validate_strings=True)


class NoveltyCategory(str, enum.Enum):
    INCIDENT = "incident"  # incidente
    EQUIPMENT = "equipment"  # equipo
    STAFF = "staff"  # personal
    CUSTOMER = "customer"  # cliente
    SECURITY = "security"  # seguridad
    OTHER = "other"  # otro


class NoveltyLevel(str, enum.Enum):
    INFO = "info"
    IMPORTANT = "important"
    URGENT = "urgent"


class Novelty(Base):
    __tablename__ = "novelties"

    id: Mapped[int] = mapped_column(primary_key=True)
    organization_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), index=True)
    store_id: Mapped[int] = mapped_column(ForeignKey("stores.id"), index=True)
    # El turno abierto cuando se registró, si había uno: una nevera se daña
    # también antes de abrir caja, y eso no puede quedar sin registrarse.
    shift_id: Mapped[int | None] = mapped_column(ForeignKey("shifts.id"), nullable=True, index=True)
    business_date: Mapped[date] = mapped_column(sa.Date)

    title: Mapped[str] = mapped_column(sa.String(200))
    detail: Mapped[str | None] = mapped_column(sa.Text, nullable=True)
    category: Mapped[NoveltyCategory] = mapped_column(_enum(NoveltyCategory))
    level: Mapped[NoveltyLevel] = mapped_column(_enum(NoveltyLevel))
    requires_follow_up: Mapped[bool] = mapped_column(sa.Boolean, default=False)
    photo_url: Mapped[str | None] = mapped_column(sa.String(500), nullable=True)

    employee_id: Mapped[int] = mapped_column(ForeignKey("employees.id"))
    employee_name: Mapped[str] = mapped_column(sa.String(200))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime())

    resolved_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    resolved_by_employee_id: Mapped[int | None] = mapped_column(ForeignKey("employees.id"), nullable=True)
    resolved_by_employee_name: Mapped[str | None] = mapped_column(sa.String(200), nullable=True)
    resolution_note: Mapped[str | None] = mapped_column(sa.Text, nullable=True)

    __table_args__ = (
        Index("ix_novelties_store_open", "store_id", "requires_follow_up", "resolved_at"),
        Index("ix_novelties_store_date", "store_id", "business_date"),
    )
