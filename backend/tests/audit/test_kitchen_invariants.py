"""Invariantes del KDS (pedido 2c, `kitchen.kds`) — la superficie de dispositivo nueva.

Renglones del checklist que cubre este archivo:

- #9  «marchar» sella `fired_at` **por curso** y el KDS lo respeta en el orden.
- #10 «bump» por ítem es **idempotente**: dos veces seguidas, con la misma
      `Idempotency-Key` y con dos distintas.
- #11 sesión de dispositivo: ninguna respuesta del KDS contiene `cost`,
      `unit_cost`, `unit_cost_micros`, `cost_source` ni `margin`, con los
      dominios nuevos montados y **anidado incluido**.

Por qué acá hay tests de RUNTIME y no sólo de OpenAPI: `GET /kitchen/rounds`
devuelve `list[dict[str, Any]]` **sin `response_model`**, y las tres escrituras
del KDS devuelven `JSONResponse`. El barrido de esquemas del OpenAPI no ve el
cuerpo de ninguna de las cuatro, así que un barrido que sólo mire el OpenAPI
pasa **en vacío** sobre el KDS. Estos tests miran el JSON que sale de verdad.
"""

from __future__ import annotations

import uuid
from typing import Any

import pytest

from tests.audit.conftest import (
    add_items,
    create_order,
    deep_keys,
    get_order,
    idem_headers,
    send,
)

API = "/api/v1"

COST_KEYS = ("cost", "unit_cost", "unit_cost_micros", "cost_source", "margin")


