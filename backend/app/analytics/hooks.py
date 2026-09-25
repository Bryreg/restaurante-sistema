"""Contrato publicado de `analytics` para otros dominios.

Ningún dominio de esta fase (ni de las anteriores) necesita leer nada de
`app.analytics` todavía — este territorio es una hoja: **lee** de `orders`,
`inventory` (vía `app.inventory.hooks`) y modelos de sólo lectura de otros
dominios, y no publica nada que otro dominio consuma. Este archivo existe
igual, vacío salvo este docstring, por dos motivos: (1) `docs/CONTEXTO-
AGENTES.md §3` fija que TODO dominio tiene su `hooks.py` como el único punto
de import cruzado, así que si algún pedido futuro necesita leer algo de acá
(por ejemplo, la clasificación de ingeniería de menú para alimentar otro
reporte) ya tiene dónde publicarlo sin reorganizar nada; (2) mantiene la
anatomía de dominio uniforme para que el Conciliador no tenga que hacer una
excepción al cruzar este territorio contra el patrón del resto del repo.

**Primer consumidor (Informes, sep. 2026):** `app.reports.overview` publica un
resumen de la ingeniería de menú —cuántos platos en cada cuadrante— y lo lee
por `menu_class_counts`, que llama a `service.menu_engineering` tal cual.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date

from sqlalchemy.orm import Session

from app.stores.models import Store


@dataclass(frozen=True)
class MenuClassCounts:
    """Cuántos platos quedaron en cada cuadrante de la ingeniería de menú del
    período — el resumen que publica Informes (`app.reports.overview`).
    Contar filas, no plata: los umbrales y la clasificación son los de
    `service.menu_engineering`, tal cual, sin una segunda regla.
    `available=False` trae el motivo en `reason` y los recuentos en cero no
    se leen (quien consume publica `null`)."""

    available: bool
    reason: str | None
    star: int
    plowhorse: int
    puzzle: int
    dog: int
    unclassified: int
    insufficient_sample: int


def menu_class_counts(db: Session, *, store: Store, date_from: date, date_to: date) -> MenuClassCounts:
    from app.analytics import service

    out = service.menu_engineering(db, store=store, date_from=date_from, date_to=date_to)
    counts = out.counts_by_class
    return MenuClassCounts(
        available=out.available,
        reason=out.reason,
        star=counts.star,
        plowhorse=counts.plowhorse,
        puzzle=counts.puzzle,
        dog=counts.dog,
        unclassified=counts.unclassified,
        insufficient_sample=counts.insufficient_sample,
    )
