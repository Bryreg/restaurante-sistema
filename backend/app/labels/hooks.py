"""Lo que otros dominios leen de `labels` (Hoy, en `app.reports`)."""

from __future__ import annotations

from datetime import date

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.labels.models import FoodLabel, LabelStatus


def label_alerts(db: Session, *, store_id: int, today: date) -> dict[str, object]:
    """Etiquetas activas vencidas o que vencen hoy: están en la cocina y ya
    no se deberían usar (o hay que usarlas hoy). Los nombres van sin repetir,
    en el orden en que vencieron."""
    rows = db.execute(
        select(FoodLabel.item_name, FoodLabel.use_by)
        .where(
            FoodLabel.store_id == store_id,
            FoodLabel.status == LabelStatus.ACTIVE,
            FoodLabel.use_by.is_not(None),
            FoodLabel.use_by <= today,
        )
        .order_by(FoodLabel.use_by.asc())
    ).all()
    expired_names: list[str] = []
    for name, use_by in rows:
        if use_by < today and name not in expired_names:
            expired_names.append(name)
    return {
        "expired": sum(1 for _, u in rows if u < today),
        "due_today": sum(1 for _, u in rows if u == today),
        "expired_names": expired_names[:5],
    }
