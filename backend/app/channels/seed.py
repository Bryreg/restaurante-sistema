"""Datos de desarrollo de `channels`: `seed_channels(db, ...)`.

**CONTRATO C4-bis.** Lo publica este agente (`backend-dinero-canales`) y lo
llama `app/seed.py`, que es territorio de `backend-canales-comanda`:

    seed_channels(db, *, organization, store, admin) -> dict

Devuelve al menos `{"platform_id": int}` — el id de la plataforma sembrada,
para que quien llama pueda sembrar una comanda de plataforma con su
`external_id` sin tener que buscarla. También devuelve
`"platform_payment_method_added"` (si tuvo que agregar el medio `platform` a
la configuración de ventas de la sede) y `"created"`.

**Idempotente**: si la sede ya tiene alguna plataforma, no crea ninguna y
devuelve la que hay. Correrlo dos veces no duplica nada — está probado en
`tests/channels/test_seed.py`, corriendo el seed dos veces de verdad, no
asumiéndolo.

Escribe las filas DIRECTO (como `seed_purchases`), sin pasar por
`app.channels.service.create_platform`: ese camino pide un `Actor` y hace
auditoría de un administrador que el seed no está simulando.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.channels.models import DeliveryPlatform
from app.channels.service import ensure_platform_payment_method
from app.core import clock

# 18 % en puntos básicos enteros. Es un número realista para el mercado
# colombiano y, sobre todo, es el del ejemplo del contrato de este pedido:
# una venta de $100.000 deja $18.000 de comisión y la venta sigue siendo
# $100.000. Entero: `commission_bp`, nunca `0.18`.
SEED_PLATFORM_COMMISSION_BP = 1_800


def seed_channels(db: Session, *, organization: Any, store: Any, admin: Any = None) -> dict[str, Any]:
    """Siembra UNA plataforma con comisión y deja el medio de pago
    `platform` disponible en la sede. Ver el CONTRATO C4-bis arriba."""
    del admin  # el seed no simula un administrador: escribe directo.

    existing = db.execute(
        select(DeliveryPlatform).where(DeliveryPlatform.store_id == store.id).order_by(DeliveryPlatform.id)
    ).scalars().first()
    if existing is not None:
        added = ensure_platform_payment_method(db, store=store)
        return {
            "platform_id": existing.id,
            "platform_code": existing.code,
            "commission_bp": existing.commission_bp,
            "platform_payment_method_added": added,
            "created": False,
        }

    now = clock.now_utc()
    platform = DeliveryPlatform(
        organization_id=organization.id,
        store_id=store.id,
        name="Rappi",
        code="rappi",
        commission_bp=SEED_PLATFORM_COMMISSION_BP,
        active=True,
        created_at=now,
        updated_at=now,
    )
    db.add(platform)
    db.flush()

    added = ensure_platform_payment_method(db, store=store)

    print(
        f"  Canales: 1 plataforma ({platform.name}, comisión "
        f"{SEED_PLATFORM_COMMISSION_BP / 100:.2f} %), medio de pago `platform` "
        f"{'agregado' if added else 'ya presente'} en la configuración de ventas."
    )
    return {
        "platform_id": platform.id,
        "platform_code": platform.code,
        "commission_bp": platform.commission_bp,
        "platform_payment_method_added": added,
        "created": True,
    }
