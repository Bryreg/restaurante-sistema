"""Los cruces de la FASE 3 («dinero y control»), auditados contra el código.

Mismo patrón de nombre y de escritura que `test_contract_2b_invariants.py` y
`test_contract_2c_invariants.py`: un archivo por pedido, un enunciado por
regla, el defecto explicado en el docstring.

**Qué es este archivo y qué NO es.** No confirma que los cinco territorios
hicieron lo que dijeron: busca **dónde mienten los números**. Cada test es un
invariante ejecutable (`docs/CONTEXTO-AGENTES.md §11`): no se ablanda, no se
acota y no se borra para poner algo verde. Si uno estorba, o el código está
mal o el invariante está mal, y eso se discute por escrito.

**Se escribió EN PARALELO con los cinco constructores, sobre un árbol que se
movía.** Por eso cada test distingue, en su docstring, entre los dos motivos
por los que puede estar rojo:

- **ROJO POR AUSENCIA** — al momento de escribirlo la ruta/función todavía no
  existía. Es información para el orquestador, no un hallazgo.
- **ROJO POR DEFECTO** — existe y el número miente. Eso sí es un hallazgo, y
  lleva su **dueño** (T1 `backend-banco`, T2 `backend-obligaciones`,
  T3 `backend-nomina-propinas`, T4 `backend-analitica`, T5 `frontend-fase3`)
  y su **remedio**.

Los que al momento de escribir este archivo NO tenían nada construido usan
`_skip_si_no_existe(...)`, que **no** los pone verdes: los marca `skipped`
con el motivo a la vista, para que el orquestador los distinga de un verde
real de un vistazo. Un invariante que mide una regla ya construida nunca se
salta.

**Disciplina de tests** (`docs/CONTEXTO-AGENTES.md §11`): todo entra por
HTTP, por la puerta real. Las únicas excepciones acá son lecturas de libros y
de tablas nuevas (`tip_payouts`, `tip_payout_distributions`, `audit_logs`,
`pending_refunds`), declaradas una por una en el test que las usa: leerlas
por HTTP obligaría a pasar por una ruta de admin y mezclaría «el asiento está
bien» con «el borde lo serializa bien» en una sola aserción. Ninguna fixture
compartida se redefine; ningún router se remonta (`create_app()` ya monta
todos los dominios de `DOMAINS`).
"""

from __future__ import annotations

import ast
import hashlib
import inspect
import subprocess
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any

import pytest

from tests.audit.conftest import app_source_files, denoms, idem_headers

API = "/api/v1"
BACKEND = Path(__file__).resolve().parents[2]
PHOTO = "data:image/png;base64,AAAA"

# Los cuatro dominios NUEVOS de la fase. Todo lo que este archivo barre por
# AST se barre sobre estos cuatro más `app/core/hours.py` (la escala entera
# nueva que T3 declaró), nunca sobre el resto del árbol: un hallazgo tiene
# que caer sobre el territorio que lo escribió.
DOMINIOS_FASE3 = ("banking", "expenses", "payroll", "analytics")
DUENO_POR_DOMINIO = {
    "banking": "T1 backend-banco",
    "expenses": "T2 backend-obligaciones",
    "payroll": "T3 backend-nomina-propinas",
    "analytics": "T4 backend-analitica",
}


# ---------------------------------------------------------------------------
# Helpers locales. No son fixtures: son composición de llamadas HTTP.
# ---------------------------------------------------------------------------


def _skip_si_no_existe(resp: Any, ruta: str, dueno: str) -> None:
    """Un `404` de ruta inexistente marca el test `skipped` con el motivo.

    **No pone nada verde**: separa «todavía no construido» (ausencia) de
    «construido mal» (defecto), que es exactamente la distinción que el
    orquestador necesita para decidir si itera. Un `404` de *recurso*
    (id ajeno) trae cuerpo `{"error": ...}` y NO se salta: ése sí es una
    respuesta del dominio.
    """
    if resp.status_code != 404:
        return
    cuerpo = resp.text or ""
    if '"error"' in cuerpo and "Not Found" not in cuerpo:
        return
    pytest.skip(f"AUSENCIA (no defecto): `{ruta}` todavía no responde; dueño {dueno}")


def _count(client: Any, shift_id: int, counted: int, *, tips_cash_out: int = 0) -> Any:
    """Paso 1 del cierre a ciegas. La sede de prueba exige foto."""
    return client.post(
        f"{API}/shifts/{shift_id}/close/count",
        json={"counted_cash": denoms(counted), "tips_cash_out": tips_cash_out, "photo": PHOTO},
        headers=idem_headers(),
    )


def _confirm(client: Any, shift_id: int, count_id: int, difference_seen: int, **extra: Any) -> Any:
    payload: dict[str, Any] = {"difference_seen": difference_seen, "closes_day": True}
    payload.update(extra)
    return client.post(f"{API}/shifts/{shift_id}/close/{count_id}/confirm", json=payload)


def cerrar_turno(device_client: Any, shift_id: int, counted: int, *, tips_cash_out: int = 0) -> dict[str, Any]:
    """Cierra un turno por la puerta real (los tres pasos) y devuelve el
    cuerpo del `confirm`. El esperado NO se deriva acá: la diferencia vista
    se lee del paso 2, que es el único que la revela."""
    paso1 = _count(device_client, shift_id, counted, tips_cash_out=tips_cash_out)
    assert paso1.status_code in (200, 201), paso1.text
    count_id = paso1.json()["count_id"]
    review = device_client.get(f"{API}/shifts/{shift_id}/close/{count_id}/review")
    assert review.status_code == 200, review.text
    diferencia = review.json()["difference"]
    extra: dict[str, Any] = {}
    if diferencia != 0:
        extra = {"cause": "unexplained", "note": "auditoría de fase 3"}
    paso3 = _confirm(device_client, shift_id, count_id, diferencia, **extra)
    assert paso3.status_code == 200, paso3.text
    return dict(paso3.json())


def _rango(dia: date) -> dict[str, str]:
    return {"from": dia.isoformat(), "to": dia.isoformat()}


def _es_gate_apagado(resp: Any) -> bool:
    if resp.status_code != 400:
        return False
    try:
        return resp.json().get("error", {}).get("code") == "FEATURE_DISABLED"
    except Exception:  # pragma: no cover - cuerpo no JSON
        return False


def _feature_del_error(resp: Any) -> str | None:
    try:
        error = resp.json()["error"]
    except Exception:  # pragma: no cover - cuerpo no JSON
        return None
    extra = error.get("feature")
    if extra:
        return str(extra)
    return None


def _arboles_fase3() -> list[tuple[str, Any]]:
    """`[(ruta, AST)]` de los cuatro dominios nuevos + `app/core/hours.py`."""
    prefijos = tuple(f"app/{d}/" for d in DOMINIOS_FASE3)
    return [
        (ruta, arbol)
        for ruta, arbol in app_source_files()
        if ruta.startswith(prefijos) or ruta == "app/core/hours.py"
    ]


def _dueno_de(ruta: str) -> str:
    for dominio, dueno in DUENO_POR_DOMINIO.items():
        if ruta.startswith(f"app/{dominio}/"):
            return dueno
    return "T3 backend-nomina-propinas (app/core/hours.py)"


# ===========================================================================
# CRUCE 1 — LA PLATA CIERRA: el esperado del turno NO se movió
#
# `compute_breakdown` es `expected = base + cash_sales + incomes − expenses −
# pickups`. La fase 3 agrega plata que NO pasa por el cajón (una
# consignación, una transferencia de arriendo, una liquidación de nómina).
# Si alguna de esas mueve el esperado, el cuadre del cajero empieza a
# depender de lo que el administrador haga en otra pantalla.
#
# Se mide leyendo el esperado ANTES y DESPUÉS, por HTTP, y exigiendo
# igualdad EXACTA. No se recalcula acá: `expected_of` lo lee de
# `GET /shifts/{id}` como administrador (una sola matemática).
# ===========================================================================


def test_registering_a_bank_deposit_does_not_move_the_shift_expected_cash(
    device_client: Any, admin_client: Any, open_shift: Any, expected_of: Any, store: Any, clock: Any
) -> None:
    """CRUCE 1 · dueño T1. Una consignación es plata que ya salió del cajón
    (o que sale del sobrante de cierre): registrarla NO puede mover el
    esperado de un turno abierto.

    Si esto se pone rojo **por defecto**, el remedio es de T1: `app/banking/`
    no puede crear ningún `CashMovement` ni `CashPickup` al registrar una
    consignación — la consignación se imputa a `Shift.to_deposit` de turnos
    YA CERRADOS, que es un snapshot y no vuelve a moverse.

    Rojo **por ausencia** si `POST /admin/deposits` todavía no existe."""
    turno = open_shift()
    antes = expected_of(turno["id"])

    resp = admin_client.post(
        f"{API}/admin/deposits?store_id={store.id}",
        json={"amount": 50_000, "receipt_photo": PHOTO, "bank_name": "Bancolombia"},
        headers=idem_headers(),
    )
    _skip_si_no_existe(resp, "POST /admin/deposits", "T1 backend-banco")
    assert resp.status_code in (200, 201), resp.text

    assert expected_of(turno["id"]) == antes, (
        "registrar una consignación movió el esperado del turno: `app/banking/` "
        "está tocando el cajón (CRUCE 1, dueño T1)"
    )


def test_an_expense_that_never_touched_the_drawer_does_not_move_the_expected_cash(
    device_client: Any, admin_client: Any, open_shift: Any, expected_of: Any, store: Any, clock: Any
) -> None:
    """CRUCE 1 · dueño T2. Una transferencia de arriendo es plata que nunca
    pasó por el cajón. Registrarla como gasto (`source != "cash_drawer"`) NO
    puede mover el esperado.

    Remedio si rojo por defecto: `app/expenses/` no debe llamar a
    `shifts.hooks.register_*_expense` para un gasto que no salió del cajón —
    ese hook es SOLO para el gasto que sí salió, y ahí la plata ya la movió
    el `CashMovement`."""
    turno = open_shift()
    antes = expected_of(turno["id"])
    hoy = date(2026, 1, 15)

    resp = admin_client.post(
        f"{API}/admin/expenses?store_id={store.id}",
        json={
            "category": "utilities",
            "description": "Arriendo por transferencia",
            "amount": 1_200_000,
            "business_date": hoy.isoformat(),
            "source": "bank",
        },
        headers=idem_headers(),
    )
    _skip_si_no_existe(resp, "POST /admin/expenses", "T2 backend-obligaciones")
    assert resp.status_code in (200, 201), resp.text

    assert expected_of(turno["id"]) == antes, (
        "un gasto que no pasó por el cajón movió el esperado (CRUCE 1, dueño T2)"
    )


def test_settling_a_scheduled_obligation_outside_the_drawer_does_not_move_the_expected_cash(
    device_client: Any, admin_client: Any, open_shift: Any, expected_of: Any, store: Any, clock: Any
) -> None:
    """CRUCE 1 · dueño T2. Saldar una obligación agendada por banco tampoco
    mueve el esperado."""
    turno = open_shift()
    antes = expected_of(turno["id"])

    creada = admin_client.post(
        f"{API}/admin/obligations?store_id={store.id}",
        json={
            "category": "rent",
            "description": "Arriendo enero",
            "amount": 3_000_000,
            "due_date": "2026-01-31",
        },
        headers=idem_headers(),
    )
    _skip_si_no_existe(creada, "POST /admin/obligations", "T2 backend-obligaciones")
    assert creada.status_code in (200, 201), creada.text
    obligacion_id = creada.json()["id"]

    saldada = admin_client.post(
        f"{API}/admin/obligations/{obligacion_id}/settle?store_id={store.id}",
        json={"source": "bank", "note": "transferencia"},
        headers=idem_headers(),
    )
    assert saldada.status_code in (200, 201), saldada.text

    assert expected_of(turno["id"]) == antes, (
        "saldar una obligación por fuera del cajón movió el esperado (CRUCE 1, dueño T2)"
    )


def test_a_payroll_run_does_not_move_the_expected_cash(
    device_client: Any, admin_client: Any, open_shift: Any, expected_of: Any, store: Any, clock: Any
) -> None:
    """CRUCE 1 · dueño T3. Liquidar la nómina del período es un cálculo, no
    un pago: no puede mover el esperado de ningún turno."""
    turno = open_shift()
    antes = expected_of(turno["id"])

    resp = admin_client.post(
        f"{API}/admin/payroll/runs?store_id={store.id}",
        json={"date_from": "2026-01-01", "date_to": "2026-01-15"},
        headers=idem_headers(),
    )
    _skip_si_no_existe(resp, "POST /admin/payroll/runs", "T3 backend-nomina-propinas")
    assert resp.status_code in (200, 201, 400), resp.text

    assert expected_of(turno["id"]) == antes, (
        "liquidar la nómina movió el esperado del turno (CRUCE 1, dueño T3)"
    )


