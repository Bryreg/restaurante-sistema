"""Ningún servicio escribe antes de poder rechazar.

`app/core/db.py` hace `commit()` cuando se levanta un `AppError` —a
propósito, y está documentado ahí: si no, cinco PIN fallidos nunca bloquean
nada porque cada intento se revierte a sí mismo—. El precio de esa decisión
es un contrato: **para cuando un servicio escribe, la operación ya tiene que
estar decidida**. Un servicio que escribe y después valida deja aplicado lo
que la respuesta dice que rechazó.

Nació de un defecto real, encontrado jugando una venta en el navegador:
`add_discount` sumaba a `item.discount_amount` y ocho líneas más abajo
comprobaba el límite del empleado. El operador pedía 40% con un límite de
10%, el sistema respondía 400 «pedí el PIN de un supervisor», él no lo
pedía, **y el descuento quedaba aplicado igual** — sin fila en
`order_discounts` y sin nada en la auditoría, así que ningún reporte de
descuentos por autorizador lo mostraba. Repitiendo el mismo rechazo cuatro
veces, un plato de $26.000 quedaba en $0. El test que cubría ese endpoint
miraba el código de error y el caso autorizado; nunca miró la plata.

El mismo barrido encontró otros tres: `update_ingredient`,
`update_platform` y `add_items` (dos platos, el segundo inválido → 400 y el
primero metido en la comanda igual, que después sale dos veces a cocina).

Qué mide: por cada función de `app/`, recorre los CAMINOS de ejecución —no
las líneas— y marca los que pueden levantar un error de negocio después de
haber escrito. Las ramas de un `if/elif` son caminos distintos y no se
mezclan; un `except` que hace `db.rollback()` antes de levantar no cuenta,
porque ahí la escritura ya se deshizo.
"""

from __future__ import annotations

import ast
import pathlib

ERRORES_DE_NEGOCIO = {"AppError", "NotFoundError", "ConflictError", "ForbiddenError", "FeatureDisabledError"}
SESIONES = {"db", "session", "sess"}

_RAZON_INTEGRITY = (
    "El rechazo sale de un `except IntegrityError`: el INSERT que lo disparó "
    "no quedó aplicado, y `test_duplicate_valid_from_conflicts` comprueba que "
    "la respuesta es un 409 limpio."
)

# Los caminos que SÍ pueden escribir antes de rechazar, con el porqué. Cada
# entrada es una decisión tomada, no una excepción heredada: agregar una acá
# es declarar por escrito que esa escritura tiene que sobrevivir al rechazo.
PERMITIDOS = {
    ("app/inventory/service.py", "save_count_lines"): (
        "Un guardado parcial de un conteo es válido por diseño y está escrito "
        "en su docstring: los renglones ya capturados se conservan aunque uno "
        "posterior venga mal. No es una escritura que el rechazo invalide."
    ),
    ("app/payroll/service.py", "create_surcharge_table"): _RAZON_INTEGRITY,
    ("app/payroll/service.py", "create_holiday"): _RAZON_INTEGRITY,
    ("app/payroll/service.py", "create_wage_rate"): _RAZON_INTEGRITY,
}


def _es_escritura(n: ast.stmt) -> bool:
    """Escribir = asignar a un atributo (una fila del ORM) o `db.add/delete`."""
    if isinstance(n, ast.Assign):
        return any(isinstance(t, ast.Attribute) for t in n.targets)
    if isinstance(n, ast.AugAssign):
        return isinstance(n.target, ast.Attribute)
    if isinstance(n, ast.Expr) and isinstance(n.value, ast.Call):
        f = n.value.func
        return (
            isinstance(f, ast.Attribute)
            and f.attr in ("add", "add_all", "delete")
            and isinstance(f.value, ast.Name)
            and f.value.id in SESIONES
        )
    return False


def _error_levantado(n: ast.Raise) -> str | None:
    e = n.exc
    if isinstance(e, ast.Call):
        f = e.func
        if isinstance(f, ast.Name):
            return f.id
        if isinstance(f, ast.Attribute):
            return f.attr
    return e.id if isinstance(e, ast.Name) else None


