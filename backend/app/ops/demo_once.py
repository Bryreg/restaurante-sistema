"""Carga única de la operación de demostración en la base desplegada.

A pedido del dueño (2026-09-28: «ningún dato es real aún»), para ver el panel
lleno y mostrárselo a clientes. El despliegue no tiene consola, así que el
disparo necesita las DOS cosas:

- el archivo marcador `app/ops/CARGAR_DEMO` en el repo (se borra en el commit
  siguiente a la carga), y
- la variable de entorno `DEMO_CLAVES` que el dueño puso en Render con las
  claves reales (JSON de `claves-produccion.json`; se borra después).

Si están las dos y el proceso corre en producción, al arrancar se lanza
`app.ops.demo_run` en un proceso APARTE: su reloj simulado no toca al
servidor, y cada llamada pasa por la API con las claves reales, sin saltarse
ninguna verificación. `demo_run` además se niega a correr dos veces.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

from app.core.config import settings

MARKER = Path(__file__).with_name("CARGAR_DEMO")


def maybe_launch() -> None:
    if settings.ENV != "production" or not MARKER.exists() or not os.environ.get("DEMO_CLAVES"):
        return
    backend_dir = Path(__file__).resolve().parents[2]
    subprocess.Popen(  # noqa: S603 — comando fijo, sin entrada del usuario
        [sys.executable, "-m", "app.ops.demo_run", *MARKER.read_text().split()],
        cwd=backend_dir,
        start_new_session=True,
    )