def test_a_drawer_expense_moves_the_expected_exactly_once_never_twice(
    device_client: Any, admin_client: Any, open_shift: Any, expected_of: Any, store: Any, clock: Any
) -> None:
    """CRUCE 1 + checklist «un gasto que sí sale del cajón» · dueño T2.

    El gasto que SÍ sale del cajón entra por el movimiento de caja con causa
    tipada (`PETTY_EXPENSE`, que ya existía). Ese movimiento mueve el
    esperado **una vez**. Anotar el mismo gasto en `app/expenses/` NO puede
    volver a moverlo: sería el doble conteo con el signo que muestra MENOS
    plata de la que hay.

    Rojo por defecto ⇒ `app/expenses/` está creando su propio `CashMovement`
    además de referenciar el que ya existe. Remedio: referenciar, nunca
    crear."""
    turno = open_shift()
    inicial = expected_of(turno["id"])

    movimiento = device_client.post(
        f"{API}/shifts/{turno['id']}/cash-movements",
        json={"kind": "expense", "cause": "petty_expense", "amount": 30_000, "note": "gas"},
        headers=idem_headers(),
    )
    assert movimiento.status_code in (200, 201), movimiento.text
    tras_movimiento = expected_of(turno["id"])
    assert tras_movimiento == inicial - 30_000, (
        "el movimiento de caja con causa tipada tiene que mover el esperado exactamente su monto"
    )

    resp = admin_client.post(
        f"{API}/admin/expenses?store_id={store.id}",
        json={
            "category": "supplies",
            "description": "Gas de la cocina",
            "amount": 30_000,
            "business_date": "2026-01-15",
            "source": "cash_drawer",
            "cash_movement_id": movimiento.json()["id"],
        },
        headers=idem_headers(),
    )
    _skip_si_no_existe(resp, "POST /admin/expenses", "T2 backend-obligaciones")
    assert resp.status_code in (200, 201), resp.text

    assert expected_of(turno["id"]) == tras_movimiento, (
        "anotar el gasto de cajón en `app/expenses/` volvió a mover el esperado: "
        "doble conteo (CRUCE 1, dueño T2)"
    )


# ===========================================================================
# CRUCE 2 — NADIE ESCRIBIÓ UNA SEGUNDA MATEMÁTICA
#
# `compute_breakdown` es la única fórmula del esperado; `payment_bucket` el
# único clasificador de un pago; `resolve_ingredient_cost` la única jerarquía
# de costo. Y `Shift.to_deposit` se LEE, nunca se recalcula.
# ===========================================================================


def test_no_new_domain_recomputes_the_to_deposit_subtraction(
) -> None:
    """CRUCE 2, el más fácil de romper de todo el pedido · dueño T1
    (o quien lo copie).

    `Shift.to_deposit = counted_cash_total − opening_cash_fixed −
    tips_cash_out` se escribe en `app/shifts/service.py` al cerrar y es un
    **snapshot de cierre**. Escribir esa resta otra vez en `app/banking/` (o
    en cualquier dominio nuevo) crea la segunda matemática que las reglas
    duras prohíben: el día que cambie la definición de `tips_cash_out` habría
    dos respuestas a la misma pregunta.

    El invariante es sintáctico a propósito: mide que **ningún dominio nuevo
    nombre siquiera** `counted_cash_total`, `opening_cash_fixed` o
    `tips_cash_out` dentro de una expresión. Leer `Shift.to_deposit` no
    necesita ninguno de los tres."""
    PROHIBIDOS = {"counted_cash_total", "opening_cash_fixed", "tips_cash_out"}
    hallazgos: list[str] = []
    for ruta, arbol in _arboles_fase3():
        for nodo in ast.walk(arbol):
            nombre: str | None = None
            if isinstance(nodo, ast.Attribute):
                nombre = nodo.attr
            elif isinstance(nodo, ast.Name):
                nombre = nodo.id
            if nombre in PROHIBIDOS:
                hallazgos.append(f"{ruta}:{getattr(nodo, 'lineno', '?')} ({nombre}) [{_dueno_de(ruta)}]")
    assert not hallazgos, (
        "un dominio nuevo volvió a calcular la resta de `Shift.to_deposit` en vez de leerla: " + str(hallazgos)
    )


def test_compute_breakdown_stays_the_only_formula_of_the_expected_cash() -> None:
    """CRUCE 2 · dueño: el dominio donde caiga.

    Ningún dominio nuevo puede reconstruir el esperado del turno. El
    invariante busca la **firma de la fórmula**: la combinación
    `cash_sales`+`pickups` en un mismo archivo (los dos términos que sólo
    existen dentro de `compute_breakdown`), o una asignación a
    `expected_cash`, que es el NOMBRE DEL CAMPO del turno
    (`Shift.expected_cash`).

    **Calibración, declarada por escrito porque un invariante no se acota en
    silencio:** la primera versión cazaba también el nombre suelto
    `expected`, y marcó `app/banking/service.py:710` y `:892`. Es un **falso
    positivo del invariante, no un hallazgo**: ahí `expected` es «lo esperado
    del datáfono / de la plataforma» —una cifra distinta, que el propio
    contrato de API de §2 nombra así («lo esperado, lo liquidado, la
    diferencia»)— y no tiene nada que ver con el esperado del cajón. Se
    corrigió el invariante, que estaba mal; no se ablandó una regla que
    estuviera bien."""
    hallazgos: list[str] = []
    for ruta, arbol in _arboles_fase3():
        nombres = {
            n.attr if isinstance(n, ast.Attribute) else n.id
            for n in ast.walk(arbol)
            if isinstance(n, (ast.Attribute, ast.Name))
        }
        if {"cash_sales", "pickups"} <= nombres:
            hallazgos.append(f"{ruta} (cash_sales+pickups) [{_dueno_de(ruta)}]")
        for nodo in ast.walk(arbol):
            if isinstance(nodo, ast.Assign):
                for objetivo in nodo.targets:
                    if isinstance(objetivo, ast.Name) and objetivo.id == "expected_cash":
                        hallazgos.append(
                            f"{ruta}:{nodo.lineno} (asigna {objetivo.id}) [{_dueno_de(ruta)}]"
                        )
    assert not hallazgos, (
        "un dominio nuevo reconstruye el esperado del turno: `compute_breakdown` dejó de ser "
        "la única fórmula (CRUCE 2): " + str(hallazgos)
    )


def test_no_new_domain_decides_by_itself_which_payment_methods_are_electronic() -> None:
    """CRUCE 2 · **HALLAZGO ABIERTO** · dueño T1 `backend-banco`.

    `app/shifts/hooks.py::payment_bucket` es, por decisión explícita del
    cierre de H-2 de la ronda 2 de 2c, **el único lugar del sistema que
    decide en qué bolsillo cae un cobro**. Su docstring cuenta el precio que
    ya se pagó por tener dos: el mismo cuerpo de `GET /shifts/{id}/tips`
    llegó a decir que la propina en efectivo del turno era $10.000 por
    método y $20.000 por empleado.

    **Lo que este invariante encuentra hoy** (y por lo que está rojo):
    `app/banking/service.py` decide por su cuenta, con literales en SQL,
    cuáles medios son «datáfono» (`Payment.method == "card"`, línea 398 del
    libro del banco) y cuáles son «transferencia»
    (`Payment.method == "transfer"`, línea 686 de la conciliación). Son dos
    sitios más que responden «qué medios son electrónicos». El día que se
    agregue un medio —y ya pasó dos veces: `platform` en 2c, el efectivo de
    domicilio en 2c— `payment_bucket` lo va a clasificar y la conciliación
    del datáfono lo va a omitir **en silencio**: la diferencia va a aparecer
    como «falta una liquidación», que es un síntoma con una causa
    completamente distinta y manda a buscar donde no es.

    **Por qué no se ablanda.** Es cierto que `payment_bucket` es una función
    de Python y acá hace falta un filtro en SQL: no se puede llamar fila por
    fila sin traer todos los pagos del período. Eso hace que el remedio sea
    de DOS territorios, no que el problema no exista.

    **Remedio concreto**: publicar el conjunto en
    `app/shifts/hooks.py` —p. ej. `METHODS_IN_BUCKET: dict[str, frozenset
    [str]]`, derivado de la misma tabla que usa `payment_bucket`— e
    importarlo desde `app/banking/service.py` para el `IN (...)` del filtro.
    Mientras `app/shifts/` no es territorio de esta fase, el dueño de este
    rojo es **T1**, que puede cerrarlo de dos formas: declarándolo como gap
    con el hook pedido, o —si el orquestador lo autoriza— agregando el hook.

    Nota de alcance: comparar contra el literal del propio dominio (p. ej.
    `TipPayout.method == "cash"`, campo de `app/shifts/models.py` con dominio
    propio de dos valores) NO es decidir un medio de venta; por eso `"cash"`
    no está en la lista de abajo."""
    MEDIOS_VENTA = {"card", "transfer", "platform", "credit", "mixed"}
    hallazgos: list[str] = []
    for ruta, arbol in _arboles_fase3():
        for nodo in ast.walk(arbol):
            if not isinstance(nodo, ast.Compare):
                continue
            literales: set[str] = set()
            for lado in [nodo.left, *nodo.comparators]:
                if isinstance(lado, ast.Constant) and isinstance(lado.value, str):
                    literales.add(lado.value)
                elif isinstance(lado, (ast.Tuple, ast.List, ast.Set)):
                    for elemento in lado.elts:
                        if isinstance(elemento, ast.Constant) and isinstance(elemento.value, str):
                            literales.add(elemento.value)
            if literales & MEDIOS_VENTA:
                hallazgos.append(
                    f"{ruta}:{nodo.lineno} ({sorted(literales & MEDIOS_VENTA)}) [{_dueno_de(ruta)}]"
                )
    assert not hallazgos, (
        "un dominio nuevo decide por su cuenta qué medios de pago son electrónicos, en vez de "
        "derivarlo de la única tabla que lo sabe (`app.shifts.hooks.payment_bucket`). El día que se "
        "agregue un medio, la conciliación lo va a omitir en silencio (CRUCE 2): " + str(hallazgos)
    )


def test_no_new_domain_rebuilds_the_ingredient_cost_hierarchy() -> None:
    """CRUCE 2 · `app/inventory/hooks.py::resolve_ingredient_cost` es la
    ÚNICA jerarquía de costo (`official → weighted_average → last_purchase →
    estimated → none`).

    Un dominio nuevo que nombre dos o más escalones de esa jerarquía la está
    reimplementando; el `cost_source` que publique va a dejar de coincidir
    con el del resto del sistema."""
    ESCALONES = {"official_cost", "weighted_average_cost_micros", "last_purchase_cost_micros", "estimated_cost"}
    hallazgos: list[str] = []
    for ruta, arbol in _arboles_fase3():
        nombres = {
            n.attr if isinstance(n, ast.Attribute) else n.id
            for n in ast.walk(arbol)
            if isinstance(n, (ast.Attribute, ast.Name))
        }
        usados = nombres & ESCALONES
        if len(usados) >= 2:
            hallazgos.append(f"{ruta} ({sorted(usados)}) [{_dueno_de(ruta)}]")
    assert not hallazgos, (
        "un dominio nuevo reconstruye la jerarquía de costo en vez de llamar a "
        "`resolve_ingredient_cost` (CRUCE 2): " + str(hallazgos)
    )


# ---------------------------------------------------------------------------
# D-1, la mitad que NO se toca: `_variance_level`
# ---------------------------------------------------------------------------

# Huella del CUERPO de `app/inventory/service.py::_variance_level`, sin
# docstring y sin números de línea: cambia si y sólo si cambia su LÓGICA.
# Calculada sobre el árbol tal como quedó al cerrar 2c (el `HEAD` sobre el
# que arrancó la fase 3). Un cambio de comentario o de redacción del
# docstring NO la mueve — a propósito: el contrato que D-1 protege es el
# comportamiento publicado de `VarianceRowOut.level`, no la prosa.
_HUELLA_VARIANCE_LEVEL = "47808a06a34eea201af8156a9eba4845"


def _huella_de_funcion(fn: Any) -> str:
    fuente = inspect.getsource(fn)
    arbol = ast.parse(inspect.cleandoc(fuente))
    definicion = arbol.body[0]
    cuerpo = list(getattr(definicion, "body", []))
    if (
        cuerpo
        and isinstance(cuerpo[0], ast.Expr)
        and isinstance(cuerpo[0].value, ast.Constant)
        and isinstance(cuerpo[0].value.value, str)
    ):
        cuerpo = cuerpo[1:]
    return hashlib.md5("\n".join(ast.dump(n) for n in cuerpo).encode()).hexdigest()


def test_d1_did_not_touch_the_per_row_variance_traffic_light() -> None:
    """D-1, la línea que NO se cruza · dueño T4 si se rompe.

    D-1 define «sostenido» como un indicador **nuevo y aparte**, de la SEDE,
    sobre la brecha de food cost. `app/inventory/service.py::_variance_level`
    —el semáforo POR RENGLÓN de un conteo, por umbral y sin historia— se
    queda **exactamente como está**. Tocarlo rompe el contrato publicado de
    `VarianceRowOut.level` y sus tests, y la spec lo declara **conflicto
    bloqueante**.

    Este invariante mide la LÓGICA (AST sin docstring), no el texto: si se
    pone rojo, alguien le cambió el comportamiento. Remedio: revertir
    `_variance_level` y poner «sostenido» donde D-1 lo puso, en
    `GET /admin/control-health/sustained`."""
    from app.inventory.service import _variance_level

    assert list(inspect.signature(_variance_level).parameters) == [
        "pct_bp",
        "theoretical",
        "variance_qty",
        "settings",
    ], (
        "cambió la FIRMA de `_variance_level`: el semáforo por renglón dejó de ser "
        "«por umbral y sin historia» (D-1, conflicto bloqueante)"
    )
    assert _huella_de_funcion(_variance_level) == _HUELLA_VARIANCE_LEVEL, (
        "cambió la LÓGICA de `app/inventory/service.py::_variance_level`. D-1 dice que "
        "«sostenido» es un indicador NUEVO Y APARTE y que este semáforo no se toca: es "
        "conflicto bloqueante, no un ajuste"
    )


