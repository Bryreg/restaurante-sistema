"""`find_spec` seguro para un submódulo de un dominio que puede no existir
todavía (patrón "un dominio ausente no rompe nada" de los dos contratos
internos de este proyecto: `features/fase-1a-cimientos/CONTRATO-INTERNO.md`
y `features/fase-1b-venta/CONTRATO-INTERNO-1b-1.md`).

`importlib.util.find_spec("app.payments.models")` importa primero el paquete
padre (`app.payments`) para resolver su `__path__`. Si ese paquete existe
(tiene `__init__.py`, aunque el submódulo puntual no exista) `find_spec`
devuelve `None` sin problema — así funcionó siempre en 1a, porque todo
dominio ausente durante la construcción en paralelo YA tenía su carpeta con
`__init__.py`. Pero si el paquete no existe en absoluto (ninguna carpeta,
como `app/payments` o `app/fiscal` mientras `backend-cobro` no escribió nada
todavía), `find_spec` no devuelve `None`: lanza `ModuleNotFoundError`. Este
envoltorio es la única forma correcta de preguntar "¿existe este módulo?"
cuando el dominio entero puede faltar, no sólo un archivo suyo."""

from __future__ import annotations

import importlib.util
from importlib.machinery import ModuleSpec


def find_spec_safe(module_name: str) -> ModuleSpec | None:
    try:
        return importlib.util.find_spec(module_name)
    except ModuleNotFoundError:
        return None
