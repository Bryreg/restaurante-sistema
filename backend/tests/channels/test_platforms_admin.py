"""Plataformas y comisiones en Configuración (§9.3), y los flags.

Renglones del checklist:
- «Con `pos.delivery`, `pos.platforms`, `pos.courses` y `kitchen.kds`
  apagadas, ... las rutas nuevas responden `400 FEATURE_DISABLED` (test con
  cada flag en los dos estados)».
- «Sin `float` en comisiones ni en precios por canal».
- «Zona horaria: un pedido de plataforma cargado a las 00:30 queda sellado
  con el día del turno».
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.channels.models import DeliveryPlatform, PlatformReceivable
from app.stores import service as stores_service
from tests.channels.conftest import idem


def test_platform_crud_stores_commission_in_integer_basis_points(
    admin_client: Any, store: Any, set_feature: Any, db: Session
) -> None:
    set_feature("pos.platforms", True)
    resp = admin_client.post(
        f"/api/v1/admin/platforms?store_id={store.id}",
        json={"name": "Didi Food", "code": "didi", "commission_bp": 2_250},
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["commission_bp"] == 2_250
    assert isinstance(body["commission_bp"], int)
    assert "commission_pct" not in body, "el porcentaje no se publica en coma flotante"

    row = db.get(DeliveryPlatform, body["id"])
    assert row is not None
    assert row.commission_bp == 2_250


def test_a_commission_over_one_hundred_percent_is_rejected(
    admin_client: Any, store: Any, set_feature: Any
) -> None:
    """El error de tecleo clásico: 18 % escrito como `180000`."""
    set_feature("pos.platforms", True)
    resp = admin_client.post(
        f"/api/v1/admin/platforms?store_id={store.id}",
        json={"name": "Mala", "code": "mala", "commission_bp": 180_000},
    )
    # El repo normaliza el error de validación a `400` con forma
    # `{error:{code,message}}` — nunca un `422` crudo de FastAPI.
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "VALIDATION_ERROR"


def test_a_platform_is_deactivated_never_deleted(
    admin_client: Any, store: Any, set_feature: Any, platform: Any, db: Session
) -> None:
    set_feature("pos.platforms", True)
    resp = admin_client.delete(f"/api/v1/admin/platforms/{platform.id}?store_id={store.id}")
    assert resp.status_code == 200, resp.text
    assert resp.json()["active"] is False

    db.expire_all()
    row = db.get(DeliveryPlatform, platform.id)
    assert row is not None, "la plataforma se borró; nada financiero se borra"
    assert row.active is False

    # Y deja de resolver por el CONTRATO C2 (quien llama rechaza con 400).
    from app.channels import hooks

    assert hooks.get_platform(db, store_id=store.id, platform_id=platform.id) is None


def test_creating_a_platform_makes_the_platform_payment_method_configurable(
    admin_client: Any, store: Any, set_feature: Any, db: Session
) -> None:
    """`platform` pasa a ser un medio de pago **de verdad** en la
    configuración de la sede, validado como cualquier otro. No es una rama
    especial escrita a mano en el cobro."""
    set_feature("pos.platforms", True)
    before = stores_service.get_sales_settings(db, store.id)
    assert not any(m["code"] == "platform" for m in before.payment_methods)

    resp = admin_client.post(
        f"/api/v1/admin/platforms?store_id={store.id}",
        json={"name": "iFood", "code": "ifood", "commission_bp": 1_500},
    )
    assert resp.status_code == 201, resp.text
    db.expire_all()

    after = stores_service.get_sales_settings(db, store.id)
    method = next(m for m in after.payment_methods if m["code"] == "platform")
    assert method["enabled"] is True
    assert method["label"]
    assert method["dian_code"]

    # Y el POS lo ve en la lista de medios habilitados de la sede.
    methods = admin_client.get(f"/api/v1/admin/platforms?store_id={store.id}")
    assert methods.status_code == 200


def test_adding_the_platform_method_is_idempotent(
    admin_client: Any, store: Any, set_feature: Any, db: Session
) -> None:
    set_feature("pos.platforms", True)
    for code in ("uno", "dos"):
        resp = admin_client.post(
            f"/api/v1/admin/platforms?store_id={store.id}",
            json={"name": code, "code": code, "commission_bp": 100},
        )
        assert resp.status_code == 201, resp.text
    db.expire_all()
    settings = stores_service.get_sales_settings(db, store.id)
    assert sum(1 for m in settings.payment_methods if m["code"] == "platform") == 1


def test_every_new_route_is_behind_its_flag_in_both_states(
    admin_client: Any,
    device_client: Any,
    store: Any,
    set_feature: Any,
    platform: Any,
    identify: Any,
    employees: dict,
) -> None:
    """Cada ruta nueva, con su flag **apagada y encendida**."""
    # `require_feature` resuelve la sede desde `current_actor`, que para un
    # dispositivo exige persona identificada: sin esto el `401` taparía al
    # `400 FEATURE_DISABLED` que este test mide.
    identify(device_client, employees["cashier"])
    platform_routes = [
        ("get", f"/api/v1/admin/platforms?store_id={store.id}", None),
        (
            "post",
            f"/api/v1/admin/platforms?store_id={store.id}",
            {"name": "X", "code": "x", "commission_bp": 100},
        ),
        (
            "get",
            f"/api/v1/admin/platform-commissions?store_id={store.id}&from=2020-01-01&to=2099-12-31",
            None,
        ),
        (
            "get",
            f"/api/v1/admin/platform-receivables?store_id={store.id}&from=2020-01-01&to=2099-12-31",
            None,
        ),
    ]

    set_feature("pos.platforms", False)
    for method, url, payload in platform_routes:
        resp = getattr(admin_client, method)(url, **({"json": payload} if payload else {}))
        assert resp.status_code == 400, f"{method} {url} -> {resp.status_code}"
        assert resp.json()["error"]["code"] == "FEATURE_DISABLED"

    # La ruta de dispositivo, apagada.
    resp = device_client.get("/api/v1/device/platforms")
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "FEATURE_DISABLED"

    set_feature("pos.platforms", True)
    for method, url, payload in platform_routes:
        resp = getattr(admin_client, method)(url, **({"json": payload} if payload else {}))
        assert resp.status_code in (200, 201), f"{method} {url} -> {resp.status_code}: {resp.text}"
    assert device_client.get("/api/v1/device/platforms").status_code == 200


def test_delivery_routes_are_behind_pos_delivery_in_both_states(
    device_client: Any,
    admin_client: Any,
    store: Any,
    set_feature: Any,
    employees: dict,
    identify: Any,
) -> None:
    identify(device_client, employees["cashier"])
    set_feature("pos.takeout", True)
    set_feature("pos.delivery", False)
    assert device_client.get("/api/v1/delivery-settlements/pending").status_code == 400
    assert (
        device_client.get("/api/v1/delivery-settlements/pending").json()["error"]["code"]
        == "FEATURE_DISABLED"
    )
    assert admin_client.get(f"/api/v1/admin/delivery-settlements?store_id={store.id}").status_code == 400

    set_feature("pos.delivery", True)
    assert device_client.get("/api/v1/delivery-settlements/pending").status_code == 200
    assert admin_client.get(f"/api/v1/admin/delivery-settlements?store_id={store.id}").status_code == 200


def test_the_device_platform_list_never_shows_the_commission(
    device_client: Any, set_feature: Any, platform: Any, identify: Any, employees: dict
) -> None:
    """Superficie de dispositivo: el operador no recibe plata del negocio."""
    identify(device_client, employees["cashier"])
    set_feature("pos.platforms", True)
    resp = device_client.get("/api/v1/device/platforms")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body
    for row in body:
        assert "commission_bp" not in row
        assert "commission" not in str(row).lower()


def test_a_platform_sale_at_00_30_is_sealed_with_the_business_day_of_the_shift(
    platform_order: Any, pay: Any, clock: Any, store: Any, db: Session
) -> None:
    """Renglón del checklist: un pedido de plataforma cargado a las 00:30
    queda sellado con el día del TURNO, no con la fecha del calendario ni
    con la del navegador.

    La sede corta a las 06:00, así que 00:30 hora de Bogotá todavía
    pertenece al día operativo anterior (`app.core.tz`).
    """
    # 05:30 UTC = 00:30 en Bogotá (UTC-5). Antes del corte de las 06:00.
    clock.set(datetime(2026, 3, 11, 5, 30, tzinfo=timezone.utc))
    order = platform_order()
    total = order["totals"]["total"]
    assert pay(order, splits=[{"method": "platform", "amount": total}]).status_code == 201
    db.expire_all()

    receivable = db.execute(
        select(PlatformReceivable).where(PlatformReceivable.order_id == order["id"])
    ).scalar_one()
    assert receivable.business_date.isoformat() == "2026-03-10", (
        "la cuenta por cobrar quedó sellada con el día calendario en vez del día del turno"
    )