# ===========================================================================
# CRUCE 3 — `null` CON MOTIVO EN TODO INDICADOR SIN DATOS
#
# El cero mudo es el error repetido nº7 del proyecto. «Nadie cargó los costos
# fijos» y «el punto de equilibrio es cero» son dos cosas distintas, y la
# segunda no existe.
# ===========================================================================


def test_break_even_without_fixed_costs_is_null_with_a_reason_never_zero(
    admin_client: Any, store: Any, clock: Any
) -> None:
    """CRUCE 3 · dueño T2. Sin costos fijos cargados, `break_even_amount` es
    `null` **con** `reason`. Jamás `0`: un punto de equilibrio de `$0` le
    dice al dueño que ya está ganando plata."""
    resp = admin_client.get(f"{API}/admin/break-even", params={"store_id": store.id, **_rango(date(2026, 1, 15))})
    _skip_si_no_existe(resp, "GET /admin/break-even", "T2 backend-obligaciones")
    assert resp.status_code == 200, resp.text
    cuerpo = resp.json()

    assert cuerpo["break_even_amount"] is None, (
        f"sin costos fijos cargados el punto de equilibrio es `null`, no {cuerpo['break_even_amount']!r} "
        "(CRUCE 3, el cero mudo, dueño T2)"
    )
    assert cuerpo["available"] is False, "sin datos suficientes `available` es False"
    assert cuerpo["reason"], "un `null` sin motivo es un `null` mudo: falta `reason` (dueño T2)"


def test_profit_without_data_is_null_with_a_reason(admin_client: Any, store: Any, clock: Any) -> None:
    """CRUCE 3 · dueño T2. La utilidad del período respeta el mismo contrato
    `available`/`reason` que el punto de equilibrio."""
    resp = admin_client.get(f"{API}/admin/profit", params={"store_id": store.id, **_rango(date(2026, 1, 15))})
    _skip_si_no_existe(resp, "GET /admin/profit", "T2 backend-obligaciones")
    assert resp.status_code == 200, resp.text
    cuerpo = resp.json()
    assert "available" in cuerpo and "reason" in cuerpo, (
        "`GET /admin/profit` tiene que publicar `available`/`reason` (contrato de API mínimo, dueño T2)"
    )
    if cuerpo["available"] is False:
        assert cuerpo["reason"], "`available=False` sin `reason` es un cero mudo con otro nombre (dueño T2)"


def test_menu_engineering_without_sales_is_unavailable_with_a_reason_not_an_empty_table(
    admin_client: Any, store: Any, clock: Any
) -> None:
    """CRUCE 3 · dueño T4. Sin ventas del período, la ingeniería de menú no
    puede devolver una tabla vacía muda: `available=False` + `reason`.

    Una tabla vacía sin explicación se lee como «no tenés platos que
    convengan», que es una afirmación distinta de «no vendiste nada»."""
    resp = admin_client.get(
        f"{API}/admin/menu-engineering", params={"store_id": store.id, **_rango(date(2026, 1, 15))}
    )
    _skip_si_no_existe(resp, "GET /admin/menu-engineering", "T4 backend-analitica")
    assert resp.status_code == 200, resp.text
    cuerpo = resp.json()
    assert cuerpo["rows"] == [], "sin ventas no puede haber filas"
    assert cuerpo["available"] is False, "sin ventas del período `available` es False (dueño T4)"
    assert cuerpo["reason"], "una lista vacía muda es el error repetido nº7 (dueño T4)"


def test_sustained_with_less_than_two_windows_is_null_with_a_reason_and_never_green(
    admin_client: Any, store: Any, clock: Any
) -> None:
    """D-1 + CRUCE 3 · dueño T4. Con **menos de 2 ventanas** computables,
    `sustained_red` es `null` con motivo — **nunca `false`**.

    `false` significa «lo medí y no está sostenido en rojo»; sin historial no
    se midió nada. Publicar `false` ahí es pintar de verde un indicador que
    nunca se calculó, que es exactamente lo que D-1 prohíbe con todas las
    letras."""
    resp = admin_client.get(f"{API}/admin/control-health/sustained", params={"store_id": store.id})
    _skip_si_no_existe(resp, "GET /admin/control-health/sustained", "T4 backend-analitica")
    assert resp.status_code == 200, resp.text
    cuerpo = resp.json()

    assert cuerpo["windows_evaluated"] == 0, "sin conteos aplicados no hay ventanas computables"
    assert cuerpo["sustained_red"] is None, (
        f"con menos de dos ventanas «sostenido» es `null`, no {cuerpo['sustained_red']!r}: "
        "D-1 dice «nunca verde» (dueño T4)"
    )
    assert cuerpo["reason"], "D-1 exige `null` CON MOTIVO (dueño T4)"


def test_pending_deposits_reports_null_to_deposit_with_a_reason_for_a_shift_closed_without_count(
    device_client: Any, admin_client: Any, open_shift: Any, store: Any, clock: Any, db: Any
) -> None:
    """CRUCE 3 · **HALLAZGO** · dueño T1 `backend-banco`.

    El contrato de API de §2 dice, con estas palabras: «`to_deposit: null`
    con `reason` **cuando el turno cerró sin conteo**». Y
    `app/banking/service.py::pending_deposits` escribió el `reason`
    correcto —«El turno cerró sin conteo (cierre administrativo); no hay
    saldo por consignar calculable»— pero lo colgó de la condición
    equivocada: `shift.to_deposit is None`.

    **El defecto**: un cierre administrativo NUNCA deja `to_deposit` en
    `NULL`. `app/shifts/service.py:1257` le escribe
    `breakdown["expected"] − opening_cash_fixed`, una cifra **derivada del
    libro**, no de un conteo. Resultado: la rama del `reason` es código
    muerto, y el turno que nadie contó aparece en «por consignar» con un
    monto y `reason: null` — indistinguible de un turno arqueado a ciegas
    por su responsable. Al dueño le dice «consigná $X» cuando la verdad es
    «nadie abrió ese cajón».

    Es el cero mudo con otro disfraz (error repetido nº7): no es un `0` en
    lugar de `null`, es **una cifra en lugar de `null`**, que miente más.

    **Remedio (T1, sin recalcular nada)**: la condición de «cerró sin
    conteo» es `Shift.closed_without_count`, que existe desde 1b
    (`app/shifts/models.py:192`) y ya se publica en
    `ShiftOut.closed_without_count`. Usar ese campo para decidir el `null` +
    `reason`, y seguir **leyendo** `Shift.to_deposit` en el caso normal.

    La precondición se arma explícitamente: el cierre administrativo exige
    que el turno esté abandonado (`SHIFT_NOT_STALE` si no), así que el reloj
    se adelanta con `app/core/clock.py` — nunca se deriva «hoy» en UTC
    (error repetido nº1)."""
    turno = open_shift()
    # `is_shift_stale`: abierto pasada la hora de corte del día SIGUIENTE a
    # su fecha de negocio. Reloj de prueba: 2026-01-15 12:00 UTC (07:00 en
    # Bogotá, día operativo 2026-01-15, corte 06:00).
    clock.advance(days=1)

    cierre = admin_client.post(
        f"{API}/admin/shifts/{turno['id']}/close-administrative",
        json={"reason": "auditoría de fase 3: turno sin conteo"},
        headers=idem_headers(),
    )
    assert cierre.status_code in (200, 201), cierre.text

    resp = admin_client.get(
        f"{API}/admin/deposits/pending", params={"store_id": store.id, **_rango(date(2026, 1, 15))}
    )
    _skip_si_no_existe(resp, "GET /admin/deposits/pending", "T1 backend-banco")
    assert resp.status_code == 200, resp.text
    filas = resp.json()
    fila = next((f for f in filas if f["shift_id"] == turno["id"]), None)
    assert fila is not None, (
        "un turno cerrado sin conteo tiene que APARECER en «por consignar», con su motivo: "
        "esconderlo es la lista vacía muda (dueño T1)"
    )
    assert fila["to_deposit"] is None, (
        f"turno cerrado SIN CONTEO y «por consignar» publica `to_deposit = {fila['to_deposit']!r}`: "
        "una cifra derivada del libro presentada como si alguien hubiera contado el cajón. El "
        "contrato de §2 pide `null` con `reason` para este caso; la condición correcta es "
        "`Shift.closed_without_count`, no `to_deposit IS NULL` (que acá nunca se da). Dueño T1"
    )
    assert fila.get("reason"), "`to_deposit: null` sin `reason` (CRUCE 3, dueño T1)"


# ===========================================================================
# CRUCE 4 — NINGÚN `float`, EN NINGUNA DE LAS DOS CAPAS
# ===========================================================================


def test_no_new_backend_code_uses_a_float_anywhere() -> None:
    """CRUCE 4 · dueño: el dominio donde caiga. Los recargos de nómina son
    donde más probable es que aparezca.

    Tres formas de meter un `float` sin querer: un literal decimal
    (`0.75`), una llamada a `float(...)`, y una división verdadera (`/`) que
    convierte dos enteros en `float` en silencio. Las tres se prohíben acá.

    **Única excepción, declarada**: `Decimal(...) / Decimal(...)`, que es el
    patrón de `format_cost_micros` para PUBLICAR un decimal exacto — nunca
    para seguir calculando con él."""
    hallazgos: list[str] = []
    for ruta, arbol in _arboles_fase3():
        for nodo in ast.walk(arbol):
            if isinstance(nodo, ast.Constant) and isinstance(nodo.value, float):
                hallazgos.append(f"{ruta}:{nodo.lineno} literal float {nodo.value!r} [{_dueno_de(ruta)}]")
            elif isinstance(nodo, ast.Call) and isinstance(nodo.func, ast.Name) and nodo.func.id == "float":
                hallazgos.append(f"{ruta}:{nodo.lineno} float(...) [{_dueno_de(ruta)}]")
            elif isinstance(nodo, ast.BinOp) and isinstance(nodo.op, ast.Div):
                def _es_decimal(n: ast.expr) -> bool:
                    return isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == "Decimal"

                if not (_es_decimal(nodo.left) and _es_decimal(nodo.right)):
                    hallazgos.append(
                        f"{ruta}:{nodo.lineno} división verdadera `/` (usá `//`) [{_dueno_de(ruta)}]"
                    )
    assert not hallazgos, "CRUCE 4: hay `float` en el código nuevo: " + str(hallazgos)


def test_no_new_model_declares_a_float_column() -> None:
    """CRUCE 4 · una columna `Float`/`Numeric` en una tabla nueva es el mismo
    error, pero persistido: sobrevive al deploy y no hay redondeo que lo
    arregle después."""
    hallazgos: list[str] = []
    for ruta, arbol in _arboles_fase3():
        if not ruta.endswith("models.py"):
            continue
        for nodo in ast.walk(arbol):
            nombre = None
            if isinstance(nodo, ast.Attribute):
                nombre = nodo.attr
            elif isinstance(nodo, ast.Name):
                nombre = nodo.id
            if nombre in ("Float", "REAL", "DOUBLE_PRECISION"):
                hallazgos.append(f"{ruta}:{getattr(nodo, 'lineno', '?')} ({nombre}) [{_dueno_de(ruta)}]")
    assert not hallazgos, "CRUCE 4: una tabla nueva declara una columna de punto flotante: " + str(hallazgos)


