"""Un solo libro, una sola escritura, una sola causa.

`docs/SPEC-NEGOCIO.md` §5.1 (libro de movimientos con causa tipada), §5.2
(stock negativo), §5.5 (mermas) y §11.3/§11.9/§11.14 (nada de inventario se
borra; idempotencia y `409`; causa tipada).

El libro de inventario es la contabilidad física del restaurante: si una
escritura lo esquiva, si una causa se adivina de un texto, o si el negativo se
confunde con el agotado, todo lo que 2b va a construir encima (varianza, food
cost real) mide humo. Estos invariantes defienden el libro, no el costo (eso
está en `test_cost_invariants.py`) ni el consumo de la venta
(`test_consumption_invariants.py`).
"""

from __future__ import annotations

import ast
import re
import threading
from pathlib import Path
from typing import Any

import pytest

from tests.audit.conftest import (
    API_V1,
    add_items,
    create_order,
    idem_headers,
    make_ingredient,
    make_preparation,
    movements_of,
    put_recipe,
    send,
    stock_of,
)

API = API_V1
APP_DIR = Path(__file__).resolve().parents[2] / "app"


# ---------------------------------------------------------------------------
# Una sola escritura
# ---------------------------------------------------------------------------


def test_no_module_writes_a_stock_movement_outside_record_movement() -> None:
    """§5.1: «toda escritura pasa por **una sola función**».

    Es la regla más fácil de violar por comodidad —`db.add(StockMovement(...))`
    es una línea— y la que rompe el libro entero: una fila escrita por fuera se
    salta la validación de insumo XOR preparación, la de costo con origen, la
    fusión y la atribución obligatoria. Este invariante no prueba
    comportamiento: prueba el **código**, con un recorrido de AST sobre
    `app/`, porque el día que alguien la viole ningún test de comportamiento
    va a fallar.
    """
    culpables: list[str] = []
    permitido = APP_DIR / "inventory" / "hooks.py"
    for archivo in sorted(APP_DIR.rglob("*.py")):
        if archivo == permitido:
            continue
        arbol = ast.parse(archivo.read_text(encoding="utf-8"), filename=str(archivo))
        for nodo in ast.walk(arbol):
            if isinstance(nodo, ast.Call):
                objetivo = nodo.func
                nombre = (
                    objetivo.id
                    if isinstance(objetivo, ast.Name)
                    else objetivo.attr
                    if isinstance(objetivo, ast.Attribute)
                    else None
                )
                if nombre in ("StockMovement", "Waste") and nombre == "StockMovement":
                    culpables.append(f"{archivo.relative_to(APP_DIR.parent)}:{nodo.lineno}")
    assert not culpables, (
        "alguien construye un `StockMovement` fuera de `app/inventory/hooks.py::record_movement`: "
        + ", ".join(culpables)
    )


def test_a_movement_always_carries_an_enumerated_cause_never_free_text(
    db: Any, store: Any, admin_client: Any, employees: Any
) -> None:
    """§5.1 y §11.14: «la causa **no** se infiere de un texto (en la referencia
    un motivo escrito distinto se leyó como fuga de $1.126.398)».

    El `reason` del ajuste manual es texto libre para un humano; la `cause` es
    un enum. Escribir "compra" en el motivo no puede convertir el movimiento en
    una compra.
    """
    from app.inventory.models import MovementCause

    ingrediente = make_ingredient(admin_client, store, name="Causa", min_stock="1000")
    resp = admin_client.post(
        f"{API}/admin/inventory/adjustments?store_id={store.id}",
        json={
            "ingredient_id": ingrediente["id"],
            "qty_delta": "500",
            "reason": "compra en la plaza, entrada de mercancía",
            "authorizer_pin": "9999",
        },
        headers=idem_headers(),
    )
    assert resp.status_code == 201, resp.text

    movimientos = movements_of(db, store, ingredient_id=ingrediente["id"])
    assert len(movimientos) == 1
    assert movimientos[0].cause is MovementCause.MANUAL_ADJUSTMENT, (
        "la causa se dedujo del texto del motivo"
    )
    assert movimientos[0].note == "compra en la plaza, entrada de mercancía"


def test_every_movement_is_attributed_to_a_real_person(
    db: Any, store: Any, admin_client: Any, device_client: Any, open_shift: Any, sales_products: Any
) -> None:
    """§11.14 y el patrón propio de `AGENTS.md`: atribución con **FK real**
    (`employee_id`) más nombre congelado. Un movimiento sin dueño es un
    movimiento que nadie puede explicar en el conteo de 2b."""
    ingrediente = make_ingredient(admin_client, store, name="Atribuido", min_stock="1000")
    product = sales_products["inc8"]
    put_recipe(admin_client, product.id, [{"ingredient_id": ingrediente["id"], "qty": "10", "unit": "g"}])
    open_shift()
    order = create_order(device_client).json()
    order = add_items(device_client, order, [{"product_id": product.id, "qty": 1}]).json()
    assert send(device_client, order).status_code == 200

    for movimiento in movements_of(db, store, ingredient_id=ingrediente["id"]):
        assert movimiento.employee_id is not None
        assert movimiento.employee_name, "el movimiento no congeló el nombre de quien lo originó"


