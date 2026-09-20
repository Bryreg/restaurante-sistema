"""Invariantes del pedido 2c — «Canales y cocina»: la plata de los canales nuevos.

Los renglones del checklist de `features/fase-2c-canales-cocina/spec.md` que
hablan de PLATA y de CARTA, escritos como enunciados cortos de una regla:

- #1  flags apagadas → `400 FEATURE_DISABLED`, con dependencias declaradas.
- #2  una venta cobrada por plataforma **no mueve el efectivo esperado**.
- #3  el cargo de domicilio es una **línea con impuesto**.
- #4  el efectivo de domicilios se arquea **aparte** hasta que se liquida.
- #5  cancelar una venta de plataforma después de preparar **no genera merma**.
- #6  un canal sin precio propio cae al de mesa; un precio en `0` se respeta.
- #7  la comisión se registra y **no se resta** de la venta.
- #8  los tres canales dejan el inventario **idéntico**.
- #12 zona horaria: un pedido a las 00:30 queda con el día del TURNO.
- #13 sin `float` en comisiones ni en precios por canal.

Todo entra por HTTP salvo las lecturas del libro y de los asientos, que son
lecturas (ver el comentario del bloque de helpers en `conftest.py`).
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

import pytest

from tests.audit.conftest import (
    NO_TIP,
    add_items,
    cash_movements_of,
    commissions_of,
    create_order,
    get_order,
    idem_headers,
    movements_of,
    pay,
    receivables_of,
    send,
    stock_of,
    wastes_of,
)

API = "/api/v1"


# ---------------------------------------------------------------------------
# Armado de comandas por canal (por HTTP, por la puerta real)
# ---------------------------------------------------------------------------


def _delivery_order(device_client: Any, courier: Any, **extra: Any) -> Any:
    return create_order(
        device_client,
        channel="delivery",
        delivery={
            "address": "Calle Falsa 123",
            "phone": "3001234567",
            "courier_employee_id": courier.id,
        },
        **extra,
    )


def _platform_order(device_client: Any, platform: Any, external_id: str = "AUDIT-1", **extra: Any) -> Any:
    return create_order(
        device_client,
        channel="platform",
        platform={"platform_id": platform.id, "external_id": external_id},
        **extra,
    )


def _priced_product(db: Any, store: Any, **prices: Any) -> Any:
    from app.catalog.models import Category, Product
    from app.core import clock as clock_module

    now = clock_module.now_utc()
    category = db.query(Category).filter(Category.store_id == store.id).first()
    if category is None:
        category = Category(
            organization_id=store.organization_id,
            store_id=store.id,
            name="Auditoría 2c",
            sort_order=91,
            default_course="main",
            default_station=None,
            active=True,
        )
        db.add(category)
        db.flush()
    row = Product(
        organization_id=store.organization_id,
        store_id=store.id,
        category_id=category.id,
        name=prices.pop("name", "Plato auditado"),
        description=None,
        station=prices.pop("station", None),
        default_course="main",
        price_dine_in=prices.pop("price_dine_in", 30_000),
        price_takeout=prices.pop("price_takeout", None),
        price_delivery=prices.pop("price_delivery", None),
        price_platform=prices.pop("price_platform", None),
        tax_code=prices.pop("tax_code", "inc_8"),
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


# ===========================================================================
# #1 — las cuatro flags, en los DOS estados, con las dependencias declaradas
# ===========================================================================


# `(flag que gatea, método, path, cuerpo mínimo)`. El cuerpo no tiene que ser
# válido: el gate corre ANTES de validar el cuerpo, y eso es justamente lo que
# se quiere probar (que nada del camino nuevo se alcance con la flag apagada).
ROUTES_BY_FEATURE_2C: list[tuple[str, str, str, dict[str, Any] | None, str]] = [
    ("pos.platforms", "GET", "/admin/platforms", None, "admin"),
    ("pos.platforms", "POST", "/admin/platforms", {"name": "X", "code": "x", "commission_bp": 100}, "admin"),
    ("pos.platforms", "PATCH", "/admin/platforms/1", {"commission_bp": 100}, "admin"),
    ("pos.platforms", "DELETE", "/admin/platforms/1", None, "admin"),
    ("pos.platforms", "GET", "/admin/platforms/1/summary", None, "admin"),
    ("pos.platforms", "GET", "/admin/platform-commissions", None, "admin"),
    ("pos.platforms", "GET", "/admin/platform-receivables", None, "admin"),
    ("pos.platforms", "POST", "/admin/platform-cancellations", {"order_id": 1, "reason": "x"}, "admin"),
    ("pos.platforms", "GET", "/device/platforms", None, "device"),
    ("pos.delivery", "GET", "/delivery-settlements/pending", None, "device"),
    ("pos.delivery", "POST", "/delivery-settlements", {"courier_employee_id": 1}, "device"),
    ("pos.delivery", "POST", "/delivery-settlements/1/void", {"reason": "x"}, "device"),
    ("pos.delivery", "GET", "/admin/delivery-settlements", None, "admin"),
    ("kitchen.kds", "POST", "/kitchen/items/1/bump", None, "device"),
    ("kitchen.kds", "POST", "/kitchen/items/1/unbump", None, "device"),
    ("kitchen.kds", "POST", "/kitchen/orders/1/expedite", None, "device"),
    ("kitchen.kds", "GET", "/kitchen/print-jobs", None, "device"),
    ("kitchen.kds", "POST", "/kitchen/print-jobs", {"round_id": 1, "station": "hot_kitchen"}, "device"),
    ("pos.courses", "POST", "/orders/1/courses/main/fire", {"expected_version": 1}, "device"),
]


def _call(
    device_client: Any, admin_client: Any, method: str, path: str, body: dict[str, Any] | None, session: str
) -> Any:
    client = admin_client if session == "admin" else device_client
    kwargs: dict[str, Any] = {"headers": idem_headers()}
    if body is not None:
        kwargs["json"] = body
    return client.request(method, f"{API}{path}", **kwargs)


@pytest.mark.parametrize("feature,method,path,body,session", ROUTES_BY_FEATURE_2C)
def test_every_2c_route_answers_feature_disabled_when_its_flag_is_off(
    device_client: Any,
    admin_client: Any,
    identify: Any,
    employees: dict[str, Any],
    set_feature: Any,
    feature: str,
    method: str,
    path: str,
    body: dict[str, Any] | None,
    session: str,
) -> None:
    """Checklist #1, mitad "apagada": con su flag apagada, **ninguna** ruta
    nueva de 2c se alcanza. `400 FEATURE_DISABLED` con la forma de error del
    proyecto, y el `feature` que falta nombrado en el error."""
    identify(device_client, employees["operator"])
    for key in ("pos.delivery", "pos.platforms", "pos.courses", "kitchen.kds"):
        set_feature(key, False)

    resp = _call(device_client, admin_client, method, path, body, session)
    assert resp.status_code == 400, f"{method} {path} respondió {resp.status_code}: {resp.text}"
    error = resp.json()["error"]
    assert error["code"] == "FEATURE_DISABLED", resp.text
    assert error.get("feature") == feature, (
        f"{method} {path} dice que falta {error.get('feature')!r} y la gatea {feature!r}"
    )


@pytest.mark.parametrize("feature,method,path,body,session", ROUTES_BY_FEATURE_2C)
def test_every_2c_route_gets_past_its_gate_when_the_flag_is_on(
    device_client: Any,
    admin_client: Any,
    identify: Any,
    employees: dict[str, Any],
    enable_2c: Any,
    feature: str,
    method: str,
    path: str,
    body: dict[str, Any] | None,
    session: str,
) -> None:
    """Checklist #1, mitad "encendida": con la flag prendida la ruta **deja de
    responder `FEATURE_DISABLED`**. No se exige `200` (los ids del cuerpo son
    inventados a propósito): se exige que el gate ya no sea el que corta, que
    es lo que distingue "la flag funciona" de "la ruta está rota igual"."""
    identify(device_client, employees["operator"])
    enable_2c()

    resp = _call(device_client, admin_client, method, path, body, session)
    if resp.status_code == 400:
        assert resp.json()["error"]["code"] != "FEATURE_DISABLED", (
            f"{method} {path} sigue cortando por flag con {feature} encendida: {resp.text}"
        )
    assert resp.status_code != 500, f"{method} {path} respondió 500: {resp.text}"


def test_the_declared_dependencies_of_the_four_2c_features_are_the_ones_the_catalog_publishes() -> None:
    """Checklist #1: las dependencias que el reparto nombró son las que el
    catálogo declara. Se leen del catálogo (no de una lista a mano del test):
    si mañana alguien le quita `kitchen.view` a `kitchen.kds`, este test lo
    canta."""
    from app.core.features import FEATURE_BY_KEY as by_key

    assert by_key["pos.delivery"].requires == ["pos.takeout"]
    assert by_key["pos.courses"].requires == ["kitchen.view"]
    assert by_key["kitchen.kds"].requires == ["kitchen.view"]
    # `pos.platforms` no depende de nada, y eso también es contrato: un
    # pedido de plataforma no necesita "para llevar" encendido.
    assert by_key["pos.platforms"].requires == []


def test_a_delivery_order_is_refused_when_its_declared_dependency_is_off(
    device_client: Any, identify: Any, employees: dict[str, Any], set_feature: Any, open_shift: Any, courier: Any,
    activate_channels: Any,
) -> None:
    """Checklist #1, la dependencia declarada: `pos.delivery` **requiere**
    `pos.takeout`. Con la dependencia apagada (estado que un `UPDATE` a mano
    puede dejar), crear un domicilio corta con `FEATURE_DISABLED` nombrando
    `pos.takeout`, no la flag propia."""
    open_shift()
    identify(device_client, employees["operator"])
    set_feature("pos.delivery", True)
    set_feature("pos.takeout", False)

    resp = _delivery_order(device_client, courier)
    assert resp.status_code == 400, resp.text
    error = resp.json()["error"]
    assert error["code"] == "FEATURE_DISABLED", resp.text
    assert error.get("feature") == "pos.takeout", resp.text


def test_with_the_four_flags_off_the_1b_kitchen_view_answers_exactly_as_before(
    device_client: Any, identify: Any, employees: dict[str, Any], set_feature: Any, open_shift: Any, db: Any, store: Any
) -> None:
    """Checklist #1, "todo lo de 1b sigue IDÉNTICO": con `kitchen.kds`
    apagada, `GET /kitchen/rounds` no gana **ni una clave** de las que agrega
    el KDS (`platform`, `course_fired_at`, `bumped_by`, `bumped_at`)."""
    from tests.audit.conftest import deep_keys

    open_shift()
    identify(device_client, employees["operator"])
    set_feature("kitchen.view", True)
    set_feature("kitchen.kds", False)
    product = _priced_product(db, store, station="hot_kitchen")

    order = create_order(device_client, channel="counter").json()
    add_items(device_client, order, [{"product_id": product.id, "qty": 1}])
    order = get_order(device_client, order["id"])
    assert send(device_client, order).status_code == 200

    resp = device_client.get(f"{API}/kitchen/rounds")
    assert resp.status_code == 200, resp.text
    keys = deep_keys(resp.json())
    for nueva in ("platform", "course_fired_at", "bumped_by", "bumped_at"):
        assert nueva not in keys, f"con kitchen.kds apagada la vista de 1b ganó {nueva!r}: {keys}"


# ===========================================================================
# #6 — el precio por canal cae al de mesa; un `0` fijado se respeta
# ===========================================================================


@pytest.mark.parametrize(
    "channel,price_field",
    [("takeout", "price_takeout"), ("delivery", "price_delivery"), ("platform", "price_platform")],
)
def test_a_product_without_a_channel_price_is_sold_at_the_dine_in_price(
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
    channel: str,
    price_field: str,
    activate_channels: Any,
) -> None:
    """Checklist #6: los tres canales opcionales. Sin precio propio se vende
    al precio de MESA — nunca `0`, nunca `null` — y lo decide el servidor
    (el cliente sólo manda `product_id`/`qty`)."""
    open_shift()
    identify(device_client, employees["operator"])
    enable_2c()
    activate_channels("delivery", "platform")
    activate_channels("delivery", "platform")
    set_feature("pos.takeout", True)
    product = _priced_product(db, store, price_dine_in=30_000)
    assert getattr(product, price_field) is None

    if channel == "delivery":
        resp = _delivery_order(device_client, courier)
    elif channel == "platform":
        resp = _platform_order(device_client, platform)
    else:
        resp = create_order(device_client, channel="takeout", takeout={"customer_name": "X", "phone": "3001"})
    assert resp.status_code in (200, 201), resp.text
    order = resp.json()

    added = add_items(device_client, order, [{"product_id": product.id, "qty": 1}])
    assert added.status_code == 200, added.text
    linea = [i for i in added.json()["items"] if i["product_id"] == product.id][0]
    assert linea["unit_price"] == 30_000, f"{channel}: cayó a {linea['unit_price']} y el de mesa es 30.000"


@pytest.mark.parametrize(
    "channel,price_field",
    [("takeout", "price_takeout"), ("delivery", "price_delivery"), ("platform", "price_platform")],
)
def test_a_channel_price_set_to_zero_is_respected_and_does_not_fall_back(
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
    channel: str,
    price_field: str,
    activate_channels: Any,
) -> None:
    """Checklist #6, el caso que separa `null` de `0`: un precio de canal
    fijado **en 0** es un precio de cero pesos de verdad y se respeta. Si
    cayera al de mesa, el backend estaría leyendo `0` como "no hay dato" —
    el cero mudo que aparece en todos los pedidos (`AGENTS.md`: `null` ≠ 0)."""
    open_shift()
    identify(device_client, employees["operator"])
    enable_2c()
    activate_channels("delivery", "platform")
    set_feature("pos.takeout", True)
    product = _priced_product(db, store, price_dine_in=30_000, **{price_field: 0})

    if channel == "delivery":
        resp = _delivery_order(device_client, courier)
    elif channel == "platform":
        resp = _platform_order(device_client, platform)
    else:
        resp = create_order(device_client, channel="takeout", takeout={"customer_name": "X", "phone": "3001"})
    order = resp.json()

    added = add_items(device_client, order, [{"product_id": product.id, "qty": 1}])
    assert added.status_code == 200, added.text
    linea = [i for i in added.json()["items"] if i["product_id"] == product.id][0]
    assert linea["unit_price"] == 0, (
        f"{channel}: un precio de canal en 0 cayó a {linea['unit_price']}; `0` no es `null`"
    )


def test_the_catalog_of_the_device_never_serves_a_null_channel_price(
    device_client: Any,
    identify: Any,
    employees: dict[str, Any],
    enable_2c: Any,
    set_feature: Any,
    db: Any,
    store: Any,
) -> None:
    """Checklist #6, del lado del contrato: `GET /catalog` resuelve los cuatro
    precios en el SERVIDOR. Ningún precio de canal sale `null` ni `0` por
    ausencia — si saliera, el cliente tendría que decidir el fallback, que es
    exactamente la segunda matemática que la spec prohíbe."""
    identify(device_client, employees["operator"])
    enable_2c()
    set_feature("pos.takeout", True)
    _priced_product(db, store, price_dine_in=30_000)

    resp = device_client.get(f"{API}/catalog")
    assert resp.status_code == 200, resp.text
    vistos = 0
    for producto in resp.json()["products"]:
        precios = producto["prices"]
        for canal in ("dine_in", "takeout", "delivery", "platform"):
            assert canal in precios, f"{producto['name']}: falta el precio de {canal}"
            assert precios[canal] is not None, f"{producto['name']}: {canal} salió null"
            assert precios[canal] == precios["dine_in"], (
                f"{producto['name']}: {canal} resolvió a {precios[canal]} y el de mesa es {precios['dine_in']}"
            )
            vistos += 1
    assert vistos > 0, "la carta del dispositivo salió vacía: el test no probó nada"


# ===========================================================================
# #1 (complemento) — la dependencia se hace cumplir donde se ENCIENDE
# ===========================================================================


def test_the_dependencies_are_enforced_where_the_flag_is_turned_on(
    admin_client: Any, store: Any, set_feature: Any
) -> None:
    """Checklist #1, el punto donde la dependencia se hace cumplir de verdad.

    `app/stores/router.py:294-309` corta en los DOS sentidos: no se puede
    encender una función con su dependencia apagada, ni apagar una de la que
    otra encendida depende. Ese es el motivo por el que los endpoints no
    repiten el chequeo de la dependencia en cada ruta (decisión declarada por
    `backend-kds`): la consistencia la garantiza el interruptor.
    """
    set_feature("pos.takeout", False)
    set_feature("pos.delivery", False)

    encender = admin_client.put(
        f"{API}/admin/features/pos.delivery",
        json={"enabled": True, "store_id": store.id},
        headers=idem_headers(),
    )
    assert encender.status_code == 400, encender.text
    assert encender.json()["error"]["code"] == "FEATURE_DEPENDENCY", encender.text
    assert encender.json()["error"].get("requires") == "pos.takeout", encender.text

    # Y al revés: con `pos.delivery` encendida no se puede apagar `pos.takeout`.
    set_feature("pos.takeout", True)
    set_feature("pos.delivery", True)
    apagar = admin_client.put(
        f"{API}/admin/features/pos.takeout",
        json={"enabled": False, "store_id": store.id},
        headers=idem_headers(),
    )
    assert apagar.status_code == 400, apagar.text
    assert apagar.json()["error"]["code"] == "FEATURE_DEPENDENCY", apagar.text

    # Y lo mismo para las otras dos dependencias declaradas de 2c.
    for dependiente, dependencia in (("pos.courses", "kitchen.view"), ("kitchen.kds", "kitchen.view")):
        set_feature(dependencia, False)
        set_feature(dependiente, False)
        resp = admin_client.put(
            f"{API}/admin/features/{dependiente}",
            json={"enabled": True, "store_id": store.id},
            headers=idem_headers(),
        )
        assert resp.status_code == 400, f"{dependiente}: {resp.text}"
        assert resp.json()["error"].get("requires") == dependencia, resp.text


# ===========================================================================
# HALLAZGOS de este archivo
# ===========================================================================


def test_the_active_channels_of_the_store_gate_every_channel_and_not_only_three(
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
    """**HALLAZGO H-3 (ADVERTENCIA).** «Canales activos» es configuración de
    sede (SPEC-NEGOCIO §9.3) y `create_order` la hace cumplir sólo para
    `counter`, `dine_in` y `takeout` (`app/orders/service.py:673-680`).
    `delivery` y `platform` **no** se miran contra `store.active_channels`.

    Consecuencia concreta: una sede cuyo `active_channels` es
    `["counter", "dine_in", "takeout"]` —el default del alta de sede— acepta
    comandas de domicilio y de plataforma en cuanto alguien enciende la flag,
    sin haber activado el canal. Los dos interruptores que §9.3 y §1.2
    describen como distintos («funciones» y «canales activos») quedan
    colapsados en uno solo para los canales nuevos, y el administrador no
    tiene forma de apagar un canal sin apagar la función entera.

    **Remedio**: extender la guarda de `create_order` a `DELIVERY`/`PLATFORM`
    (y, si `active_channels` no debe gatear los canales nuevos, decirlo por
    escrito en la spec: hoy el código dice dos cosas distintas para la misma
    lista). **Dueño**: `backend-canales-comanda` (`app/orders/service.py`).

    ---

    **RONDA 3 — DECISIÓN DIFERIDA DEL MAESTRO. Este test QUEDA ROJO a
    propósito.** No se ablanda, no se acota y no se borra: es el marcador de
    una deuda aceptada, no un defecto que nadie vio.

    Razón de la diferición, tal como me la pasó el Maestro: gatear
    `delivery`/`platform` por `active_channels` **sin un backfill** dejaría a
    toda sede ya existente sin poder vender por domicilio el día del deploy
    —el default del alta es `["counter", "dine_in", "takeout"]`—, y la
    casilla que el administrador necesitaría para activarlos
    (`StoreFormDialog.tsx`) es territorio de otro pedido.

    **Deuda, con dueño y remedio, para que no se pierda**: `backend-canales-comanda`
    extiende la guarda de `create_order` a `DELIVERY`/`PLATFORM` **junto con**
    (a) una migración que agregue `delivery`/`platform` a `active_channels`
    de las sedes que ya tengan la función encendida, y (b) la casilla en
    `StoreFormDialog.tsx`. Mientras las tres no vayan juntas, el remedio
    parcial rompe sedes vivas. Cuando se haga, este test se pone verde solo.
    """
    open_shift()
    identify(device_client, employees["operator"])
    enable_2c()
    set_feature("pos.takeout", True)
    assert "delivery" not in (store.active_channels or []), "el test se armó mal"
    assert "platform" not in (store.active_channels or []), "el test se armó mal"

    # El canal que SÍ mira la lista, como control: `takeout` está activo.
    ok = create_order(device_client, channel="takeout", takeout={"customer_name": "X", "phone": "3"})
    assert ok.status_code in (200, 201), ok.text

    domicilio = _delivery_order(device_client, courier)
    plataforma = _platform_order(device_client, platform)
    colados = [
        f"delivery -> {domicilio.status_code}" if domicilio.status_code in (200, 201) else "",
        f"platform -> {plataforma.status_code}" if plataforma.status_code in (200, 201) else "",
    ]
    colados = [c for c in colados if c]
    assert not colados, (
        "la sede tiene `active_channels` = "
        f"{store.active_channels} y aun así acepta comandas de los canales nuevos: {colados}. "
        "`app/orders/service.py:673-680` sólo mira la lista para `counter`/`dine_in`/`takeout`; "
        "`delivery` y `platform` la esquivan (SPEC-NEGOCIO §9.3 pone «canales activos» en Configuración, "
        "distinto de la función habilitable de §1.2)"
    )


def test_a_delivery_order_never_publishes_a_courier_with_id_zero(
    device_client: Any,
    identify: Any,
    employees: dict[str, Any],
    enable_2c: Any,
    open_shift: Any,
    db: Any,
    store: Any,
    courier: Any,
    delivery_fee_product: Any,
    activate_channels: Any,
) -> None:
    """**HALLAZGO H-4 (ADVERTENCIA) — cero mudo.**
    `app/orders/service.py:457` serializa el domiciliario como
    `EmployeeRef(id=order.courier_employee_id or 0, name=... or "")`.

    `courier_employee_id` es una columna **nullable** (`0013_channels_orders`)
    y `create_order` la exige sólo en el alta; cualquier comanda de domicilio
    que llegue con la columna en `NULL` —una sede que vendía por domicilio
    antes de 2c, un `UPDATE` a mano, o el endpoint de reasignación que el
    propio constructor declaró como gap— se publica con **`courier.id = 0` y
    nombre vacío**: un empleado inexistente presentado como un dato real.

    `AGENTS.md`: «`null` no es 0». Lo correcto es `DeliveryOut.courier:
    EmployeeRef | None` (o no serializar el bloque), nunca un id 0.

    **RONDA 3 — CERRADO POR EL CÓDIGO.** `backend-canales-comanda` lo cerró
    por la vía correcta: `DeliveryOut.courier` es opcional y
    `app/orders/service.py:452-466` publica `None` cuando
    `courier_employee_id is None`, dejando el bloque `delivery` en pie con
    su dirección y su teléfono. El cuerpo de este test se reexpresó contra
    ese contrato (ver el comentario en el cuerpo): mide lo mismo con dos
    filos en vez de uno.
    **Dueño**: `backend-canales-comanda` (`app/orders/schemas.py`,
    `app/orders/service.py`).
    """
    from app.orders.models import Order

    open_shift()
    identify(device_client, employees["operator"])
    enable_2c()
    activate_channels("delivery", "platform")
    resp = _delivery_order(device_client, courier)
    assert resp.status_code in (200, 201), resp.text
    order_id = resp.json()["id"]

    fila = db.get(Order, order_id)
    fila.courier_employee_id = None
    fila.courier_employee_name = None
    db.commit()

    leida = get_order(device_client, order_id)
    entregado = leida.get("delivery")
    assert entregado is not None, "el bloque `delivery` desapareció: cambió el contrato"

    # RONDA 3 — REEXPRESADO, NO ABLANDADO. La forma de la ronda 2
    # (`entregado["courier"]["id"] != 0`) daba por hecho que `courier`
    # SIEMPRE viene; el remedio correcto —el que pedía el hallazgo— es que
    # venga `null`, así que aquella forma explota con `TypeError` en vez de
    # medir. El hecho exigido es el mismo y con dos filos, no uno:
    #
    #   (a) el bloque `delivery` NO desaparece (arriba, sin tocar): la
    #       dirección y el teléfono son datos de la comanda y no dependen
    #       de que haya domiciliario asignado;
    #   (b) `courier` dice "no hay" —`null`— o es un empleado REAL; lo que
    #       no puede ser nunca es el empleado 0 con nombre vacío.
    #
    # Y se agrega un filo que la ronda 2 no tenía: que la dirección siga
    # publicándose, para que "arreglarlo" borrando el bloque entero no pase.
    assert entregado.get("address"), (
        f"el bloque `delivery` quedó sin dirección: {entregado}. Poner el domiciliario en `null` no "
        "puede haberse llevado puesto el resto del bloque"
    )
    courier = entregado["courier"]
    assert courier is None or (courier.get("id") not in (0, None) and courier.get("name")), (
        "la comanda publica un domiciliario que no existe: "
        f"{courier}. `app/orders/service.py:457` convertía el `null` en `id: 0` y nombre "
        'vacío. `null` no es 0 (AGENTS.md): el contrato tiene que decir "no hay domiciliario" '
        "(`courier: null`), no inventar el empleado 0"
    )


def test_the_platform_of_a_payment_is_resolved_with_is_not_none_and_never_with_or(db: Any) -> None:
    """**HALLAZGO H-5 (ADVERTENCIA).** `app/payments/service.py:421` resuelve
    la plataforma del cobro con

        candidate = getattr(order, "platform_id", None) or getattr(payload, "platform_id", None)

    `or` trata el `0` como ausencia. Hoy no rompe (los ids nacen en 1), pero
    es literalmente el patrón que la regla dura prohíbe —`null` ≠ 0— en el
    lugar donde se decide QUÉ plataforma cobró una venta, y el mismo que
    produjo B-2 en 2a. Lo correcto es
    `candidato = a if a is not None else b`.
    **Dueño**: `backend-dinero-canales`.
    """
    import ast

    from tests.audit.conftest import app_source_files

    _, arbol = next((r, a) for r, a in app_source_files() if r == "app/payments/service.py")
    funcion = next(
        n for n in ast.walk(arbol) if isinstance(n, ast.FunctionDef) and n.name == "_resolve_channels"
    )
    ors = [
        n
        for n in ast.walk(funcion)
        if isinstance(n, ast.BoolOp) and isinstance(n.op, ast.Or) and "platform_id" in ast.dump(n)
    ]
    assert not ors, (
        "la plataforma del cobro se resuelve con `or`, que trata el `0` como ausencia "
        f"(app/payments/service.py:{ors[0].lineno}). `null` no es 0: usá `is not None`"
    )


def test_no_business_invariant_of_2c_is_defended_with_a_bare_assert(db: Any) -> None:
    """**HALLAZGO H-6 (ADVERTENCIA).** `app/channels/service.py:736` defiende
    con un `assert` pelado el invariante más caro del pedido —que cancelar
    una venta de plataforma no reponga inventario—:

        assert not returned_ids, "una cancelación de plataforma revirtió consumo..."

    Un `assert` **desaparece con `python -O`**, que es exactamente como se
    corre un proceso de producción afinado; y si se cumple, sale como
    `AssertionError` → `500`, no como la forma de error del proyecto. El
    invariante es bueno; el mecanismo, no. Lo correcto es levantar un
    `AppError` tipado (o revertir la transacción con un error nombrado).
    **Dueño**: `backend-dinero-canales`.
    """
    import ast

    from tests.audit.conftest import app_source_files

    hallazgos: list[str] = []
    for ruta in ("app/channels/service.py", "app/kitchen/service.py"):
        entrada = next(((r, a) for r, a in app_source_files() if r == ruta), None)
        if entrada is None:
            continue
        _, arbol = entrada
        for nodo in ast.walk(arbol):
            if isinstance(nodo, ast.Assert):
                hallazgos.append(f"{ruta}:{nodo.lineno}")
    assert not hallazgos, (
        "un invariante de negocio de 2c se defiende con un `assert` pelado, que desaparece con "
        f"`python -O` y sale como `500` si se cumple: {hallazgos}"
    )
