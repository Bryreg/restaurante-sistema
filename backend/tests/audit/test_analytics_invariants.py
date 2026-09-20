"""Invariantes ejecutables de INGENIERÍA DE MENÚ, VARIANZA POR PLATO,
REPOSICIÓN SUGERIDA y «SOSTENIDO» (fase 3, T4 `backend-analitica`).

Cada test de este archivo es un renglón del checklist de
`features/fase-3-dinero-control/spec.md § 4` convertido en enunciado
ejecutable: costo congelado (nunca revalorado), `null` con motivo sin datos
suficientes, `method: "prorated"` explícito, «sostenido» exactamente según
D-1, `_variance_level` intacto, el operador sigue sin ver costos ni
márgenes, y ninguna función nueva se cuela sin su flag ni antes que su
dependencia.

Reusa las fixtures y helpers compartidos de `tests/audit/conftest.py`
(`open_shift`, `expected_of`, `make_ingredient`, `sales_products`,
`put_recipe`, `send`, `pay`, `open_count`, `save_count_lines`, `apply_count`,
`admin_only_paths`, `device_reachable_paths`, `iter_api_routes`) — no
redefine ninguna."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any
from uuid import uuid4

import pytest

from tests.audit.conftest import (
    NO_TIP,
    admin_only_paths,
    apply_count,
    create_order,
    add_items,
    idem_headers,
    make_ingredient,
    open_count,
    pay,
    put_recipe,
    sales_products,
    save_count_lines,
)

API = "/api/v1"


def _idem() -> dict[str, str]:
    return {"Idempotency-Key": str(uuid4())}


def _enable(set_feature: Any, store_id: int | None = None) -> None:
    for key in (
        "catalog.recipes", "inventory.perpetual", "inventory.counts", "inventory.variance",
        "purchases", "analytics.menu_engineering", "inventory.replenishment",
    ):
        set_feature(key, True, store_id=store_id)


# ---------------------------------------------------------------------------
# (1) La plata cierra: nada de esta fase mueve el esperado del turno (es
# territorio de sólo lectura, pero es barato confirmarlo — GET nunca escribe).
# ---------------------------------------------------------------------------


def test_analytics_reads_never_move_the_expected_cash(
    admin_client: Any, store: Any, open_shift: Any, expected_of: Any, set_feature: Any
) -> None:
    _enable(set_feature)
    turno = open_shift()
    esperado_antes = expected_of(turno["id"])

    admin_client.get(f"{API}/admin/menu-engineering", params={"store_id": store.id, "from": "2020-01-01", "to": "2099-12-31"})
    admin_client.get(f"{API}/admin/control-health/sustained", params={"store_id": store.id})
    admin_client.get(f"{API}/admin/replenishment", params={"store_id": store.id})

    assert expected_of(turno["id"]) == esperado_antes, (
        "una lectura de analytics movió el esperado del turno: no puede, es sólo lectura"
    )


# ---------------------------------------------------------------------------
# (2) Nadie escribió una segunda matemática: `_variance_level` intacto.
# ---------------------------------------------------------------------------


def test_variance_level_semaphore_keeps_its_published_contract(
    admin_client: Any, store: Any, set_feature: Any
) -> None:
    """`GET /admin/variance?count_id=` (el semáforo POR RENGLÓN de un
    conteo, `_variance_level`) sigue respondiendo `level` en
    {green, yellow, red} tal cual lo publica `app.inventory` — D-1 es un
    indicador NUEVO Y APARTE (`GET /admin/control-health/sustained`), nunca
    un reemplazo ni una segunda versión de éste."""
    _enable(set_feature)
    ing = make_ingredient(admin_client, store, name="Semáforo intacto", official_cost="1")
    count1 = open_count(admin_client, store, scope="full")
    save_count_lines(admin_client, store, count1["id"], [{"ingredient_id": ing["id"], "qty_counted": "100", "was_counted": True}])
    apply_count(admin_client, store, count1["id"])
    count2 = open_count(admin_client, store, scope="full")
    save_count_lines(admin_client, store, count2["id"], [{"ingredient_id": ing["id"], "qty_counted": "60", "was_counted": True}])
    apply_count(admin_client, store, count2["id"])

    resp = admin_client.get(f"{API}/admin/variance", params={"store_id": store.id, "count_id": count2["id"]})
    assert resp.status_code == 200, resp.text
    row = next(r for r in resp.json()["rows"] if r["ingredient_id"] == ing["id"])
    assert row["level"] in ("green", "yellow", "red")
    assert row["level"] == "red"  # 40 g de faltante sin ninguna venta que lo explique


def test_analytics_module_never_imports_or_redefines_variance_level() -> None:
    import inspect

    import app.analytics.service as analytics_service

    source = inspect.getsource(analytics_service)
    assert "def _variance_level" not in source
    assert "_variance_level(" not in source
    assert "import app.inventory.service" not in source
    assert "from app.inventory import service" not in source
    assert "from app.inventory.service import" not in source


# ---------------------------------------------------------------------------
# (3) `null` con motivo en todo indicador sin datos suficientes.
# ---------------------------------------------------------------------------


def test_menu_engineering_and_sustained_are_null_with_reason_without_enough_data(
    admin_client: Any, store: Any, set_feature: Any
) -> None:
    _enable(set_feature)

    menu = admin_client.get(
        f"{API}/admin/menu-engineering", params={"store_id": store.id, "from": "2020-01-01", "to": "2099-12-31"}
    )
    assert menu.status_code == 200, menu.text
    body = menu.json()
    assert body["available"] is False
    assert body["reason"]
    assert body["rows"] == []

    sustained = admin_client.get(f"{API}/admin/control-health/sustained", params={"store_id": store.id})
    assert sustained.status_code == 200, sustained.text
    body = sustained.json()
    assert body["sustained_red"] is None, "nunca verde/False por defecto sin historial suficiente"
    assert body["reason"]
    assert body["windows_evaluated"] == 0


def test_replenishment_is_never_a_silent_zero_for_missing_lead_time(
    admin_client: Any, store: Any, set_feature: Any
) -> None:
    _enable(set_feature)
    ing = make_ingredient(admin_client, store, name="Sin lead time", lead_time_days=None)
    resp = admin_client.get(f"{API}/admin/replenishment", params={"store_id": store.id})
    assert resp.status_code == 200, resp.text
    row = next(r for r in resp.json()["rows"] if r["ingredient_id"] == ing["id"])
    assert row["suggested_min"] is None
    assert row["reason"], "sin lead_time_days el mínimo propuesto tiene que ser null CON motivo, nunca 0 mudo"


# ---------------------------------------------------------------------------
# (4) Ningún `float` en ningún campo nuevo.
# ---------------------------------------------------------------------------


def _walk_for_float(value: Any, path: str, offenders: list[str]) -> None:
    if isinstance(value, bool):
        return
    if isinstance(value, float):
        offenders.append(path)
    elif isinstance(value, dict):
        for k, v in value.items():
            _walk_for_float(v, f"{path}.{k}", offenders)
    elif isinstance(value, list):
        for i, v in enumerate(value):
            _walk_for_float(v, f"{path}[{i}]", offenders)


def test_no_float_in_any_analytics_response(
    admin_client: Any,
    device_client: Any,
    identify: Any,
    employees: Any,
    open_shift: Any,
    store: Any,
    set_feature: Any,
    sales_products: Any,
) -> None:
    _enable(set_feature)
    ingredient = make_ingredient(admin_client, store, name="Insumo float", official_cost="3.5")
    product = sales_products["inc8"]
    put_recipe(admin_client, product.id, [{"ingredient_id": ingredient["id"], "qty": "12.5", "unit": "g"}])

    open_shift()
    identify(device_client, employees["cashier"])
    order = create_order(device_client).json()
    order = add_items(device_client, order, [{"product_id": product.id, "qty": 2}]).json()
    total = order["totals"]["total"]
    pay(device_client, order["id"], splits=[{"method": "cash", "amount": total, "tendered": total}], tip=NO_TIP)

    count1 = open_count(admin_client, store, scope="full")
    save_count_lines(admin_client, store, count1["id"], [{"ingredient_id": ingredient["id"], "qty_counted": "100", "was_counted": True}])
    apply_count(admin_client, store, count1["id"])
    count2 = open_count(admin_client, store, scope="full")
    save_count_lines(admin_client, store, count2["id"], [{"ingredient_id": ingredient["id"], "qty_counted": "95", "was_counted": True}])
    apply_count(admin_client, store, count2["id"])

    responses = [
        admin_client.get(f"{API}/admin/menu-engineering", params={"store_id": store.id, "from": "2020-01-01", "to": "2099-12-31"}),
        admin_client.get(f"{API}/admin/variance/by-dish", params={"store_id": store.id, "count_id": count2["id"]}),
        admin_client.get(f"{API}/admin/control-health/sustained", params={"store_id": store.id}),
        admin_client.get(f"{API}/admin/replenishment", params={"store_id": store.id}),
    ]
    offenders: list[str] = []
    for resp in responses:
        assert resp.status_code == 200, resp.text
        _walk_for_float(resp.json(), resp.request.url.path, offenders)
    assert not offenders, f"respuesta de analytics con un float JSON: {offenders}"


# ---------------------------------------------------------------------------
# (5) El operador no ve costos ni márgenes: ninguna ruta de este dominio es
# alcanzable desde una sesión de dispositivo.
# ---------------------------------------------------------------------------


ANALYTICS_PATHS = (
    "/api/v1/admin/menu-engineering",
    "/api/v1/admin/variance/by-dish",
    "/api/v1/admin/control-health/sustained",
    "/api/v1/admin/replenishment",
)


def test_every_analytics_route_requires_current_admin() -> None:
    admin_only = admin_only_paths()
    missing = [p for p in ANALYTICS_PATHS if p not in admin_only]
    assert not missing, (
        f"rutas de analytics sin `current_admin` (alcanzables por el operador, "
        f"costos y márgenes filtrados): {missing}"
    )


def test_no_analytics_route_is_reachable_under_a_device_session(device_client: Any, store: Any) -> None:
    rutas = [
        ("get", f"{API}/admin/menu-engineering?store_id={store.id}&from=2026-01-01&to=2026-01-31"),
        ("get", f"{API}/admin/variance/by-dish?store_id={store.id}&count_id=1"),
        ("get", f"{API}/admin/control-health/sustained?store_id={store.id}"),
        ("get", f"{API}/admin/replenishment?store_id={store.id}"),
    ]
    alcanzables: list[str] = []
    for metodo, ruta in rutas:
        resp = getattr(device_client, metodo)(ruta)
        if resp.status_code not in (401, 403, 404):
            alcanzables.append(f"{metodo.upper()} {ruta} -> {resp.status_code} {resp.text[:160]}")
    assert not alcanzables, (
        "una sesión de dispositivo alcanza rutas de ingeniería de menú/varianza/reposición "
        "(BLOQUEANTE, regla dura AGENTS.md \"el operador no ve costos ni márgenes\"):\n"
        + "\n".join(alcanzables)
    )


# ---------------------------------------------------------------------------
# (6) Toda capacidad detrás de su función, y la dependencia se valida ANTES
# que el gate de sede (error repetido nº6 de `AGENTS.md §14`).
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "ruta,flag",
    [
        ("/admin/menu-engineering?from=2026-01-01&to=2026-01-31", "analytics.menu_engineering"),
        ("/admin/control-health/sustained", "inventory.variance"),
        ("/admin/replenishment", "inventory.replenishment"),
    ],
)
def test_each_analytics_capability_answers_400_feature_disabled_when_its_flag_is_off(
    admin_client: Any, store: Any, set_feature: Any, ruta: str, flag: str
) -> None:
    _enable(set_feature)
    encendida = admin_client.get(f"{API}{ruta}{'&' if '?' in ruta else '?'}store_id={store.id}")
    assert encendida.status_code != 400 or encendida.json().get("error", {}).get("code") != "FEATURE_DISABLED"

    set_feature(flag, False)
    apagada = admin_client.get(f"{API}{ruta}{'&' if '?' in ruta else '?'}store_id={store.id}")
    assert apagada.status_code == 400, f"{ruta} con {flag} apagada devolvió {apagada.status_code}: {apagada.text[:200]}"
    assert apagada.json()["error"]["code"] == "FEATURE_DISABLED"


def test_menu_engineering_dependency_checked_before_store_gate(
    admin_client: Any, store_b: Any, set_feature: Any
) -> None:
    """`catalog.recipes` (la dependencia de `analytics.menu_engineering`) se
    valida ANTES que el gate de sede: con `catalog.recipes` apagada y una
    sede AJENA (`store_b`, de otra organización), la respuesta tiene que
    seguir siendo `FEATURE_DISABLED`, nunca `404`."""
    set_feature("catalog.recipes", False)
    set_feature("analytics.menu_engineering", True)
    resp = admin_client.get(
        f"{API}/admin/menu-engineering", params={"store_id": store_b.id, "from": "2026-01-01", "to": "2026-01-31"}
    )
    assert resp.status_code == 400, resp.text
    body = resp.json()
    assert body["error"]["code"] == "FEATURE_DISABLED"
    assert body["error"]["feature"] == "catalog.recipes"


def test_replenishment_dependencies_checked_before_store_gate(
    admin_client: Any, store_b: Any, set_feature: Any
) -> None:
    """`inventory.replenishment` requiere `inventory.perpetual` **y**
    `purchases`: cualquiera de las dos apagada corta antes que el gate de
    sede."""
    set_feature("inventory.perpetual", True)
    set_feature("purchases", False)
    set_feature("inventory.replenishment", True)
    resp = admin_client.get(f"{API}/admin/replenishment", params={"store_id": store_b.id})
    assert resp.status_code == 400, resp.text
    body = resp.json()
    assert body["error"]["code"] == "FEATURE_DISABLED"
    assert body["error"]["feature"] == "purchases"


# ---------------------------------------------------------------------------
# (7) La varianza por plato se declara SIEMPRE prorrateada.
# ---------------------------------------------------------------------------


def test_variance_by_dish_always_declares_the_prorated_method(
    admin_client: Any, store: Any, set_feature: Any
) -> None:
    """SPEC-NEGOCIO §5.4: "varianza «por plato» sólo como estimación
    prorrateada" — el campo está presente y vale `"prorated"` incluso
    cuando la respuesta no está `available` (sin ventana anterior)."""
    _enable(set_feature)
    ing = make_ingredient(admin_client, store, name="Sin ventana previa")
    count = open_count(admin_client, store, scope="full")
    save_count_lines(admin_client, store, count["id"], [{"ingredient_id": ing["id"], "qty_counted": "10", "was_counted": True}])
    apply_count(admin_client, store, count["id"])

    resp = admin_client.get(f"{API}/admin/variance/by-dish", params={"store_id": store.id, "count_id": count["id"]})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["method"] == "prorated"
    assert body["available"] is False