# ---------------------------------------------------------------------------
# Stock negativo: se permite, y no es lo mismo que agotado
# ---------------------------------------------------------------------------


def test_selling_with_zero_or_negative_stock_never_blocks_the_sale(
    db: Any, store: Any, admin_client: Any, device_client: Any, open_shift: Any, sales_products: Any
) -> None:
    """§5.2: «se **permite** vender aunque el sistema diga que no hay. El
    negativo es deuda de registro, no bloqueo».

    Bloquear la venta por un saldo teórico sería peor que el faltante: el
    restaurante deja de facturar por un número que nadie contó.
    """
    ingrediente = make_ingredient(admin_client, store, name="En cero", min_stock="1000")
    product = sales_products["inc8"]
    put_recipe(admin_client, product.id, [{"ingredient_id": ingrediente["id"], "qty": "500", "unit": "g"}])
    open_shift()

    for vuelta in range(3):
        order = create_order(device_client).json()
        order = add_items(device_client, order, [{"product_id": product.id, "qty": 2}]).json()
        resp = send(device_client, order)
        assert resp.status_code == 200, f"la venta {vuelta} se bloqueó por stock: {resp.text}"

    assert stock_of(db, store, ingredient_id=ingrediente["id"]) == -3_000_000
    # -3.000 g: el saldo negativo se REGISTRA, no se recorta a cero.


def test_negative_and_below_minimum_are_two_different_alerts_with_different_messages(
    db: Any, store: Any, admin_client: Any, device_client: Any, open_shift: Any, sales_products: Any
) -> None:
    """§5.2: «**negativo no es agotado**: alertas distintas» — un helado estuvo
    tres meses en −400 g porque tres recetas descontaban un insumo que nunca se
    compró, y nadie lo vio porque estaba mezclado con los "bajo mínimo".

    Se exige: dos listas distintas en `GET /admin/today`, el negativo con su
    `negative_since` y su **causa probable derivada de las causas tipadas**, y
    un insumo bajo mínimo pero positivo que NO aparezca entre los negativos.
    """
    negativo = make_ingredient(admin_client, store, name="Insumo negativo", min_stock="1000")
    bajo = make_ingredient(admin_client, store, name="Insumo bajo", min_stock="1000")

    # `bajo` entra con 500 (positivo, por debajo de su mínimo de 1.000).
    resp = admin_client.post(
        f"{API}/admin/inventory/adjustments?store_id={store.id}",
        json={"ingredient_id": bajo["id"], "qty_delta": "0.5", "reason": "carga inicial", "authorizer_pin": "9999"},
        headers=idem_headers(),
    )
    assert resp.status_code == 201, resp.text

    # `negativo` se vende sin haber entrado nunca.
    product = sales_products["inc8"]
    put_recipe(admin_client, product.id, [{"ingredient_id": negativo["id"], "qty": "400", "unit": "g"}])
    open_shift()
    order = create_order(device_client).json()
    order = add_items(device_client, order, [{"product_id": product.id, "qty": 1}]).json()
    assert send(device_client, order).status_code == 200

    hoy = admin_client.get(f"{API}/admin/today?store_id={store.id}")
    assert hoy.status_code == 200, hoy.text
    cuerpo = hoy.json()

    assert "ingredients_below_min" in cuerpo and "ingredients_negative" in cuerpo, (
        "«negativo» y «bajo mínimo» tienen que ser dos alertas distintas, no una sola lista"
    )
    negativos = {a["ingredient_id"] for a in cuerpo["ingredients_negative"]}
    bajo_minimo = {a["ingredient_id"] for a in cuerpo["ingredients_below_min"]}

    assert negativo["id"] in negativos
    assert bajo["id"] not in negativos, "un insumo positivo bajo mínimo se reportó como negativo"
    assert bajo["id"] in bajo_minimo

    fila = next(a for a in cuerpo["ingredients_negative"] if a["ingredient_id"] == negativo["id"])
    assert fila["negative_since"] is not None, "el negativo no dice desde cuándo lo está"
    assert fila["probable_cause"] == "sale", (
        "la causa probable del negativo no salió de las causas tipadas del libro"
    )


def test_a_sold_out_product_and_a_negative_ingredient_are_not_the_same_signal(
    db: Any, store: Any, admin_client: Any, device_client: Any, open_shift: Any, sales_products: Any
) -> None:
    """La otra mitad de §5.2: «agotado» es un estado del **plato** (`available`
    del catálogo, el 86 del día) y «negativo» es un saldo del **insumo**. Un
    insumo en −400 g no apaga el plato, y apagar el plato no crea un negativo.
    """
    ingrediente = make_ingredient(admin_client, store, name="Negativo sin 86", min_stock="1000")
    product = sales_products["inc8"]
    put_recipe(admin_client, product.id, [{"ingredient_id": ingrediente["id"], "qty": "400", "unit": "g"}])
    open_shift()
    order = create_order(device_client).json()
    order = add_items(device_client, order, [{"product_id": product.id, "qty": 1}]).json()
    assert send(device_client, order).status_code == 200

    assert stock_of(db, store, ingredient_id=ingrediente["id"]) < 0

    from app.catalog.models import Product

    db.expire_all()
    fila = db.get(Product, product.id)
    assert fila.available is True, "un insumo en negativo apagó el plato: son dos señales distintas"


