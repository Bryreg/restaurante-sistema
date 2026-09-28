"""Estado de la carga única de la demo (sólo administrador)."""

from __future__ import annotations

from fastapi import APIRouter, Depends

from app.auth.deps import Actor, current_admin
from app.ops import demo_once

router = APIRouter(tags=["ops"])


@router.get("/admin/ops/demo-status")
def demo_status(actor: Actor = Depends(current_admin)) -> dict[str, object]:
    del actor
    return demo_once.status()
