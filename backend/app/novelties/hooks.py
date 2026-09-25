"""Lo que otros dominios leen de `novelties`.

- `open_count(db, store_id)` — cuántas novedades requieren seguimiento y
  siguen sin resolver. Para la bandeja de Hoy (`app.reports`).
- `urgent_open(db, store_id)` — las urgentes abiertas, de la más vieja a la
  más nueva, como `UrgentNovelty` (sin foto ni detalle: la bandeja muestra el
  título y enlaza a la novedad).

Este dominio no importa `app.reports`: la dependencia va en un solo sentido.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

from sqlalchemy.orm import Session

from app.novelties import service


def open_count(db: Session, store_id: int) -> int:
    return service.open_count(db, store_id=store_id)


@dataclass(frozen=True)
class UrgentNovelty:
    id: int
    title: str
    category: str
    employee_name: str
    created_at: datetime


def urgent_open(db: Session, store_id: int) -> list[UrgentNovelty]:
    return [
        UrgentNovelty(
            id=r.id,
            title=r.title,
            category=r.category.value,
            employee_name=r.employee_name,
            created_at=r.created_at,
        )
        for r in service.urgent_open(db, store_id=store_id)
    ]
