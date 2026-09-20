"""CONTRATO C4-bis: `app.channels.seed.seed_channels` es IDEMPOTENTE.

Lo llama `app/seed.py` (territorio de `backend-canales-comanda`), así que la
firma y el diccionario de vuelta son contrato publicado: `{"platform_id":
int, ...}`.

El seed se corre **dos veces de verdad** — no se asume la idempotencia, se
comprueba. Es la lección de 2b: «confirmado con `run_idempotent`, no
asumido».
"""

from __future__ import annotations

import inspect
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.channels.models import DeliveryPlatform
from app.channels.seed import seed_channels
from app.stores import service as stores_service


def test_the_published_signature_is_the_one_the_caller_expects() -> None:
    """Firma estable (C4-bis): `db` posicional y `organization`, `store`,
    `admin` por palabra clave."""
    sig = inspect.signature(seed_channels)
    params = list(sig.parameters)
    assert params[0] == "db"
    for name in ("organization", "store", "admin"):
        assert name in sig.parameters, f"`seed_channels` dejó de aceptar `{name}`"
        assert sig.parameters[name].kind is inspect.Parameter.KEYWORD_ONLY


def test_seeding_twice_does_not_duplicate_anything(db: Session, org: Any, store: Any) -> None:
    first = seed_channels(db, organization=org, store=store, admin=None)
    db.commit()
    assert first["created"] is True
    assert isinstance(first["platform_id"], int)
    assert first["commission_bp"] > 0
    assert isinstance(first["commission_bp"], int)

    second = seed_channels(db, organization=org, store=store, admin=None)
    db.commit()
    assert second["created"] is False
    assert second["platform_id"] == first["platform_id"], "el seed creó una plataforma nueva"

    count = db.execute(
        select(func.count()).select_from(DeliveryPlatform).where(DeliveryPlatform.store_id == store.id)
    ).scalar_one()
    assert int(count) == 1

    # Y el medio de pago tampoco se duplica.
    settings = stores_service.get_sales_settings(db, store.id)
    assert sum(1 for m in settings.payment_methods if m["code"] == "platform") == 1


def test_the_seeded_platform_resolves_through_the_published_contract(
    db: Session, org: Any, store: Any
) -> None:
    """Lo que siembra el seed tiene que ser resoluble por el CONTRATO C2,
    que es por donde lo va a leer `app/orders/**`."""
    from app.channels import hooks

    result = seed_channels(db, organization=org, store=store, admin=None)
    db.commit()
    ref = hooks.get_platform(db, store_id=store.id, platform_id=result["platform_id"])
    assert ref is not None
    assert ref.active is True
    assert ref.commission_bp == result["commission_bp"]
