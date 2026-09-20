"""Los mensajes que lee una persona no nombran cosas de programadores.

`AGENTS.md` y SPEC-NEGOCIO §11.18 piden que todo error de negocio lleve un
mensaje que **nombre la acción correctiva**. Un mensaje que dice
`app.payroll.hooks.period_payroll_cost no tiene datos suficientes` cumple la
forma —es un texto, está en el campo correcto— y no cumple nada de lo que
importa: quien lo lee es el dueño de un restaurante, y le acabamos de poner el
nombre de una función de Python en la pantalla.

Los dos casos que motivaron este archivo los encontró el **recorrido en
navegador real** de la fase 3, no la suite:

- `GET /admin/profit` respondía `reason: "app.payroll.hooks.
  period_payroll_cost no tiene datos suficientes para este período."`
- y, para el caso en que la costura todavía no existiera, un mensaje que
  además nombraba a dos agentes del equipo que la construyó.

Ninguno de los dos le dice a nadie qué hacer. Hoy los dos dicen qué falta y en
qué pantalla se carga.

**Qué mide este invariante**: ningún literal de texto que viaje a una
respuesta HTTP —el `message` de un `AppError`, un `reason`, una `description`—
contiene una ruta de módulo de Python, un nombre de archivo `.py`, ni el id de
un agente del equipo. No mira docstrings, ni llamadas al logger, ni las
cadenas que son de verdad nombres de módulo (`importlib`, `find_spec`,
`getattr`): esas son código, no pantalla.
"""

from __future__ import annotations

import ast
import re
from pathlib import Path

APP = Path(__file__).resolve().parents[2] / "app"

# `app.algo.otra_cosa` (dos puntos o más), `algo.py`, o el id de un agente.
RUTA_DE_MODULO = re.compile(r"\bapp\.[a-z_]+\.[a-z_]+")
ARCHIVO_PY = re.compile(r"\b[a-z_]+\.py\b")
ID_DE_AGENTE = re.compile(r"\bbackend-[a-z-]+|\bfrontend-[a-z0-9-]+|\bauditor-[a-z0-9-]+")

# Llamadas cuyo argumento de texto ES un nombre de módulo o una clave interna,
# no un mensaje: ahí la ruta es legítima.
LLAMADAS_TECNICAS = {
    "import_module",
    "find_spec",
    "find_spec_safe",
    "getattr",
    "hasattr",
    "setattr",
    "debug",
    "info",
    "warning",
    "error",
    "exception",
    "critical",
    "getLogger",
}


# Excepciones que NO son de negocio: van a un `500 INTERNAL_ERROR` genérico y
# su texto no llega nunca a una pantalla (lo dice `app/core/errors.py`). Ahí
# nombrar el módulo que falta es exactamente lo correcto — es un despliegue
# roto, y quien lo lee es quien lo despliega.
EXCEPCIONES_TECNICAS = {"RuntimeError", "ValueError", "TypeError", "AssertionError", "NotImplementedError"}

# Los `seed.py` imprimen por consola para quien corre el comando, no para un
# usuario del producto.
ARCHIVOS_DE_CONSOLA = {"seed.py"}


def _nombre_de_llamada(node: ast.Call) -> str:
    func = node.func
    if isinstance(func, ast.Attribute):
        return func.attr
    if isinstance(func, ast.Name):
        return func.id
    return ""


class _Recolector(ast.NodeVisitor):
    """Junta los literales que viajan a una respuesta, con su línea."""

    def __init__(self) -> None:
        self.sospechosos: list[tuple[int, str]] = []
        self._dentro_de_tecnica = 0

    def visit_Call(self, node: ast.Call) -> None:
        tecnica = _nombre_de_llamada(node) in LLAMADAS_TECNICAS
        if tecnica:
            self._dentro_de_tecnica += 1
        self.generic_visit(node)
        if tecnica:
            self._dentro_de_tecnica -= 1

    def visit_Raise(self, node: ast.Raise) -> None:
        exc = node.exc
        nombre = ""
        if isinstance(exc, ast.Call):
            nombre = _nombre_de_llamada(exc)
        elif isinstance(exc, ast.Name):
            nombre = exc.id
        tecnica = nombre in EXCEPCIONES_TECNICAS
        if tecnica:
            self._dentro_de_tecnica += 1
        self.generic_visit(node)
        if tecnica:
            self._dentro_de_tecnica -= 1

    def visit_Assert(self, node: ast.Assert) -> None:
        # Un `assert` es una guarda para el equipo, no un mensaje de pantalla.
        self._dentro_de_tecnica += 1
        self.generic_visit(node)
        self._dentro_de_tecnica -= 1

    def visit_Constant(self, node: ast.Constant) -> None:
        if self._dentro_de_tecnica:
            return
        if not isinstance(node.value, str):
            return
        texto = node.value
        # Un literal de una sola palabra sin espacios no es un mensaje: es una
        # clave, un `scope`, un nombre de columna.
        if " " not in texto.strip():
            return
        if RUTA_DE_MODULO.search(texto) or ARCHIVO_PY.search(texto) or ID_DE_AGENTE.search(texto):
            self.sospechosos.append((node.lineno, texto))


def _literales_de_mensaje(fuente: str) -> list[tuple[int, str]]:
    arbol = ast.parse(fuente)
    # Los docstrings son documentación para quien lee el código: se sacan
    # antes de mirar, porque ahí nombrar un módulo es exactamente lo correcto.
    for nodo in ast.walk(arbol):
        if isinstance(nodo, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            cuerpo = getattr(nodo, "body", [])
            if (
                cuerpo
                and isinstance(cuerpo[0], ast.Expr)
                and isinstance(cuerpo[0].value, ast.Constant)
                and isinstance(cuerpo[0].value.value, str)
            ):
                cuerpo[0].value.value = ""
    recolector = _Recolector()
    recolector.visit(arbol)
    return recolector.sospechosos


def test_no_user_facing_message_names_a_python_module_or_an_agent() -> None:
    hallazgos: list[str] = []
    for archivo in sorted(APP.rglob("*.py")):
        if "__pycache__" in archivo.parts or archivo.name in ARCHIVOS_DE_CONSOLA:
            continue
        for linea, texto in _literales_de_mensaje(archivo.read_text(encoding="utf-8")):
            relativo = archivo.relative_to(APP.parent)
            hallazgos.append(f"{relativo}:{linea}: {texto[:150]}")

    assert not hallazgos, (
        "hay textos con nombres de módulos, archivos .py o ids de agentes que pueden llegar a "
        "una pantalla. Quien los lee es el dueño de un restaurante: el mensaje tiene que decir "
        "QUÉ FALTA y EN QUÉ PANTALLA se arregla (AGENTS.md; SPEC-NEGOCIO §11.18). Si el texto es "
        "para el equipo y no para una persona, va al logger, no a la respuesta.\n  - "
        + "\n  - ".join(hallazgos)
    )
