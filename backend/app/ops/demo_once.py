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

La salida del proceso va a `LOG_PATH`, que el administrador lee con
`GET /admin/ops/demo-status` (sin claves: sólo el registro de la carga).
"""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
from pathlib import Path

from app.core.config import settings

MARKER = Path(__file__).with_name("CARGAR_DEMO")
LOG_PATH = Path(tempfile.gettempdir()) / "demo_run.log"

_state: dict[str, object] = {"launched": False, "reason": "no evaluado"}


def maybe_launch() -> None:
    if settings.ENV != "production":
        _state["reason"] = "no es producción"
        return
    if not MARKER.exists():
        _state["reason"] = "sin marcador"
        return
    if not os.environ.get("DEMO_CLAVES"):
        _state["reason"] = "falta DEMO_CLAVES en el entorno"
        return
    backend_dir = Path(__file__).resolve().parents[2]
    log = LOG_PATH.open("ab")
    subprocess.Popen(  # noqa: S603 — comando fijo, sin entrada del usuario
        [sys.executable, "-u", "-m", "app.ops.demo_run", *MARKER.read_text().split()],
        cwd=backend_dir,
        stdout=log,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    _state["launched"] = True
    _state["reason"] = "lanzado"


def status() -> dict[str, object]:
    tail: list[str] = []
    if LOG_PATH.exists():
        lines = LOG_PATH.read_text(errors="replace").splitlines()
        tail = [ln for ln in lines if "Warning" not in ln and "decode_complete" not in ln and "_jws.encode" not in ln][-80:]
    return {
        "launched": _state["launched"],
        "reason": _state["reason"],
        "marker": MARKER.exists(),
        "log_tail": tail,
    }
