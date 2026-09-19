"""Invariantes ejecutables de CONTEOS, LOTES, VARIANZA y FOOD COST (pedido 2b).

`docs/SPEC-NEGOCIO.md` §5.4 (conteos a ciegas y varianza), §5.7 (lotes y
vencimientos) y §4.1 (la jerarquía de costo de cinco escalones).

El renglón más caro del checklist vive acá: **aplicar un conteo usa «contado +
(entradas − salidas desde el INSTANTE DEL CONTEO)», no desde el instante de
aplicar**. En la referencia, aplicarlo desde el instante de aplicar es lo que
«mandó a buscar un robo que no existe»: un conteo de las 13:07 aplicado a las
15:42 convertía en faltante todo lo que el restaurante vendió en el medio.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

import pytest

from tests.audit.conftest import (
    API_V1,
    NO_TIP,
    add_items,
    apply_count,
    create_order,
    get_order,
    idem_headers,
    lots_of,
    make_ingredient,
    make_supplier,
    open_count,
    pay,
    post_reception,
    put_recipe,
    reception_line,
    save_count_lines,
    send,
    stock_of,
)

API = API_V1


def _count_lines_of(admin_client: Any, store: Any, count_id: int) -> list[dict[str, Any]]:
    resp = admin_client.get(f"{API}/admin/counts/{count_id}?store_id={store.id}")
    assert resp.status_code == 200, resp.text
    return resp.json()["lines"]


def _deep_values(node: Any) -> list[Any]:
    out: list[Any] = []
    if isinstance(node, dict):
        for value in node.values():
            out.append(value)
            out.extend(_deep_values(value))
    elif isinstance(node, list):
        for item in node:
            out.append(item)
            out.extend(_deep_values(item))
    return out


def _deep_keys(node: Any) -> set[str]:
    keys: set[str] = set()
    if isinstance(node, dict):
        for key, value in node.items():
            keys.add(key)
            keys |= _deep_keys(value)
    elif isinstance(node, list):
        for item in node:
            keys |= _deep_keys(item)
    return keys


# ---------------------------------------------------------------------------
# (a) El conteo es A CIEGAS — sobre el JSON, no sobre la pantalla.
# ---------------------------------------------------------------------------


def test_no_response_of_the_capture_flow_carries_the_theoretical_stock(
    admin_client: Any, store: Any, db: Any
) -> None:
    """Checklist 2b: «ninguna respuesta del flujo de captura contiene el stock
    teórico por ningún camino (test sobre el JSON, no sobre la pantalla)».

    Se recorre el cuerpo ENTERO de las tres respuestas del flujo (abrir,
    leer, guardar renglones) buscando el número exacto del stock teórico a
    cualquier profundidad, en entero y en texto decimal. Un conteo que ve el
    teórico deja de ser un conteo: es una confirmación.
    """
    from app.core.quantity import format_qty_base

    ing = make_ingredient(admin_client, store, name="Arroz", official_cost="5", min_stock="1000")
    supplier = make_supplier(admin_client, store)
    post_reception(
        admin_client, store, [reception_line(ing["id"], qty_received="7331", purchase_unit_price="5000")],
        supplier_id=supplier["id"],
    )
    teorico = stock_of(db, store, ingredient_id=ing["id"])
    assert teorico != 0, "el caso no se armó: sin stock teórico el test no probaría nada"
    prohibidos = {teorico, str(teorico), format_qty_base(teorico)}

    abierto = admin_client.post(f"{API}/admin/counts?store_id={store.id}", json={"scope": "full"})
    assert abierto.status_code == 201, abierto.text
    count_id = abierto.json()["id"]
    detalle = admin_client.get(f"{API}/admin/counts/{count_id}?store_id={store.id}")
    assert detalle.status_code == 200, detalle.text
    guardado = admin_client.put(
        f"{API}/admin/counts/{count_id}/lines?store_id={store.id}",
        json={"lines": [{"ingredient_id": ing["id"], "qty_counted": "7000", "was_counted": True}]},
    )
    assert guardado.status_code == 200, guardado.text
    listado = admin_client.get(f"{API}/admin/counts?store_id={store.id}")
    assert listado.status_code == 200, listado.text

    for nombre, resp in (("open", abierto), ("detail", detalle), ("save", guardado), ("list", listado)):
        valores = set(map(str, _deep_values(resp.json())))
        filtrado = valores & {str(p) for p in prohibidos}
        assert not filtrado, f"la respuesta de `{nombre}` del flujo de captura publica el stock teórico: {filtrado}"
        claves = {k.lower() for k in _deep_keys(resp.json())}
        for sospechosa in ("theoretical", "stock_teorico", "qty_base", "current_stock", "expected_qty", "system_qty"):
            assert sospechosa not in claves, f"`{nombre}` publica el campo `{sospechosa}` en el flujo de captura"

    # La referencia en pantalla es el CONTEO ANTERIOR (§5.4), no el teórico.
    assert "previous_qty_counted" in {k for k in _deep_keys(detalle.json())}


def test_there_is_no_everything_matches_shortcut(admin_client: Any, store: Any) -> None:
    """Checklist 2b: «No existe "todo coincide": ninguna ruta ni botón marca
    todos los renglones de una vez» (borró faltantes reales de −10.065 g en
    la referencia). Test de contrato sobre el OpenAPI **y** sobre el esquema
    de entrada: `was_counted` se escribe renglón por renglón."""
    from app.inventory.schemas import CountLineRefIn, CountLinesIn

    entrada = set(CountLinesIn.model_fields)
    assert entrada == {"lines"}, (
        f"el esquema de captura acepta algo más que la lista de renglones: {sorted(entrada)} — "
        "cualquier bandera de nivel superior es un «todo coincide» con otro nombre"
    )
    assert "was_counted" in CountLineRefIn.model_fields, "`was_counted` dejó de ser por renglón"

    from app.main import app

    spec = app.openapi()
    rutas_de_conteo = [p for p in spec["paths"] if "/counts" in p]
    assert rutas_de_conteo, "no hay rutas de conteo en el OpenAPI"
    sospechosas = [
        p
        for p in rutas_de_conteo
        if any(t in p.lower() for t in ("match", "confirm-all", "all", "coincide", "complete-all", "bulk"))
    ]
    assert not sospechosas, f"hay una ruta que marca todo de una vez: {sospechosas}"

    # Y por comportamiento: guardar dos renglones de tres deja el conteo
    # PARCIAL, y lo dice — nunca se completa solo.
    a = make_ingredient(admin_client, store, name="A", min_stock="1000")
    b = make_ingredient(admin_client, store, name="B", min_stock="1000")
    make_ingredient(admin_client, store, name="C", min_stock="1000")
    count = open_count(admin_client, store, scope="full")
    guardado = save_count_lines(
        admin_client,
        store,
        count["id"],
        [
            {"ingredient_id": a["id"], "qty_counted": "100", "was_counted": True},
            {"ingredient_id": b["id"], "qty_counted": "200", "was_counted": True},
        ],
    )
    assert guardado["lines_total"] == 3 and guardado["lines_counted"] == 2
    assert guardado["partial"] is True, "un guardado parcial no se declara parcial"


def test_a_local_draft_never_overwrites_a_confirmed_value(admin_client: Any, store: Any) -> None:
    """§5.4: «un borrador local nunca pisa un valor confirmado»."""
    a = make_ingredient(admin_client, store, name="A", min_stock="1000")
    count = open_count(admin_client, store, scope="full")
    save_count_lines(admin_client, store, count["id"], [{"ingredient_id": a["id"], "qty_counted": "1500", "was_counted": True}])
    save_count_lines(admin_client, store, count["id"], [{"ingredient_id": a["id"], "qty_counted": "9", "was_counted": False}])

    linea = next(l for l in _count_lines_of(admin_client, store, count["id"]) if l["ingredient_id"] == a["id"])
    assert linea["was_counted"] is True
    assert linea["qty_counted"] == "1500", f"un borrador pisó el valor confirmado: {linea}"


# ---------------------------------------------------------------------------
# (b) EL test de la misión: 13:07 aplicado a las 15:42.
# ---------------------------------------------------------------------------


def test_applying_a_count_uses_the_movements_since_the_instant_of_the_count(
    admin_client: Any, store: Any, db: Any, device_client: Any, identify: Any, employees: Any, open_shift: Any, clock: Any
) -> None:
    """Checklist 2b: «un conteo de las 13:07 aplicado a las 15:42, con
    movimientos en el medio, no inventa un faltante».

    Armado a mano, con instantes explícitos:

    - 13:07 — se abre el conteo. El libro dice 7.000 g. Quien cuenta encuentra
      exactamente 7.000 g: **no hay faltante**.
    - 14:30 — el restaurante sigue trabajando: se registra una merma de 500 g.
      El libro pasa a 6.500 g.
    - 15:42 — el administrador aplica el conteo.

    Si el ajuste se calculara contra el stock del INSTANTE DE APLICAR
    (6.500 g), el sistema escribiría un ajuste de +500 g y la varianza del
    período siguiente acusaría un sobrante fantasma; peor, el caso simétrico
    (una compra en el medio) inventaría el faltante que la spec nombra. El
    ajuste correcto es `contado − stock_al_instante_del_conteo` = 0.
    """
    from app.inventory.models import MovementCause, StockMovement
    from sqlalchemy import select

    ing = make_ingredient(admin_client, store, name="Arroz", official_cost="5", min_stock="1000")
    supplier = make_supplier(admin_client, store)

    clock.set(datetime(2026, 1, 15, 12, 0, tzinfo=timezone.utc))  # 07:00 Bogotá
    post_reception(
        admin_client, store, [reception_line(ing["id"], qty_received="7000", purchase_unit_price="5000")],
        supplier_id=supplier["id"],
    )
    assert stock_of(db, store, ingredient_id=ing["id"]) == 7_000_000  # 7.000 g en milésimas

    clock.set(datetime(2026, 1, 15, 18, 7, tzinfo=timezone.utc))  # 13:07 Bogotá
    count = open_count(admin_client, store, scope="full")
    save_count_lines(admin_client, store, count["id"], [{"ingredient_id": ing["id"], "qty_counted": "7000", "was_counted": True}])

    clock.set(datetime(2026, 1, 15, 19, 30, tzinfo=timezone.utc))  # 14:30 Bogotá
    open_shift()
    identify(device_client, employees["operator"])
    merma = device_client.post(
        f"{API}/waste",
        headers=idem_headers(),
        json={"ingredient_id": ing["id"], "qty": "500", "type": "breakage", "employee_pin": "2222"},
    )
    assert merma.status_code == 201, merma.text
    db.expire_all()
    assert stock_of(db, store, ingredient_id=ing["id"]) == 6_500_000

    clock.set(datetime(2026, 1, 15, 20, 42, tzinfo=timezone.utc))  # 15:42 Bogotá
    resultado = apply_count(admin_client, store, count["id"])

    db.expire_all()
    ajustes = list(
        db.execute(
            select(StockMovement).where(
                StockMovement.store_id == store.id,
                StockMovement.ingredient_id == ing["id"],
                StockMovement.cause == MovementCause.COUNT_ADJUSTMENT,
            )
        ).scalars()
    )
    assert ajustes == [], (
        "el conteo inventó un ajuste: el faltante que no existe. "
        f"Ajustes escritos: {[(a.qty_base, a.note) for a in ajustes]}"
    )
    linea = next(l for l in resultado["lines"] if l["ingredient_id"] == ing["id"])
    assert linea["adjustment"] == "0", f"el ajuste publicado no es cero: {linea}"
    assert stock_of(db, store, ingredient_id=ing["id"]) == 6_500_000, (
        "aplicar el conteo pisó el stock con el valor contado y borró la merma de las 14:30"
    )


def test_applying_a_count_with_a_real_shortfall_writes_exactly_that_shortfall(
    admin_client: Any, store: Any, db: Any, clock: Any
) -> None:
    """El caso simétrico del anterior: cuando SÍ hay faltante, el ajuste es
    exactamente el faltante y lleva `cause=count_adjustment` (causa tipada)."""
    from sqlalchemy import select

    from app.inventory.models import MovementCause, StockMovement

    ing = make_ingredient(admin_client, store, name="Arroz", official_cost="5", min_stock="1000")
    supplier = make_supplier(admin_client, store)
    clock.set(datetime(2026, 1, 15, 12, 0, tzinfo=timezone.utc))
    post_reception(
        admin_client, store, [reception_line(ing["id"], qty_received="7000", purchase_unit_price="5000")],
        supplier_id=supplier["id"],
    )

    clock.set(datetime(2026, 1, 15, 18, 7, tzinfo=timezone.utc))
    count = open_count(admin_client, store, scope="full")
    save_count_lines(admin_client, store, count["id"], [{"ingredient_id": ing["id"], "qty_counted": "6800", "was_counted": True}])
    clock.set(datetime(2026, 1, 15, 20, 42, tzinfo=timezone.utc))
    apply_count(admin_client, store, count["id"])

    db.expire_all()
    ajustes = list(
        db.execute(
            select(StockMovement).where(
                StockMovement.store_id == store.id,
                StockMovement.cause == MovementCause.COUNT_ADJUSTMENT,
            )
        ).scalars()
    )
    assert len(ajustes) == 1, ajustes
    assert ajustes[0].qty_base == -200_000, f"el ajuste es {ajustes[0].qty_base}, se esperaba -200.000 milésimas"
    assert stock_of(db, store, ingredient_id=ing["id"]) == 6_800_000


def test_applying_the_same_count_twice_does_not_duplicate_the_adjustment(
    admin_client: Any, store: Any, db: Any, clock: Any
) -> None:
    """Checklist 2b: «Aplicar el mismo conteo dos veces no duplica el ajuste
    (`409`)». Con `Idempotency-Key` DISTINTA a propósito: la idempotencia de
    transporte no puede ser la única defensa de una regla de negocio."""
    from sqlalchemy import func, select

    from app.inventory.models import MovementCause, StockMovement

    ing = make_ingredient(admin_client, store, name="Arroz", official_cost="5", min_stock="1000")
    clock.set(datetime(2026, 1, 15, 18, 7, tzinfo=timezone.utc))
    count = open_count(admin_client, store, scope="full")
    save_count_lines(admin_client, store, count["id"], [{"ingredient_id": ing["id"], "qty_counted": "500", "was_counted": True}])
    apply_count(admin_client, store, count["id"])

    reintento = apply_count(admin_client, store, count["id"], headers=idem_headers(), expect=None)
    assert reintento.status_code == 409, reintento.text
    assert reintento.json()["error"]["code"] == "COUNT_ALREADY_APPLIED"

    db.expire_all()
    total = db.execute(
        select(func.count())
        .select_from(StockMovement)
        .where(StockMovement.store_id == store.id, StockMovement.cause == MovementCause.COUNT_ADJUSTMENT)
    ).scalar_one()
    assert total == 1, f"el ajuste se duplicó: {total} movimientos de ajuste"
    assert stock_of(db, store, ingredient_id=ing["id"]) == 500_000


# ---------------------------------------------------------------------------
# (c) Varianza: la identidad, los pesos con origen del costo y el semáforo.
# ---------------------------------------------------------------------------


def test_the_variance_closes_the_identity_and_publishes_pesos_with_the_cost_source(
    admin_client: Any, store: Any, db: Any, device_client: Any, identify: Any,
    employees: Any, open_shift: Any, sales_products: Any, clock: Any,
) -> None:
    """Checklist 2b: «La varianza cierra la identidad `inicial + entradas −
    final = uso real` y publica `uso real − uso teórico` en cantidad **y en
    pesos con el origen del costo**» — caso numérico armado a mano.

    El caso, en gramos:
      inicial (conteo 1, aplicado)   = 5.000
      entradas (una compra)          = +2.000
      final (conteo 2, aplicado)     = 6.400
      uso real                       = 5.000 + 2.000 − 6.400 = 600
      uso teórico (una venta de un plato con ficha de 100 g) = 100
      varianza                       = 600 − 100 = 500  (a favor de la merma)
    """
    ing = make_ingredient(admin_client, store, name="Arroz", official_cost="5", min_stock="100")
    supplier = make_supplier(admin_client, store)
    put_recipe(admin_client, sales_products["inc8"].id, [{"ingredient_id": ing["id"], "qty": "100", "unit": "g"}])

    # T0: el conteo inicial fija 5.000 g.
    clock.set(datetime(2026, 1, 10, 12, 0, tzinfo=timezone.utc))
    c1 = open_count(admin_client, store, scope="full")
    save_count_lines(admin_client, store, c1["id"], [{"ingredient_id": ing["id"], "qty_counted": "5000", "was_counted": True}])
    apply_count(admin_client, store, c1["id"])
    db.expire_all()
    assert stock_of(db, store, ingredient_id=ing["id"]) == 5_000_000

    # T0+1d: entra una compra de 2.000 g.
    clock.set(datetime(2026, 1, 11, 12, 0, tzinfo=timezone.utc))
    post_reception(
        admin_client, store, [reception_line(ing["id"], qty_received="2000", purchase_unit_price="5000")],
        supplier_id=supplier["id"], invoice_date="2026-01-11",
    )

    # T0+2d: se vende un plato con ficha de 100 g -> uso teórico 100 g.
    clock.set(datetime(2026, 1, 12, 15, 0, tzinfo=timezone.utc))
    open_shift()
    identify(device_client, employees["operator"])
    order = create_order(device_client, channel="counter").json()
    order = add_items(device_client, order, [{"product_id": sales_products["inc8"].id, "qty": 1}]).json()
    resp = send(device_client, order)
    assert resp.status_code == 200, resp.text

    # T0+3d: el conteo final encuentra 6.400 g.
    clock.set(datetime(2026, 1, 13, 12, 0, tzinfo=timezone.utc))
    c2 = open_count(admin_client, store, scope="full")
    save_count_lines(admin_client, store, c2["id"], [{"ingredient_id": ing["id"], "qty_counted": "6400", "was_counted": True}])
    apply_count(admin_client, store, c2["id"])

    varianza = admin_client.get(f"{API}/admin/variance?store_id={store.id}&count_id={c2['id']}")
    assert varianza.status_code == 200, varianza.text
    body = varianza.json()
    assert body["available"] is True, body
    assert body["opening_count_id"] == c1["id"]
    fila = next(r for r in body["rows"] if r["ingredient_id"] == ing["id"])

    assert fila["opening_qty"] == "5000", fila
    assert fila["inflow_qty"] == "2000", fila
    assert fila["closing_qty"] == "6400", fila
    assert fila["real_usage_qty"] == "600", f"la identidad inicial+entradas−final no cierra: {fila}"
    assert fila["theoretical_usage_qty"] == "100", fila
    assert fila["variance_qty"] == "500", fila

    # En pesos, con el origen del costo. 500 g × $5/g = $2.500.
    assert fila["variance_value"] == 2_500, fila
    assert fila["cost_source"] == "official", (
        f"la varianza en pesos no dice de dónde salió el costo: {fila['cost_source']}"
    )


def test_the_traffic_light_thresholds_are_store_configuration(
    admin_client: Any, store: Any, db: Any, device_client: Any, identify: Any,
    employees: Any, open_shift: Any, sales_products: Any, clock: Any,
) -> None:
    """Checklist 2b: «Los umbrales del semáforo son configuración de sede con
    defaults: cambiar el umbral cambia el color». Nunca cableados.

    El caso lleva una venta real en el medio a propósito: sin uso teórico el
    porcentaje de varianza queda `null` y el nivel sale verde pase lo que pase
    con el umbral — ver el invariante hermano
    `test_variance_without_theoretical_usage_is_painted_green`, que documenta
    ese agujero."""
    ing = make_ingredient(admin_client, store, name="Arroz", official_cost="5", min_stock="100")
    put_recipe(admin_client, sales_products["inc8"].id, [{"ingredient_id": ing["id"], "qty": "100", "unit": "g"}])

    clock.set(datetime(2026, 1, 16, 12, 0, tzinfo=timezone.utc))
    c1 = open_count(admin_client, store, scope="full")
    save_count_lines(admin_client, store, c1["id"], [{"ingredient_id": ing["id"], "qty_counted": "1000", "was_counted": True}])
    apply_count(admin_client, store, c1["id"])

    clock.set(datetime(2026, 1, 17, 15, 0, tzinfo=timezone.utc))
    open_shift()
    identify(device_client, employees["operator"])
    order = create_order(device_client, channel="counter").json()
    order = add_items(device_client, order, [{"product_id": sales_products["inc8"].id, "qty": 1}]).json()
    assert send(device_client, order).status_code == 200

    clock.set(datetime(2026, 1, 18, 12, 0, tzinfo=timezone.utc))
    c2 = open_count(admin_client, store, scope="full")
    # Uso teórico 100 g, uso real 130 g: 30 % de varianza.
    save_count_lines(admin_client, store, c2["id"], [{"ingredient_id": ing["id"], "qty_counted": "870", "was_counted": True}])
    apply_count(admin_client, store, c2["id"])

    ajustes = admin_client.get(f"{API}/admin/stores/{store.id}/inventory-settings")
    assert ajustes.status_code == 200, ajustes.text
    defaults = ajustes.json()
    assert defaults["variance_yellow_threshold_bp"] > 0 and defaults["variance_red_threshold_bp"] > 0

    def _nivel() -> str:
        body = admin_client.get(f"{API}/admin/variance?store_id={store.id}&count_id={c2['id']}").json()
        return next(r for r in body["rows"] if r["ingredient_id"] == ing["id"])["level"]

    # Umbrales enormes: todo verde. Umbrales mínimos: el mismo caso, en rojo.
    puesta = admin_client.put(
        f"{API}/admin/stores/{store.id}/inventory-settings",
        json={**defaults, "variance_yellow_threshold_bp": 900_000, "variance_red_threshold_bp": 950_000},
    )
    assert puesta.status_code == 200, puesta.text
    assert _nivel() == "green"

    puesta = admin_client.put(
        f"{API}/admin/stores/{store.id}/inventory-settings",
        json={**defaults, "variance_yellow_threshold_bp": 1, "variance_red_threshold_bp": 2},
    )
    assert puesta.status_code == 200, puesta.text
    assert _nivel() == "red", "cambiar el umbral de la sede no cambió el color: está cableado"


def test_variance_without_theoretical_usage_is_never_green_when_stock_is_missing(
    admin_client: Any, store: Any, db: Any, clock: Any
) -> None:
    """**RONDA 2 — el invariante cambió de enunciado, no de severidad
    (hallazgo H-5).**

    En la ronda 1 `_variance_level` devolvía `green` siempre que
    `variance_pct_bp` fuera `None`, y el porcentaje queda `None` siempre que
    el uso teórico del período sea `0`. Resultado: el caso MÁS sospechoso de
    todos —desapareció stock y no se vendió ni se produjo nada que lo
    explique— era el único que el semáforo pintaba verde. El faltante en
    pesos sí se publicaba, así que la plata estaba contada; lo que se perdía
    era la alarma, que es justo para lo que existe un semáforo. Un insumo que
    se fuga por robo puro (sin ventas que lo cubran) tiene exactamente esta
    forma.

    Decisión del orquestador: con uso teórico `0`, **faltante → `red`,
    sobrante → `yellow`, cero → `green`**, y `variance_pct_bp` sigue en
    `null` — no se inventa un `100 %` que dividiría por cero. Este test fija
    los tres casos, porque «no es verde» sola dejaría pasar un semáforo que
    pinta todo rojo y deja de distinguir.

    El signo: `variance_qty = uso_real − uso_teórico` y el contrato publicado
    de `VarianceRowOut.variance_qty` dice «positivo = se usó más de lo
    esperado». Un faltante físico (se contó menos de lo que el libro
    explica) da `variance_qty` POSITIVO bajo esa fórmula; un sobrante lo da
    negativo. Lo verifico acá con números, no de memoria.
    """
    ing = make_ingredient(admin_client, store, name="Whisky", official_cost="500", min_stock="100")
    otro = make_ingredient(admin_client, store, name="Ron", official_cost="500", min_stock="100")
    igual = make_ingredient(admin_client, store, name="Gin", official_cost="500", min_stock="100")

    clock.set(datetime(2026, 1, 16, 12, 0, tzinfo=timezone.utc))
    c1 = open_count(admin_client, store, scope="full")
    save_count_lines(
        admin_client, store, c1["id"],
        [
            {"ingredient_id": ing["id"], "qty_counted": "1000", "was_counted": True},
            {"ingredient_id": otro["id"], "qty_counted": "1000", "was_counted": True},
            {"ingredient_id": igual["id"], "qty_counted": "1000", "was_counted": True},
        ],
    )
    apply_count(admin_client, store, c1["id"])

    clock.set(datetime(2026, 1, 18, 12, 0, tzinfo=timezone.utc))
    c2 = open_count(admin_client, store, scope="full")
    # Ninguno se vendió ni se produjo: uso teórico 0 en los tres.
    # `ing`  faltan 400 de 1.000 -> fuga pura.
    # `otro` sobran 300          -> error de conteo del otro signo.
    # `igual` coincide           -> no pasó nada.
    save_count_lines(
        admin_client, store, c2["id"],
        [
            {"ingredient_id": ing["id"], "qty_counted": "600", "was_counted": True},
            {"ingredient_id": otro["id"], "qty_counted": "1300", "was_counted": True},
            {"ingredient_id": igual["id"], "qty_counted": "1000", "was_counted": True},
        ],
    )
    apply_count(admin_client, store, c2["id"])

    body = admin_client.get(f"{API}/admin/variance?store_id={store.id}&count_id={c2['id']}").json()
    filas = {r["ingredient_id"]: r for r in body["rows"]}

    faltante = filas[ing["id"]]
    assert faltante["theoretical_usage_qty"] == "0", faltante
    assert faltante["variance_qty"] == "400", faltante
    assert faltante["variance_value"] == 200_000, faltante  # 400 × $500: la plata sí se cuenta
    assert faltante["variance_pct_bp"] is None, (
        f"con uso teórico 0 el porcentaje tiene que seguir en `null` (no hay con qué dividir), y salió "
        f"{faltante['variance_pct_bp']!r}: un `100 %` inventado acá es peor que no publicarlo"
    )
    assert faltante["level"] == "red", (
        "una varianza de 400 unidades SIN uso teórico que la explique se publica en "
        f"`level={faltante['level']}`: es el caso de fuga pura y tiene que ser ROJO. Verde ahí es el único "
        "caso que el semáforo no alerta, y es el más sospechoso de todos"
    )

    sobrante = filas[otro["id"]]
    assert sobrante["theoretical_usage_qty"] == "0", sobrante
    assert sobrante["variance_pct_bp"] is None, sobrante
    assert sobrante["level"] == "yellow", (
        f"un SOBRANTE sin uso teórico salió `{sobrante['level']}`: se contó más stock del que el libro "
        "explica, que es un error de conteo del otro signo — amarillo, no rojo (no hay plata faltante) y "
        "tampoco verde (algo no cuadra)"
    )

    sin_novedad = filas[igual["id"]]
    assert sin_novedad["variance_qty"] == "0", sin_novedad
    assert sin_novedad["level"] == "green", (
        f"un insumo sin uso teórico y sin varianza salió `{sin_novedad['level']}`: si TODO se pinta en "
        "alerta, el semáforo deja de distinguir y nadie lo mira más"
    )


def test_no_count_and_no_variance_ever_revalues_a_past_sale(
    admin_client: Any, store: Any, db: Any, device_client: Any, identify: Any,
    employees: Any, open_shift: Any, sales_products: Any, clock: Any,
) -> None:
    """Regla dura de `AGENTS.md` (§11.2, snapshot): «ninguna consulta vuelve a
    la carta actual para valorar una venta pasada». Un conteo y una varianza
    son lecturas de stock; no pueden tocar el `unit_cost` congelado del ítem
    vendido ni su `recipe_version`."""
    ing = make_ingredient(admin_client, store, name="Arroz", official_cost="5", min_stock="100")
    put_recipe(admin_client, sales_products["inc8"].id, [{"ingredient_id": ing["id"], "qty": "100", "unit": "g"}])

    clock.set(datetime(2026, 1, 12, 15, 0, tzinfo=timezone.utc))
    open_shift()
    identify(device_client, employees["operator"])
    order = create_order(device_client, channel="counter").json()
    order = add_items(device_client, order, [{"product_id": sales_products["inc8"].id, "qty": 1}]).json()
    assert send(device_client, order).status_code == 200

    from app.orders.models import OrderItem
    from sqlalchemy import select

    item = db.execute(select(OrderItem).where(OrderItem.order_id == order["id"])).scalars().first()
    assert item is not None
    congelado = (item.unit_cost, item.unit_cost_micros, item.recipe_version)
    assert congelado[0] is not None, "el caso no se armó: el ítem no quedó costeado"

    # Cambia el costo del insumo, se cuenta y se aplica.
    admin_client.patch(f"{API}/admin/ingredients/{ing['id']}", json={"official_cost": "999"})
    clock.set(datetime(2026, 1, 13, 12, 0, tzinfo=timezone.utc))
    c1 = open_count(admin_client, store, scope="full")
    save_count_lines(admin_client, store, c1["id"], [{"ingredient_id": ing["id"], "qty_counted": "10", "was_counted": True}])
    apply_count(admin_client, store, c1["id"])
    clock.set(datetime(2026, 1, 14, 12, 0, tzinfo=timezone.utc))
    c2 = open_count(admin_client, store, scope="full")
    save_count_lines(admin_client, store, c2["id"], [{"ingredient_id": ing["id"], "qty_counted": "5", "was_counted": True}])
    apply_count(admin_client, store, c2["id"])
    admin_client.get(f"{API}/admin/variance?store_id={store.id}&count_id={c2['id']}")

    db.expire_all()
    item = db.execute(select(OrderItem).where(OrderItem.order_id == order["id"])).scalars().first()
    assert (item.unit_cost, item.unit_cost_micros, item.recipe_version) == congelado, (
        "un conteo o una varianza revaloró una venta pasada"
    )


# ---------------------------------------------------------------------------
# (d) Food cost real y salud del control.
# ---------------------------------------------------------------------------


def test_real_food_cost_is_null_with_a_reason_without_two_consecutive_full_counts(
    admin_client: Any, store: Any, clock: Any
) -> None:
    """Checklist 2b: «`null` **con motivo** sin dos conteos completos
    consecutivos … Jamás `0`»."""
    ing = make_ingredient(admin_client, store, name="Arroz", official_cost="5", min_stock="100")

    clock.set(datetime(2026, 1, 10, 12, 0, tzinfo=timezone.utc))
    sin_conteos = admin_client.get(f"{API}/admin/food-cost?store_id={store.id}&from=2026-01-01&to=2026-01-31")
    assert sin_conteos.status_code == 200, sin_conteos.text
    assert sin_conteos.json()["available"] is False
    assert sin_conteos.json()["pct_bp"] is None, "sin dos conteos el food cost real no puede ser un número"
    assert sin_conteos.json()["pct_bp"] != 0
    assert sin_conteos.json()["reason"], "el `null` vino sin motivo"

    # Con UN solo conteo completo tampoco alcanza.
    c1 = open_count(admin_client, store, scope="full")
    save_count_lines(admin_client, store, c1["id"], [{"ingredient_id": ing["id"], "qty_counted": "1000", "was_counted": True}])
    apply_count(admin_client, store, c1["id"])
    uno = admin_client.get(f"{API}/admin/food-cost?store_id={store.id}&from=2026-01-01&to=2026-01-31").json()
    assert uno["available"] is False and uno["pct_bp"] is None and uno["reason"]


def test_real_food_cost_is_computed_only_between_two_consecutive_full_counts(
    admin_client: Any, store: Any, db: Any, device_client: Any, identify: Any,
    employees: Any, open_shift: Any, sales_products: Any, clock: Any,
) -> None:
    """La otra mitad: con dos conteos completos aplicados y ventas netas en el
    medio, el food cost real se calcula, y sale de `(inicial + compras −
    final) ÷ ventas netas`."""
    from tests.audit.conftest import NO_TIP, pay

    ing = make_ingredient(admin_client, store, name="Arroz", official_cost="5", min_stock="100")
    supplier = make_supplier(admin_client, store)
    put_recipe(admin_client, sales_products["inc8"].id, [{"ingredient_id": ing["id"], "qty": "100", "unit": "g"}])

    clock.set(datetime(2026, 1, 10, 12, 0, tzinfo=timezone.utc))
    c1 = open_count(admin_client, store, scope="full")
    save_count_lines(admin_client, store, c1["id"], [{"ingredient_id": ing["id"], "qty_counted": "1000", "was_counted": True}])
    apply_count(admin_client, store, c1["id"])

    clock.set(datetime(2026, 1, 11, 15, 0, tzinfo=timezone.utc))
    post_reception(
        admin_client, store, [reception_line(ing["id"], qty_received="1000", purchase_unit_price="5000")],
        supplier_id=supplier["id"], invoice_date="2026-01-11",
    )
    open_shift()
    identify(device_client, employees["operator"])
    order = create_order(device_client, channel="counter").json()
    order = add_items(device_client, order, [{"product_id": sales_products["inc8"].id, "qty": 1}]).json()
    assert send(device_client, order).status_code == 200
    identify(device_client, employees["cashier"])
    order = get_order(device_client, order["id"])
    presentada = device_client.post(
        f"{API}/orders/{order['id']}/bill/present",
        json={"expected_version": order["version"]},
        headers=idem_headers(),
    )
    assert presentada.status_code == 200, presentada.text
    total = presentada.json()["total"]
    cobro = pay(
        device_client,
        order["id"],
        splits=[{"method": "cash", "amount": total, "tendered": total}],
        tip=NO_TIP,
    )
    assert cobro.status_code == 201, cobro.text

    clock.set(datetime(2026, 1, 12, 12, 0, tzinfo=timezone.utc))
    c2 = open_count(admin_client, store, scope="full")
    save_count_lines(admin_client, store, c2["id"], [{"ingredient_id": ing["id"], "qty_counted": "1800", "was_counted": True}])
    apply_count(admin_client, store, c2["id"])

    body = admin_client.get(f"{API}/admin/food-cost?store_id={store.id}&from=2026-01-01&to=2026-01-31").json()
    assert body["available"] is True, body
    assert body["opening_count_id"] == c1["id"] and body["closing_count_id"] == c2["id"]
    assert body["net_sales"] > 0
    assert body["pct_bp"] is not None
    # `(inicial + compras − final) ÷ ventas netas`, publicado pieza por pieza
    # para que el número se pueda auditar sin reimplementar la cuenta.
    esperado = body["opening_value"] + body["purchases_value"] - body["closing_value"]
    assert body["opening_value"] == 1_000 * 5, body  # 1.000 g × $5 oficial
    assert body["closing_value"] == 1_800 * 5, body  # 1.800 g × $5 oficial
    assert body["purchases_value"] > 0, body
    assert body["pct_bp"] == (abs(esperado) * 10000 + body["net_sales"] // 2) // body["net_sales"], body
    assert body["pct_bp"] != 0, "un food cost real de 0 es el cero mudo que la spec prohíbe"


def test_past_14_days_without_a_full_count_the_control_is_unreliable_and_food_cost_is_not_published(
    admin_client: Any, store: Any, clock: Any
) -> None:
    """Checklist 2b: «Con más de 14 días sin conteo completo, "salud del
    control" dice inventario no confiable y el food cost real **no se
    publica**»."""
    ing = make_ingredient(admin_client, store, name="Arroz", official_cost="5", min_stock="100")

    clock.set(datetime(2026, 1, 10, 12, 0, tzinfo=timezone.utc))
    for dia, contado in ((10, "1000"), (11, "900")):
        clock.set(datetime(2026, 1, dia, 12, 0, tzinfo=timezone.utc))
        count = open_count(admin_client, store, scope="full")
        save_count_lines(admin_client, store, count["id"], [{"ingredient_id": ing["id"], "qty_counted": contado, "was_counted": True}])
        apply_count(admin_client, store, count["id"])

    salud = admin_client.get(f"{API}/admin/control-health?store_id={store.id}").json()
    assert salud["inventory_unreliable"] is False, salud
    assert salud["days_since_full_count"] is not None

    # 15 días después del último conteo completo.
    clock.set(datetime(2026, 1, 26, 12, 0, tzinfo=timezone.utc))
    salud = admin_client.get(f"{API}/admin/control-health?store_id={store.id}").json()
    assert salud["days_since_full_count"] == 15, salud
    assert salud["inventory_unreliable"] is True, salud

    food = admin_client.get(f"{API}/admin/food-cost?store_id={store.id}&from=2026-01-01&to=2026-01-31").json()
    assert food["available"] is False, food
    assert food["pct_bp"] is None, "el food cost real se publicó con el inventario declarado no confiable"
    assert "confiable" in (food["reason"] or "").lower(), food


# ---------------------------------------------------------------------------
# (e) Lotes: FEFO declarado, y el vencido que NO se da de baja solo.
# ---------------------------------------------------------------------------


def test_an_issue_consumes_the_lot_closest_to_expiring_and_ties_break_by_reception(
    admin_client: Any, store: Any, db: Any, device_client: Any, identify: Any, employees: Any, open_shift: Any, clock: Any
) -> None:
    """Checklist 2b: «Una salida consume el lote más próximo a vencer, y a
    igualdad el recibido primero (test con tres lotes)».

    §5.7 dice «el más antiguo», que es ambiguo entre fecha de recepción y de
    vencimiento, y una elección silenciosa acá mueve plata: los tres lotes de
    este caso están ordenados **al revés** por fecha de recepción que por
    vencimiento, así que un FIFO por recepción y un FEFO por vencimiento dan
    resultados distintos y el test los distingue.
    """
    ing = make_ingredient(admin_client, store, name="Leche", official_cost=None, min_stock="100")
    supplier = make_supplier(admin_client, store)

    # Recibido 1.º, vence ÚLTIMO. Recibido 2.º y 3.º, vencen el mismo día.
    clock.set(datetime(2026, 1, 10, 12, 0, tzinfo=timezone.utc))
    post_reception(
        admin_client, store, [reception_line(ing["id"], qty_received="1000", purchase_unit_price="12000", lot_code="TARDE", expires_at="2026-06-01")],
        supplier_id=supplier["id"], invoice_date="2026-01-10",
    )
    clock.set(datetime(2026, 1, 11, 12, 0, tzinfo=timezone.utc))
    post_reception(
        admin_client, store, [reception_line(ing["id"], qty_received="1000", purchase_unit_price="12000", lot_code="EMPATE-A", expires_at="2026-02-01")],
        supplier_id=supplier["id"], invoice_date="2026-01-11", confirm_price=True,
    )
    clock.set(datetime(2026, 1, 12, 12, 0, tzinfo=timezone.utc))
    post_reception(
        admin_client, store, [reception_line(ing["id"], qty_received="1000", purchase_unit_price="12000", lot_code="EMPATE-B", expires_at="2026-02-01")],
        supplier_id=supplier["id"], invoice_date="2026-01-12", confirm_price=True,
    )

    clock.set(datetime(2026, 1, 13, 15, 0, tzinfo=timezone.utc))
    open_shift()
    identify(device_client, employees["operator"])
    merma = device_client.post(
        f"{API}/waste",
        headers=idem_headers(),
        json={"ingredient_id": ing["id"], "qty": "1200", "type": "breakage", "employee_pin": "2222"},
    )
    assert merma.status_code == 201, merma.text

    db.expire_all()
    por_codigo = {b.lot_code: b for b in lots_of(db, store, ingredient_id=ing["id"])}
    assert por_codigo["EMPATE-A"].qty_remaining == 0, (
        f"FEFO no vació primero el lote más próximo a vencer recibido antes: {por_codigo['EMPATE-A'].qty_remaining}"
    )
    assert por_codigo["EMPATE-B"].qty_remaining == 800_000, (
        f"el desempate por fecha de recepción no se respetó: {por_codigo['EMPATE-B'].qty_remaining}"
    )
    assert por_codigo["TARDE"].qty_remaining == 1_000_000, (
        "se consumió el lote que vence más tarde: eso es FIFO por recepción, no FEFO"
    )


def test_an_expired_lot_is_never_written_off_automatically(
    admin_client: Any, store: Any, db: Any, device_client: Any, identify: Any, employees: Any, open_shift: Any, clock: Any
) -> None:
    """Checklist 2b: «Un lote vencido **no se da de baja solo**: queda la
    alerta "vencido con stock" y el stock sigue hasta que alguien registre la
    merma»."""
    ing = make_ingredient(admin_client, store, name="Leche", official_cost=None, min_stock="100")
    supplier = make_supplier(admin_client, store)

    clock.set(datetime(2026, 1, 10, 12, 0, tzinfo=timezone.utc))
    post_reception(
        admin_client, store, [reception_line(ing["id"], qty_received="1000", purchase_unit_price="12000", lot_code="V", expires_at="2026-01-12")],
        supplier_id=supplier["id"], invoice_date="2026-01-10",
    )
    antes = stock_of(db, store, ingredient_id=ing["id"])

    # Una semana DESPUÉS del vencimiento, y varias lecturas de por medio.
    clock.set(datetime(2026, 1, 19, 12, 0, tzinfo=timezone.utc))
    lotes = admin_client.get(f"{API}/admin/lots?store_id={store.id}")
    assert lotes.status_code == 200, lotes.text
    fila = next(r for r in lotes.json() if r["lot_code"] == "V")
    assert fila["status"] == "expired", fila
    assert fila["qty_remaining"] != "0", "el lote vencido se dio de baja solo"
    admin_client.get(f"{API}/admin/today?store_id={store.id}")

    db.expire_all()
    assert stock_of(db, store, ingredient_id=ing["id"]) == antes, "el vencimiento movió el stock por su cuenta"
    assert lots_of(db, store, ingredient_id=ing["id"])[0].qty_remaining == 1_000_000

    # Hasta que una PERSONA registra la merma.
    open_shift()
    identify(device_client, employees["operator"])
    merma = device_client.post(
        f"{API}/waste",
        headers=idem_headers(),
        json={"ingredient_id": ing["id"], "qty": "1000", "type": "expired", "employee_pin": "2222"},
    )
    assert merma.status_code == 201, merma.text
    db.expire_all()
    assert stock_of(db, store, ingredient_id=ing["id"]) == antes - 1_000_000


def test_today_and_control_health_agree_on_the_days_since_the_last_full_count(
    admin_client: Any, store: Any, clock: Any
) -> None:
    """**VERDE DESDE LA RONDA 2 — nació rojo (H-4): la misma pregunta con
    dos cuentas.** Se cerró consolidando la matemática en
    `app.inventory.hooks.inventory_staleness` (`app/inventory/hooks.py:729`)
    con la constante única `INVENTORY_STALE_DAYS` (`:712`); `app/reports`
    la consume (`app/reports/service.py:741`) y borró su copia. El test se
    queda tal cual. Lo que sigue es el modo de falla original, como
    registro.

    «Inventario no confiable» se respondía en DOS endpoints y cada uno la
    calculaba distinto:

    - `app/inventory/service.py:1505-1507` (`control_health`) resta **fechas
      de negocio** (`tz.business_date_for`, corte de la sede).
    - `app/reports/service.py:729-730` (`_inventory_reliability`, «Hoy») resta
      **instantes UTC** (`(now - last_applied).days`), que trunca hacia abajo
      y descuenta la hora del día.

    Con el mismo dato, las dos respuestas se separan en un día justo sobre el
    umbral de 14: «Hoy» puede decir que el inventario es confiable mientras
    «Salud del control» ya dice que no, y el food cost real deja de
    publicarse sin que el tablero lo anuncie. Es literalmente la regla dura de
    `AGENTS.md` — «una sola matemática, en el backend» — con la constante
    declarada dos veces (`CONTROL_HEALTH_STALE_DAYS` y
    `_CONTROL_HEALTH_STALE_DAYS`) y calculada de dos formas.
    """
    ing = make_ingredient(admin_client, store, name="Arroz", official_cost="5", min_stock="100")

    # Conteo completo aplicado a las 18:00 de Bogotá del 15 (23:00 UTC).
    clock.set(datetime(2026, 1, 15, 23, 0, tzinfo=timezone.utc))
    count = open_count(admin_client, store, scope="full")
    save_count_lines(admin_client, store, count["id"], [{"ingredient_id": ing["id"], "qty_counted": "1000", "was_counted": True}])
    apply_count(admin_client, store, count["id"])

    # Se consulta a las 09:00 de Bogotá del 30 (14:00 UTC). Por fecha de
    # negocio han pasado 15 días (30 − 15) y el inventario NO es confiable;
    # restando instantes UTC han pasado 14 días y 15 horas, que truncado da
    # 14, y 14 no es "> 14": confiable. La misma pregunta, dos respuestas.
    clock.set(datetime(2026, 1, 30, 14, 0, tzinfo=timezone.utc))
    salud = admin_client.get(f"{API}/admin/control-health?store_id={store.id}").json()
    hoy = admin_client.get(f"{API}/admin/today?store_id={store.id}").json()

    assert hoy["days_since_last_full_count"] == salud["days_since_full_count"], (
        "«Hoy» y «Salud del control» no cuentan los mismos días desde el último conteo completo: "
        f"{hoy['days_since_last_full_count']} vs {salud['days_since_full_count']} — "
        "uno resta fechas de negocio y el otro instantes UTC"
    )
    assert hoy["inventory_unreliable"] == salud["inventory_unreliable"], (
        "los dos endpoints discrepan sobre si el inventario es confiable: "
        f"Hoy={hoy['inventory_unreliable']} vs Salud={salud['inventory_unreliable']}"
    )


# ---------------------------------------------------------------------------
# RONDA 2 — el borde de los 14 días, con el reloj de Bogotá del lado malo.
#
# H-4 se cerró consolidando la cuenta en `app.inventory.hooks.
# inventory_staleness`. El test de la ronda 1 comparaba dos endpoints en un
# instante cualquiera; estos dos fijan la decisión donde de verdad duele: el
# borde exacto del umbral, con una hora de Bogotá que en UTC ya es el día
# siguiente, y con la constante declarada una sola vez.
# ---------------------------------------------------------------------------


def test_on_the_14_day_border_today_control_health_and_food_cost_use_the_same_threshold(
    admin_client: Any, store: Any, db: Any, device_client: Any, identify: Any,
    employees: Any, open_shift: Any, sales_products: Any, clock: Any,
) -> None:
    """**RONDA 2, invariante nuevo — cierra H-4 en el borde.**

    El caso está armado a mano para que las tres matemáticas posibles den
    respuestas DISTINTAS, y así un empate no pueda pasar por casualidad:

    - el último conteo completo se aplica a las **21:00 de Bogotá del 15**,
      que en UTC ya es el **16** — su fecha de negocio es el 15;
    - se consulta a las **12:00 de Bogotá del 29** (17:00 UTC del 29, mismo
      día en las dos zonas): por fecha de negocio han pasado **14** días, que
      no es «> 14» → confiable;
    - se consulta a las **12:00 de Bogotá del 30**: **15** días → no
      confiable, y el food cost real deja de publicarse.

    Quien restara fechas UTC contaría 30 − 16 = 14 el día en que la fecha de
    negocio ya dice 15, y publicaría el food cost de un inventario que el
    otro endpoint declara no confiable. Quien restara instantes UTC contaría
    14 días y 15 horas → 14, con el mismo error. Las dos formas mal hechas se
    ponen rojas acá; la buena pasa.

    Las tres lecturas tienen que decir lo mismo **el día 14 y el día 15**:
    `GET /admin/today`, `GET /admin/control-health` y el umbral que usa
    `GET /admin/food-cost` para apagarse.
    """
    ing = make_ingredient(admin_client, store, name="Arroz", official_cost="5", min_stock="100")
    put_recipe(admin_client, sales_products["inc8"].id, [{"ingredient_id": ing["id"], "qty": "100", "unit": "g"}])

    # Dos conteos completos consecutivos CON ventas en el medio: hacen falta
    # para que el food cost real exista de verdad y se pueda comprobar que se
    # APAGA por el umbral de días, no por falta de conteos ni por falta de
    # ventas (los otros dos motivos, que taparían el hallazgo).
    clock.set(datetime(2026, 1, 15, 2, 0, tzinfo=timezone.utc))  # 21:00 Bogotá del 14
    c1 = open_count(admin_client, store, scope="full")
    save_count_lines(admin_client, store, c1["id"], [{"ingredient_id": ing["id"], "qty_counted": "1000", "was_counted": True}])
    apply_count(admin_client, store, c1["id"])

    clock.set(datetime(2026, 1, 15, 18, 0, tzinfo=timezone.utc))  # 13:00 Bogotá del 15
    open_shift()
    identify(device_client, employees["cashier"])
    order = create_order(device_client, channel="counter").json()
    order = add_items(device_client, order, [{"product_id": sales_products["inc8"].id, "qty": 1}]).json()
    assert send(device_client, order).status_code == 200
    cobro = pay(
        device_client,
        order["id"],
        splits=[{"method": "cash", "amount": order["totals"]["total"]}],
        tip=NO_TIP,
    )
    assert cobro.status_code == 201, cobro.text

    clock.set(datetime(2026, 1, 16, 2, 0, tzinfo=timezone.utc))  # 21:00 Bogotá del 15
    c2 = open_count(admin_client, store, scope="full")
    save_count_lines(admin_client, store, c2["id"], [{"ingredient_id": ing["id"], "qty_counted": "900", "was_counted": True}])
    apply_count(admin_client, store, c2["id"])

    def leer() -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
        hoy = admin_client.get(f"{API}/admin/today?store_id={store.id}")
        salud = admin_client.get(f"{API}/admin/control-health?store_id={store.id}")
        food = admin_client.get(f"{API}/admin/food-cost?store_id={store.id}&from=2026-01-01&to=2026-02-28")
        assert hoy.status_code == 200, hoy.text
        assert salud.status_code == 200, salud.text
        assert food.status_code == 200, food.text
        return hoy.json(), salud.json(), food.json()

    # --- Día 14: dentro del umbral. Los tres tienen que decir "confiable".
    clock.set(datetime(2026, 1, 29, 17, 0, tzinfo=timezone.utc))  # 12:00 Bogotá del 29
    hoy, salud, food = leer()
    assert salud["days_since_full_count"] == 14, (
        f"la fecha de negocio del último conteo completo es el 15 y hoy es el 29: son 14 días, no "
        f"{salud['days_since_full_count']}. Restar fechas o instantes UTC da 14 el día equivocado"
    )
    assert hoy["days_since_last_full_count"] == salud["days_since_full_count"], (
        f"«Hoy» dice {hoy['days_since_last_full_count']} días y «Salud del control» dice "
        f"{salud['days_since_full_count']}: la misma pregunta con dos cuentas (AGENTS.md, una sola matemática)"
    )
    assert hoy["inventory_unreliable"] is False and salud["inventory_unreliable"] is False, (hoy, salud)
    assert food["available"] is True, (
        f"el food cost real no se publica a los 14 días (el umbral es «más de 14»): {food}"
    )
    assert food["pct_bp"] is not None, food

    # --- Día 15: pasado el umbral. Los tres tienen que darse vuelta JUNTOS.
    clock.set(datetime(2026, 1, 30, 17, 0, tzinfo=timezone.utc))  # 12:00 Bogotá del 30
    hoy, salud, food = leer()
    assert salud["days_since_full_count"] == 15, salud
    assert hoy["days_since_last_full_count"] == salud["days_since_full_count"], (
        f"«Hoy» dice {hoy['days_since_last_full_count']} y «Salud del control» dice "
        f"{salud['days_since_full_count']} justo en el borde: es el día en que el tablero que el dueño mira "
        "todas las mañanas le dice que el inventario es confiable mientras el número que le importa ya no "
        "se publica, y nadie le explica por qué"
    )
    assert hoy["inventory_unreliable"] is True and salud["inventory_unreliable"] is True, (hoy, salud)
    assert food["available"] is False, (
        f"pasados los 14 días el food cost real se sigue publicando: usa un umbral distinto del de «Salud "
        f"del control» — {food}"
    )
    assert food["pct_bp"] is None, "el food cost real se publicó con el inventario declarado no confiable"
    assert (food["reason"] or "").strip(), "se apagó el food cost real sin decir por qué (`null` sin motivo)"


#: El único archivo autorizado a escribir el umbral de inventario no confiable.
STALE_DAYS_OWNER = "app/inventory/hooks.py"


def _literal_14_sweep() -> tuple[list[str], list[str]]:
    """`(declaraciones, usos_como_días)` del número 14 en todo `app/**`.

    - **declaración**: una asignación a nivel de módulo con valor `14`.
    - **uso como días**: `timedelta(days=14)` o una comparación contra `14`,
      fuera del archivo dueño de la constante.

    No caza cualquier `14` suelto: `lead_time_days=14` para la sal de la demo
    no tiene nada que ver con el umbral de inventario no confiable, y un
    invariante que lo acusara sería ruido.
    """
    import ast

    from tests.audit.conftest import app_source_files

    declaraciones: list[str] = []
    usos_como_dias: list[str] = []
    for ruta, arbol in app_source_files():
        for nodo in ast.iter_child_nodes(arbol):
            destinos = (
                nodo.targets if isinstance(nodo, ast.Assign)
                else [nodo.target] if isinstance(nodo, ast.AnnAssign) else []
            )
            valor = getattr(nodo, "value", None)
            if destinos and isinstance(valor, ast.Constant) and valor.value == 14 and not isinstance(valor.value, bool):
                nombres = [t.id for t in destinos if isinstance(t, ast.Name)]
                declaraciones.append(f"{ruta}:{valor.lineno} ({', '.join(nombres) or '?'})")
        if ruta == STALE_DAYS_OWNER:
            continue
        for nodo in ast.walk(arbol):
            if isinstance(nodo, ast.Call) and any(
                kw.arg == "days" and isinstance(kw.value, ast.Constant) and kw.value.value == 14
                for kw in nodo.keywords
            ):
                usos_como_dias.append(f"{ruta}:{nodo.lineno} (timedelta(days=14))")
            elif isinstance(nodo, ast.Compare) and any(
                isinstance(c, ast.Constant) and c.value == 14 and not isinstance(c.value, bool)
                for c in [nodo.left, *nodo.comparators]
            ):
                usos_como_dias.append(f"{ruta}:{nodo.lineno} (comparación contra 14)")
    return declaraciones, usos_como_dias


def test_the_14_day_threshold_is_declared_exactly_once_in_the_whole_app() -> None:
    """**RONDA 2, invariante nuevo — la otra mitad de H-4.**

    Consolidar el CÁLCULO no alcanza si el NÚMERO sigue escrito en varios
    lados: en la ronda 1 el `14` vivía tres veces
    (`CONTROL_HEALTH_STALE_DAYS`, `FOOD_COST_STALE_DAYS` y
    `_CONTROL_HEALTH_STALE_DAYS`), y por eso las dos respuestas podían
    separarse sin que ningún test lo viera. Ahora la constante vive UNA vez,
    en `app.inventory.hooks.INVENTORY_STALE_DAYS`, y este barrido de AST lo
    mantiene así.
    """
    from app.inventory.hooks import INVENTORY_STALE_DAYS

    assert INVENTORY_STALE_DAYS == 14, (
        f"el umbral de inventario no confiable dejó de ser 14 (`{INVENTORY_STALE_DAYS}`). Si la spec lo "
        "movió, este test se actualiza con ella; si no, alguien lo movió sin decirlo"
    )
    declaraciones, _ = _literal_14_sweep()
    assert len(declaraciones) == 1, (
        "el umbral de 14 días está declarado más de una vez en app/: "
        f"{declaraciones}. Es la duplicación que produjo H-4 — la misma pregunta con dos fórmulas"
    )
    assert declaraciones[0].startswith(STALE_DAYS_OWNER), (
        f"la única declaración del umbral no está en {STALE_DAYS_OWNER}: {declaraciones}"
    )


def test_nobody_rewrites_the_14_day_threshold_as_a_bare_day_count() -> None:
    """**ROJO A PROPÓSITO — advertencia baja (hallazgo H-10 de la ronda 2).**

    Declararla una sola vez no alcanza si alguien vuelve a escribir el
    número. `app/inventory/seed.py:257` siembra el conteo completo de la demo
    con `now - timedelta(days=14)`: es el umbral escrito por segunda vez, y
    además **exactamente sobre el borde** (`unreliable = días > 14`, así que
    14 justo pasa). Dos consecuencias:

    1. si el umbral cambia a 10, la demo sembrada arranca declarando el
       inventario no confiable y el food cost real desaparece de la base de
       demostración, sin que nadie toque el seed;
    2. cualquier diferencia de un día en la fecha de negocio (un
       `cutoff_hour` distinto, el seed corrido de madrugada) apaga el food
       cost real de la demo el día que se siembra.

    El remedio es de una línea: importar `INVENTORY_STALE_DAYS` y restarle
    margen explícito (`days=INVENTORY_STALE_DAYS - 7`, por ejemplo), en vez
    de repetir el número. Dueño: `app/inventory/seed.py`
    (`backend-inventario-espejo`).
    """
    _, usos_como_dias = _literal_14_sweep()
    assert not usos_como_dias, (
        "el número 14 se usa como cantidad de días fuera del dueño de la constante: "
        f"{usos_como_dias}. Tiene que importar `app.inventory.hooks.INVENTORY_STALE_DAYS` — si el umbral "
        "cambia, ese uso se queda viejo y nadie se entera"
    )