def test_no_new_endpoint_ever_returns_a_json_float(
    admin_client: Any, store: Any, clock: Any
) -> None:
    """CRUCE 4, del lado del contrato · un `float` en el JSON llega al
    navegador como `float` y vuelve como `float`: el redondeo entero del
    backend no lo salva.

    Barre TODAS las rutas `GET` de la fase con datos mínimos y exige que
    ningún número del cuerpo sea `float`."""
    rango = _rango(date(2026, 1, 15))
    rutas = [
        (f"{API}/admin/deposits", {"store_id": store.id, **rango}),
        (f"{API}/admin/deposits/pending", {"store_id": store.id, **rango}),
        (f"{API}/admin/bank/ledger", {"store_id": store.id, **rango}),
        (f"{API}/admin/bank/owner-hand", {"store_id": store.id, **rango}),
        (f"{API}/admin/reconciliation/card", {"store_id": store.id, **rango}),
        (f"{API}/admin/reconciliation/platform", {"store_id": store.id, **rango}),
        (f"{API}/admin/expenses", {"store_id": store.id, **rango}),
        (f"{API}/admin/obligations", {"store_id": store.id}),
        (f"{API}/admin/break-even", {"store_id": store.id, **rango}),
        (f"{API}/admin/profit", {"store_id": store.id, **rango}),
        (f"{API}/admin/payroll/hours", {"store_id": store.id, **rango}),
        (f"{API}/admin/payroll/surcharge-tables", {"store_id": store.id}),
        (f"{API}/admin/payroll/runs", {"store_id": store.id}),
        (f"{API}/admin/tips/settings", {"store_id": store.id}),
        (f"{API}/admin/menu-engineering", {"store_id": store.id, **rango}),
        (f"{API}/admin/control-health/sustained", {"store_id": store.id}),
        (f"{API}/admin/replenishment", {"store_id": store.id}),
    ]
    hallazgos: list[str] = []

    def _barrer(valor: Any, ruta: str, clave: str | None) -> None:
        if isinstance(valor, dict):
            for k, v in valor.items():
                _barrer(v, ruta, str(k))
        elif isinstance(valor, list):
            for v in valor:
                _barrer(v, ruta, clave)
        elif isinstance(valor, float):
            hallazgos.append(f"{ruta} -> {clave} = {valor!r}")

    alcanzadas = 0
    for ruta, params in rutas:
        resp = admin_client.get(ruta, params=params)
        if resp.status_code == 404:
            continue
        if resp.status_code != 200:
            continue
        alcanzadas += 1
        _barrer(resp.json(), ruta, None)

    assert alcanzadas > 0, "AUSENCIA: ninguna ruta de la fase respondió 200; nada que barrer"
    assert not hallazgos, "CRUCE 4: una ruta de la fase publica un `float` en JSON: " + str(hallazgos)


# ===========================================================================
# CRUCE 5 — UNA TABLA LEGAL VIEJA RECALCULA CON LAS TABLAS DE SU ÉPOCA
# ===========================================================================


def test_an_old_period_is_liquidated_with_the_surcharge_table_in_force_back_then(
    admin_client: Any, device_client: Any, identify: Any, employees: dict[str, Any],
    open_shift: Any, store: Any, clock: Any,
) -> None:
    """CRUCE 5 · dueño T3. Mismo patrón que `StoreFiscalConfig`: rige la
    tabla de mayor `valid_from ≤` la fecha consultada.

    Se cargan DOS tablas (2025 y 2026), se trabaja una jornada REAL en junio
    de 2025 —turno abierto, entrada y salida por el roster, con el reloj de
    negocio de Bogotá movido con `app/core/clock.py`, **nunca derivando
    «hoy» en UTC** (error repetido nº1)— y recién entonces se liquida ese
    período viejo. La respuesta tiene que nombrar la tabla de **2025**. Si
    nombra la de 2026, una nómina vieja se recalcula con la ley de hoy, que
    es exactamente lo que §7 prohíbe.

    La precondición se arma **explícitamente acá** —las dos tablas, la
    tarifa por hora de la persona y su jornada—, no se hereda de ningún
    default de fixture (error repetido nº5): con una nómina vacía la
    respuesta trae `tables_used: []` y el invariante mediría el silencio, no
    la vigencia."""
    vieja = admin_client.post(
        f"{API}/admin/payroll/surcharge-tables?store_id={store.id}",
        json={
            "valid_from": "2025-01-01",
            "night_start_hour": 21,
            "night_end_hour": 6,
            "night_surcharge_bp": 3500,
            "sunday_holiday_surcharge_bp": 7500,
            "overtime_surcharge_bp": 2500,
            "weekly_ordinary_hours": 46,
        },
        headers=idem_headers(),
    )
    _skip_si_no_existe(vieja, "POST /admin/payroll/surcharge-tables", "T3 backend-nomina-propinas")
    if vieja.status_code == 422:
        pytest.skip(
            "AUSENCIA/CONTRATO: el cuerpo de `POST /admin/payroll/surcharge-tables` no encaja con "
            f"el que este invariante arma; revisar `SurchargeTableIn` (T3). Respuesta: {vieja.text[:400]}"
        )
    assert vieja.status_code in (200, 201), vieja.text

    nueva = admin_client.post(
        f"{API}/admin/payroll/surcharge-tables?store_id={store.id}",
        json={
            "valid_from": "2026-01-01",
            "night_start_hour": 19,
            "night_end_hour": 6,
            "night_surcharge_bp": 3500,
            "sunday_holiday_surcharge_bp": 9000,
            "overtime_surcharge_bp": 2500,
            "weekly_ordinary_hours": 46,
        },
        headers=idem_headers(),
    )
    assert nueva.status_code in (200, 201), nueva.text

    # Tarifa por hora de la persona, vigente desde 2025: sin ella la línea
    # no se puede liquidar y la corrida queda vacía.
    # Se usa un OPERADOR, no el responsable de caja: el responsable no puede
    # marcar salida sin un relevo (`NOT_CASH_RESPONSIBLE`), y este invariante
    # mide la vigencia de la tabla, no la regla del relevo.
    persona = employees["operator"]
    tarifa = admin_client.post(
        f"{API}/admin/payroll/wages?store_id={store.id}",
        json={"employee_id": persona.id, "hourly_wage_pesos": 8_000, "valid_from": "2025-01-01"},
        headers=idem_headers(),
    )
    if tarifa.status_code == 422:
        pytest.skip(
            "AUSENCIA/CONTRATO: el cuerpo de `POST /admin/payroll/wages` no encaja con el que este "
            f"invariante arma. Respuesta: {tarifa.text[:400]}"
        )
    assert tarifa.status_code in (200, 201), tarifa.text

    # Una jornada real en junio de 2025, por la puerta real. El reloj de
    # negocio se mueve con `app/core/clock.py`, que es la única puerta.
    clock.set(datetime(2025, 6, 16, 18, 0, tzinfo=timezone.utc))  # 13:00 en Bogotá
    turno = open_shift()
    identify(device_client, persona)
    entrada = device_client.post(
        f"{API}/shifts/{turno['id']}/roster",
        json={"employee_id": persona.id, "action": "in", "pin": "2222"},
    )
    assert entrada.status_code in (200, 201), entrada.text
    clock.advance(hours=8)
    salida = device_client.post(
        f"{API}/shifts/{turno['id']}/roster",
        json={"employee_id": persona.id, "action": "out", "pin": "2222"},
    )
    assert salida.status_code in (200, 201), salida.text

    # Hoy es 2026: se liquida un período VIEJO.
    clock.set(datetime(2026, 1, 15, 12, 0, tzinfo=timezone.utc))
    corrida = admin_client.post(
        f"{API}/admin/payroll/runs?store_id={store.id}",
        json={"date_from": "2025-06-01", "date_to": "2025-06-30"},
        headers=idem_headers(),
    )
    _skip_si_no_existe(corrida, "POST /admin/payroll/runs", "T3 backend-nomina-propinas")
    assert corrida.status_code in (200, 201), corrida.text
    cuerpo = corrida.json()

    assert cuerpo.get("tables_used"), (
        "la liquidación de un período con jornada cargada no nombra NINGUNA tabla de recargos "
        f"(`tables_used` vacío): sin eso no hay forma de auditar con qué ley se calculó. "
        f"Cuerpo: {str(cuerpo)[:600]} (CRUCE 5, dueño T3)"
    )

    texto = str(cuerpo)
    assert "2025-01-01" in texto, (
        "liquidar junio de 2025 tiene que nombrar la tabla vigente ENTONCES (`valid_from=2025-01-01`); "
        f"la respuesta no la nombra. Cuerpo: {texto[:600]} (CRUCE 5, dueño T3)"
    )
    assert "2026-01-01" not in texto, (
        "liquidar junio de 2025 usó la tabla de 2026: una nómina vieja se está recalculando con la "
        "ley de hoy (CRUCE 5, dueño T3)"
    )


# ===========================================================================
# CRUCE 6 — EL OPERADOR SIGUE SIN VER COSTOS, MÁRGENES, NÓMINA NI PROPINA
#           AJENA
# ===========================================================================


RUTAS_ADMIN_FASE3 = [
    "/admin/deposits",
    "/admin/deposits/pending",
    "/admin/bank/ledger",
    "/admin/bank/owner-hand",
    "/admin/reconciliation/card",
    "/admin/reconciliation/platform",
    "/admin/expenses",
    "/admin/obligations",
    "/admin/break-even",
    "/admin/profit",
    "/admin/payroll/hours",
    "/admin/payroll/surcharge-tables",
    "/admin/payroll/runs",
    "/admin/tips/distribution/proposal",
    "/admin/tips/settings",
    "/admin/menu-engineering",
    "/admin/variance/by-dish",
    "/admin/control-health/sustained",
    "/admin/replenishment",
]


@pytest.mark.parametrize("ruta", RUTAS_ADMIN_FASE3)
def test_an_operator_device_cannot_reach_any_new_admin_route(
    device_client: Any, identify: Any, employees: dict[str, Any], store: Any, clock: Any, ruta: str
) -> None:
    """CRUCE 6 · dueño: el dominio de la ruta.

    Se prueba con la sesión REAL del dispositivo del salón, con un operador
    identificado — no con un cliente sin credenciales, que probaría otra
    cosa. Toda ruta de esta fase publica costos, márgenes, nómina o el
    reparto de propinas de otro: ninguna puede responder `200` a un
    operador.

    Remedio si rojo por defecto: `Depends(current_admin)` en el endpoint (y
    NO `current_actor`)."""
    identify(device_client, employees["operator"])
    resp = device_client.get(f"{API}{ruta}", params={"store_id": store.id, "from": "2026-01-01", "to": "2026-01-31"})
    if resp.status_code == 404 and '"error"' not in (resp.text or ""):
        pytest.skip(f"AUSENCIA (no defecto): `{ruta}` todavía no existe")
    assert resp.status_code != 200, (
        f"un operador alcanzó `{ruta}` y recibió 200: el operador no ve costos, márgenes, "
        "nómina ajena ni el reparto de propinas de otro (CRUCE 6)"
    )
    assert resp.status_code in (401, 403), (
        f"`{ruta}` rechazó al operador con {resp.status_code}; se espera 401/403. Cuerpo: {resp.text[:300]}"
    )


def test_no_payroll_response_ever_names_an_employee_debt_or_a_payroll_deduction(
    admin_client: Any, store: Any, clock: Any
) -> None:
    """LA LÍNEA QUE NO SE CRUZA (SPEC-NEGOCIO §3.2 y §11.16; CST art. 149) ·
    dueño T3.

    El sistema **nunca** calcula una deuda del empleado ni genera un
    descuento de nómina por un faltante de caja. `test_cash_invariants.py` ya
    barre las respuestas de turno buscando `debt`, `deuda`, `owes` y
    `payroll_deduction`; acá se barre **la nómina**, que es donde alguien va
    a intentar cruzarla — ni siquiera opcional, ni siquiera en cero."""
    PROHIBIDAS = ("debt", "deuda", "owes", "payroll_deduction", "descuento_nomina", "shortage_deduction")
    rutas = [
        (f"{API}/admin/payroll/hours", {"store_id": store.id, "from": "2026-01-01", "to": "2026-01-31"}),
        (f"{API}/admin/payroll/runs", {"store_id": store.id}),
    ]
    hallazgos: list[str] = []
    alcanzadas = 0
    for ruta, params in rutas:
        resp = admin_client.get(ruta, params=params)
        if resp.status_code != 200:
            continue
        alcanzadas += 1
        texto = resp.text.lower()
        for palabra in PROHIBIDAS:
            if palabra in texto:
                hallazgos.append(f"{ruta} menciona `{palabra}`")

    if alcanzadas == 0:
        pytest.skip("AUSENCIA (no defecto): ninguna ruta de nómina responde todavía")
    assert not hallazgos, (
        "la nómina nombra una deuda del empleado o un descuento por faltante: CST art. 149 lo "
        "prohíbe y §11.16 lo declara no negociable (dueño T3): " + str(hallazgos)
    )


def test_no_new_model_declares_a_column_that_looks_like_an_employee_debt() -> None:
    """La misma línea, en el ESQUEMA · dueño T3. Una columna así no se
    arregla no publicándola: existe, se llena, y algún día alguien la
    muestra."""
    PROHIBIDAS = {"debt", "deuda", "owes", "payroll_deduction", "shortage_deduction", "employee_debt"}
    hallazgos: list[str] = []
    for ruta, arbol in _arboles_fase3():
        for nodo in ast.walk(arbol):
            if isinstance(nodo, ast.AnnAssign) and isinstance(nodo.target, ast.Name):
                if nodo.target.id.lower() in PROHIBIDAS:
                    hallazgos.append(f"{ruta}:{nodo.lineno} ({nodo.target.id}) [{_dueno_de(ruta)}]")
    assert not hallazgos, "un modelo/esquema nuevo declara una deuda del empleado: " + str(hallazgos)


# ===========================================================================
# CRUCE 7 — TODA CAPACIDAD NUEVA RESPONDE `400 FEATURE_DISABLED`,
#           Y LA DEPENDENCIA SE VALIDA **ANTES** QUE EL GATE DE SEDE
# ===========================================================================


