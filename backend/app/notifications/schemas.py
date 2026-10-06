from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field


class NotificationOut(BaseModel):
    id: int
    #: La sede del aviso: la vista del aviso la nombra («Crítico · Caja ·
    #: Chapinero») porque se puede abrir desde el celular con otra sede elegida.
    store_id: int | None = None
    type: str
    level: str
    title: str
    body: str
    payload: dict[str, Any] | None = None
    #: Lo vio alguien en la campana: deja de contar como nuevo.
    read_at: datetime | None = None
    #: Se atendió (0042): recién ahí sale de «Requiere tu atención». Lo
    #: firma la persona que tocó «Resolver» o «Sistema» cuando la condición
    #: se apagó sola.
    resolved_at: datetime | None = None
    resolved_by_name: str | None = None
    created_at: datetime


class NotificationResolveIn(BaseModel):
    """«Resolver» desde el riel de Hoy: uno o varios avisos (el resumen de
    caja junta varios en una sola tarjeta)."""

    notification_ids: list[int] = Field(min_length=1, max_length=200)


class NotificationResolveOut(BaseModel):
    #: Cuántos estaban abiertos y quedaron resueltos con esta llamada.
    resolved: int


class NotificationRuleOut(BaseModel):
    type: str
    enabled: bool
    threshold: int | None = None
    level: str
    # Sólo en los tipos cuyo emisor lee el umbral (`THRESHOLD_DEFAULTS`):
    # el valor que manda mientras la sede no guarde uno, y qué mide. En los
    # demás tipos llegan `None` y el umbral no aplica.
    threshold_default: int | None = None
    threshold_unit: str | None = None


class NotificationRuleIn(BaseModel):
    type: str
    enabled: bool
    # `None` = el default del tipo. Un umbral en cero o negativo dispararía
    # la alerta siempre: se rechaza antes de escribir.
    threshold: int | None = Field(default=None, ge=1, le=100_000)
    level: str


# ---------------------------------------------------------------------------
# Avisos al celular (0031, `notifications.push`)
# ---------------------------------------------------------------------------


class PushPublicKeyOut(BaseModel):
    """La clave pública VAPID con la que el navegador se suscribe. La
    privada no viaja nunca."""

    public_key: str


class PushKeysIn(BaseModel):
    p256dh: str = Field(min_length=1, max_length=200)
    auth: str = Field(min_length=1, max_length=100)


class PushSubscribeIn(BaseModel):
    """La forma de `PushSubscription.toJSON()` del navegador."""

    endpoint: str = Field(min_length=1, max_length=1000)
    keys: PushKeysIn


class PushUnsubscribeIn(BaseModel):
    subscription_id: int | None = None
    endpoint: str | None = Field(default=None, max_length=1000)


class PushDeviceOut(BaseModel):
    id: int
    label: str
    endpoint: str
    created_at: datetime
    last_success_at: datetime | None = None
    last_error: str | None = None


class PushUnsubscribeOut(BaseModel):
    removed: bool


class PushTestOut(BaseModel):
    sent: int
    failed: int
    removed: int
