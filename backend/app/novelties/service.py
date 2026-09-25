"""Lógica de `novelties`: registrar, listar lo abierto y resolver.

Reglas:
- Una novedad **urgente siempre requiere seguimiento**: se fuerza acá, no en
  la pantalla. Una urgencia que se pierde al cambiar de turno no avisó a nadie.
- «Abierta» = requiere seguimiento y nadie la resolvió. Una novedad
  informativa sin seguimiento no está abierta nunca: queda en el registro del
  turno y en el histórico, sin pedirle nada a nadie.
- Resolver exige una nota (cómo se resolvió) y una persona; se resuelve una
  sola vez (`409 NOVELTY_ALREADY_RESOLVED`). Nada se borra ni se reabre: si
  vuelve a pasar, es una novedad nueva.
- Todo se valida antes de escribir (`get_db` comitea también ante un
  `AppError`).
"""

from __future__ import annotations

from datetime import date
from typing import Any

from sqlalchemy import case, select
from sqlalchemy.orm import Session

from app.auth.deps import Actor
from app.core import clock, tz
from app.core.errors import AppError, NotFoundError
from app.novelties.models import Novelty, NoveltyCategory, NoveltyLevel
from app.novelties.schemas import NoveltyBoardOut, NoveltyIn, NoveltyOut, NoveltyResolveIn
from app.photos import hooks as photos_hooks
from app.shifts import hooks as shifts_hooks
from app.stores.models import Store

# Urgentes primero, después importantes, después informativas; dentro de cada
# nivel, la más vieja primero (lleva más tiempo esperando).
_LEVEL_ORDER = case(
    (Novelty.level == NoveltyLevel.URGENT, 0),
    (Novelty.level == NoveltyLevel.IMPORTANT, 1),
    else_=2,
)


def _open_shift_id(db: Session, store_id: int) -> int | None:
    return db.execute(shifts_hooks.open_shift_ids_query(store_id)).scalars().first()


def _open_clause() -> Any:
    return (Novelty.requires_follow_up.is_(True)) & (Novelty.resolved_at.is_(None))


def novelty_out(row: Novelty) -> NoveltyOut:
    return NoveltyOut(
        id=row.id,
        store_id=row.store_id,
        shift_id=row.shift_id,
        business_date=row.business_date,
        title=row.title,
        detail=row.detail,
        category=row.category.value,  # type: ignore[arg-type]
        level=row.level.value,  # type: ignore[arg-type]
        requires_follow_up=row.requires_follow_up,
        photo=row.photo_url,
        employee_id=row.employee_id,
        employee_name=row.employee_name,
        created_at=row.created_at,
        open=row.requires_follow_up and row.resolved_at is None,
        resolved_at=row.resolved_at,
        resolved_by_employee_name=row.resolved_by_employee_name,
        resolution_note=row.resolution_note,
    )


def create_novelty(db: Session, *, store: Store, actor: Actor, data: NoveltyIn) -> Novelty:
    title = data.title.strip()
    if not title:
        raise AppError(code="VALIDATION_ERROR", message="Escribí qué pasó")
    if actor.employee_id is None or not actor.employee_name:
        raise AppError(code="IDENTIFY_REQUIRED", message="Identificate con tu PIN para registrar la novedad", status=401)
    level = NoveltyLevel(data.level)
    detail = data.detail.strip() if data.detail is not None and data.detail.strip() else None

    now = clock.now_utc()
    row = Novelty(
        organization_id=store.organization_id,
        store_id=store.id,
        shift_id=_open_shift_id(db, store.id),
        business_date=tz.business_date_for(now, store.cutoff_hour),
        title=title,
        detail=detail,
        category=NoveltyCategory(data.category),
        level=level,
        requires_follow_up=data.requires_follow_up or level is NoveltyLevel.URGENT,
        photo_url=photos_hooks.store_photo(db, data.photo, organization_id=store.organization_id, store_id=store.id),
        employee_id=actor.employee_id,
        employee_name=actor.employee_name,
        created_at=now,
    )
    db.add(row)
    db.flush()
    return row