GATES_FASE3 = [
    ("money.deposits", "/admin/deposits", "T1 backend-banco"),
    ("money.deposits", "/admin/deposits/pending", "T1 backend-banco"),
    ("money.bank", "/admin/bank/ledger", "T1 backend-banco"),
    ("money.bank", "/admin/bank/owner-hand", "T1 backend-banco"),
    ("money.bank", "/admin/reconciliation/card", "T1 backend-banco"),
    ("money.bank", "/admin/reconciliation/platform", "T1 backend-banco"),
    ("money.obligations", "/admin/expenses", "T2 backend-obligaciones"),
    ("money.obligations", "/admin/obligations", "T2 backend-obligaciones"),
    ("money.obligations", "/admin/break-even", "T2 backend-obligaciones"),
    ("money.obligations", "/admin/profit", "T2 backend-obligaciones"),
    ("payroll", "/admin/payroll/hours", "T3 backend-nomina-propinas"),
    ("payroll", "/admin/payroll/surcharge-tables", "T3 backend-nomina-propinas"),
    ("payroll", "/admin/payroll/runs", "T3 backend-nomina-propinas"),
    ("pos.tips", "/admin/tips/settings", "T3 backend-nomina-propinas"),
    ("analytics.menu_engineering", "/admin/menu-engineering", "T4 backend-analitica"),
    ("inventory.replenishment", "/admin/replenishment", "T4 backend-analitica"),
]


@pytest.mark.parametrize("flag,ruta,dueno", GATES_FASE3)
def test_every_new_capability_answers_400_feature_disabled_when_its_flag_is_off(
    admin_client: Any, set_feature: Any, store: Any, clock: Any, flag: str, ruta: str, dueno: str
) -> None:
    """CRUCE 7 · «toda función habilitable se prueba encendida y apagada».

    Con la función apagada la ruta corta en `400 FEATURE_DISABLED`, nunca
    `200` (la capacidad se filtra a un plan que no la incluye) ni `500`."""
    encendida = admin_client.get(
        f"{API}{ruta}", params={"store_id": store.id, "from": "2026-01-01", "to": "2026-01-31"}
    )
    if encendida.status_code == 404 and '"error"' not in (encendida.text or ""):
        pytest.skip(f"AUSENCIA (no defecto): `{ruta}` todavía no existe; dueño {dueno}")

    set_feature(flag, False)
    apagada = admin_client.get(
        f"{API}{ruta}", params={"store_id": store.id, "from": "2026-01-01", "to": "2026-01-31"}
    )
    assert apagada.status_code != 200, (
        f"`{ruta}` respondió 200 con `{flag}` APAGADA: la capacidad se filtra fuera de su plan "
        f"(CRUCE 7, dueño {dueno})"
    )
    assert _es_gate_apagado(apagada), (
        f"`{ruta}` con `{flag}` apagada respondió {apagada.status_code} en vez de "
        f"`400 FEATURE_DISABLED`. Cuerpo: {apagada.text[:300]} (dueño {dueno})"
    )


DEPENDENCIAS_FASE3 = [
    ("money.bank", "money.deposits", "/admin/bank/ledger", "T1 backend-banco"),
    ("analytics.menu_engineering", "catalog.recipes", "/admin/menu-engineering", "T4 backend-analitica"),
    ("inventory.replenishment", "inventory.perpetual", "/admin/replenishment", "T4 backend-analitica"),
    ("inventory.replenishment", "purchases", "/admin/replenishment", "T4 backend-analitica"),
]


@pytest.mark.parametrize("flag,dependencia,ruta,dueno", DEPENDENCIAS_FASE3)
def test_the_feature_dependency_is_validated_before_the_store_gate(
    admin_client: Any, set_feature: Any, store: Any, clock: Any,
    flag: str, dependencia: str, ruta: str, dueno: str,
) -> None:
    """CRUCE 7, la mitad que se olvida — **error repetido nº6** del proyecto.

    `app/core/features.py` declara `requires`, pero `require_feature` **no
    encadena** por sí solo: evalúa la clave puntual que se le pasa. Si la
    dependencia está apagada y el endpoint sólo mira su propia clave, el
    administrador recibe «esta sede no usa X» cuando la verdad es «tu plan no
    incluye Y», y lo manda a una pantalla que no puede arreglarlo.

    Precondición armada explícitamente: la función propia **encendida** y su
    dependencia **apagada**. El mensaje tiene que nombrar la DEPENDENCIA.

    Remedio si rojo por defecto: una dependencia compuesta que valide
    `requires` ANTES de la clave propia (el `_require_bank()` de
    `app/banking/router.py` es el patrón a copiar)."""
    sonda = admin_client.get(
        f"{API}{ruta}", params={"store_id": store.id, "from": "2026-01-01", "to": "2026-01-31"}
    )
    if sonda.status_code == 404 and '"error"' not in (sonda.text or ""):
        pytest.skip(f"AUSENCIA (no defecto): `{ruta}` todavía no existe; dueño {dueno}")

    set_feature(flag, True)
    set_feature(dependencia, False)
    resp = admin_client.get(
        f"{API}{ruta}", params={"store_id": store.id, "from": "2026-01-01", "to": "2026-01-31"}
    )

    assert _es_gate_apagado(resp), (
        f"`{ruta}` con la dependencia `{dependencia}` apagada respondió {resp.status_code}; "
        f"se espera `400 FEATURE_DISABLED`. Cuerpo: {resp.text[:300]} (dueño {dueno})"
    )
    nombrada = _feature_del_error(resp)
    assert nombrada == dependencia, (
        f"`{ruta}` culpó a `{nombrada}` cuando lo que falta es la DEPENDENCIA `{dependencia}`: "
        f"«tu plan no incluye esto» tiene que ganarle a «esta sede no lo usa» "
        f"(error repetido nº6, dueño {dueno})"
    )


# ===========================================================================
# CRUCE 8 — D-4: LA SUPRESIÓN ANONIMIZA Y **NO** BORRA EL ASIENTO,
#           Y SU AUDITORÍA GUARDA SÓLO NOMBRES DE CAMPOS
# ===========================================================================


# Titular de prueba de D-4: la persona cuya identidad se suprime. Sus datos
# se arman explícitamente acá, no se heredan de ningún default (error
# repetido nº5).
D4_CLIENTE = {
    "doc_type": "13",
    "doc_number": "1020304050",
    "name": "Ana Pérez Restrepo",
    "email": "ana.perez@correo.test",
    "address": "Carrera 7 # 12-34",
    "municipality_dane": "11001",
    "consent": {"text_version": "politica-v3", "channel": "pos"},
}


def _venta_con_cliente(device_client: Any, producto_id: int) -> dict[str, Any]:
    """Una venta REAL al titular de D-4, por la puerta real: es la única
    forma de que exista un `FiscalDocument` con su snapshot, que es el
    documento al que se cuelga la devolución pendiente. Mismo camino que
    usa `test_privacy_invariants.py`."""
    from tests.audit.conftest import NO_TIP, add_items, create_order, pay

    order = create_order(device_client, channel="counter").json()
    order = add_items(device_client, order, [{"product_id": producto_id, "qty": 1}]).json()
    resp = pay(
        device_client,
        order["id"],
        splits=[{"method": "cash", "amount": order["totals"]["total"]}],
        tip=NO_TIP,
        customer=D4_CLIENTE,
    )
    assert resp.status_code == 201, resp.text
    return dict(resp.json())


def _crear_pending_refund(db: Any, store: Any, employees: dict[str, Any], customer: Any, document_id: int) -> Any:
    """EXCEPCIÓN DECLARADA a «todo por HTTP»: `pending_refunds` sólo nace de
    una nota crédito emitida **sin ningún turno abierto**, un camino de 1b-2
    que exige cerrar el turno entre la venta y la nota. Armarlo completo acá
    probaría a `app/fiscal/` y a `app/refunds/`, no a D-4. La fila se escribe
    directa —es una tabla, no una regla— y **la supresión sí entra por
    HTTP**, que es lo que este invariante mide.

    El documento y el cliente, en cambio, son REALES: vienen de una venta
    por la puerta real, porque el snapshot del documento es parte de lo que
    D-4 promete no tocar."""
    from app.core import clock as clock_module
    from app.refunds.models import PendingRefund

    now = clock_module.now_utc()
    fila = PendingRefund(
        organization_id=store.organization_id,
        store_id=store.id,
        document_id=document_id,
        customer_id=customer.id,
        customer_name=D4_CLIENTE["name"],
        customer_doc_number=D4_CLIENTE["doc_number"],
        amount=45_000,
        method="cash",
        authorized_by_employee_id=employees["supervisor"].id,
        authorized_by_employee_name=employees["supervisor"].name,
        requested_at=now,
    )
    db.add(fila)
    db.commit()
    return fila


def test_d4_erasing_a_customer_anonymizes_the_pending_refund_but_never_the_money(
    device_client: Any, admin_client: Any, db: Any, store: Any, employees: dict[str, Any],
    open_shift: Any, sales_products: Any, clock: Any,
) -> None:
    """D-4 / CRUCE 8 · dueño T1.

    «No se borra la plata, se borra la identidad»: tras una supresión por
    habeas data, el `pending_refund` conserva **monto, documento asociado,
    quién la autorizó y su estado** intactos, y su **nombre** pasa a la forma
    anonimizada.

    **Este test entra por la puerta real** (`POST
    /admin/customers/{id}/erase`), no llamando a la función de anonimización:
    D-4 no es «existe una función que anonimiza», es «suprimir a una persona
    alcanza a sus devoluciones pendientes». Una función correcta que nadie
    llama deja el dato personal intacto en producción.

    Rojo **por defecto** si la supresión corre y el nombre sigue ahí."""
    import sqlalchemy as sa

    from app.customers.models import Customer
    from app.refunds.models import PendingRefund

    open_shift()
    venta = _venta_con_cliente(device_client, sales_products["inc8"].id)
    documento_id = venta["document"]["id"]

    db.expire_all()
    cliente = db.execute(sa.select(Customer)).scalars().one()
    fila = _crear_pending_refund(db, store, employees, cliente, documento_id)
    refund_id = fila.id

    erase = admin_client.post(
        f"{API}/admin/customers/{cliente.id}/erase",
        json={"reason": "el titular pidió la supresión"},
        headers=idem_headers(),
    )
    _skip_si_no_existe(erase, "POST /admin/customers/{id}/erase", "1b-2 (precondición)")
    assert erase.status_code in (200, 201), erase.text

    db.expire_all()
    despues = db.get(PendingRefund, refund_id)
    assert despues is not None, (
        "la supresión BORRÓ la devolución pendiente: D-4 dice anonimizar, no borrar; "
        "«nada financiero se borra» (dueño T1)"
    )
    assert despues.amount == 45_000, "la supresión tocó el MONTO de la devolución (dueño T1)"
    assert despues.document_id == fila.document_id, "la supresión tocó el documento asociado (dueño T1)"
    assert despues.status.value == "pending", "la supresión tocó el ESTADO de la devolución (dueño T1)"
    assert despues.authorized_by_employee_name == employees["supervisor"].name, (
        "la supresión tocó quién autorizó la devolución (dueño T1)"
    )
    assert despues.customer_name != D4_CLIENTE["name"], (
        "DEFECTO: se suprimió al titular y su NOMBRE sigue intacto en `pending_refunds`. "
        "D-4 dice que la supresión SÍ alcanza a esta tabla. `app/refunds/service.py` tiene la "
        "función `anonymize_pending_refunds_for_customer`, pero nadie la llama: falta la línea "
        "en `app/customers/service.py::erase_customer` (D-4 autoriza a T1 a tocar ese archivo) "
        "(dueño T1)"
    )


def test_d4_the_erasure_audit_stores_only_field_names_never_the_erased_data(
    device_client: Any, admin_client: Any, db: Any, store: Any, employees: dict[str, Any],
    open_shift: Any, sales_products: Any, clock: Any,
) -> None:
    """D-4 / CRUCE 8, la mitad que ya fue bloqueante una vez · dueño T1.

    `audit_logs` se conserva años y se exporta. Copiar el dato suprimido a
    `before` deja **exactamente lo que el titular pidió borrar**, intacto, en
    el mismo acto de borrarlo. Fue el bloqueante B-1 de 1b-2 y repetirlo acá
    sería reintroducir el mismo defecto.

    EXCEPCIÓN DECLARADA: `audit_logs` se lee de la tabla (es el libro; no hay
    ruta que lo devuelva sin filtrar por entidad)."""
    import sqlalchemy as sa

    from app.audit.models import AuditLog
    from app.customers.models import Customer

    open_shift()
    venta = _venta_con_cliente(device_client, sales_products["inc8"].id)
    db.expire_all()
    cliente = db.execute(sa.select(Customer)).scalars().one()
    _crear_pending_refund(db, store, employees, cliente, venta["document"]["id"])

    erase = admin_client.post(
        f"{API}/admin/customers/{cliente.id}/erase",
        json={"reason": "el titular pidió la supresión"},
        headers=idem_headers(),
    )
    _skip_si_no_existe(erase, "POST /admin/customers/{id}/erase", "1b-2 (precondición)")
    assert erase.status_code in (200, 201), erase.text

    db.expire_all()
    filas = db.execute(sa.select(AuditLog).where(AuditLog.organization_id == store.organization_id)).scalars().all()
    hallazgos: list[str] = []
    for log in filas:
        if log.action not in ("erase", "anonymize_personal_data"):
            continue  # sólo la auditoría DE LA SUPRESIÓN; el resto es el historial normal
        texto = f"{log.before!r} {log.after!r}"
        for dato in (D4_CLIENTE["name"], D4_CLIENTE["doc_number"], D4_CLIENTE["email"], D4_CLIENTE["address"]):
            if dato in texto:
                hallazgos.append(f"audit_logs#{log.id} ({log.entity}/{log.action}) filtró `{dato}`")
    assert not hallazgos, (
        "la auditoría de la supresión guardó el DATO suprimido, no sólo el nombre del campo: "
        "es el bloqueante B-1 de 1b-2 otra vez (dueño T1): " + str(hallazgos)
    )


