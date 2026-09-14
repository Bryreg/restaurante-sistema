"""Identidad: empleados (incluido el administrador), sesión de dispositivo y
autorizaciones (SPEC-NEGOCIO §2).

El administrador **es** un `Employee` con `role="admin"` y `store_id=None`
(ve toda la organización): correo + contraseña para entrar en PC, y su propio
PIN de 4 dígitos para autorizar en el POS sin compartir el de nadie más.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import Boolean, ForeignKey, Integer, Numeric, String
from sqlalchemy import Enum as SAEnum
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base, UTCDateTime

ROLE_VALUES = ("operator", "supervisor", "admin")


class Employee(Base):
    __tablename__ = "employees"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    organization_id: Mapped[int] = mapped_column(
        ForeignKey("organizations.id"), nullable=False, index=True
    )
    store_id: Mapped[int | None] = mapped_column(
        ForeignKey("stores.id"), nullable=True, index=True
    )  # None en un admin = toda la organización
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    role: Mapped[str] = mapped_column(
        SAEnum(*ROLE_VALUES, name="employee_role", native_enum=False, length=16), nullable=False
    )
    pin_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    email: Mapped[str | None] = mapped_column(String(255), nullable=True, unique=True)
    password_hash: Mapped[str | None] = mapped_column(String(255), nullable=True)
    can_charge: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    discount_limit_pct: Mapped[Any] = mapped_column(Numeric(5, 2), nullable=True)
    document: Mapped[str | None] = mapped_column(String(30), nullable=True)
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    failed_pin_attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    pin_locked_until: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False)


class DeviceSession(Base):
    """Una tablet activada con el PIN de sede. Sesión larga; prueba *dónde*,
    no *quién* — la persona activa se liga acá, en el servidor, nunca en el
    cliente."""

    __tablename__ = "device_sessions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)  # uuid4
    organization_id: Mapped[int] = mapped_column(
        ForeignKey("organizations.id"), nullable=False, index=True
    )
    store_id: Mapped[int] = mapped_column(ForeignKey("stores.id"), nullable=False, index=True)
    device_name: Mapped[str | None] = mapped_column(String(100), nullable=True)
    employee_id: Mapped[int | None] = mapped_column(
        ForeignKey("employees.id"), nullable=True, index=True
    )
    employee_bound_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    employee_expires_at: Mapped[datetime | None] = mapped_column(
        UTCDateTime(), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False)
    revoked_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)


class Authorization(Base):
    """Cada autorización queda a nombre de quien la dio: es lo que hace un
    reporte de "autorizaciones por autorizador" posible (SPEC-NEGOCIO §2.2)."""

    __tablename__ = "authorizations"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    organization_id: Mapped[int] = mapped_column(
        ForeignKey("organizations.id"), nullable=False, index=True
    )
    store_id: Mapped[int] = mapped_column(ForeignKey("stores.id"), nullable=False, index=True)
    authorizer_id: Mapped[int] = mapped_column(ForeignKey("employees.id"), nullable=False, index=True)
    authorizer_name: Mapped[str] = mapped_column(String(200), nullable=False)
    action: Mapped[str] = mapped_column(String(64), nullable=False)
    requested_by_employee_id: Mapped[int | None] = mapped_column(
        ForeignKey("employees.id"), nullable=True
    )
    at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False, index=True)
    reference_type: Mapped[str | None] = mapped_column(String(64), nullable=True)
    reference_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
