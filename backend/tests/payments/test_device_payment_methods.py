"""`GET /device/payment-methods`: sólo los medios habilitados de la sede
(gap declarado en `outputs-1b-1/*.md` — el POS ofrecía siempre los mismos
seis códigos fijos). Ninguna respuesta de dispositivo lleva costos."""

from __future__ import annotations

import json
from typing import Any


def test_device_payment_methods_lists_only_enabled(device_client: Any, admin_client: Any, store: Any) -> None:
    resp = device_client.get("/api/v1/device/payment-methods")
    assert resp.status_code == 200, resp.text
    codes = {m["code"] for m in resp.json()}
    assert codes == {"cash", "card", "transfer"}  # default de `stores.service.DEFAULT_PAYMENT_METHODS`

    settings = admin_client.get(f"/api/v1/admin/stores/{store.id}/sales-settings").json()
    for method in settings["payment_methods"]:
        if method["code"] == "transfer":
            method["enabled"] = False
    resp2 = admin_client.put(f"/api/v1/admin/stores/{store.id}/sales-settings", json=settings)
    assert resp2.status_code == 200, resp2.text

    after = device_client.get("/api/v1/device/payment-methods")
    codes_after = {m["code"] for m in after.json()}
    assert codes_after == {"cash", "card"}


def test_device_payment_methods_never_exposes_cost_fields(device_client: Any) -> None:
    resp = device_client.get("/api/v1/device/payment-methods")
    raw = json.dumps(resp.json())
    for forbidden in ("\"cost\"", "\"margin\"", "\"unit_cost\""):
        assert forbidden not in raw