# ===========================================================================
# EL CONTRATO DE API MÍNIMO — las rutas existen TAL CUAL están escritas
# ===========================================================================


CONTRATO_API = [
    ("GET", "/admin/deposits", "T1 backend-banco"),
    ("POST", "/admin/deposits", "T1 backend-banco"),
    ("GET", "/admin/deposits/pending", "T1 backend-banco"),
    ("GET", "/admin/bank/ledger", "T1 backend-banco"),
    ("GET", "/admin/bank/owner-hand", "T1 backend-banco"),
    ("GET", "/admin/reconciliation/card", "T1 backend-banco"),
    ("GET", "/admin/reconciliation/platform", "T1 backend-banco"),
    ("POST", "/admin/reconciliation/card/{}/settle", "T1 backend-banco"),
    ("GET", "/admin/expenses", "T2 backend-obligaciones"),
    ("POST", "/admin/expenses", "T2 backend-obligaciones"),
    ("GET", "/admin/obligations", "T2 backend-obligaciones"),
    ("POST", "/admin/obligations", "T2 backend-obligaciones"),
    ("POST", "/admin/obligations/{}/settle", "T2 backend-obligaciones"),
    ("GET", "/admin/break-even", "T2 backend-obligaciones"),
    ("GET", "/admin/profit", "T2 backend-obligaciones"),
    ("GET", "/admin/payables/{}", "T2 backend-obligaciones (D-2)"),
    ("POST", "/admin/payables/{}/approve", "T2 backend-obligaciones (D-2)"),
    ("GET", "/admin/payroll/hours", "T3 backend-nomina-propinas"),
    ("GET", "/admin/payroll/surcharge-tables", "T3 backend-nomina-propinas"),
    ("POST", "/admin/payroll/surcharge-tables", "T3 backend-nomina-propinas"),
    ("GET", "/admin/payroll/runs", "T3 backend-nomina-propinas"),
    ("POST", "/admin/payroll/runs", "T3 backend-nomina-propinas"),
    ("GET", "/admin/tips/distribution/proposal", "T3 backend-nomina-propinas"),
    ("POST", "/admin/tips/payouts", "1b-2 (ya existía; no se reescribe)"),
    ("GET", "/admin/tips/settings", "T3 backend-nomina-propinas"),
    ("PATCH", "/admin/tips/settings", "T3 backend-nomina-propinas"),
    ("GET", "/admin/menu-engineering", "T4 backend-analitica"),
    ("GET", "/admin/variance/by-dish", "T4 backend-analitica"),
    ("GET", "/admin/control-health/sustained", "T4 backend-analitica"),
    ("GET", "/admin/replenishment", "T4 backend-analitica"),
    ("GET", "/admin/sales", "1b-2 (cobro por mesero: group_by=employee)"),
]


def _rutas_publicadas(client: Any) -> set[tuple[str, str]]:
    spec = client.get("/openapi.json")
    assert spec.status_code == 200, spec.text
    import re

    publicadas: set[tuple[str, str]] = set()
    for ruta, metodos in spec.json()["paths"].items():
        normalizada = re.sub(r"\{[^}]+\}", "{}", ruta)
        if normalizada.startswith("/api/v1"):
            normalizada = normalizada[len("/api/v1") :]
        for metodo in metodos:
            publicadas.add((metodo.upper(), normalizada))
    return publicadas


@pytest.mark.parametrize("metodo,ruta,dueno", CONTRATO_API)
def test_every_route_of_the_minimum_api_contract_exists_exactly_as_written(
    admin_client: Any, metodo: str, ruta: str, dueno: str
) -> None:
    """CONTRATO DE API MÍNIMO (§2), sentido IDA · vinculante en las dos
    direcciones: un backend que publica otra ruta rompe la pantalla.

    Se compara contra el OpenAPI de la app REAL, normalizando el NOMBRE del
    parámetro de path (`{id}` vs `{settlement_id}` no cambia la URL; el
    nombre del segmento sí)."""
    publicadas = _rutas_publicadas(admin_client)
    assert (metodo, ruta) in publicadas, (
        f"el contrato de API mínimo fija `{metodo} {ruta}` y la API no la publica. "
        f"Del otro lado hay una pantalla que ya la consume (dueño {dueno}). "
        f"Rutas parecidas publicadas: "
        + str(sorted(r for m, r in publicadas if r.split('/')[:3] == ruta.split('/')[:3]))
    )


# ===========================================================================
# D-2 — `invoice_total` / `invoice_discrepancy`, y la cuenta con diferencia
#       NO SE APRUEBA SOLA
# ===========================================================================


def test_d2_the_payable_publishes_both_figures_and_amount_keeps_its_meaning(
    admin_client: Any, store: Any, clock: Any
) -> None:
    """D-2 · dueño T2. El esquema de la cuenta por pagar publica
    `invoice_total` (lo que dice el papel) e `invoice_discrepancy`
    (`invoice_total − amount`), y `Payable.amount` **no cambia de
    significado**: sigue siendo la cifra CALCULADA, la que costea el
    inventario.

    Se mide sobre el esquema publicado (OpenAPI), que es el contrato, no
    sobre el modelo."""
    spec = admin_client.get("/openapi.json")
    assert spec.status_code == 200
    esquemas = spec.json()["components"]["schemas"]
    payable = esquemas.get("PayableOut")
    assert payable is not None, "AUSENCIA: `PayableOut` no está en el OpenAPI"
    props = payable["properties"]
    for campo in ("invoice_total", "invoice_discrepancy"):
        assert campo in props, f"D-2 exige `{campo}` en `PayableOut` y no está (dueño T2)"
    assert "amount" in props, "`Payable.amount` desapareció de la salida (dueño T2)"

    aprobar = esquemas.get("PayableApproveIn")
    assert aprobar is not None, "AUSENCIA: `PayableApproveIn` no está en el OpenAPI"
    assert "confirm_discrepancy" in aprobar["properties"], (
        "D-2 exige `confirm_discrepancy` en la aprobación, con el MISMO patrón que "
        "`confirm_price` de `ReceptionIn` — no un segundo dialecto de confirmación (dueño T2)"
    )


def test_d2_copies_the_confirm_price_pattern_and_does_not_invent_a_second_dialect() -> None:
    """D-2 · dueño T2. «Dos formas distintas de decir "sí, ya sé, seguí" son
    dos formas de que alguien no entienda ninguna.»

    El patrón de `confirm_price` es: `409` + código estable + repetir con la
    confirmación + `*_confirmed_by_employee_*` guardado. Este invariante
    exige que la confirmación de D-2 use ese mismo molde y que NO aparezca un
    tercer nombre (`force`, `ignore_*`, `override_*`) en `app/purchases/`."""
    fuente = (BACKEND / "app" / "purchases" / "service.py").read_text(encoding="utf-8")
    assert "INVOICE_DISCREPANCY" in fuente, (
        "AUSENCIA: `app/purchases/service.py` no nombra `INVOICE_DISCREPANCY` (D-2, dueño T2)"
    )
    for inventado in ("force_approve", "ignore_discrepancy", "override_discrepancy", "skip_discrepancy"):
        assert inventado not in fuente, (
            f"D-2 inventó un segundo dialecto de confirmación (`{inventado}`) en vez de copiar "
            "`confirm_price` (dueño T2)"
        )
    modelos = (BACKEND / "app" / "purchases" / "models.py").read_text(encoding="utf-8")
    assert "discrepancy_confirmed_by_employee_id" in modelos, (
        "el patrón `confirm_price` guarda QUIÉN confirmó (`price_confirmed_by_employee_*`); "
        "D-2 tiene que guardar lo mismo (`discrepancy_confirmed_by_employee_*`) (dueño T2)"
    )


def test_d2_a_payable_with_a_discrepancy_is_not_approved_on_its_own(
    admin_client: Any, db: Any, store: Any, employees: dict[str, Any], clock: Any
) -> None:
    """D-2 · dueño T2. Con diferencia entre el papel y el cálculo,
    `POST /admin/payables/{id}/approve` corta con `409 INVOICE_DISCREPANCY`
    **nombrando las dos cifras**; sólo `confirm_discrepancy: true` la
    aprueba, y queda registrado quién confirmó.

    EXCEPCIÓN DECLARADA: la cuenta por pagar se arma por HTTP entera
    (proveedor → insumo → recepción con `invoice_total` distinto del
    calculado); sólo se lee la tabla para encontrar el `payable` que la
    recepción creó, porque `GET /admin/payables` filtra por estado."""
    from tests.audit.conftest import make_ingredient, make_supplier, reception_line

    proveedor = make_supplier(admin_client, store, name="Distribuidora Audit")
    insumo = make_ingredient(admin_client, store, name="Harina audit")

    recepcion = admin_client.post(
        f"{API}/receptions?store_id={store.id}",
        json={
            "supplier_id": proveedor["id"],
            "invoice_number": "F-AUDIT-1",
            "invoice_date": "2026-01-15",
            "no_invoice": False,
            # Lo que dice el PAPEL, distinto del cálculo a propósito: es la
            # precondición del `409` de D-2, armada explícitamente acá.
            "invoice_total": 999_999,
            "received_by_pin": "1111",
            "confirm_price": True,
            "lines": [reception_line(insumo["id"])],
        },
        headers=idem_headers(),
    )
    if recepcion.status_code == 422:
        pytest.skip(
            "AUSENCIA/CONTRATO: el cuerpo de `POST /receptions` no encaja con el que este "
            f"invariante arma. Respuesta: {recepcion.text[:400]}"
        )
    assert recepcion.status_code in (200, 201), recepcion.text
    assert recepcion.json().get("invoice_total") == 999_999, (
        "D-2: la recepción tiene que GUARDAR el total del papel tal cual; la respuesta dice "
        f"{recepcion.json().get('invoice_total')!r} (dueño T2)"
    )

    import sqlalchemy as sa

    from app.purchases.models import Payable

    payable = db.execute(
        sa.select(Payable).where(Payable.store_id == store.id).order_by(Payable.id.desc())
    ).scalars().first()
    assert payable is not None, "AUSENCIA de precondición: la recepción no creó cuenta por pagar"

    detalle = admin_client.get(f"{API}/admin/payables/{payable.id}")
    _skip_si_no_existe(detalle, "GET /admin/payables/{id}", "T2 backend-obligaciones (D-2)")
    assert detalle.status_code == 200, detalle.text
    cuerpo = detalle.json()
    assert cuerpo["invoice_total"] == 999_999, "D-2: el papel se guarda tal cual (dueño T2)"
    assert cuerpo["invoice_discrepancy"] == 999_999 - cuerpo["amount"], (
        "D-2: `invoice_discrepancy` es `invoice_total − amount` (dueño T2)"
    )

    sin_confirmar = admin_client.post(
        f"{API}/admin/payables/{payable.id}/approve",
        json={"authorizer_pin": "9999"},
        headers=idem_headers(),
    )
    assert sin_confirmar.status_code == 409, (
        f"una cuenta con diferencia SE APROBÓ SOLA ({sin_confirmar.status_code}): D-2 exige "
        f"`409 INVOICE_DISCREPANCY`. Cuerpo: {sin_confirmar.text[:300]} (dueño T2)"
    )
    error = sin_confirmar.json()["error"]
    assert error["code"] == "INVOICE_DISCREPANCY", error
    assert "999999" in error["message"].replace(".", "").replace(",", ""), (
        f"el `409` tiene que NOMBRAR LAS DOS CIFRAS; el mensaje no nombra el papel: {error['message']}"
    )
    assert str(cuerpo["amount"]) in error["message"].replace(".", "").replace(",", ""), (
        f"el `409` tiene que NOMBRAR LAS DOS CIFRAS; el mensaje no nombra el cálculo: {error['message']}"
    )

    confirmada = admin_client.post(
        f"{API}/admin/payables/{payable.id}/approve",
        json={"authorizer_pin": "9999", "confirm_discrepancy": True},
        headers=idem_headers(),
    )
    assert confirmada.status_code == 200, confirmada.text
    aprobada = confirmada.json()
    assert aprobada["discrepancy_confirmed"] is True, "quedó sin registrar que se confirmó (dueño T2)"
    assert aprobada["discrepancy_confirmed_by_employee_name"], (
        "el patrón `confirm_price` guarda QUIÉN confirmó; D-2 lo dejó vacío (dueño T2)"
    )