def _deshace_antes_de(cuerpo: list[ast.stmt], linea: int) -> bool:
    for n in cuerpo:
        if n.lineno >= linea:
            break
        for x in ast.walk(n):
            if isinstance(x, ast.Call) and isinstance(x.func, ast.Attribute) and x.func.attr == "rollback":
                return True
    return False


def _recorrer(cuerpo: list[ast.stmt], escrito: bool, hallazgos: list[tuple[int, str]], deshecho: bool = False) -> bool:
    """Recorre un bloque por caminos y devuelve si al final hubo escritura."""
    for n in cuerpo:
        if _es_escritura(n):
            escrito = True
        elif isinstance(n, ast.Raise):
            err = _error_levantado(n)
            if escrito and not deshecho and err in ERRORES_DE_NEGOCIO:
                hallazgos.append((n.lineno, err))
        elif isinstance(n, ast.If):
            # Las ramas son caminos distintos: cada una arranca del mismo estado.
            a = _recorrer(n.body, escrito, hallazgos, deshecho)
            b = _recorrer(n.orelse, escrito, hallazgos, deshecho)
            escrito = a or b
        elif isinstance(n, (ast.For, ast.While, ast.AsyncFor)):
            # Dos pasadas: lo que escribió una vuelta vale para la siguiente,
            # que es justo el caso de `add_items` (el segundo ítem rechaza
            # cuando el primero ya se agregó).
            m = _recorrer(n.body, escrito, hallazgos, deshecho)
            m = _recorrer(n.body, m, hallazgos, deshecho)
            escrito = _recorrer(n.orelse, m, hallazgos, deshecho)
        elif isinstance(n, ast.Try):
            m = _recorrer(n.body, escrito, hallazgos, deshecho)
            for h in n.handlers:
                primer_raise = next((x.lineno for x in ast.walk(h) if isinstance(x, ast.Raise)), 10**9)
                _recorrer(h.body, m, hallazgos, _deshace_antes_de(h.body, primer_raise))
            m = _recorrer(n.orelse, m, hallazgos, deshecho)
            escrito = _recorrer(n.finalbody, m, hallazgos, deshecho)
        elif isinstance(n, (ast.With, ast.AsyncWith)):
            escrito = _recorrer(n.body, escrito, hallazgos, deshecho)
    return escrito


def test_ningun_servicio_escribe_antes_de_poder_rechazar() -> None:
    raiz = pathlib.Path(__file__).resolve().parents[2] / "app"
    nuevos: list[str] = []
    permitidos_vistos: set[tuple[str, str]] = set()

    for archivo in sorted(raiz.rglob("*.py")):
        rel = str(archivo.relative_to(raiz.parent))
        arbol = ast.parse(archivo.read_text())
        for fn in [n for n in ast.walk(arbol) if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))]:
            hallazgos: list[tuple[int, str]] = []
            _recorrer(fn.body, False, hallazgos)
            if not hallazgos:
                continue
            clave = (rel, fn.name)
            if clave in PERMITIDOS:
                permitidos_vistos.add(clave)
                continue
            linea, err = hallazgos[0]
            nuevos.append(f"{rel}:{linea} · {fn.name}() puede levantar {err} después de haber escrito")

    assert nuevos == [], (
        "Hay servicios que escriben antes de poder rechazar. `get_db` hace "
        "`commit()` al levantar un error de negocio, así que lo que estas "
        "funciones escriben ANTES del rechazo queda aplicado aunque la API "
        "responda 400/404/409 — plata regalada sin fila que la justifique, o "
        "una actualización a medias que el cliente cree fallida.\n"
        "Movelo: primero validá todo en variables locales, escribí al final, "
        "cuando ya no quede nada que pueda decir que no. Si la escritura "
        "TIENE que sobrevivir al rechazo (el contador de PIN fallido), "
        "agregala a PERMITIDOS con el porqué.\n  - " + "\n  - ".join(nuevos)
    )

    sin_usar = set(PERMITIDOS) - permitidos_vistos
    assert sin_usar == set(), (
        "Hay entradas en PERMITIDOS que ya no corresponden a ningún hallazgo: "
        f"{sorted(sin_usar)}. Si el servicio se arregló, sacá la entrada — un "
        "permiso que ya no permite nada esconde el próximo."
    )
