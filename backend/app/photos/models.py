"""La foto, con sus bytes. Una fila por foto: nunca se edita ni se borra —es
soporte de un registro de plata o de inventario, y esos no se borran—."""

from __future__ import annotations

from datetime import datetime

import sqlalchemy as sa
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base, UTCDateTime


class Photo(Base):
    __tablename__ = "photos"

    id: Mapped[int] = mapped_column(sa.Integer, primary_key=True)
    organization_id: Mapped[int] = mapped_column(sa.ForeignKey("organizations.id"), index=True)
    store_id: Mapped[int | None] = mapped_column(sa.ForeignKey("stores.id"), nullable=True)
    content_type: Mapped[str] = mapped_column(sa.String(32))
    size_bytes: Mapped[int] = mapped_column(sa.Integer)
    data: Mapped[bytes] = mapped_column(sa.LargeBinary)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime())
