"""Endpoints de `analytics` (`/api/v1/admin/...`), todas de administrador
(`current_admin`) — este dominio es costos y márgenes, el operador nunca
llega hasta acá (`AGENTS.md`). Sólo borde HTTP: valida, llama a
`app.analytics.service`, serializa (`docs/CONTEXTO-AGENTES.md §3`).

Rutas del **contrato de API mínimo**
(`features/fase-3-dinero-control/spec.md § 2`, tabla T4 — vinculante, no se
renombran ni se cambian): `GET /admin/menu-engineering`,
`GET /admin/variance/by-dish`, `GET /admin/control-health/sustained`,
`GET /admin/replenishment`. Ninguna ruta agregada fuera del contrato.

**Flags y el orden de validación** (`docs/CONTEXTO-AGENTES.md §6`, error
repetido nº6 de `AGENTS.md §14`): `require_feature` NO encadena `requires`
por sí solo — sólo evalúa la clave puntual que se le pasa —, así que cada
ruta valida la dependencia de `app.core.features.FEATURE_CATALOG` (que no se
toca) ANTES que su propia clave, con `dependencies=[Depends(...)]`: FastAPI
resuelve esas dependencias antes de que el cuerpo del endpoint llegue a
`admin_store` (el «gate de sede»), así que «tu plan no incluye esto» le gana
a «esta sede no lo usa» por construcción, igual que `app.banking.router.
_require_bank()`.

- `GET /admin/menu-engineering`: `analytics.menu_engineering` requiere
  `catalog.recipes` — se valida `catalog.recipes` primero.
- `GET /admin/variance/by-dish` y `GET /admin/control-health/sustained`: NO
  son territorio de `analytics.menu_engineering` ni de `inventory.
  replenishment` (el contrato mínimo sólo nombra esos dos flags para T4).
  Ambas son, conceptualmente, una extensión de la varianza de inventario que
  YA vive detrás de `inventory.variance` (§5.4: "varianza de inventario,
  food cost real y salud del control" — la propia descripción del flag en
  `FEATURE_CATALOG`), y `app.inventory.router` gatea sus rutas hermanas
  (`/admin/variance`, `/admin/food-cost`, `/admin/control-health`) con esa
  MISMA clave, sin encadenar manualmente `inventory.counts`/`inventory.
  perpetual`/`catalog.recipes` (se verificó contra su código antes de
  decidir esto). Se reutiliza `inventory.variance` con el mismo criterio de
  su propio dueño, en vez de inventar una tercera clave nueva para el mismo
  concepto — declarado en el entregable, no asumido en silencio.
- `GET /admin/replenishment`: `inventory.replenishment` requiere
  `inventory.perpetual` **y** `purchases` — se validan los dos primero.
"""

from __future__ import annotations

from datetime import date
from typing import Any

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy.orm import Session

from app.analytics import service
from app.analytics.schemas import (
    MenuEngineeringOut,
    ReplenishmentOut,
    SustainedOut,
    VarianceByDishOut,
)
from app.auth.deps import Actor, admin_store, current_actor, current_admin
from app.core.db import get_db
from app.core.features import require_feature

router = APIRouter()


def _require_menu_engineering() -> Any:
    recipes_dep = require_feature("catalog.recipes")
    menu_dep = require_feature("analytics.menu_engineering")

    def _dependency(request: Request, db: Session = Depends(get_db), actor: Actor = Depends(current_actor)) -> None:
        recipes_dep(request=request, db=db, actor=actor)
        menu_dep(request=request, db=db, actor=actor)

    return _dependency


def _require_replenishment() -> Any:
    perpetual_dep = require_feature("inventory.perpetual")
    purchases_dep = require_feature("purchases")
    replenishment_dep = require_feature("inventory.replenishment")

    def _dependency(request: Request, db: Session = Depends(get_db), actor: Actor = Depends(current_actor)) -> None:
        perpetual_dep(request=request, db=db, actor=actor)
        purchases_dep(request=request, db=db, actor=actor)
        replenishment_dep(request=request, db=db, actor=actor)

    return _dependency


@router.get("/admin/menu-engineering", dependencies=[Depends(_require_menu_engineering())])
def get_menu_engineering(
    store_id: int = Query(...),
    date_from: date = Query(..., alias="from"),
    date_to: date = Query(..., alias="to"),
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> MenuEngineeringOut:
    store = admin_store(db, actor, store_id)
    return service.menu_engineering(db, store=store, date_from=date_from, date_to=date_to)


@router.get("/admin/variance/by-dish", dependencies=[Depends(require_feature("inventory.variance"))])
def get_variance_by_dish(
    store_id: int = Query(...),
    # AJUSTE ITERACIÓN 2 (C3/H-3, decisión del Maestro): opcional. El
    # cliente (`frontend/src/api/analytics.ts::getVarianceByDish`) siempre
    # mandó sólo `store_id` y documentó por escrito que `count_id` era
    # "opcional: el más reciente si se omite" — este lado nunca lo cumplió,
    # y toda carga de la pantalla devolvía `422`. Se mueve el backend, no el
    # cliente: es el lado que sabe cuál fue el último conteo aplicado.
    count_id: int | None = Query(default=None),
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> VarianceByDishOut:
    store = admin_store(db, actor, store_id)
    return service.variance_by_dish(db, store=store, count_id=count_id)


@router.get("/admin/control-health/sustained", dependencies=[Depends(require_feature("inventory.variance"))])
def get_control_health_sustained(
    store_id: int = Query(...),
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> SustainedOut:
    store = admin_store(db, actor, store_id)
    return service.control_health_sustained(db, store=store)


@router.get("/admin/replenishment", dependencies=[Depends(_require_replenishment())])
def get_replenishment(
    store_id: int = Query(...),
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> ReplenishmentOut:
    store = admin_store(db, actor, store_id)
    return service.replenishment(db, store=store)
