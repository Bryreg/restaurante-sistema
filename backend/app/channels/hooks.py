"""Contratos PUBLICADOS de `channels` hacia otros dominios (pedido 2c).

Este módulo no importa `app.channels.service` (evita el ciclo: `service` sí
importa `hooks`). Sólo depende de `app.channels.models` y de `app.core`.

**CONTRATO C2 — `get_platform`.** Lo publica este agente
(`backend-dinero-canales`) y lo llama `backend-canales-comanda` desde
`app/orders/**` con `app.core.modules.find_spec_safe`, para validar la
plataforma de una comanda de canal `platform`:

    get_platform(db, *, store_id: int, platform_id: int) -> PlatformRef | None

Devuelve `None` —y **quien llama rechaza la comanda con `400`**— en los
tres casos: no existe, no es de esa sede, o está inactiva. Nunca levanta
excepción por "no existe": es una lectura, no un gate. Firma **estable**;
cambiarla se declara por escrito nombrando a quien la llama.

`PlatformRef` es un objeto liviano (`dataclass` congelada) con `id`,
`name`, `commission_bp` y `active`, deliberadamente SIN el modelo ORM
adentro: quien llama no tiene que aprender el esquema de otro dominio para
leer un nombre y un porcentaje.

**Por qué `commission_bp` viaja en el contrato y no un `%`**: 100 = 1 %,
entero. Es el precedente de 2b (`WasteKpiOut.ratio`, que pasó de `float` a
`int` en basis points). Un `float` acá reaparece redondeado distinto en
cada capa.
"""

from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.channels.models import DeliveryPlatform


@dataclass(frozen=True)
class PlatformRef:
    """Vista liviana de una plataforma para dominios ajenos (CONTRATO C2)."""

    id: int
    name: str
    code: str
    commission_bp: int
    active: bool


def get_platform(db: Session, *, store_id: int, platform_id: int) -> PlatformRef | None:
    """CONTRATO C2. La plataforma `platform_id` de la sede `store_id`, o
    `None` si no existe, es de otra sede, o está inactiva.

    Quien llama (`app/orders/**`, `backend-canales-comanda`) rechaza la
    comanda con `400` ante `None`. Acá no se levanta `AppError`: un hook de
    lectura que decide el código HTTP de otro dominio es exactamente el
    cruce que 2b pagó cuatro veces.
    """
    row = db.get(DeliveryPlatform, platform_id)
    if row is None or row.store_id != store_id or not row.active:
        return None
    return PlatformRef(
        id=row.id,
        name=row.name,
        code=row.code,
        commission_bp=row.commission_bp,
        active=row.active,
    )


def list_active_platforms(db: Session, *, store_id: int) -> list[PlatformRef]:
    """Las plataformas activas de una sede, para que el POS ofrezca una
    lista en vez de pedir un id a ciegas. Misma vista liviana que C2."""
    rows = (
        db.execute(
            select(DeliveryPlatform)
            .where(DeliveryPlatform.store_id == store_id, DeliveryPlatform.active.is_(True))
            .order_by(DeliveryPlatform.name)
        )
        .scalars()
        .all()
    )
    return [
        PlatformRef(id=r.id, name=r.name, code=r.code, commission_bp=r.commission_bp, active=r.active)
        for r in rows
    ]