# ---------------------------------------------------------------------------
# Mermas (§5.5)
# ---------------------------------------------------------------------------


def test_there_is_no_staff_meal_waste_type(db: Any, store: Any, device_client: Any, identify: Any, employees: Any) -> None:
    """§5.5, literal: «**no existe "consumo de personal" como merma**: es una
    comanda `staff_meal`».

    Si el tipo existiera, el mismo hecho tendría dos caminos de registro —el
    modo de falla de §4.1 (dos caminos dejaron la leche entera en −4 y la
    deslactosada en +19)— y el costo del personal se contaría dos veces o
    ninguna.
    """
    from app.inventory.models import WasteType

    valores = {t.value for t in WasteType}
    assert valores == {
        "expired",
        "overproduction",
        "kitchen_error",
        "breakage",
        "customer_return",
        "tasting",
        "courtesy_no_dish",
        "unidentified",
    }, f"el catálogo de tipos de merma cambió: {sorted(valores)}"
    assert not any("staff" in v or "personal" in v or "employee" in v for v in valores)


def test_waste_deducts_the_ledger_with_its_own_cause_and_a_responsible(
    db: Any, store: Any, admin_client: Any, device_client: Any, identify: Any, employees: Any
) -> None:
    """§5.5: «responsable (PIN), insumo o preparación, cantidad, costo con
    origen». La merma baja el libro con `cause=waste`, nunca con la causa de
    una venta: un reporte que suma por causa tiene que poder separarlas."""
    from app.inventory.models import MovementCause

    ingrediente = make_ingredient(admin_client, store, name="Merma", official_cost="20", min_stock="1000")
    identify(device_client, employees["operator"])
    resp = device_client.post(
        f"{API}/waste",
        json={"ingredient_id": ingrediente["id"], "qty": "250", "type": "expired", "employee_pin": "2222"},
        headers=idem_headers(),
    )
    assert resp.status_code == 201, resp.text
    cuerpo = resp.json()
    assert cuerpo["qty"] == "250"
    assert cuerpo["employee_id"] == employees["operator"].id

    assert stock_of(db, store, ingredient_id=ingrediente["id"]) == -250_000
    movimiento = movements_of(db, store, ingredient_id=ingrediente["id"])[0]
    assert movimiento.cause is MovementCause.WASTE
    assert movimiento.cost_micros == 20_000_000 and movimiento.cost_source.value == "official"


def test_waste_with_a_wrong_pin_writes_nothing(
    db: Any, store: Any, admin_client: Any, device_client: Any, identify: Any, employees: Any
) -> None:
    """§11.4: la merma se atribuye con PIN. Un PIN equivocado no puede dejar ni
    la merma ni el movimiento: validar antes de escribir es obligatorio porque
    `get_db` comitea también ante un `AppError` (`docs/ESTADO.md`, decisiones
    de implementación)."""
    ingrediente = make_ingredient(admin_client, store, name="Merma sin pin", min_stock="1000")
    identify(device_client, employees["operator"])
    resp = device_client.post(
        f"{API}/waste",
        json={"ingredient_id": ingrediente["id"], "qty": "100", "type": "breakage", "employee_pin": "0000"},
        headers=idem_headers(),
    )
    assert resp.status_code in (400, 401, 403), resp.text
    assert set(resp.json()["error"]) >= {"code", "message"}
    assert stock_of(db, store, ingredient_id=ingrediente["id"]) == 0
    assert movements_of(db, store, ingredient_id=ingrediente["id"]) == []


def test_the_weekly_waste_ratio_says_no_data_instead_of_zero(
    db: Any, store: Any, admin_client: Any
) -> None:
    """§13 de `AGENTS.md` y el contrato del pedido: «mermas ÷ compras es `null`
    hasta que 2b traiga las compras — decí "sin datos", nunca `0`». Un `0`
    ahí se lee como "no hay merma", que es exactamente lo contrario de lo que
    el dato significa."""
    resp = admin_client.get(f"{API}/admin/waste?store_id={store.id}")
    assert resp.status_code == 200, resp.text
    kpi = resp.json()["weekly_kpi"]
    assert kpi["ratio"] is None, "el KPI de mermas devolvió un número sin tener compras"
    assert "sin datos" in kpi["label"].lower()


