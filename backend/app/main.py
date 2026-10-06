"""Punto de entrada de la API.

`create_app()` registra los handlers de error y **descubre** los routers de
cada dominio con `find_spec` — así un dominio que otro agente todavía no
terminó de escribir simplemente no se monta, en vez de romper el arranque.
Si existe `../frontend/dist` (build de producción), lo sirve con fallback SPA
después de las rutas `/api`.
"""

from __future__ import annotations

import importlib
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse, JSONResponse
from starlette.responses import Response

from app.core.errors import register_error_handlers
from app.core.modules import find_spec_safe

DOMAINS: list[str] = [
    "auth",
    "stores",
    "catalog",
    "shifts",
    "orders",
    "payments",
    "fiscal",
    "customers",
    "refunds",
    "kitchen",
    "reports",
    "audit",
    "notifications",
    # Pedido 2a (`features/fase-2-costo-inventario/spec.md`): dominios nuevos
    # de `backend-inventario`/`backend-recetas`. Paso 0 de este reparto
    # (verificado antes de tocar esta lista): `app/inventory/__init__.py` y
    # `app/recipes/__init__.py` ya existen con contenido de sus dueños, así
    # que `find_spec_safe("app.inventory.router")` resuelve `None` limpio si
    # algún día falta el archivo puntual — nunca `ModuleNotFoundError` por
    # falta de carpeta (la lección de 1b-1, ver `app.core.modules`).
    "inventory",
    "recipes",
    # Pedido 2b (`features/fase-2-costo-inventario/spec.md § Alcance de 2b`):
    # dominio nuevo de `backend-compras`. Paso 0 de este reparto (verificado
    # antes de tocar esta lista): `app/purchases/__init__.py` ya existe, así
    # que `find_spec_safe("app.purchases.router")` resuelve `None` limpio si
    # algún día falta el archivo puntual — nunca `ModuleNotFoundError`.
    "purchases",
    # Pedido 2c (`features/fase-2c-canales-cocina/spec.md`): dominio nuevo de
    # `backend-dinero-canales` (plataformas, comisiones, cuenta por cobrar y
    # liquidación del efectivo de domicilios). **Paso 0 de este reparto,
    # ejecutado ANTES de tocar esta lista**: `app/channels/__init__.py` ya
    # existe, así que `find_spec_safe("app.channels.router")` resuelve `None`
    # limpio si algún día falta el archivo puntual — nunca
    # `ModuleNotFoundError` por falta de carpeta (la lección de 1b-1, ver
    # `app.core.modules`).
    "channels",
    # Fase 3 (`features/fase-3-dinero-control/spec.md § 2`): CUATRO dominios
    # nuevos, uno por territorio de backend. Los registró el **orquestador
    # humano en el paso 0**, antes de lanzar el equipo, justamente para que
    # cuatro agentes en paralelo no se peleen este archivo: la spec les dice
    # explícitamente que no lo toquen.
    #
    # Paso 0 hecho para los cuatro: `app/<dominio>/__init__.py` existe desde
    # antes de esta línea, así que `find_spec_safe("app.<dominio>.router")`
    # resuelve `None` limpio mientras el router todavía no está escrito —
    # nunca `ModuleNotFoundError` por falta de carpeta (lección de 1b-1, ver
    # `app.core.modules`).
    "banking",
    "expenses",
    "payroll",
    "analytics",
    # Las fotos de soporte, en su tabla (`app/photos/__init__.py`).
    "photos",
    # La rutina del turno en el POS (2026-09-25): solicitudes y novedades.
    "requests",
    "novelties",
    # Etiquetas de cocina con QR (0036).
    "labels",
    # Estado de la carga única de la demo (`app/ops/demo_once.py`).
    "ops",
]


def create_app() -> FastAPI:
    app = FastAPI(title="Restaurante Sistema API", version="0.1.0")

    register_error_handlers(app)

    # Mismo origen (frontend y API bajo el mismo host): no hace falta CORS.
    # Si algún día se sirven desde orígenes distintos en desarrollo, se agrega
    # CORSMiddleware acá — nunca cookies con `SameSite=None` sin `secure`.

    for domain in DOMAINS:
        module_name = f"app.{domain}.router"
        if find_spec_safe(module_name) is not None:
            module = importlib.import_module(module_name)
            router = getattr(module, "router", None)
            if router is not None:
                app.include_router(router, prefix="/api/v1")

    _mount_frontend(app)

    return app


# Archivos de la raíz del build que el navegador trata distinto (avisos al
# celular, 0031). El service worker se sirve desde `/` para que su alcance
# sea todo el sitio, y sin caché: una versión nueva tiene que llegar en la
# próxima visita, no cuando venza un caché de un día. El manifiesto con su
# tipo propio, que es lo que mira el iPhone para «Agregar a inicio».
_ROOT_FILE_HEADERS: dict[str, tuple[str, dict[str, str]]] = {
    "sw.js": ("text/javascript", {"Cache-Control": "no-cache", "Service-Worker-Allowed": "/"}),
    "manifest.webmanifest": ("application/manifest+json", {"Cache-Control": "no-cache"}),
}


def _mount_frontend(app: FastAPI, frontend_dist: Path | None = None) -> None:
    if frontend_dist is None:
        frontend_dist = Path(__file__).resolve().parent.parent.parent / "frontend" / "dist"
    if not frontend_dist.is_dir():
        return
    dist_root = frontend_dist.resolve()

    @app.get("/{full_path:path}", include_in_schema=False)
    async def spa_fallback(full_path: str) -> Response:
        # Una ruta de la API que no existe es un 404 de la API, no la
        # pantalla de la app: si no, una ruta retirada «respondía» 200 con
        # HTML y el cliente no se enteraba.
        if full_path == "api" or full_path.startswith("api/"):
            return JSONResponse(
                {"error": {"code": "NOT_FOUND", "message": "Esa ruta de la API no existe"}}, status_code=404
            )
        candidate = (dist_root / full_path).resolve()
        try:
            candidate.relative_to(dist_root)
        except ValueError:
            candidate = dist_root / "index.html"
        if full_path and candidate.is_file():
            special = _ROOT_FILE_HEADERS.get(full_path)
            if special is not None:
                media_type, headers = special
                return FileResponse(candidate, media_type=media_type, headers=headers)
            return FileResponse(candidate)
        return FileResponse(dist_root / "index.html")


app = create_app()

# Carga única de la demo en el despliegue (ver `app/ops/demo_once.py`): no
# hace nada sin el marcador en el repo y las claves en el entorno.
from app.ops import demo_once  # noqa: E402

demo_once.maybe_launch()
