"""Contrato de `format=csv` (pedido 2b, `backend-lectura-contrato`; deuda
declarada en `outputs-2a/ENTREGA.md § 5` y en `docs/ESTADO.md` punto 13):
todo listado que sirve CSV tiene que DECLARAR `format` en la firma de su
endpoint — no basta con leerlo de `request.query_params` dentro de
`app.core.csv.wants_csv`, porque entonces el OpenAPI no lo publica y ningún
cliente generado puede pedirlo (hallazgo R-5 de 1b-2, repetido en 2a: «cinco
listados» según la spec, pero un barrido de AST sobre TODO `app/` encuentra
17, en 10 routers).

Este test recorre `app/**/router.py` con AST (no una lista a mano, que es
exactamente lo que se desincroniza) y falla si algún endpoint llama
`wants_csv` sin declarar un parámetro `format` en su firma. **Esto es lo que
evita que la deuda vuelva a pasar**: un router nuevo que agregue
`format=csv` a mano, del mismo modo que los cinco de 1b-2, se cae en rojo
acá antes de llegar a producción.
"""

from __future__ import annotations

import ast
import pathlib

APP_ROOT = pathlib.Path(__file__).resolve().parents[2] / "app"


def _functions_calling_wants_csv() -> list[tuple[str, str, bool]]:
    """`(archivo, función, declara_format)` para toda función de cualquier
    `router.py` que llama `wants_csv` en su cuerpo."""
    results: list[tuple[str, str, bool]] = []
    for path in sorted(APP_ROOT.rglob("router.py")):
        tree = ast.parse(path.read_text(), filename=str(path))
        for node in ast.walk(tree):
            if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            calls_wants_csv = any(
                isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == "wants_csv"
                for n in ast.walk(node)
            )
            if not calls_wants_csv:
                continue
            arg_names = {a.arg for a in node.args.args} | {a.arg for a in node.args.kwonlyargs}
            results.append((str(path.relative_to(APP_ROOT.parent)), node.name, "format" in arg_names))
    return results


def test_every_endpoint_that_serves_csv_declares_format_in_its_signature() -> None:
    functions = _functions_calling_wants_csv()
    assert functions, "el barrido no encontró ningún endpoint con `wants_csv` — revisá que `APP_ROOT` resuelva bien"

    offenders = [f"{path}::{name}" for path, name, has_format in functions if not has_format]
    assert offenders == [], (
        "Estos endpoints sirven `format=csv` leyendo `request.query_params` a mano, "
        "sin declarar `format` en la firma (el OpenAPI no lo publica): "
        f"{offenders}"
    )


def test_the_seventeen_endpoints_this_pedido_fixed_are_exactly_these() -> None:
    """Fija la lista exacta que este pedido corrigió (`outputs-2b/
    backend-lectura-contrato.md § 4`), para que el número deje de discutirse
    de memoria: la spec decía «cinco» (herencia de 1b-2), el reparto de este
    pedido decía «19» — el barrido de AST, acá mismo, da **17**. Si mañana
    alguien agrega un listado nuevo con `wants_csv` y `format`, este test
    sigue en verde (no depende de la lista); si lo agrega SIN `format`, el
    test de arriba ya lo atrapa. Este segundo test es sólo para que la cifra
    «17» quede escrita contra código, no contra memoria."""
    fixed_by_this_pedido = {
        "app/audit/router.py::list_audit",
        "app/auth/router.py::list_employees",
        "app/auth/router.py::list_authorizations",
        "app/catalog/router.py::list_categories",
        "app/catalog/router.py::list_products",
        "app/catalog/router.py::list_combos",
        "app/customers/router.py::admin_list_customers",
        "app/customers/router.py::admin_list_requests",
        "app/fiscal/router.py::get_ranges",
        "app/fiscal/router.py::get_fiscal_documents",
        "app/fiscal/router.py::get_notes",
        "app/notifications/router.py::list_notifications",
        "app/payments/router.py::get_admin_documents",
        "app/refunds/router.py::admin_list_pending_refunds",
        "app/reports/router.py::get_accountant_report",
        "app/reports/router.py::get_unavailable_log",
        "app/stores/router.py::list_stores",
    }
    assert len(fixed_by_this_pedido) == 17

    functions = _functions_calling_wants_csv()
    all_declared = {f"{path}::{name}" for path, name, has_format in functions if has_format}
    missing = fixed_by_this_pedido - all_declared
    assert missing == set(), f"{missing} ya no declara `format`: revisar si el endpoint cambió de forma"