def test_waste_over_one_and_a_half_times_last_week_raises_a_notification(
    db: Any, store: Any, admin_client: Any, device_client: Any, identify: Any, employees: Any, clock: Any
) -> None:
    """§5.5: «alerta si la merma de un insumo supera 1,5 × la semana
    anterior». Es la única alarma temprana de un insumo que se está yendo por
    un agujero que nadie declaró."""
    from sqlalchemy import select

    from app.notifications.models import Notification

    ingrediente = make_ingredient(admin_client, store, name="Pico", official_cost="5", min_stock="1000")
    identify(device_client, employees["operator"])

    def merma(qty: str) -> Any:
        return device_client.post(
            f"{API}/waste",
            json={"ingredient_id": ingrediente["id"], "qty": qty, "type": "expired", "employee_pin": "2222"},
            headers=idem_headers(),
        )

    assert merma("100").status_code == 201
    clock.advance(days=8)
    identify(device_client, employees["operator"])
    assert merma("400").status_code == 201  # 4x la semana anterior

    avisos = list(
        db.execute(select(Notification).where(Notification.type == "waste_spike")).scalars()
    )
    assert avisos, "una merma de 4x la semana anterior no avisó a nadie"


# ---------------------------------------------------------------------------
# Idempotencia y carreras (§11.9)
# ---------------------------------------------------------------------------


def test_the_same_idempotency_key_never_registers_two_wastes(
    db: Any, store: Any, admin_client: Any, device_client: Any, identify: Any, employees: Any
) -> None:
    """§11.9: «idempotencia en toda escritura que mueve plata o estado». El POS
    del salón pierde la red a mitad de un `POST`; el reintento no puede
    descontar el insumo dos veces."""
    ingrediente = make_ingredient(admin_client, store, name="Merma idem", min_stock="1000")
    identify(device_client, employees["operator"])
    headers = idem_headers()
    cuerpo = {"ingredient_id": ingrediente["id"], "qty": "300", "type": "kitchen_error", "employee_pin": "2222"}

    primera = device_client.post(f"{API}/waste", json=cuerpo, headers=headers)
    segunda = device_client.post(f"{API}/waste", json=cuerpo, headers=headers)
    assert primera.status_code == 201, primera.text
    assert segunda.status_code == 201, segunda.text
    assert primera.json()["id"] == segunda.json()["id"]
    assert stock_of(db, store, ingredient_id=ingrediente["id"]) == -300_000


def test_the_same_idempotency_key_never_registers_two_adjustments(
    db: Any, store: Any, admin_client: Any
) -> None:
    """Lo mismo para el ajuste manual: es la única escritura de inventario que
    un humano teclea a mano y por lo tanto la que más se reintenta."""
    ingrediente = make_ingredient(admin_client, store, name="Ajuste idem", min_stock="1000")
    headers = idem_headers()
    cuerpo = {
        "ingredient_id": ingrediente["id"],
        "qty_delta": "1000",
        "reason": "carga inicial",
        "authorizer_pin": "9999",
    }
    primera = admin_client.post(
        f"{API}/admin/inventory/adjustments?store_id={store.id}", json=cuerpo, headers=headers
    )
    segunda = admin_client.post(
        f"{API}/admin/inventory/adjustments?store_id={store.id}", json=cuerpo, headers=headers
    )
    assert primera.status_code == 201, primera.text
    assert segunda.status_code == 201, segunda.text
    assert primera.json()["id"] == segunda.json()["id"]
    assert stock_of(db, store, ingredient_id=ingrediente["id"]) == 1_000_000


def _seed_batch_preparation(race_env: Any, *, ingredient_cost_micros: int = 1_000_000) -> tuple[int, int]:
    """Un insumo y una preparación en modo lote **dentro de la base de la
    carrera** (no la de `db`: son bases distintas). Devuelve
    `(ingredient_id, preparation_id)`."""
    from app.core import clock as clock_module
    from app.inventory.models import BaseUnit, Ingredient
    from app.recipes.models import PrepMode, Preparation, PreparationLine

    now = clock_module.now_utc()
    with race_env.session_factory() as db:
        ingrediente = Ingredient(
            organization_id=race_env.organization_id,
            store_id=race_env.store_id,
            name="Insumo carrera",
            category=None,
            base_unit=BaseUnit.G,
            purchase_unit="kg",
            purchase_factor=1000,
            yield_pct=100,
            official_cost_micros=ingredient_cost_micros,
            estimated_cost_micros=None,
            min_stock=1000,
            lead_time_days=None,
            perishable=False,
            key_item=False,
            active=True,
            consumption_untracked=False,
            substitute_ingredient_id=None,
            supplier_id=None,
            created_at=now,
            updated_at=now,
        )
        db.add(ingrediente)
        db.flush()
        preparacion = Preparation(
            organization_id=race_env.organization_id,
            store_id=race_env.store_id,
            name="Caldo carrera",
            mode=PrepMode.BATCH,
            standard_yield_qty=1_000_000,
            standard_yield_unit="g",
            process_loss_pct=0,
            shelf_life_days=2,
            active=True,
            created_at=now,
            updated_at=now,
        )
        db.add(preparacion)
        db.flush()
        db.add(
            PreparationLine(
                preparation_id=preparacion.id,
                ingredient_id=ingrediente.id,
                component_preparation_id=None,
                qty_base=500_000,
                unit="g",
            )
        )
        db.commit()
        return ingrediente.id, preparacion.id


