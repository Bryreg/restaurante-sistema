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
from fastapi.responses import FileResponse
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
    "kitchen",
    "audit",
    "notifications",
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


def _mount_frontend(app: FastAPI) -> None:
    frontend_dist = Path(__file__).resolve().parent.parent.parent / "frontend" / "dist"
    if not frontend_dist.is_dir():
        return
    dist_root = frontend_dist.resolve()

    @app.get("/{full_path:path}", include_in_schema=False)
    async def spa_fallback(full_path: str) -> Response:
        candidate = (dist_root / full_path).resolve()
        try:
            candidate.relative_to(dist_root)
        except ValueError:
            candidate = dist_root / "index.html"
        if full_path and candidate.is_file():
            return FileResponse(candidate)
        return FileResponse(dist_root / "index.html")


app = create_app()
