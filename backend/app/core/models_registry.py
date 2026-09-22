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
    "customers",
    "refunds",
    "reports",
    "audit",
    "notifications",
    # Pedido 2a: ver el mismo comentario en `app.main.DOMAINS`.
    "inventory",
    "recipes",
    # Pedido 2b: ver el mismo comentario en `app.main.DOMAINS`.
    "purchases",
    # Pedido 2c (`features/fase-2c-canales-cocina/spec.md`), CONTRATO C5.
    # `backend-dinero-canales` es el ÚNICO dueño de este archivo y de
    # `app.main.DOMAINS`, y registra DOS dominios, no uno:
    #
    # - `channels` es suyo (plataformas, comisiones, cuenta por cobrar y
    #   liquidación del efectivo de domicilios). Paso 0 hecho:
    #   `app/channels/__init__.py` existe desde antes de esta línea.
    # - `kitchen` NO es suyo: lo escribe `backend-kds`, que en 2c le agrega
    #   `app/kitchen/models.py` (hasta 2b ese dominio no tenía modelos, por
    #   eso nunca estuvo acá) y que tiene PROHIBIDO tocar este archivo.
    #   Sin esta línea las tablas del KDS no entran a `Base.metadata`, y por
    #   lo tanto no existen ni para Alembic ni para `create_all` en los
    #   tests, y su dueño no podría arreglarlo desde su territorio. Es H-0 de
    #   2b en su forma exacta —uno agrega al modelo, otro produce, nadie es
    #   dueño del contrato publicado— resuelto de antemano.
    #   `find_spec_safe` ya devolvía `None` para `app.kitchen.models` (la
    #   carpeta existe desde 1b-1), así que registrarlo es inofensivo aunque
    #   el archivo todavía no esté escrito.
    "channels",
    "kitchen",
    # Fase 3 (`features/fase-3-dinero-control/spec.md § 2`): ver el mismo
    # comentario en `app.main.DOMAINS`. Registrados por el orquestador humano
    # en el paso 0; ningún agente de la fase toca este archivo.
    "banking",
    "expenses",
    "payroll",
    "analytics",
    # Reservas de mesa. Sin esta línea la tabla no entra a `Base.metadata` y
    # por lo tanto no existe ni para Alembic ni para `create_all` en los
    # tests — el modo exacto en que un dominio nuevo «funciona» hasta que
    # alguien corre una migración.
    "reservations",
]


def import_all_models() -> None:
    for domain in MODEL_MODULES:
        module_name = f"app.{domain}.models"
        if find_spec_safe(module_name) is not None:
            importlib.import_module(module_name)
