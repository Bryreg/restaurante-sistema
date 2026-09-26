"""Notificaciones por campana, con reglas por sede (SPEC-NEGOCIO §9.3)."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import JSON, Boolean, ForeignKey, Index, Integer, String, UniqueConstraint, text
from sqlalchemy import Enum as SAEnum
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base, UTCDateTime

LEVEL_VALUES = ("info", "warning", "critical")


class Notification(Base):
    __tablename__ = "notifications"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    organization_id: Mapped[int] = mapped_column(
        ForeignKey("organizations.id"), nullable=False, index=True
    )
    store_id: Mapped[int] = mapped_column(ForeignKey("stores.id"), nullable=False, index=True)
    type: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    level: Mapped[str] = mapped_column(
        SAEnum(*LEVEL_VALUES, name="notification_level", native_enum=False, length=16), nullable=False
    )
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    body: Mapped[str] = mapped_column(String(1000), nullable=False)
    payload: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    dedupe_key: Mapped[str | None] = mapped_column(String(200), nullable=True, index=True)
    read_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False, index=True)
    # Cuándo se encoló el aviso al celular (0031, `app.notifications.push`).
    # `None` = no salió al celular (no era grave, la función estaba apagada,
    # nadie tenía un celular activo o ya había salido uno igual hace poco).
    pushed_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)


class NotificationRule(Base):
    __tablename__ = "notification_rules"
    __table_args__ = (
        UniqueConstraint("store_id", "type", name="uq_notification_rules_store_type"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    organization_id: Mapped[int] = mapped_column(
        ForeignKey("organizations.id"), nullable=False, index=True
    )
    store_id: Mapped[int] = mapped_column(ForeignKey("stores.id"), nullable=False, index=True)
    type: Mapped[str] = mapped_column(String(64), nullable=False)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    threshold: Mapped[int | None] = mapped_column(Integer, nullable=True)
    level: Mapped[str] = mapped_column(
        SAEnum(*LEVEL_VALUES, name="notification_level_rule", native_enum=False, length=16),
        nullable=False,
        default="warning",
    )


class PushSubscription(Base):
    """Un celular (o navegador) que recibe los avisos graves de una persona
    (0031, `notifications.push`). Nunca se borra: «Quitar» o un servicio de
    push que responde 404/410 la dan de baja con `revoked_at` y su motivo."""

    __tablename__ = "push_subscriptions"
    # Un mismo celular (endpoint) está activo una sola vez: dos «Activar» a
    # la vez no dejan dos filas vivas que reciban cada aviso dos veces.
    __table_args__ = (
        Index(
            "uq_push_subscriptions_active_endpoint",
            "endpoint",
            unique=True,
            postgresql_where=text("revoked_at IS NULL"),
            sqlite_where=text("revoked_at IS NULL"),
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    organization_id: Mapped[int] = mapped_column(
        ForeignKey("organizations.id"), nullable=False, index=True
    )
    employee_id: Mapped[int] = mapped_column(ForeignKey("employees.id"), nullable=False, index=True)
    endpoint: Mapped[str] = mapped_column(String(1000), nullable=False)
    p256dh: Mapped[str] = mapped_column(String(200), nullable=False)
    auth: Mapped[str] = mapped_column(String(100), nullable=False)
    # La clave pública VAPID con la que el navegador se suscribió: si la del
    # servidor cambia, esta suscripción ya no sirve y se da de baja.
    vapid_public_key: Mapped[str] = mapped_column(String(200), nullable=False)
    user_agent: Mapped[str | None] = mapped_column(String(300), nullable=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False)
    last_success_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    last_error: Mapped[str | None] = mapped_column(String(200), nullable=True)
    revoked_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    revoked_reason: Mapped[str | None] = mapped_column(String(32), nullable=True)


class PushVapidKey(Base):
    """El par de claves VAPID de la organización, generado una vez cuando no
    vienen por variables de entorno. **La privada nunca sale por ninguna
    respuesta**: sólo la lee el despachador para firmar."""

    __tablename__ = "push_vapid_keys"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    organization_id: Mapped[int] = mapped_column(
        ForeignKey("organizations.id"), nullable=False, unique=True
    )
    public_key: Mapped[str] = mapped_column(String(200), nullable=False)
    private_key: Mapped[str] = mapped_column(String(100), nullable=False)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False)