def test_two_concurrent_productions_with_the_same_key_leave_one_batch(race_env: Any) -> None:
    """§11.9: «`409` ante concurrencia». Dos toques del mismo botón de
    producción rápida (o dos cocineros al mismo tiempo) no pueden crear dos
    lotes ni descontar los insumos dos veces.

    Corre sobre `race_env` —una sesión por request, como en producción— porque
    la fixture `db` entrega una sola `Session` a todos los requests y dos hilos
    sobre ella se matan antes de tocar la reserva de idempotencia.
    """
    from sqlalchemy import func, select

    from app.inventory.models import StockMovement
    from app.recipes.models import PrepBatch

    ingrediente_id, preparacion_id = _seed_batch_preparation(race_env)
    headers = idem_headers()
    cuerpo = {"qty_expected": "1000", "qty_real": "1000", "employee_pin": race_env.employee_pin}

    resultados: list[Any] = []
    barrera = threading.Barrier(2)

    def _producir() -> None:
        barrera.wait()
        resultados.append(
            race_env.client.post(
                f"{API}/preparations/{preparacion_id}/produce", json=cuerpo, headers=headers
            )
        )

    hilos = [threading.Thread(target=_producir) for _ in range(2)]
    for h in hilos:
        h.start()
    for h in hilos:
        h.join()

    codigos = sorted(r.status_code for r in resultados)
    assert codigos in ([201, 201], [201, 409]), [r.status_code for r in resultados]

    with race_env.session_factory() as db:
        lotes = db.execute(select(func.count()).select_from(PrepBatch)).scalar_one()
        salidas = db.execute(
            select(func.coalesce(func.sum(StockMovement.qty_base), 0)).where(
                StockMovement.ingredient_id == ingrediente_id
            )
        ).scalar_one()
    assert lotes == 1, f"dos producciones concurrentes dejaron {lotes} lotes"
    assert salidas == -500_000, f"el insumo se descontó dos veces: {salidas}"


# ---------------------------------------------------------------------------
# Nada de inventario se borra (§11.3)
# ---------------------------------------------------------------------------


def test_deleting_an_ingredient_is_a_logical_deactivation_with_its_audit_row(
    db: Any, store: Any, admin_client: Any
) -> None:
    """§11.3: «nada financiero ni de inventario se borra ni se edita en
    silencio: baja lógica, reversas con motivo, auditoría con antes y
    después». Borrar la fila de un insumo dejaría huérfanos todos sus
    movimientos y todas las fichas que lo usan."""
    from sqlalchemy import select

    from app.audit.models import AuditLog
    from app.inventory.models import Ingredient

    ingrediente = make_ingredient(admin_client, store, name="A dar de baja", min_stock="1000")
    resp = admin_client.delete(f"{API}/admin/ingredients/{ingrediente['id']}")
    assert resp.status_code == 200, resp.text
    assert resp.json()["active"] is False

    fila = db.get(Ingredient, ingrediente["id"])
    assert fila is not None, "el insumo se borró de verdad"
    assert fila.active is False

    logs = list(
        db.execute(
            select(AuditLog).where(AuditLog.entity == "ingredient", AuditLog.entity_id == ingrediente["id"])
        ).scalars()
    )
    acciones = {log.action for log in logs}
    assert "deactivate" in acciones, f"la baja lógica no quedó auditada: {acciones}"
    baja = next(log for log in logs if log.action == "deactivate")
    assert baja.before is not None and baja.after is not None, "la auditoría no guardó antes y después"


def test_the_ledger_is_append_only_no_endpoint_edits_or_deletes_a_movement(client: Any) -> None:
    """§5.1 + §11.3: el libro es **append-only**. No existe (y no puede
    existir) una ruta que edite o borre un movimiento: corregir es escribir
    otro movimiento con su causa, nunca reescribir el pasado."""
    spec = client.get("/openapi.json").json()
    prohibidas = [
        f"{metodo.upper()} {ruta}"
        for ruta, item in spec["paths"].items()
        for metodo in item
        if metodo in ("put", "patch", "delete")
        and re.search(r"/(stock-)?movements?(/|$)", ruta)
    ]
    assert not prohibidas, f"el libro de movimientos dejó de ser append-only: {prohibidas}"


