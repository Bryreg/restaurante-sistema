"""Descubre los `models.py` de cada dominio sin importarlos a mano.

Lo usan `alembic/env.py` (para que `Base.metadata` tenga todas las tablas
antes de generar o correr una migración) y `tests/conftest.py` (para que
`Base.metadata.create_all` cree el esquema completo). Un dominio que todavía
no existe (por ejemplo `catalog` o `shifts` mientras otro agente los escribe
en paralelo) se salta sin romper nada — es la gracia de `find_spec` en vez de
un `import` directo.
"""

from __future__ import annotations

import importlib

from app.core.modules import find_spec_safe

MODEL_MODULES: list[str] = [
    "core",
    "auth",
    "stores",
    "catalog",
    "shifts",
    "orders",
    "payments",
    "fiscal",
    "audit",
    "notifications",
]


def import_all_models() -> None:
    for domain in MODEL_MODULES:
        module_name = f"app.{domain}.models"
        if find_spec_safe(module_name) is not None:
            importlib.import_module(module_name)
