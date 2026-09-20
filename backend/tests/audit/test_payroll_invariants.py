"""Invariantes de nómina — cada test es un enunciado de regla que
`app.payroll` no puede violar (SPEC-NEGOCIO §3.2 y §11.16; CST art. 149).

Auditor de control interno (rol Contador de `.claude/skills/agentes/`): esto
no prueba "que el endpoint responda", prueba que **la nómina nunca calcula
una deuda del empleado ni un descuento por un faltante de caja**. Las reglas
salen de `docs/CONTEXTO-AGENTES.md §14 (7)` y del pedido de esta fase
(`features/fase-3-dinero-control/spec.md § 2`, T3); ninguna sale de leer la
implementación.

Convención: el nombre del test dice la regla, el docstring la cita. Reusa
los helpers de `tests/audit/conftest.py` (`deep_keys`, `deep_contains_text`)
— los mismos que ya barren las respuestas de TURNO en
`test_cash_invariants.py::test_no_shift_payload_ever_speaks_of_employee_debt`;
este archivo hace la misma barrida sobre las respuestas de NÓMINA, que ese
test no alcanza.
"""

from __future__ import annotations

from datetime import date
from typing import Any

from fastapi.testclient import TestClient

from tests.audit.conftest import deep_contains_text, deep_keys, idem_headers
from tests.conftest import KNOWN_PINS
from tests.payroll.conftest import bogota_utc

API = "/api/v1"

FORBIDDEN = ("debt", "deuda", "owes", "payroll_deduction")


def _assert_clean(payload: Any, *, where: str) -> None:
    keys = {k.lower() for k in deep_keys(payload)}
    for word in FORBIDDEN:
        assert not any(word in k for k in keys), f'"{word}" aparece como CLAVE en {where}: {payload}'
        assert not deep_contains_text(payload, word), f'"{word}" aparece en el TEXTO de {where}: {payload}'


def _seed_table(admin_client: TestClient, *, store_id: int) -> None:
    resp = admin_client.post(
        f"{API}/admin/payroll/surcharge-tables",
        params={"store_id": store_id},
        json={
            "valid_from": "2020-01-01",
            "night_start_hour": 19,
            "night_end_hour": 6,
            "night_surcharge_bp": 3500,
            "sunday_holiday_surcharge_bp": 8000,
            "overtime_surcharge_bp": 2500,
            "weekly_ordinary_hours": 46,
        },
        headers=idem_headers(),
    )
    assert resp.status_code == 201, resp.text


def test_no_payroll_response_ever_speaks_of_employee_debt(
    device_client: TestClient,
    admin_client: TestClient,
    open_shift: Any,
    employees: dict[str, Any],
    store: Any,
    clock: Any,
) -> None:
    """§3.2 y §11.16: el sistema NUNCA calcula una deuda del empleado ni
    genera un descuento de nómina por un faltante de caja. La liquidación
    de `app.payroll` **tampoco** puede tener un renglón así, ni siquiera
    opcional, ni siquiera en cero — barre `GET /admin/payroll/hours`,
    `GET/POST /admin/payroll/runs` y el detalle de una liquidación."""
    _seed_table(admin_client, store_id=store.id)
    operator = employees["operator"]

    clock.set(bogota_utc(2026, 3, 10, 8, 0))
    shift = open_shift()
    clock.set(bogota_utc(2026, 3, 10, 9, 0))
    resp_in = device_client.post(
        f"{API}/shifts/{shift['id']}/roster",
        json={"employee_id": operator.id, "action": "in", "pin": KNOWN_PINS["Operator"]},
    )
    assert resp_in.status_code == 200, resp_in.text
    clock.set(bogota_utc(2026, 3, 10, 11, 0))
    resp_out = device_client.post(
        f"{API}/shifts/{shift['id']}/roster",
        json={"employee_id": operator.id, "action": "out", "pin": KNOWN_PINS["Operator"]},
    )
    assert resp_out.status_code == 200, resp_out.text

    hours_resp = admin_client.get(
        f"{API}/admin/payroll/hours", params={"store_id": store.id, "from": "2026-03-10", "to": "2026-03-10"}
    )
    assert hours_resp.status_code == 200, hours_resp.text
    _assert_clean(hours_resp.json(), where="GET /admin/payroll/hours")

    # Sin tarifa por hora a propósito: es el caso en el que alguien podría
    # sentirse tentado a "cobrarle" al empleado el faltante como si fuera
    # una deuda — la liquidación tiene que quedar `null` con motivo, nunca
    # con un renglón de deuda.
    run_resp = admin_client.post(
        f"{API}/admin/payroll/runs",
        params={"store_id": store.id},
        json={"date_from": "2026-03-10", "date_to": "2026-03-10"},
        headers=idem_headers(),
    )
    assert run_resp.status_code == 201, run_resp.text
    run_body = run_resp.json()
    _assert_clean(run_body, where="POST /admin/payroll/runs")

    detail_resp = admin_client.get(f"{API}/admin/payroll/runs/{run_body['id']}", params={"store_id": store.id})
    assert detail_resp.status_code == 200, detail_resp.text
    _assert_clean(detail_resp.json(), where="GET /admin/payroll/runs/{id}")

    list_resp = admin_client.get(f"{API}/admin/payroll/runs", params={"store_id": store.id})
    assert list_resp.status_code == 200, list_resp.text
    _assert_clean(list_resp.json(), where="GET /admin/payroll/runs")


def test_no_tip_distribution_response_ever_speaks_of_employee_debt(
    admin_client: TestClient, store: Any
) -> None:
    resp = admin_client.get(f"{API}/admin/tips/settings", params={"store_id": store.id})
    assert resp.status_code == 200, resp.text
    _assert_clean(resp.json(), where="GET /admin/tips/settings")


def test_feature_dependency_checked_before_store_gate(admin_client: TestClient, store_b: Any, set_feature: Any) -> None:
    """`docs/CONTEXTO-AGENTES.md §6` / error repetido n.º 6 de §14: la
    dependencia de función se valida ANTES que el gate de sede. Con
    `payroll` apagada Y una sede ajena (`store_b`, que además ni siquiera
    existe para esta organización), la respuesta tiene que ser
    `FEATURE_DISABLED` — nunca `404` primero, que mandaría al administrador
    a pensar que es un problema de sede cuando en realidad su plan no
    incluye la función."""
    set_feature("payroll", False)
    resp = admin_client.get(
        f"{API}/admin/payroll/hours", params={"store_id": store_b.id, "from": "2026-03-10", "to": "2026-03-10"}
    )
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "FEATURE_DISABLED"


def test_tips_feature_dependency_checked_before_store_gate(admin_client: TestClient, store_b: Any, set_feature: Any) -> None:
    set_feature("pos.tips", False)
    resp = admin_client.get(f"{API}/admin/tips/settings", params={"store_id": store_b.id})
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "FEATURE_DISABLED"