# ===========================================================================
# D-3 — TRES MÉTODOS, DEFAULT `by_hours`, Y LA PROPUESTA NO MUEVE PLATA
# ===========================================================================


def test_d3_the_default_tip_distribution_method_is_by_hours(
    admin_client: Any, store: Any, clock: Any
) -> None:
    """D-3 · dueño T3. Una sede que nunca configuró nada reparte **por
    horas**: es el único de los tres proporcional al trabajo hecho y el único
    que se le puede explicar a quien pregunte por qué le tocó menos."""
    resp = admin_client.get(f"{API}/admin/tips/settings", params={"store_id": store.id})
    _skip_si_no_existe(resp, "GET /admin/tips/settings", "T3 backend-nomina-propinas")
    assert resp.status_code == 200, resp.text
    assert resp.json()["method"] == "by_hours", (
        f"el default de D-3 es `by_hours`, no {resp.json()['method']!r} (dueño T3)"
    )


@pytest.mark.parametrize("metodo", ["equal_shares", "by_hours", "by_area"])
def test_d3_the_three_distribution_methods_exist(
    admin_client: Any, store: Any, clock: Any, metodo: str
) -> None:
    """D-3 · dueño T3. Se construyen **los tres**, configurables por sede."""
    resp = admin_client.patch(
        f"{API}/admin/tips/settings?store_id={store.id}",
        json={"method": metodo},
        headers=idem_headers(),
    )
    _skip_si_no_existe(resp, "PATCH /admin/tips/settings", "T3 backend-nomina-propinas")
    assert resp.status_code == 200, (
        f"D-3 ofrece los tres métodos; `{metodo}` fue rechazado ({resp.status_code}): "
        f"{resp.text[:300]} (dueño T3)"
    )
    assert resp.json()["method"] == metodo


def test_d3_the_proposal_is_a_proposal_and_writes_absolutely_nothing(
    admin_client: Any, device_client: Any, open_shift: Any, db: Any, store: Any, clock: Any
) -> None:
    """D-3 · dueño T3. «El reparto es una PROPUESTA QUE ALGUIEN CONFIRMA,
    nunca una transferencia automática.»

    `GET /admin/tips/distribution/proposal` no puede escribir **nada**: ni un
    `TipPayout`, ni una `TipPayoutDistribution`, ni un `CashMovement`. Se
    cuentan las tres tablas antes y después.

    EXCEPCIÓN DECLARADA: las tres se cuentan leyendo la tabla (son libros;
    contar por HTTP obligaría a una ruta de listado que no es la que se está
    auditando).

    Remedio si rojo por defecto: la escritura del reparto sigue siendo
    `app/shifts/tips.py::register_tip_payout` vía `POST /admin/tips/payouts`,
    que YA EXISTÍA desde 1b-2. El `GET` sólo calcula."""
    import sqlalchemy as sa

    from app.shifts.models import CashMovement, TipPayout, TipPayoutDistribution

    turno = open_shift()

    def _conteos() -> tuple[int, int, int]:
        return (
            int(db.execute(sa.select(sa.func.count()).select_from(TipPayout)).scalar_one()),
            int(db.execute(sa.select(sa.func.count()).select_from(TipPayoutDistribution)).scalar_one()),
            int(db.execute(sa.select(sa.func.count()).select_from(CashMovement)).scalar_one()),
        )

    antes = _conteos()
    resp = admin_client.get(
        f"{API}/admin/tips/distribution/proposal",
        params={"store_id": store.id, "shift_id": turno["id"]},
    )
    _skip_si_no_existe(resp, "GET /admin/tips/distribution/proposal", "T3 backend-nomina-propinas")
    assert resp.status_code == 200, resp.text
    db.expire_all()
    despues = _conteos()

    assert despues == antes, (
        f"la PROPUESTA escribió en la base ({antes} -> {despues}): D-3 dice que el sistema propone "
        "y registra, pero no mueve plata solo (dueño T3)"
    )
    cuerpo = resp.json()
    for campo in ("method", "rows", "total"):
        assert campo in cuerpo, f"el contrato fija `{campo}` en la propuesta y no está (dueño T3)"


def test_d3_payroll_does_not_create_its_own_tip_payout_tables() -> None:
    """D-3 · dueño T3. «D-3 no crea tablas de reparto: calcula la propuesta y
    la asienta en las que ya están» (`tip_payouts` y
    `tip_payout_distributions`, de 1b-2).

    Una tabla nueva de reparto sería un segundo libro de lo mismo: dos
    respuestas a «a quién se le pagó cuánto»."""
    prohibidas = {"tip_payouts", "tip_payout_distributions", "tip_distributions", "tip_payout"}
    hallazgos: list[str] = []
    for ruta, arbol in _arboles_fase3():
        if not ruta.endswith("models.py"):
            continue
        for nodo in ast.walk(arbol):
            if isinstance(nodo, ast.Assign):
                for objetivo in nodo.targets:
                    if isinstance(objetivo, ast.Name) and objetivo.id == "__tablename__":
                        if isinstance(nodo.value, ast.Constant) and nodo.value.value in prohibidas:
                            hallazgos.append(f"{ruta}:{nodo.lineno} ({nodo.value.value}) [{_dueno_de(ruta)}]")
    assert not hallazgos, "un dominio nuevo duplicó las tablas de reparto de 1b-2: " + str(hallazgos)


def test_d3_the_write_path_is_still_the_one_that_already_existed() -> None:
    """D-3 · dueño T3. El «confirmar» llama a
    `app/shifts/tips.py::register_tip_payout` tal cual — no una función
    nueva. Si `app/payroll/` escribiera el reparto por su cuenta, habría dos
    puertas de escritura y sólo una dispararía la auditoría de 1b-2."""
    from app.shifts import tips

    assert hasattr(tips, "register_tip_payout"), (
        "AUSENCIA: `app.shifts.tips.register_tip_payout` no existe (precondición de 1b-2)"
    )
    hallazgos: list[str] = []
    for ruta, arbol in _arboles_fase3():
        if not ruta.startswith("app/payroll/"):
            continue
        for nodo in ast.walk(arbol):
            if isinstance(nodo, ast.Assign):
                for objetivo in nodo.targets:
                    if (
                        isinstance(objetivo, ast.Attribute)
                        and objetivo.attr in ("amount", "employee_id", "paid_at")
                        and isinstance(objetivo.value, ast.Name)
                        and objetivo.value.id in ("payout", "tip_payout", "distribution")
                    ):
                        hallazgos.append(f"{ruta}:{nodo.lineno} ({objetivo.attr})")
    assert not hallazgos, (
        "`app/payroll/` escribe un reparto de propinas a mano en vez de llamar a "
        "`register_tip_payout` (D-3, dueño T3): " + str(hallazgos)
    )


# ===========================================================================
# T4 — INGENIERÍA DE MENÚ SOBRE EL COSTO CONGELADO, Y LA VARIANZA
#      SE DECLARA PRORRATEADA
# ===========================================================================


def test_variance_by_dish_declares_itself_prorated_in_the_response(
    admin_client: Any, store: Any, clock: Any
) -> None:
    """§5.4 · dueño T4. La varianza por plato es «sólo estimación
    prorrateada»: el método va **explícito en la respuesta** (y en pantalla,
    que se audita en `frontend/src/audit/menu-engineering.test.tsx`).

    Sin el método a la vista, un número prorrateado se lee como una medición
    y alguien va a pedirle cuentas a un cocinero por un decimal que el
    sistema repartió."""
    resp = admin_client.get(
        f"{API}/admin/variance/by-dish", params={"store_id": store.id, "count_id": 1}
    )
    _skip_si_no_existe(resp, "GET /admin/variance/by-dish", "T4 backend-analitica")
    if resp.status_code == 404:
        cuerpo = resp.json()
        assert "error" in cuerpo, resp.text
        pytest.skip(
            "AUSENCIA de precondición: no hay conteo aplicado (`count_id=1`) sobre el que medir "
            "varianza; el invariante del método se cobra igual en el test de esquema de abajo"
        )
    assert resp.status_code == 200, resp.text
    assert resp.json().get("method") == "prorated", (
        f"la varianza por plato no se declara prorrateada: `method` = {resp.json().get('method')!r} "
        "(§5.4, dueño T4)"
    )


def test_the_variance_by_dish_schema_pins_the_prorated_method(admin_client: Any) -> None:
    """§5.4, del lado del contrato · el `method` no puede ser un `str`
    cualquiera: es el literal `"prorated"` en el esquema publicado, para que
    nadie lo pueda apagar con un parámetro."""
    spec = admin_client.get("/openapi.json")
    assert spec.status_code == 200
    esquemas = spec.json()["components"]["schemas"]
    salida = esquemas.get("VarianceByDishOut")
    if salida is None:
        pytest.skip("AUSENCIA (no defecto): `VarianceByDishOut` todavía no está publicado (T4)")
    metodo = salida["properties"].get("method")
    assert metodo is not None, "el contrato fija `method` en la respuesta (§5.4, dueño T4)"
    assert metodo.get("const") == "prorated" or metodo.get("enum") == ["prorated"], (
        f"`method` tiene que estar fijado al literal `prorated`, no ser un texto libre: {metodo} (dueño T4)"
    )


def test_menu_engineering_uses_the_cost_frozen_in_the_item_not_todays_recipe() -> None:
    """§5.4/§9 · dueño T4. «Ningún reporte revalora una venta pasada con la
    carta de hoy.»

    El invariante es sintáctico porque es donde se rompe: `app/analytics/`
    no puede leer el costo desde `Recipe`/`RecipeLine`/`Product` para valorar
    una venta; el costo congelado vive en `OrderItem.unit_cost_micros` /
    `theoretical_cost_micros`.

    Y **usa los micros**: sumar `unit_cost` (pesos, ya redondeado) línea por
    línea pierde plata real en platos de costo menor a $1
    (`app/reports/service.py` ya documenta por qué)."""
    hallazgos_recetas: list[str] = []
    usa_micros = False
    usa_pesos_por_linea = False
    for ruta, arbol in _arboles_fase3():
        if not ruta.startswith("app/analytics/"):
            continue
        for nodo in ast.walk(arbol):
            if isinstance(nodo, ast.Attribute):
                if nodo.attr in ("unit_cost_micros", "theoretical_cost_micros"):
                    usa_micros = True
                if nodo.attr == "unit_cost" and isinstance(nodo.value, ast.Name) and nodo.value.id in (
                    "item",
                    "order_item",
                    "linea",
                    "line",
                ):
                    usa_pesos_por_linea = True
                if nodo.attr in ("official_cost_micros", "cost_micros") and isinstance(nodo.value, ast.Name):
                    if nodo.value.id in ("recipe", "recipe_line", "product", "ficha"):
                        hallazgos_recetas.append(f"{ruta}:{nodo.lineno} ({nodo.value.id}.{nodo.attr})")

    if not usa_micros and not usa_pesos_por_linea:
        pytest.skip("AUSENCIA (no defecto): `app/analytics/` todavía no valora ventas (T4)")
    assert not hallazgos_recetas, (
        "la ingeniería de menú lee el costo de la ficha de HOY en vez del congelado en el ítem "
        "(dueño T4): " + str(hallazgos_recetas)
    )
    assert usa_micros, (
        "la ingeniería de menú no usa `unit_cost_micros`/`theoretical_cost_micros`: acumular en "
        "pesos redondeados por línea desvía el food cost hacia arriba (dueño T4)"
    )
    assert not usa_pesos_por_linea, (
        "la ingeniería de menú suma `OrderItem.unit_cost` (pesos redondeados) por línea en vez de "
        "acumular en micros y redondear UNA sola vez al final (dueño T4)"
    )


# ===========================================================================
# T1 — LA MANO DEL DUEÑO CUADRA, Y UN MISMO PESO NO ESTÁ EN DOS LADOS
# ===========================================================================


def test_the_owner_hand_equation_holds_withdrawn_minus_deposited_minus_spent(
    device_client: Any, admin_client: Any, open_shift: Any, store: Any, clock: Any
) -> None:
    """Checklist «la mano del dueño cuadra» · dueño T1:
    `retirado − consignado − gastado = saldo`.

    No se deriva nada acá: se leen las cuatro cifras que publica el backend y
    se exige que la identidad se cumpla **entre ellas**. Si no cuadra, el
    dueño está viendo cuatro números que no son el mismo relato."""
    turno = open_shift()
    pickup = device_client.post(
        f"{API}/shifts/{turno['id']}/pickups",
        json={"amount": 100_000, "authorizer_pin": "9999", "photo": PHOTO},
        headers=idem_headers(),
    )
    assert pickup.status_code in (200, 201), pickup.text

    resp = admin_client.get(
        f"{API}/admin/bank/owner-hand", params={"store_id": store.id, **_rango(date(2026, 1, 15))}
    )
    _skip_si_no_existe(resp, "GET /admin/bank/owner-hand", "T1 backend-banco")
    assert resp.status_code == 200, resp.text
    m = resp.json()

    assert m["withdrawn"] - m["deposited"] - m["spent"] == m["balance"], (
        f"la mano del dueño no cuadra: {m['withdrawn']} − {m['deposited']} − {m['spent']} != "
        f"{m['balance']} (dueño T1)"
    )
    assert m["withdrawn"] >= 100_000, (
        "un retiro de caja es plata que pasó a la mano del dueño y no aparece en `withdrawn` (dueño T1)"
    )


