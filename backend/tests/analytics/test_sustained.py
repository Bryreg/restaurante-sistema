"""`GET /admin/control-health/sustained` — D-1 (`features/fase-3-dinero-
control/spec.md § 1`, decisión ya tomada, no se renegocia acá).

D-1, textual: "la brecha está sostenida en rojo cuando supera el umbral rojo
en al menos 2 de las últimas 3 ventanas de food cost real disponibles [...]
Con menos de 2 ventanas computables, el indicador es `null` con motivo,
nunca verde." Tests obligatorios de la misión: 0, 1, 2 y 3 ventanas."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Callable

from fastapi.testclient import TestClient

from app.auth.models import Employee
from app.stores.models import Store


def test_sustained_with_zero_or_one_applied_counts_is_null_with_a_reason(
    admin_client: TestClient, store: Store, enable_analytics: Callable[[], None], create_ingredient: Callable[..., dict[str, Any]]
) -> None:
    enable_analytics()
    resp = admin_client.get("/api/v1/admin/control-health/sustained", params={"store_id": store.id})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["sustained_red"] is None
    assert body["windows_evaluated"] == 0
    assert body["reason"]

    create_ingredient(name="Sólo un conteo")
    opened = admin_client.post(f"/api/v1/admin/counts?store_id={store.id}", json={"scope": "full"})
    assert opened.status_code == 201, opened.text
    applied = admin_client.post(
        f"/api/v1/admin/counts/{opened.json()['id']}/apply?store_id={store.id}",
        json={"authorizer_pin": "9999"},
        headers={"Idempotency-Key": "sustained-1"},
    )
    assert applied.status_code == 200, applied.text

    resp = admin_client.get("/api/v1/admin/control-health/sustained", params={"store_id": store.id})
    body = resp.json()
    assert body["sustained_red"] is None, "un solo conteo aplicado no arma ninguna ventana"
    assert body["windows_evaluated"] == 0
    assert body["reason"]


def _noon_utc(step: int, *, base: datetime) -> datetime:
    """Paso `step` de la escena, a las 12:00 hora de Bogotá (17:00 UTC,
    Bogotá es UTC-5 todo el año): lejos de cualquier `cutoff_hour` de sede
    (por defecto 06:00) para que `business_date` sea siempre el mismo día
    calendario, sin ambigüedad de madrugada.

    Los conteos caen en los pasos pares y las ventas en los impares; cada
    par de pasos son TRES días (`3 * step // 2`: 0, 1, 3, 4, 6, 7, 9), para
    que cada ventana entre conteos dure 72 h, holgadamente sobre la mínima
    que exige el food cost real (`app.inventory.hooks.FOOD_COST_MIN_WINDOW_HOURS`)."""
    return base + timedelta(days=3 * step // 2, hours=17)


def test_sustained_two_of_three_windows_over_threshold_is_red(
    db: Any,
    admin_client: TestClient,
    device_client: TestClient,
    identify: Any,
    store: Store,
    employees: dict[str, Employee],
    clock: Any,
    open_shift: Any,
    enable_analytics: Callable[[], None],
    create_ingredient: Callable[..., dict[str, Any]],
    apply_full_count: Callable[..., dict[str, Any]],
    main_product: Any,
    set_recipe: Callable[..., Any],
    sell: Callable[..., Any],
) -> None:
    """Insumo a $1/g. Ficha: 10 g del insumo por plato ($10 de costo
    teórico por plato). Cada ventana vende exactamente UN plato (mismo
    costo teórico congelado: $10), y el conteo de cierre decide si el costo
    REAL de esa ventana coincide con lo vendido (verde) o si además
    desaparecieron ~2.000 g sin que ningún movimiento lo explique (roja: a
    ~$1/g, eso son ~$2.000 de food cost real que ninguna venta ni compra
    respalda, sobre una venta neta de un solo plato — muy por encima del
    umbral rojo por defecto de 400 bp)."""
    enable_analytics()
    ing = create_ingredient(name="Insumo ventana", official_cost="1", min_stock="1")  # $1/g
    set_recipe(main_product.id, lines=[{"ingredient_id": ing["id"], "qty": "10", "unit": "g"}])

    base = datetime(2026, 3, 1, tzinfo=timezone.utc)
    open_shift()

    def _sell_one() -> None:
        identify(device_client, employees["cashier"])
        sell(main_product, qty=1)

    # Conteo 0: 20.000 g iniciales — de sobra para las tres ventanas.
    clock.set(_noon_utc(0, base=base))
    apply_full_count({ing["id"]: "20000"})

    # Ventana 1 (más vieja, roja): 1 plato vendido (10 g teóricos) + 2.000 g
    # que se esfuman sin explicación.
    clock.set(_noon_utc(1, base=base))
    _sell_one()
    clock.set(_noon_utc(2, base=base))
    apply_full_count({ing["id"]: "17990"})  # 20000 - 10 (venta) - 2000 (fuga) = 17990

    # Ventana 2 (verde): 1 plato vendido, el conteo cuadra EXACTO con la
    # ficha — sin fuga.
    clock.set(_noon_utc(3, base=base))
    _sell_one()
    clock.set(_noon_utc(4, base=base))
    apply_full_count({ing["id"]: "17980"})  # 17990 - 10 = 17980, cuadra

    # Ventana 3 (más reciente, roja): otra vez 1 plato + 2.000 g de fuga.
    clock.set(_noon_utc(5, base=base))
    _sell_one()
    clock.set(_noon_utc(6, base=base))
    apply_full_count({ing["id"]: "15970"})  # 17980 - 10 - 2000 = 15970

    resp = admin_client.get("/api/v1/admin/control-health/sustained", params={"store_id": store.id})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["windows_evaluated"] == 3, body
    assert body["reason"] is None
    assert body["sustained_red"] is True, body
    exceed_flags = [w["exceeds_red"] for w in body["windows"]]
    assert exceed_flags.count(True) == 2, body
    # La más reciente es `window_index == 1` (ventana 3, roja).
    assert body["windows"][0]["exceeds_red"] is True
    # Números fijados (informe #4/#15): un plato de $25.000 con INC 8 % son
    # $23.148 netos. Ventana roja: real (10 + 2.000) ÷ 23.148 → 868 bp,
    # teórico 10 ÷ 23.148 → 4 bp, brecha 864. Ventana verde: 4 − 4 = 0.
    assert [w["gap_bp"] for w in body["windows"]] == [864, 0, 864]
    assert [w["real_pct_bp"] for w in body["windows"]] == [868, 4, 868]
    for w in body["windows"]:
        assert (w["window_days"], w["window_hours"]) == (3, 72)
        assert w["orders_in_window"] == 1
        assert w["costed_pct_bp"] == 10000
    assert body["windows_skipped"] == 0
    assert (body["min_window_days"], body["min_costed_pct_bp"]) == (1, 8000)


def test_sustained_two_windows_one_over_threshold_is_not_red(
    db: Any,
    admin_client: TestClient,
    device_client: TestClient,
    identify: Any,
    store: Store,
    employees: dict[str, Employee],
    clock: Any,
    open_shift: Any,
    enable_analytics: Callable[[], None],
    create_ingredient: Callable[..., dict[str, Any]],
    apply_full_count: Callable[..., dict[str, Any]],
    main_product: Any,
    set_recipe: Callable[..., Any],
    sell: Callable[..., Any],
) -> None:
    """Dos ventanas computables (tres conteos), sólo UNA supera el umbral:
    2 de 3 no se alcanza (ni siquiera 2 de 2 alcanza 2 hits, faltando uno) —
    `sustained_red` tiene que quedar en `False`, nunca `None` (SÍ hay
    historial suficiente: 2 ventanas computables, el mínimo que exige D-1)."""
    enable_analytics()
    ing = create_ingredient(name="Insumo ventana 2", official_cost="1", min_stock="1")
    set_recipe(main_product.id, lines=[{"ingredient_id": ing["id"], "qty": "10", "unit": "g"}])

    base = datetime(2026, 4, 1, tzinfo=timezone.utc)
    open_shift()

    def _sell_one() -> None:
        identify(device_client, employees["cashier"])
        sell(main_product, qty=1)

    clock.set(_noon_utc(0, base=base))
    apply_full_count({ing["id"]: "20000"})

    # Ventana 1: verde (cuadra exacto).
    clock.set(_noon_utc(1, base=base))
    _sell_one()
    clock.set(_noon_utc(2, base=base))
    apply_full_count({ing["id"]: "19990"})  # 20000 - 10

    # Ventana 2: roja (fuga de 2.000 g).
    clock.set(_noon_utc(3, base=base))
    _sell_one()
    clock.set(_noon_utc(4, base=base))
    apply_full_count({ing["id"]: "17980"})  # 19990 - 10 - 2000

    resp = admin_client.get("/api/v1/admin/control-health/sustained", params={"store_id": store.id})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["windows_evaluated"] == 2, body
    assert body["reason"] is None
    assert body["sustained_red"] is False, body


def test_variance_level_semaphore_is_untouched_by_this_territory(db: Any) -> None:
    """Guardrail explícito de la misión: `app.inventory.service._variance_level`
    sigue existiendo, exportado con la MISMA firma, y este territorio nunca
    lo importa ni lo reimplementa (`app.analytics` no tiene ningún símbolo
    llamado `_variance_level` ni `variance_level`)."""
    import inspect

    from app.inventory import service as inventory_service

    assert hasattr(inventory_service, "_variance_level")
    sig = inspect.signature(inventory_service._variance_level)
    assert list(sig.parameters) == ["pct_bp", "theoretical", "variance_qty", "settings"]

    import app.analytics.service as analytics_service

    assert not hasattr(analytics_service, "_variance_level")
    # El docstring del módulo SÍ nombra `_variance_level` en prosa (explica
    # por qué no se toca); lo que no puede aparecer es una DEFINICIÓN o un
    # LLAMADO.
    source = inspect.getsource(analytics_service)
    assert "def _variance_level" not in source
    assert "_variance_level(" not in source
    assert "inventory_service" not in source, "este territorio no importa app.inventory.service"


def test_sustained_skips_windows_shorter_than_a_day(
    db: Any,
    admin_client: TestClient,
    device_client: TestClient,
    identify: Any,
    store: Store,
    employees: dict[str, Employee],
    clock: Any,
    open_shift: Any,
    enable_analytics: Callable[[], None],
    create_ingredient: Callable[..., dict[str, Any]],
    apply_full_count: Callable[..., dict[str, Any]],
    main_product: Any,
    set_recipe: Callable[..., Any],
    sell: Callable[..., Any],
) -> None:
    """Tres conteos a 16 h uno del otro, con fuga en las dos ventanas: antes
    daban «sostenido en rojo»; con ventanas de horas el food cost real es
    ruido (informe #3), así que no cuentan — `null` con motivo, nunca rojo
    ni verde."""
    enable_analytics()
    ing = create_ingredient(name="Insumo ventana corta", official_cost="1", min_stock="1")
    set_recipe(main_product.id, lines=[{"ingredient_id": ing["id"], "qty": "10", "unit": "g"}])
    base = datetime(2026, 5, 1, 17, tzinfo=timezone.utc)
    open_shift()

    clock.set(base)
    apply_full_count({ing["id"]: "20000"})
    clock.set(base + timedelta(hours=8))
    identify(device_client, employees["cashier"])
    sell(main_product, qty=1)
    clock.set(base + timedelta(hours=16))
    apply_full_count({ing["id"]: "17990"})
    clock.set(base + timedelta(hours=24))
    identify(device_client, employees["cashier"])
    sell(main_product, qty=1)
    clock.set(base + timedelta(hours=32))
    apply_full_count({ing["id"]: "15980"})

    body = admin_client.get("/api/v1/admin/control-health/sustained", params={"store_id": store.id}).json()
    assert body["sustained_red"] is None, body
    assert body["windows_evaluated"] == 0
    assert body["windows_skipped"] == 2
    assert "24 h" in body["reason"]
