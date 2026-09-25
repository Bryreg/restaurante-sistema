"""Esquemas de `novelties`. Ninguno lleva plata: una novedad no mueve caja ni
inventario (si se dañó un insumo, eso es una merma, con su pantalla)."""

from __future__ import annotations

from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, Field

from app.photos.hooks import PhotoIn

NoveltyCategoryLiteral = Literal["incident", "equipment", "staff", "customer", "security", "other"]
NoveltyLevelLiteral = Literal["info", "important", "urgent"]
NoveltyStatusLiteral = Literal["open", "all"]


class NoveltyIn(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    detail: str | None = Field(default=None, max_length=4000)
    category: NoveltyCategoryLiteral
    level: NoveltyLevelLiteral = "info"
    requires_follow_up: bool = False
    photo: PhotoIn | None = None


class NoveltyResolveIn(BaseModel):
    note: str = Field(min_length=1, max_length=2000)


class NoveltyOut(BaseModel):
    id: int
    store_id: int
    shift_id: int | None
    business_date: date
    title: str
    detail: str | None
    category: NoveltyCategoryLiteral
    level: NoveltyLevelLiteral
    requires_follow_up: bool
    photo: str | None
    employee_id: int
    employee_name: str
    created_at: datetime
    # `open` = requiere seguimiento y nadie la resolvió todavía. Lo calcula
    # el servidor: la pantalla no decide qué está abierto.
    open: bool
    resolved_at: datetime | None
    resolved_by_employee_name: str | None
    resolution_note: str | None


class NoveltyBoardOut(BaseModel):
    """`GET /novelties/open`: lo que ve el POS. `open` son las que requieren
    seguimiento y siguen sin resolver, de cualquier turno (urgentes primero);
    `this_shift` son todas las registradas en el turno abierto — o, si no hay
    turno abierto, en el día operativo de hoy."""

    open: list[NoveltyOut]
    this_shift: list[NoveltyOut]
    open_count: int
