"""`GET /photos/{id}`: la foto, para quien es de la misma organización.

La ve el administrador y la ve una tablet activada de la organización (el
turno muestra la foto del retiro que acaba de sacar). Nunca otra
organización: a esa le responde 404, igual que a una foto que no existe.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session
from starlette.responses import Response

from app.auth.deps import Actor, _read_admin_actor, current_device
from app.core.db import get_db
from app.core.errors import AppError
from app.photos.models import Photo

router = APIRouter(tags=["photos"])


def _viewer(request: Request, db: Session = Depends(get_db)) -> Actor:
    """El admin con su sesión web, o si no, la tablet (con o sin persona)."""
    return _read_admin_actor(request, db) or current_device(request, db)


@router.get("/photos/{photo_id}")
def get_photo(photo_id: int, actor: Actor = Depends(_viewer), db: Session = Depends(get_db)) -> Response:
    photo = db.get(Photo, photo_id)
    if photo is None or photo.organization_id != actor.organization_id:
        raise AppError("NOT_FOUND", "La foto no existe", status=404)
    return Response(
        content=photo.data,
        media_type=photo.content_type,
        # Nunca cambia (no se edita): el navegador la guarda, pero sólo para
        # esta sesión (`private`), nunca un proxy compartido.
        headers={"Cache-Control": "private, max-age=86400"},
    )