# ---------------------------------------------------------------------------
# Funciones apagadas (§11.19)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("flag", "metodo", "ruta", "cuerpo"),
    [
        ("inventory.perpetual", "get", "/admin/inventory/stock", None),
        ("inventory.perpetual", "post", "/admin/inventory/adjustments", {}),
        ("inventory.waste", "get", "/admin/waste", None),
        ("catalog.preps", "get", "/admin/preparations", None),
    ],
)
def test_an_endpoint_of_a_disabled_function_answers_400_feature_disabled(
    db: Any, store: Any, admin_client: Any, set_feature: Any, flag: str, metodo: str, ruta: str, cuerpo: Any
) -> None:
    """§11.19 y `AGENTS.md`: «toda función opcional vive detrás de su flag, que
    **hace cumplir el backend**». Probado apagado, no sólo encendido: el
    bloqueante B-2 de 1b-2 fue exactamente una flag apagada por un camino que
    nadie probó apagado, y perdía ventas enteras."""
    set_feature(flag, False)
    url = f"{API}{ruta}?store_id={store.id}"
    resp = (
        admin_client.get(url)
        if metodo == "get"
        else admin_client.post(url, json=cuerpo, headers=idem_headers())
    )
    assert resp.status_code == 400, resp.text
    error = resp.json()["error"]
    assert error["code"] == "FEATURE_DISABLED", error
    assert flag in error["message"], "el error no nombra la función que hay que encender"


def test_with_inventory_waste_disabled_the_device_cannot_register_waste(
    db: Any, store: Any, admin_client: Any, device_client: Any, identify: Any, employees: Any, set_feature: Any
) -> None:
    """La misma regla en la ruta de dispositivo, que es la que de verdad usa
    cocina."""
    ingrediente = make_ingredient(admin_client, store, name="Merma apagada", min_stock="1000")
    set_feature("inventory.waste", False)
    identify(device_client, employees["operator"])
    resp = device_client.post(
        f"{API}/waste",
        json={"ingredient_id": ingrediente["id"], "qty": "10", "type": "expired", "employee_pin": "2222"},
        headers=idem_headers(),
    )
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "FEATURE_DISABLED"
    assert stock_of(db, store, ingredient_id=ingrediente["id"]) == 0


def test_with_inventory_perpetual_disabled_today_reports_no_inventory_alerts(
    db: Any, store: Any, admin_client: Any, set_feature: Any
) -> None:
    """Una función apagada no puede seguir hablando por otra pantalla. Con
    `inventory.perpetual` apagada no hay libro de movimientos, así que **todos**
    los insumos están en cero: reportarlos como "bajo mínimo" en Hoy llenaría
    «Requiere tu atención» con una alarma que el restaurante no pidió y que no
    puede resolver (§11.19; y §5.2, que separa negativo de agotado justamente
    para que cada alerta signifique algo)."""
    make_ingredient(admin_client, store, name="Sin libro 1", min_stock="1000")
    make_ingredient(admin_client, store, name="Sin libro 2", min_stock="1000")
    set_feature("inventory.perpetual", False)

    resp = admin_client.get(f"{API}/admin/today?store_id={store.id}")
    assert resp.status_code == 200, resp.text
    cuerpo = resp.json()
    assert cuerpo["ingredients_below_min"] == [], (
        "con el inventario perpetuo apagado, Hoy alertó igual sobre insumos bajo mínimo"
    )
    assert cuerpo["ingredients_negative"] == []


# ---------------------------------------------------------------------------
# Aislamiento por sede y por organización (§1.1)
# ---------------------------------------------------------------------------


def test_an_ingredient_of_another_organization_is_404_for_reading_and_writing(
    db: Any, store: Any, admin_client: Any, other_org: dict[str, Any]
) -> None:
    """§1.1 y §11.19: «toda consulta se acota por organización y sede; un id
    ajeno es `404`» — nunca `403`, que confirmaría que el id existe."""
    from app.core import clock as clock_module
    from app.inventory.models import BaseUnit, Ingredient

    now = clock_module.now_utc()
    ajeno = Ingredient(
        organization_id=other_org["org"].id,
        store_id=other_org["store"].id,
        name="Insumo ajeno",
        category=None,
        base_unit=BaseUnit.G,
        purchase_unit="kg",
        purchase_factor=1000,
        yield_pct=100,
        official_cost_micros=1_000_000,
        estimated_cost_micros=None,
        min_stock=1000,
        lead_time_days=None,
        perishable=False,
        key_item=False,
        active=True,
        consumption_untracked=False,
        substitute_ingredient_id=None,
        supplier_id=None,
        created_at=now,
        updated_at=now,
    )
    db.add(ajeno)
    db.commit()

    lectura = admin_client.get(f"{API}/admin/ingredients/{ajeno.id}/movements")
    assert lectura.status_code == 404, lectura.text
    escritura = admin_client.patch(f"{API}/admin/ingredients/{ajeno.id}", json={"name": "robado"})
    assert escritura.status_code == 404, escritura.text
    baja = admin_client.delete(f"{API}/admin/ingredients/{ajeno.id}")
    assert baja.status_code == 404, baja.text


# ---------------------------------------------------------------------------
# Forma del error: `400` con acción correctiva, nunca `500`
# ---------------------------------------------------------------------------