def test_the_same_peso_cannot_be_in_the_hand_and_in_the_bank_at_the_same_time(
    device_client: Any, admin_client: Any, open_shift: Any, store: Any, clock: Any
) -> None:
    """LA LLAVE ANTI DOBLE CONTEO de T1 (retiro vs consignación) · dueño T1.

    Es obligación del auditor intentar romperla: se retira plata del cajón y
    después se consigna esa misma plata. El saldo en la mano tiene que BAJAR
    exactamente lo consignado — si no baja, el mismo peso está contado dos
    veces, en la mano y en el banco."""
    turno = open_shift()
    pickup = device_client.post(
        f"{API}/shifts/{turno['id']}/pickups",
        json={"amount": 100_000, "authorizer_pin": "9999", "photo": PHOTO},
        headers=idem_headers(),
    )
    assert pickup.status_code in (200, 201), pickup.text

    antes = admin_client.get(
        f"{API}/admin/bank/owner-hand", params={"store_id": store.id, **_rango(date(2026, 1, 15))}
    )
    _skip_si_no_existe(antes, "GET /admin/bank/owner-hand", "T1 backend-banco")
    assert antes.status_code == 200, antes.text
    saldo_antes = antes.json()["balance"]

    deposito = admin_client.post(
        f"{API}/admin/deposits?store_id={store.id}",
        json={"amount": 60_000, "receipt_photo": PHOTO, "bank_name": "Bancolombia"},
        headers=idem_headers(),
    )
    assert deposito.status_code in (200, 201), deposito.text

    despues = admin_client.get(
        f"{API}/admin/bank/owner-hand", params={"store_id": store.id, **_rango(date(2026, 1, 15))}
    )
    assert despues.status_code == 200, despues.text
    saldo_despues = despues.json()["balance"]

    assert saldo_despues == saldo_antes - 60_000, (
        f"consignar $60.000 no bajó la mano del dueño ({saldo_antes} -> {saldo_despues}): el mismo "
        "peso está «en la mano» y «en el banco» a la vez (llave anti doble conteo de T1)"
    )


def test_reconciling_a_platform_settlement_does_not_duplicate_the_receivable(
    admin_client: Any, db: Any, store: Any, platform: Any, clock: Any
) -> None:
    """Checklist «sin duplicar la cuenta por cobrar» · dueño T1.

    `app/channels/` ya registra la cuenta por cobrar de una venta por
    plataforma. Conciliar la liquidación **no puede crear una segunda**: si
    lo hiciera, el mes cerraría con el doble de plata por cobrar.

    EXCEPCIÓN DECLARADA: se cuentan las filas de `platform_receivables` en la
    tabla (es el libro de `channels`, que no es territorio de esta fase)."""
    from tests.audit.conftest import receivables_of

    antes = len(receivables_of(db, store))

    liquidacion = admin_client.post(
        f"{API}/admin/reconciliation/platform?store_id={store.id}",
        json={
            "platform_id": platform.id,
            "period_from": "2026-01-01",
            "period_to": "2026-01-15",
            "gross_amount": 500_000,
            "commission_amount": 100_000,
            "reference": "LIQ-1",
        },
        headers=idem_headers(),
    )
    _skip_si_no_existe(liquidacion, "POST /admin/reconciliation/platform", "T1 backend-banco")
    if liquidacion.status_code == 422:
        pytest.skip(
            "AUSENCIA/CONTRATO: el cuerpo de la liquidación de plataforma no encaja con el que "
            f"este invariante arma. Respuesta: {liquidacion.text[:400]}"
        )
    assert liquidacion.status_code in (200, 201), liquidacion.text

    db.expire_all()
    despues = len(receivables_of(db, store))
    assert despues == antes, (
        f"registrar la liquidación de plataforma creó {despues - antes} cuenta(s) por cobrar nueva(s): "
        "`app/channels/` ya la registró y `app/banking/` la está duplicando (dueño T1)"
    )


# ===========================================================================
# TRANSVERSAL — NADA FINANCIERO SE BORRA, NINGUNA REGLA RESPONDE `500`,
#               Y `alembic heads` DEVUELVE UNA SOLA CABEZA
# ===========================================================================


def test_no_new_domain_physically_deletes_a_financial_row() -> None:
    """`AGENTS.md` / §9 · dueño: el dominio donde caiga. «Nada financiero ni
    de inventario se borra: baja lógica + auditoría con antes y después.»

    Un `db.delete(...)` en un dominio de plata es un asiento que desaparece
    sin rastro."""
    hallazgos: list[str] = []
    for ruta, arbol in _arboles_fase3():
        for nodo in ast.walk(arbol):
            if (
                isinstance(nodo, ast.Call)
                and isinstance(nodo.func, ast.Attribute)
                and nodo.func.attr in ("delete", "hard_delete")
                and isinstance(nodo.func.value, ast.Name)
                and nodo.func.value.id in ("db", "session")
            ):
                hallazgos.append(f"{ruta}:{nodo.lineno} [{_dueno_de(ruta)}]")
    assert not hallazgos, "un dominio de plata borra físicamente una fila: " + str(hallazgos)


@pytest.mark.parametrize("ruta", RUTAS_ADMIN_FASE3)
def test_no_business_rule_of_the_new_routes_ever_answers_500(
    admin_client: Any, store: Any, clock: Any, ruta: str
) -> None:
    """§7 · «Ninguna regla de negocio responde `500`.»

    Se golpea cada ruta nueva con los parámetros mínimos y con un rango
    invertido (`from > to`), que es la forma más barata de encontrar una
    división por cero o un `None` sin defender. `400`/`404`/`409`/`422` son
    respuestas legítimas; `500` no lo es nunca."""
    for params in (
        {"store_id": store.id, "from": "2026-01-01", "to": "2026-01-31"},
        {"store_id": store.id, "from": "2026-01-31", "to": "2026-01-01"},
    ):
        resp = admin_client.get(f"{API}{ruta}", params=params)
        assert resp.status_code < 500, (
            f"`{ruta}` con {params} respondió {resp.status_code}: ninguna regla de negocio "
            f"responde 500. Cuerpo: {resp.text[:400]}"
        )


def test_alembic_has_exactly_one_head() -> None:
    """Checklist de la fase · dueño: el orquestador si hay que reencadenar.

    Cuatro agentes creando migraciones en paralelo producen cuatro cabezas y
    `alembic upgrade head` deja de existir como comando. La cadena repartida
    es `0017 banking` sobre `0016`, `0018 expenses` sobre `0017`,
    `0019 invoice_total` sobre `0018`, `0020 payroll` sobre `0019`,
    `0021 analytics` sobre `0020` — **salvo que analytics haya declarado que
    no necesitó tablas**, en cuyo caso `0021` no existe y la cabeza es
    `0020`.

    Se lee el árbol de migraciones directamente (no `alembic heads` por
    subproceso: necesita una base y un `alembic.ini` resueltos, y este
    invariante mide la CADENA, no el estado de una base)."""
    versiones = BACKEND / "alembic" / "versions"
    revisiones: dict[str, str | None] = {}
    for archivo in sorted(versiones.glob("*.py")):
        arbol = ast.parse(archivo.read_text(encoding="utf-8"), filename=str(archivo))
        rev: str | None = None
        down: str | None = None
        for nodo in arbol.body:
            if isinstance(nodo, (ast.Assign, ast.AnnAssign)):
                objetivos = nodo.targets if isinstance(nodo, ast.Assign) else [nodo.target]
                valor = nodo.value
                for objetivo in objetivos:
                    if not isinstance(objetivo, ast.Name) or valor is None:
                        continue
                    if objetivo.id == "revision" and isinstance(valor, ast.Constant):
                        rev = valor.value
                    if objetivo.id == "down_revision":
                        down = valor.value if isinstance(valor, ast.Constant) else None
        assert rev is not None, f"{archivo.name} no declara `revision`"
        assert rev not in revisiones, f"revisión duplicada `{rev}` en {archivo.name}"
        revisiones[rev] = down

    padres = {d for d in revisiones.values() if d is not None}
    cabezas = sorted(set(revisiones) - padres)
    assert len(cabezas) == 1, (
        f"`alembic heads` devolvería {len(cabezas)} cabezas ({cabezas}): `alembic upgrade head` "
        "deja de existir como comando y la fase no se despliega. El orquestador tiene que "
        "reencadenar los `down_revision`"
    )
    huerfanos = sorted(d for d in padres if d not in revisiones)
    assert not huerfanos, (
        f"hay migraciones cuyo `down_revision` apunta a una revisión que no existe: {huerfanos}"
    )


def test_the_phase_three_migration_chain_is_the_one_the_spec_assigned() -> None:
    """§2, la tabla de la cadena · dueño: el territorio de cada migración.

    Cada territorio escribe **su número y su padre asignados**, no «el
    siguiente». Un agente que tome «el siguiente» produce una cabeza nueva
    en cuanto otro haga lo mismo."""
    esperado = {
        "0017": ("0016", "T1 backend-banco"),
        "0018": ("0017", "T2 backend-obligaciones"),
        "0019": ("0018", "T2 backend-obligaciones (D-2)"),
        "0020": ("0019", "T3 backend-nomina-propinas"),
        "0021": ("0020", "T4 backend-analitica (sólo si necesitó tablas)"),
    }
    versiones = BACKEND / "alembic" / "versions"
    encontradas: dict[str, str | None] = {}
    for archivo in sorted(versiones.glob("*.py")):
        arbol = ast.parse(archivo.read_text(encoding="utf-8"), filename=str(archivo))
        rev = down = None
        for nodo in arbol.body:
            if isinstance(nodo, (ast.Assign, ast.AnnAssign)):
                objetivos = nodo.targets if isinstance(nodo, ast.Assign) else [nodo.target]
                valor = nodo.value
                for objetivo in objetivos:
                    if not isinstance(objetivo, ast.Name) or valor is None:
                        continue
                    if objetivo.id == "revision" and isinstance(valor, ast.Constant):
                        rev = valor.value
                    if objetivo.id == "down_revision":
                        down = valor.value if isinstance(valor, ast.Constant) else None
        if rev in esperado:
            encontradas[str(rev)] = down

    errores: list[str] = []
    for rev, (padre, dueno) in esperado.items():
        if rev not in encontradas:
            continue  # ausencia: o todavía no está, o el territorio declaró que no necesitó tablas
        if encontradas[rev] != padre:
            errores.append(f"{rev}.down_revision = {encontradas[rev]!r}, la spec asignó {padre!r} [{dueno}]")
    assert not errores, "la cadena repartida de Alembic no se respetó: " + str(errores)


def test_alembic_heads_reports_a_single_head_through_the_real_command() -> None:
    """El mismo invariante, por la puerta real (`alembic heads`).

    El test de arriba mide la CADENA en el árbol; éste mide lo que el
    comando del despliegue va a decir. Se salta —no se ablanda— si `alembic`
    no está instalado en este entorno."""
    try:
        proc = subprocess.run(
            ["alembic", "heads"],
            cwd=str(BACKEND),
            capture_output=True,
            text=True,
            timeout=120,
            env={"PATH": "/usr/local/bin:/usr/bin:/bin", "DATABASE_URL": "sqlite:///./audit-heads.db", "PYTHONPATH": "."},
        )
    except (FileNotFoundError, subprocess.TimeoutExpired) as exc:  # pragma: no cover
        pytest.skip(f"AUSENCIA de herramienta: no se pudo correr `alembic heads` ({exc})")
    if proc.returncode != 0:
        pytest.skip(f"AUSENCIA de entorno: `alembic heads` falló: {proc.stderr[-500:]}")
    cabezas = [linea for linea in proc.stdout.splitlines() if linea.strip()]
    assert len(cabezas) == 1, f"`alembic heads` devolvió {len(cabezas)} cabezas: {cabezas}"


# ===========================================================================
# «COBRO POR MESERO» NO LLEVA RUTA NUEVA
# ===========================================================================


def test_charge_by_waiter_did_not_grow_a_second_report(admin_client: Any) -> None:
    """§2, T4 · «Cobro por mesero YA ESTÁ CONSTRUIDO»
    (`GET /admin/sales?group_by=employee`, desde 1b-2). **No se construye un
    segundo reporte.**

    Dos reportes de lo mismo son dos respuestas a «cuánto cobró Juan», y la
    que esté mal va a ser la que alguien mire."""
    publicadas = _rutas_publicadas(admin_client)
    sospechosas = sorted(
        ruta
        for _m, ruta in publicadas
        if ("waiter" in ruta or "by-employee" in ruta or "per-employee" in ruta or "mesero" in ruta)
    )
    assert not sospechosas, (
        "apareció un segundo reporte de «cobro por mesero»; el que vale es "
        "`GET /admin/sales?group_by=employee`, de 1b-2: " + str(sospechosas)
    )
    assert ("GET", "/admin/sales") in publicadas, (
        "AUSENCIA de precondición: `GET /admin/sales` (1b-2) no está publicada"
    )