def _product(db: Any, store: Any, *, name: str, course: str, station: str = "hot_kitchen") -> Any:
    from app.catalog.models import Category, Product
    from app.core import clock as clock_module

    now = clock_module.now_utc()
    category = Category(
        organization_id=store.organization_id,
        store_id=store.id,
        name=f"Auditoría KDS {name}",
        sort_order=93,
        default_course=course,
        default_station=station,
        active=True,
    )
    db.add(category)
    db.flush()
    row = Product(
        organization_id=store.organization_id,
        store_id=store.id,
        category_id=category.id,
        name=name,
        description=None,
        station=station,
        default_course=course,
        price_dine_in=20_000,
        price_takeout=None,
        price_delivery=None,
        price_platform=None,
        tax_code="inc_8",
        active=True,
        available=True,
        daily_count=None,
        daily_remaining=None,
        unavailable_by_employee_id=None,
        unavailable_by_employee_name=None,
        unavailable_at=None,
        is_delivery_fee=False,
        created_at=now,
        updated_at=now,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


@pytest.fixture()
def kds_order(
    device_client: Any,
    identify: Any,
    employees: dict[str, Any],
    enable_2c: Any,
    set_feature: Any,
    open_shift: Any,
    db: Any,
    store: Any,
) -> dict[str, Any]:
    """Una comanda de mostrador con DOS cursos (`starter` y `main`), enviada
    a cocina. Es el estado desde el que se marcha, se bumpea y se expide."""
    open_shift()
    identify(device_client, employees["operator"])
    enable_2c()
    set_feature("pos.courses", True)

    entrada = _product(db, store, name="Ceviche", course="starter")
    fuerte = _product(db, store, name="Bandeja", course="main")

    order = create_order(device_client, channel="counter").json()
    added = add_items(
        device_client,
        order,
        [
            {"product_id": entrada.id, "qty": 1, "course": "starter"},
            {"product_id": fuerte.id, "qty": 1, "course": "main"},
        ],
    )
    assert added.status_code == 200, added.text
    order = get_order(device_client, order["id"])
    assert send(device_client, order).status_code == 200
    order = get_order(device_client, order["id"])

    por_curso = {i["course"]: i["id"] for i in order["items"]}
    assert set(por_curso) == {"starter", "main"}, order["items"]
    return {"order": order, "items_by_course": por_curso}


# ===========================================================================
# #9 — «MARCHAR» SELLA `fired_at` POR CURSO Y EL KDS LO RESPETA
# ===========================================================================


def test_firing_a_course_seals_fired_at_for_that_course_only(
    device_client: Any, kds_order: dict[str, Any], db: Any
) -> None:
    """Checklist #9: «marchar» sella `fired_at` **por curso**, no por comanda.
    Marchar `main` no puede sellar `starter`."""
    from app.orders.models import OrderCourseFire
    from sqlalchemy import select

    order = kds_order["order"]
    resp = device_client.post(
        f"{API}/orders/{order['id']}/courses/main/fire",
        json={"expected_version": order["version"]},
        headers=idem_headers(),
    )
    assert resp.status_code in (200, 201), resp.text
    cuerpo = resp.json()
    marchados = {c["course"]: c["fired_at"] for c in cuerpo["courses_fired"]}
    assert set(marchados) == {"main"}, f"marchar `main` selló también otros cursos: {marchados}"
    assert marchados["main"] is not None

    filas = list(db.execute(select(OrderCourseFire).where(OrderCourseFire.order_id == order["id"])).scalars())
    assert [f.course for f in filas] == ["main"], filas


def test_firing_the_same_course_twice_does_not_move_the_first_fired_at(
    device_client: Any, kds_order: dict[str, Any], clock: Any
) -> None:
    """Checklist #9 + «qué pasa cuando se repite»: marchar dos veces deja el
    PRIMER `fired_at`. Un segundo toque en hora pico no puede reescribir la
    hora que la cocina usa para ordenar."""
    order = kds_order["order"]
    primera = device_client.post(
        f"{API}/orders/{order['id']}/courses/main/fire",
        json={"expected_version": order["version"]},
        headers=idem_headers(),
    )
    assert primera.status_code in (200, 201), primera.text
    fired_at = primera.json()["courses_fired"][0]["fired_at"]
    version = primera.json()["version"]

    clock.advance(minutes=2)
    segunda = device_client.post(
        f"{API}/orders/{order['id']}/courses/main/fire",
        json={"expected_version": version},
        headers=idem_headers(),
    )
    assert segunda.status_code in (200, 201), segunda.text
    marchados = {c["course"]: c["fired_at"] for c in segunda.json()["courses_fired"]}
    assert marchados["main"] == fired_at, (
        f"marchar de nuevo movió el sello de {fired_at} a {marchados['main']}"
    )


def test_the_kds_orders_the_queue_by_fired_at_and_never_puts_an_unfired_course_first(
    device_client: Any, kds_order: dict[str, Any], clock: Any
) -> None:
    """Checklist #9, la parte que importa de verdad: **el KDS lo respeta en
    el orden**.

    `starter` se envió primero (id menor). Al marchar `main`, el fuerte pasa
    al frente de la cola: un curso YA marchado nunca queda detrás de uno sin
    marchar. Sin este orden, «marchar» es un sello decorativo.
    """
    order = kds_order["order"]
    por_curso = kds_order["items_by_course"]

    antes = device_client.get(f"{API}/kitchen/rounds")
    assert antes.status_code == 200, antes.text
    ronda = antes.json()[0]
    assert [i["item_id"] for i in ronda["items"]] == sorted(por_curso.values()), (
        "sin marchar, el orden tiene que ser el de envío"
    )
    assert all(i["course_fired_at"] is None for i in ronda["items"]), ronda["items"]

    clock.advance(minutes=2)
    fire = device_client.post(
        f"{API}/orders/{order['id']}/courses/main/fire",
        json={"expected_version": order["version"]},
        headers=idem_headers(),
    )
    assert fire.status_code in (200, 201), fire.text

    despues = device_client.get(f"{API}/kitchen/rounds")
    assert despues.status_code == 200, despues.text
    items = despues.json()[0]["items"]
    assert items[0]["item_id"] == por_curso["main"], (
        f"el curso marchado no quedó primero en la cola del KDS: {[(i['course'], i['course_fired_at']) for i in items]}"
    )
    assert items[0]["course_fired_at"] is not None
    assert items[1]["course_fired_at"] is None, (
        "un curso sin marchar quedó con sello: el KDS está leyendo el `fired_at` de otro curso"
    )


# ===========================================================================
# #10 — «BUMP» POR ÍTEM ES IDEMPOTENTE
# ===========================================================================


def test_bumping_twice_with_two_different_keys_is_a_no_op_the_second_time(
    device_client: Any, kds_order: dict[str, Any], clock: Any
) -> None:
    """Checklist #10, el caso real de "dos toques": dos `Idempotency-Key`
    DISTINTAS. El segundo bump devuelve `200` (nunca error), `changed:
    false`, el MISMO `ready_at` y conserva la atribución del primero."""
    item_id = kds_order["items_by_course"]["main"]

    primero = device_client.post(f"{API}/kitchen/items/{item_id}/bump", headers=idem_headers())
    assert primero.status_code == 200, primero.text
    uno = primero.json()
    assert uno["changed"] is True, uno
    assert uno["status"] == "ready", uno

    clock.advance(minutes=2)
    segundo = device_client.post(f"{API}/kitchen/items/{item_id}/bump", headers=idem_headers())
    assert segundo.status_code == 200, segundo.text
    dos = segundo.json()
    assert dos["changed"] is False, f"el segundo bump volvió a cambiar el ítem: {dos}"
    assert dos["ready_at"] == uno["ready_at"], (
        f"el segundo bump movió `ready_at` de {uno['ready_at']} a {dos['ready_at']}"
    )
    assert dos["bumped_by"] == uno["bumped_by"], "el segundo bump reescribió la atribución"


def test_bumping_twice_with_the_same_key_replays_the_stored_response(
    device_client: Any, kds_order: dict[str, Any], clock: Any
) -> None:
    """Checklist #10, el otro caso: la MISMA `Idempotency-Key` (un reintento
    de red). Tiene que devolver la respuesta guardada, no ejecutar de nuevo —
    y en particular no puede devolver `changed: false` la segunda vez, porque
    eso sería "ya estaba hecho" en vez de "esta es tu misma respuesta"."""
    item_id = kds_order["items_by_course"]["main"]
    clave = {"Idempotency-Key": str(uuid.uuid4())}

    primero = device_client.post(f"{API}/kitchen/items/{item_id}/bump", headers=clave)
    assert primero.status_code == 200, primero.text
    clock.advance(minutes=2)
    segundo = device_client.post(f"{API}/kitchen/items/{item_id}/bump", headers=clave)
    assert segundo.status_code == 200, segundo.text
    assert segundo.json() == primero.json(), (
        "la misma Idempotency-Key no devolvió la MISMA respuesta: "
        f"{primero.json()} vs {segundo.json()}"
    )


def test_unbumping_reverses_the_bump_and_is_also_idempotent(
    device_client: Any, kds_order: dict[str, Any]
) -> None:
    """Checklist #10, «qué pasa cuando se deshace»: un bump equivocado en
    hora pico es inevitable. `unbump` devuelve el ítem a `sent` y repetirlo
    es un no-op, no un error."""
    item_id = kds_order["items_by_course"]["main"]
    device_client.post(f"{API}/kitchen/items/{item_id}/bump", headers=idem_headers())

    uno = device_client.post(f"{API}/kitchen/items/{item_id}/unbump", headers=idem_headers())
    assert uno.status_code == 200, uno.text
    assert uno.json()["changed"] is True and uno.json()["status"] == "sent", uno.json()

    dos = device_client.post(f"{API}/kitchen/items/{item_id}/unbump", headers=idem_headers())
    assert dos.status_code == 200, dos.text
    assert dos.json()["changed"] is False, dos.json()
    assert dos.json()["status"] == "sent", dos.json()


def test_expediting_twice_bumps_everything_once_and_the_second_time_changes_nothing(
    device_client: Any, kds_order: dict[str, Any]
) -> None:
    """Checklist #10, para la comanda completa: expedir dos veces deja todo
    `ready` una sola vez. "No había nada que expedir" es información, no un
    fallo."""
    order = kds_order["order"]
    uno = device_client.post(f"{API}/kitchen/orders/{order['id']}/expedite", headers=idem_headers())
    assert uno.status_code == 200, uno.text
    assert uno.json()["changed"] is True, uno.json()
    assert len(uno.json()["changed_item_ids"]) == 2, uno.json()

    dos = device_client.post(f"{API}/kitchen/orders/{order['id']}/expedite", headers=idem_headers())
    assert dos.status_code == 200, dos.text
    assert dos.json()["changed"] is False, dos.json()
    assert dos.json()["changed_item_ids"] == [], dos.json()


def test_a_bump_that_changed_nothing_writes_no_audit_row(
    device_client: Any, kds_order: dict[str, Any], db: Any, store: Any
) -> None:
    """Checklist #10, el corolario de la idempotencia en la AUDITORÍA: un
    bump que no cambió nada no puede escribir una fila de evento. Si la
    escribiera, el reporte de "quién bumpeó" contaría dos veces el mismo
    plato por un doble toque."""
    from app.kitchen.models import KitchenBumpEvent
    from sqlalchemy import select

    item_id = kds_order["items_by_course"]["main"]
    device_client.post(f"{API}/kitchen/items/{item_id}/bump", headers=idem_headers())
    db.expire_all()
    despues_del_primero = len(
        list(db.execute(select(KitchenBumpEvent).where(KitchenBumpEvent.item_id == item_id)).scalars())
    )
    assert despues_del_primero == 1, "el primer bump tenía que dejar UNA fila de auditoría"

    device_client.post(f"{API}/kitchen/items/{item_id}/bump", headers=idem_headers())
    db.expire_all()
    final = len(
        list(db.execute(select(KitchenBumpEvent).where(KitchenBumpEvent.item_id == item_id)).scalars())
    )
    assert final == 1, f"un bump idempotente escribió una fila de auditoría de más ({final})"


def test_bumping_an_item_of_another_store_is_404_and_never_500(
    device_client: Any, kds_order: dict[str, Any]
) -> None:
    """Regla dura: un id ajeno es `404`, nunca `403` (confirmaría que existe)
    ni `500`."""
    resp = device_client.post(f"{API}/kitchen/items/999999/bump", headers=idem_headers())
    assert resp.status_code == 404, resp.text
    assert resp.json()["error"]["code"] == "NOT_FOUND", resp.text


# ===========================================================================
# #11 — EL OPERADOR NO VE COSTOS, CON EL KDS COMO SUPERFICIE NUEVA
# ===========================================================================


def _leaks(valor: Any, donde: str) -> list[str]:
    out: list[str] = []
    if isinstance(valor, dict):
        for k, v in valor.items():
            bajo = str(k).lower()
            if any(secreto in bajo for secreto in ("cost", "margin")):
                out.append(f"{donde}.{k}")
            out += _leaks(v, f"{donde}.{k}")
    elif isinstance(valor, list):
        for i, v in enumerate(valor):
            out += _leaks(v, f"{donde}[{i}]")
    return out


def test_no_kds_response_body_ever_contains_a_cost_or_margin_key(
    device_client: Any,
    admin_client: Any,
    kds_order: dict[str, Any],
    db: Any,
    store: Any,
) -> None:
    """Checklist #11, en RUNTIME y anidado.

    `GET /kitchen/rounds` no declara `response_model` (devuelve
    `list[dict[str, Any]]`) y bump/unbump/expedite devuelven `JSONResponse`:
    el barrido del OpenAPI **no ve el cuerpo de ninguna de las cuatro**. Este
    test mira el JSON que sale de verdad, recursivamente, con los dominios
    nuevos montados y con una receta cargada (para que el ítem TENGA costo
    congelado del otro lado y el test no pase por no haber costo).
    """
    from tests.audit.conftest import make_ingredient, put_recipe

    order = kds_order["order"]
    item_id = kds_order["items_by_course"]["main"]

    # Que el ítem tenga costo del lado del modelo: si no, el test pasaría
    # porque no hay costo, no porque el KDS lo oculte.
    ingrediente = make_ingredient(admin_client, store, name="Insumo del KDS")
    producto_id = [i["product_id"] for i in order["items"] if i["id"] == item_id][0]
    put_recipe(
        admin_client,
        producto_id,
        lines=[{"ingredient_id": ingrediente["id"], "qty": "1.000", "unit": ingrediente["base_unit"]}],
    )

    respuestas: list[tuple[str, Any]] = []
    rondas = device_client.get(f"{API}/kitchen/rounds")
    assert rondas.status_code == 200, rondas.text
    respuestas.append(("GET /kitchen/rounds", rondas.json()))

    trabajos = device_client.get(f"{API}/kitchen/print-jobs")
    assert trabajos.status_code == 200, trabajos.text
    respuestas.append(("GET /kitchen/print-jobs", trabajos.json()))

    round_id = trabajos.json()[0]["round_id"] if trabajos.json() else None
    if round_id is not None:
        impreso = device_client.post(
            f"{API}/kitchen/print-jobs",
            json={"round_id": round_id, "station": "hot_kitchen"},
            headers=idem_headers(),
        )
        assert impreso.status_code == 200, impreso.text
        respuestas.append(("POST /kitchen/print-jobs", impreso.json()))

    bump = device_client.post(f"{API}/kitchen/items/{item_id}/bump", headers=idem_headers())
    assert bump.status_code == 200, bump.text
    respuestas.append(("POST /kitchen/items/{id}/bump", bump.json()))

    unbump = device_client.post(f"{API}/kitchen/items/{item_id}/unbump", headers=idem_headers())
    assert unbump.status_code == 200, unbump.text
    respuestas.append(("POST /kitchen/items/{id}/unbump", unbump.json()))

    expedite = device_client.post(f"{API}/kitchen/orders/{order['id']}/expedite", headers=idem_headers())
    assert expedite.status_code == 200, expedite.text
    respuestas.append(("POST /kitchen/orders/{id}/expedite", expedite.json()))

    hallazgos: list[str] = []
    for nombre, cuerpo in respuestas:
        hallazgos += _leaks(cuerpo, nombre)
    assert not hallazgos, "el KDS filtró costo o margen: " + str(hallazgos)

    # Y los nombres exactos que la misión enumera, por si alguno no contuviera
    # la subcadena "cost"/"margin" mañana.
    for nombre, cuerpo in respuestas:
        claves = deep_keys(cuerpo)
        for prohibida in COST_KEYS:
            assert prohibida not in claves, f"{nombre} trae {prohibida!r}"


def test_the_kds_never_exposes_the_delivery_address_or_the_platform_commission(
    device_client: Any,
    identify: Any,
    employees: dict[str, Any],
    enable_2c: Any,
    set_feature: Any,
    open_shift: Any,
    db: Any,
    store: Any,
    courier: Any,
    platform: Any,
    delivery_fee_product: Any,
) -> None:
    """Checklist #11 ampliado: la cocina necesita saber que un pedido es de
    plataforma; no necesita el teléfono del cliente ni la comisión. Mínimo
    privilegio sobre la superficie de dispositivo nueva."""
    open_shift()
    identify(device_client, employees["operator"])
    enable_2c()
    set_feature("pos.takeout", True)

    producto = _product(db, store, name="Fuerte del canal", course="main")

    for canal, cuerpo in (
        ("delivery", {"delivery": {"address": "Calle Secreta 9", "phone": "3009998888", "courier_employee_id": courier.id}}),
        ("platform", {"platform": {"platform_id": platform.id, "external_id": "SECRETO-1"}}),
    ):
        resp = create_order(device_client, channel=canal, **cuerpo)
        assert resp.status_code in (200, 201), resp.text
        order = resp.json()
        add_items(device_client, order, [{"product_id": producto.id, "qty": 1}])
        order = get_order(device_client, order["id"])
        assert send(device_client, order).status_code == 200

    rondas = device_client.get(f"{API}/kitchen/rounds")
    assert rondas.status_code == 200, rondas.text
    texto = rondas.text
    assert "Calle Secreta 9" not in texto, "el KDS expuso la dirección del cliente de domicilio"
    assert "3009998888" not in texto, "el KDS expuso el teléfono del cliente de domicilio"
    claves = deep_keys(rondas.json())
    for prohibida in ("commission_bp", "platform_commission_bp", "delivery_address", "delivery_phone"):
        assert prohibida not in claves, f"el KDS trae {prohibida!r}: {sorted(claves)}"
    # Lo que SÍ tiene que ver: que el pedido es de plataforma.
    plataformas = [r.get("platform") for r in rondas.json() if r.get("platform")]
    assert plataformas, "el KDS no distingue un pedido de plataforma: falta el bloque `platform`"
    assert plataformas[0]["external_id"] == "SECRETO-1", plataformas


def test_the_inherited_openapi_cost_sweep_actually_sees_the_new_2c_routes() -> None:
    """Invariante heredado (c), re-apuntado en 2c: los barridos de costo del
    OpenAPI tienen que **cubrir las rutas nuevas**.

    En 2b resultó que «eran siete barridos, no tres», y el recorte correcto
    no es por texto del path sino **por sesión**: una ruta es de admin si y
    sólo si su árbol de dependencias incluye `current_admin`. Este test
    verifica que el barrido las está viendo de verdad — es lo que separa un
    barrido que pasa de uno que pasa **en vacío**.
    """
    from tests.audit.conftest import admin_only_paths, device_reachable_paths

    device = device_reachable_paths()
    admin = admin_only_paths()

    # Del dispositivo: caen DENTRO del barrido.
    for ruta in (
        "/api/v1/kitchen/rounds",
        "/api/v1/kitchen/print-jobs",
        "/api/v1/kitchen/items/{item_id}/bump",
        "/api/v1/kitchen/items/{item_id}/unbump",
        "/api/v1/kitchen/orders/{order_id}/expedite",
        "/api/v1/orders/{order_id}/courses/{course}/fire",
        "/api/v1/device/platforms",
        "/api/v1/delivery-settlements",
        "/api/v1/delivery-settlements/pending",
        "/api/v1/delivery-settlements/{settlement_id}/void",
    ):
        assert ruta in device, f"{ruta} quedó FUERA del barrido de costo de dispositivo"
        assert ruta not in admin, f"{ruta} se clasificó como admin y el barrido ya no la mira"

    # De admin: caen FUERA (y ahí la comisión es legítima).
    for ruta in (
        "/api/v1/admin/platforms",
        "/api/v1/admin/platform-commissions",
        "/api/v1/admin/platform-receivables",
        "/api/v1/admin/platform-cancellations",
        "/api/v1/admin/delivery-settlements",
    ):
        assert ruta in admin, f"{ruta} no exige `current_admin`: la comisión quedaría al alcance del dispositivo"


def test_the_openapi_cost_sweep_is_blind_to_the_kds_because_it_declares_no_response_model() -> None:
    """**Hueco declarado, con test que lo demuestra.**

    Las cuatro rutas principales del KDS no publican esquema de respuesta:
    `GET /kitchen/rounds` devuelve `list[dict[str, Any]]` y bump/unbump/
    expedite devuelven `JSONResponse`. El barrido de propiedades del OpenAPI
    (`openapi_properties_reachable_from`) no ve ni una propiedad del cuerpo
    de esas rutas, así que **pasa en vacío sobre ellas**.

    Este test NO es un rojo: fija el hecho por escrito para que nadie lea
    "el barrido de costo pasa" como "el KDS está barrido". Lo que de verdad
    cubre el KDS es `test_no_kds_response_body_ever_contains_a_cost_or_margin_key`,
    que mira el JSON en runtime. Si algún día el KDS declara su
    `response_model`, este test se pone rojo y se borra: es la señal de que
    el hueco se cerró.
    """
    from app.main import app
    from tests.audit.conftest import openapi_properties_reachable_from

    spec = app.openapi()
    ciegas = {
        "/api/v1/kitchen/rounds",
        "/api/v1/kitchen/items/{item_id}/bump",
        "/api/v1/kitchen/items/{item_id}/unbump",
        "/api/v1/kitchen/orders/{order_id}/expedite",
    }
    for ruta in ciegas:
        props = {p for _, p in openapi_properties_reachable_from(spec, {ruta})}
        # Lo único alcanzable es el esquema de error de validación de FastAPI.
        assert props <= {"detail", "loc", "msg", "type", "ctx", "input", "url"}, (
            f"{ruta} ahora SÍ declara un esquema de respuesta ({sorted(props)}): "
            "el hueco se cerró, borrá este test y confiá en el barrido del OpenAPI"
        )