def test_every_business_error_of_this_phase_has_exactly_one_shape(
    db: Any, store: Any, admin_client: Any, device_client: Any, identify: Any, employees: Any
) -> None:
    """§11.18 y §12: una sola forma `{error:{code,message}}`, regla de negocio
    en `400` con la acción correctiva, **ningún `500`**."""
    ingrediente = make_ingredient(admin_client, store, name="Errores", min_stock="1000")
    prep = make_preparation(admin_client, store, name="Explotada", mode="exploded")
    identify(device_client, employees["operator"])

    casos: list[tuple[str, Any]] = [
        (
            "min_stock en cero",
            admin_client.post(
                f"{API}/admin/ingredients?store_id={store.id}",
                json={
                    "name": "X",
                    "base_unit": "g",
                    "purchase_unit": "kg",
                    "purchase_factor": 1000,
                    "min_stock": "0",
                },
            ),
        ),
        (
            "ajuste de cantidad cero",
            admin_client.post(
                f"{API}/admin/inventory/adjustments?store_id={store.id}",
                json={
                    "ingredient_id": ingrediente["id"],
                    "qty_delta": "0",
                    "reason": "nada",
                    "authorizer_pin": "9999",
                },
                headers=idem_headers(),
            ),
        ),
        (
            "merma sin insumo ni preparación",
            device_client.post(
                f"{API}/waste",
                json={"qty": "10", "type": "expired", "employee_pin": "2222"},
                headers=idem_headers(),
            ),
        ),
        (
            "merma de cantidad negativa",
            device_client.post(
                f"{API}/waste",
                json={
                    "ingredient_id": ingrediente["id"],
                    "qty": "-5",
                    "type": "expired",
                    "employee_pin": "2222",
                },
                headers=idem_headers(),
            ),
        ),
        (
            "producir una preparación explotada",
            device_client.post(
                f"{API}/preparations/{prep['id']}/produce",
                json={"qty_expected": "100", "qty_real": "100", "employee_pin": "2222"},
                headers=idem_headers(),
            ),
        ),
        (
            "unidad que no corresponde a la base",
            admin_client.post(
                f"{API}/admin/preparations?store_id={store.id}",
                json={
                    "name": "Unidad mala",
                    "mode": "exploded",
                    "standard_yield_qty": "1000",
                    "standard_yield_unit": "g",
                    "lines": [{"ingredient_id": ingrediente["id"], "qty": "1", "unit": "l"}],
                },
            ),
        ),
    ]

    for nombre, resp in casos:
        assert resp.status_code != 500, f"«{nombre}» respondió 500: {resp.text[:200]}"
        assert resp.status_code == 400, f"«{nombre}» respondió {resp.status_code}: {resp.text[:200]}"
        cuerpo = resp.json()
        assert set(cuerpo) == {"error"}, f"«{nombre}» no usa la forma única: {cuerpo}"
        assert set(cuerpo["error"]) >= {"code", "message"}, cuerpo
        assert cuerpo["error"]["code"] and cuerpo["error"]["code"].isupper()
        assert len(cuerpo["error"]["message"]) > 15, (
            f"«{nombre}» no nombra la acción correctiva: {cuerpo['error']['message']!r}"
        )


# ---------------------------------------------------------------------------
# Coherencia entre los dominios que construyó este pedido
#
# Los tres rojos de 1b-2 cayeron en archivos sin dueño; el equivalente en 2a
# es el contrato ENTRE dueños: dos agentes que publican el mismo enum con
# valores distintos, o un listado que no declara su `format=csv`, no le fallan
# a nadie hasta que alguien de afuera los usa.
# ---------------------------------------------------------------------------


def test_the_cost_source_of_the_api_is_the_same_enum_as_the_model() -> None:
    """Si el `Literal` del esquema y el enum del modelo se separan, el día que
    2b agregue `weighted_average` de verdad la API lo va a rechazar (o peor,
    lo va a aceptar y el modelo va a reventar al guardarlo). Es el tipo de
    desfase que no falla en ningún test de comportamiento."""
    from typing import get_args

    from app.inventory.models import CostSource, MovementCause, WasteType
    from app.inventory.schemas import CostSourceLiteral, MovementCauseLiteral, WasteTypeLiteral

    assert set(get_args(CostSourceLiteral)) == {c.value for c in CostSource}
    assert set(get_args(MovementCauseLiteral)) == {c.value for c in MovementCause}
    assert set(get_args(WasteTypeLiteral)) == {w.value for w in WasteType}


