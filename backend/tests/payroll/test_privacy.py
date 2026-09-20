"""Un operador no ve la nómina de otro ni el reparto de propinas ajeno
(checklist de la fase, `docs/CONTEXTO-AGENTES.md`): en este dominio **todas**
las rutas son de administrador (`current_admin`), la misma puerta que ya usan
`app.banking`/`app.expenses` — un operador identificado en el dispositivo del
salón no tiene, estructuralmente, cómo llegar a `/admin/payroll/**` ni a
`/admin/tips/**`. Este archivo lo prueba explícitamente sobre CADA ruta del
contrato, más el aislamiento entre sedes de organizaciones distintas.
"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

API = "/api/v1"


def test_device_session_cannot_reach_any_payroll_route(device_client: TestClient, store: Any) -> None:
    """Un dispositivo activado (el salón) — sin sesión de administrador — no
    puede leer ni escribir nada de este dominio: 401, nunca 200 ni 403 (403
    confirmaría que la ruta existe para un rol que no debería siquiera
    intentarlo)."""
    routes = [
        ("get", f"{API}/admin/payroll/hours", {"store_id": store.id, "from": "2026-03-10", "to": "2026-03-10"}),
        ("get", f"{API}/admin/payroll/surcharge-tables", {"store_id": store.id}),
        ("get", f"{API}/admin/payroll/runs", {"store_id": store.id}),
        (
            "get",
            f"{API}/admin/tips/distribution/proposal",
            {"store_id": store.id, "from": "2026-03-10", "to": "2026-03-10"},
        ),
        ("get", f"{API}/admin/tips/settings", {"store_id": store.id}),
    ]
    for verb, url, params in routes:
        resp = getattr(device_client, verb)(url, params=params)
        assert resp.status_code == 401, f"{verb.upper()} {url} -> {resp.status_code}, {resp.text}"


def test_foreign_organization_store_is_404_not_leaked(admin_client: TestClient, store_b: Any) -> None:
    """`store_b` es de OTRA organización: el admin de la primera no puede
    verla ni por accidente. `404`, nunca `403` (que confirmaría que existe)."""
    for url, params in (
        (f"{API}/admin/payroll/hours", {"store_id": store_b.id, "from": "2026-03-10", "to": "2026-03-10"}),
        (f"{API}/admin/payroll/surcharge-tables", {"store_id": store_b.id}),
        (f"{API}/admin/payroll/runs", {"store_id": store_b.id}),
        (f"{API}/admin/tips/settings", {"store_id": store_b.id}),
    ):
        resp = admin_client.get(url, params=params)
        assert resp.status_code == 404, f"GET {url} -> {resp.status_code}, {resp.text}"