def list_open(db: Session, *, store_id: int) -> list[Novelty]:
    stmt = (
        select(Novelty)
        .where(Novelty.store_id == store_id, _open_clause())
        .order_by(_LEVEL_ORDER, Novelty.created_at, Novelty.id)
    )
    return list(db.execute(stmt).scalars().all())


def list_this_shift(db: Session, *, store: Store) -> list[Novelty]:
    """Las del turno abierto; sin turno abierto, las del día operativo."""
    shift_id = _open_shift_id(db, store.id)
    stmt = select(Novelty).where(Novelty.store_id == store.id)
    if shift_id is not None:
        stmt = stmt.where(Novelty.shift_id == shift_id)
    else:
        stmt = stmt.where(Novelty.business_date == tz.today_business_date(store.cutoff_hour))
    return list(db.execute(stmt.order_by(Novelty.created_at.desc(), Novelty.id.desc())).scalars().all())


def board(db: Session, *, store: Store) -> NoveltyBoardOut:
    open_rows = list_open(db, store_id=store.id)
    return NoveltyBoardOut(
        open=[novelty_out(r) for r in open_rows],
        this_shift=[novelty_out(r) for r in list_this_shift(db, store=store)],
        open_count=len(open_rows),
    )


def list_admin(
    db: Session, *, store: Store, status: str, date_from: date | None, date_to: date | None
) -> list[Novelty]:
    stmt = select(Novelty).where(Novelty.store_id == store.id)
    if status == "open":
        stmt = stmt.where(_open_clause())
    if date_from is not None:
        stmt = stmt.where(Novelty.business_date >= date_from)
    if date_to is not None:
        stmt = stmt.where(Novelty.business_date <= date_to)
    if status == "open":
        stmt = stmt.order_by(_LEVEL_ORDER, Novelty.created_at, Novelty.id)
    else:
        stmt = stmt.order_by(Novelty.created_at.desc(), Novelty.id.desc())
    return list(db.execute(stmt).scalars().all())


def novelty_or_404(db: Session, *, store: Store, novelty_id: int) -> Novelty:
    row = db.execute(select(Novelty).where(Novelty.id == novelty_id).with_for_update()).scalar_one_or_none()
    if row is None or row.organization_id != store.organization_id or row.store_id != store.id:
        raise NotFoundError("La novedad no existe")
    return row


def resolve_novelty(db: Session, *, store: Store, actor: Actor, novelty_id: int, data: NoveltyResolveIn) -> Novelty:
    row = novelty_or_404(db, store=store, novelty_id=novelty_id)
    if row.resolved_at is not None:
        raise AppError(
            code="NOVELTY_ALREADY_RESOLVED",
            message=f"Esta novedad ya la resolvió {row.resolved_by_employee_name or 'otra persona'}",
            status=409,
        )
    note = data.note.strip()
    if not note:
        raise AppError(code="VALIDATION_ERROR", message="Contá en una nota cómo se resolvió la novedad")
    if actor.employee_id is None or not actor.employee_name:
        raise AppError(code="IDENTIFY_REQUIRED", message="Identificate con tu PIN para resolver la novedad", status=401)

    row.resolved_at = clock.now_utc()
    row.resolved_by_employee_id = actor.employee_id
    row.resolved_by_employee_name = actor.employee_name
    row.resolution_note = note
    db.flush()
    return row


# Lecturas para otros dominios (`hooks.py` las publica).


def open_count(db: Session, *, store_id: int) -> int:
    return len(list_open(db, store_id=store_id))


def urgent_open(db: Session, *, store_id: int) -> list[Novelty]:
    return [r for r in list_open(db, store_id=store_id) if r.level is NoveltyLevel.URGENT]