def test_the_ledger_declares_the_causes_of_section_5_1_and_nothing_else() -> None:
    """§5.1: la causa de un movimiento es un enum cerrado, nunca un texto.

    **Acotado en 2b, declarado**: en 2a este test se llamaba «declara las
    cuatro causas de 2b sin usarlas» y fijaba **once** valores exactos. 2b
    agrega una duodécima, `reception_reversal`, y no es un desliz: sus
    «Convenciones propias» la nombran una por una («Las causas nuevas
    (`purchase`, `count_adjustment`, `reception_reversal`) se agregan al
    enum»), y `app.purchases.service.reverse_reception` la produce porque
    «eliminar una recepción es una reversa con causa, nunca un `DELETE` de
    filas». Un invariante que fija un conjunto exacto tiene que moverse
    cuando la spec mueve el conjunto — lo que NO puede es aflojarse a «que
    contenga al menos».

    **RONDA 2 — decisión del orquestador (hallazgo H-3)**: `void_after_send`
    SALE del enum y del `Literal` publicado. Estuvo declarada desde 1b y
    nunca se produjo ni una sola vez. El razonamiento de NO producirla es
    correcto y quedó escrito en `app/orders/service.py::_resolve_waste_stub`
    — producirla exigiría un par alta+baja que se cancela en el saldo, y
    desde 2b la mitad negativa dispararía una **segunda depleción FEFO real**
    de `StockBatch.qty_remaining` sobre cantidad que ya se consumió al
    vender, corrompiendo la contabilidad por lote aunque el agregado quede
    exacto. Pero un enum cerrado no puede declarar una causa que nadie
    escribe: el lector del contrato supone que existen mermas por anulación
    agrupables por causa, y un reporte agrupado por causa le devuelve vacío.
    El checklist de 2b pedía «se produce o se saca»; la decisión fue sacarla.
    Si `app.orders` alguna vez necesita producirla de verdad, se reintroduce
    junto con quien la escriba, en el mismo pedido.

    Qué sigue prohibido, igual que antes: que aparezca una causa que §5.1 no
    enumera, y que desaparezca una que sí. `transfer_in`/`transfer_out`
    siguen declaradas y sin uso (no hay traslados entre sedes hasta fase 3),
    y ésa es la ÚNICA excepción tolerada a «toda causa declarada se produce»
    — está fechada (fase 3) y tiene dueño.
    """
    from app.inventory.models import MovementCause

    declaradas = {c.value for c in MovementCause}
    assert declaradas == {
        "sale",
        "production_in",
        "production_out",
        "waste",
        "note_return",
        "manual_adjustment",
        "purchase",
        "count_adjustment",
        "reception_reversal",
        "transfer_in",
        "transfer_out",
    }, f"el enum de causas se apartó de §5.1: {sorted(declaradas)}"


def test_every_new_listing_declares_format_csv_in_its_contract(client: Any) -> None:
    """Hallazgo R-5 de 1b-2: cinco listados servían CSV leyendo
    `request.query_params` a mano, así que el OpenAPI **no lo publicaba** y
    ningún cliente generado podía pedirlo.

    Cada listado nuevo de 2a tiene que declarar `format` en su firma
    (`Every list endpoint keeps accepting format=csv`, contrato de la API del
    pedido).
    """
    spec = client.get("/openapi.json").json()
    listados = [
        f"{API}/admin/ingredients",
        f"{API}/admin/ingredients/{{ingredient_id}}/movements",
        f"{API}/admin/inventory/stock",
        f"{API}/admin/waste",
        f"{API}/admin/preparations",
        f"{API}/admin/preparations/{{preparation_id}}/batches",
        f"{API}/admin/recipes/coverage",
        f"{API}/admin/recipes/suspicious-units",
    ]
    faltan: list[str] = []
    for ruta in listados:
        item = spec["paths"].get(ruta)
        assert item is not None, f"la ruta {ruta} no está publicada en el OpenAPI"
        parametros = {p["name"] for p in item.get("get", {}).get("parameters", [])}
        if "format" not in parametros:
            faltan.append(ruta)
    assert not faltan, f"estos listados sirven CSV sin declararlo en el contrato: {faltan}"


def test_the_admin_orders_report_values_courtesies_at_cost(
    db: Any, store: Any, admin_client: Any, device_client: Any, identify: Any, employees: Any,
    open_shift: Any, sales_products: Any,
) -> None:
    """Contrato del pedido: «`GET /admin/orders` gana las cortesías **a
    costo**». Es el contrapeso del reporte de cortesías por precio: lo que el
    restaurante de verdad regaló es el costo, no el precio de la carta."""
    from tests.audit.conftest import deep_keys

    insumo = make_ingredient(admin_client, store, name="Insumo cortesía admin", official_cost="10", min_stock="1000")
    product = sales_products["inc8"]
    put_recipe(admin_client, product.id, [{"ingredient_id": insumo["id"], "qty": "100", "unit": "g"}])

    open_shift()
    identify(device_client, employees["operator"])
    order = create_order(device_client).json()
    order = add_items(device_client, order, [{"product_id": product.id, "qty": 1}]).json()
    item_id = order["items"][0]["id"]
    cortesia = device_client.post(
        f"{API}/orders/{order['id']}/items/{item_id}/courtesy",
        json={"expected_version": order["version"], "reason": "complaint", "authorizer_pin": "5555"},
    )
    assert cortesia.status_code == 200, cortesia.text
    assert send(device_client, cortesia.json()).status_code == 200

    resp = admin_client.get(
        f"{API}/admin/orders",
        params={"store_id": store.id, "from": "2020-01-01", "to": "2099-12-31"},
    )
    assert resp.status_code == 200, resp.text
    claves = {k.lower() for k in deep_keys(resp.json())}
    a_costo = {k for k in claves if "courtes" in k and ("cost" in k or "theoretical" in k or "value" in k)}
    assert a_costo, f"`GET /admin/orders` no valora las cortesías a costo: {sorted(k for k in claves if 'courtes' in k)}"
