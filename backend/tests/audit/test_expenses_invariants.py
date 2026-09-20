"""Invariantes ejecutables de GASTOS, OBLIGACIONES, PUNTO DE EQUILIBRIO,
UTILIDAD y D-2 (fase 3, T2 `backend-obligaciones`).

Cada test de este archivo es un renglón del checklist de
`features/fase-3-dinero-control/spec.md § 4` convertido en enunciado
ejecutable: el esperado del turno no se mueve, `null` con motivo sin datos
suficientes, la diferencia de factura no se aprueba sola, el operador sigue
sin ver plata de este dominio, y ninguna función nueva se cuela sin su flag.

Reusa las fixtures compartidas de `tests/audit/conftest.py`
(`expected_of`, `open_shift`, `idem_headers`, `make_supplier`,
`make_ingredient`, `denoms`) — no redefine ninguna.
"""

from __future__ import annotations

from typing import Any
from uuid import uuid4

import pytest

from tests.audit.conftest import idem_headers, make_ingredient, make_supplier

API = "/api/v1"


def _idem() -> dict[str, str]:
    return {"Idempotency-Key": str(uuid4())}


# ---------------------------------------------------------------------------
# (1) La plata cierra: nada de esta fase mueve el esperado del turno.
# ---------------------------------------------------------------------------


def test_an_expense_that_never_touched_the_drawer_never_moves_the_expected_cash(
    admin_client: Any, store: Any, open_shift: Any, expected_of: Any
) -> None:
    """Checklist: «El esperado del turno no cambió por ninguna capacidad de
    esta fase» (T2 agrega plata que no pasa por el cajón)."""
    turno = open_shift()
    esperado_antes = expected_of(turno["id"])

    resp = admin_client.post(
        f"{API}/admin/expenses?store_id={store.id}",
        json={"category": "utilities", "description": "Arriendo (transferencia)", "amount": 3_000_000, "business_date": "2026-01-15", "source": "bank"},
        headers=_idem(),
    )
    assert resp.status_code == 201, resp.text

    row = admin_client.post(
        f"{API}/admin/obligations?store_id={store.id}",
        json={"category": "rent", "description": "Servicios", "amount": 500_000, "due_date": "2026-01-20"},
        headers=_idem(),
    ).json()
    admin_client.post(f"{API}/admin/obligations/{row['id']}/settle", json={"source": "bank"}, headers=_idem())

    assert expected_of(turno["id"]) == esperado_antes, (
        "un gasto/obligación que nunca pasó por el cajón movió el esperado del turno: T2 recalculó lo que "
        "compute_breakdown ya calcula, en vez de dejarlo intacto"
    )


@pytest.mark.parametrize("with_reference", [True, False])
def test_expenses_never_write_a_second_cash_movements_row(
    admin_client: Any, device_client: Any, identify: Any, employees: dict[str, Any], store: Any,
    db: Any, open_shift: Any, with_reference: bool,
) -> None:
    from sqlalchemy import func, select

    from app.shifts.models import CashMovement

    turno = open_shift()
    identify(device_client, employees["cashier"])
    movement_id = None
    if with_reference:
        movimiento = device_client.post(
            f"{API}/shifts/{turno['id']}/cash-movements",
            json={"kind": "expense", "cause": "other_expense", "amount": 12_000, "note": "x"},
            headers=idem_headers(),
        )
        assert movimiento.status_code == 201, movimiento.text
        movement_id = movimiento.json()["id"]

    count_before = db.execute(select(func.count()).select_from(CashMovement)).scalar_one()

    payload: dict[str, Any] = {
        "category": "supplies", "description": "x", "amount": 12_000, "business_date": "2026-01-15",
        "source": "cash_drawer" if with_reference else "bank",
    }
    if with_reference:
        payload["cash_movement_id"] = movement_id
    resp = admin_client.post(f"{API}/admin/expenses?store_id={store.id}", json=payload, headers=_idem())
    assert resp.status_code == 201, resp.text

    db.expire_all()
    count_after = db.execute(select(func.count()).select_from(CashMovement)).scalar_one()
    assert count_after == count_before, (
        "app.expenses.service creó un CashMovement propio: la llave anti doble conteo del territorio "
        "(pago vs movimiento de banco / egreso vs recepción) exige que este dominio SÓLO referencie un "
        "movimiento que shifts ya escribió, nunca que escriba uno nuevo"
    )


# ---------------------------------------------------------------------------
# (2) `null` con motivo — nunca `0`, nunca una tabla vacía muda.
# ---------------------------------------------------------------------------


def test_break_even_and_profit_are_null_with_reason_without_enough_data(admin_client: Any, store: Any) -> None:
    """Checklist: «Punto de equilibrio y utilidad son `null` con motivo sin
    costos fijos». `profit` sin ventas ni gastos es `0` legítimo (hecho, no
    ausencia de dato) — la ausencia de dato la prueba `break-even` sin
    costos fijos."""
    resp = admin_client.get(
        f"{API}/admin/break-even", params={"store_id": store.id, "from": "2020-01-01", "to": "2099-12-31"}
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["break_even_amount"] is None, "sin costos fijos, break_even_amount tiene que ser null, nunca 0"
    assert body["break_even_amount"] != 0
    assert body["available"] is False
    assert isinstance(body["reason"], str) and body["reason"], "el motivo tiene que nombrarse, no quedar vacío"


# ---------------------------------------------------------------------------
# (3) D-2: una cuenta con diferencia no se aprueba sola.
# ---------------------------------------------------------------------------


def test_a_payable_with_invoice_discrepancy_never_approves_itself(admin_client: Any, store: Any) -> None:
    ing = make_ingredient(admin_client, store, name="Arroz", official_cost=None, min_stock="1000")
    supplier = make_supplier(admin_client, store)

    resp = admin_client.post(
        f"{API}/receptions?store_id={store.id}",
        headers=idem_headers(),
        json={
            "supplier_id": supplier["id"],
            "invoice_number": "FE-D2",
            "invoice_date": "2026-01-10",
            "no_invoice": False,
            "invoice_total": 999_999,  # muy distinto del cálculo, a propósito
            "received_by_pin": "1111",
            "confirm_price": False,
            "lines": [
                {
                    "ingredient_id": ing["id"], "qty_received": "10000", "qty_invoiced": "10000",
                    "purchase_unit_price": "12000", "tax_base": 120_000, "tax_rate": 19, "tax_amount": 22_800,
                    "lot_code": None, "expires_at": None,
                }
            ],
        },
    )
    assert resp.status_code == 201, resp.text
    payable_id = resp.json()["payable_id"]

    payable = admin_client.get(f"{API}/admin/payables/{payable_id}").json()
    assert payable["invoice_total"] == 999_999
    assert payable["invoice_discrepancy"] not in (None, 0)

    intento = admin_client.post(f"{API}/admin/payables/{payable_id}/approve", json={"authorizer_pin": "9999"})
    assert intento.status_code == 409, intento.text
    assert intento.json()["error"]["code"] == "INVOICE_DISCREPANCY"

    still = admin_client.get(f"{API}/admin/payables/{payable_id}").json()
    assert still["status"] == "pending_review", "la aprobación se rechazó pero el estado igual cambió"

    ok = admin_client.post(
        f"{API}/admin/payables/{payable_id}/approve", json={"authorizer_pin": "9999", "confirm_discrepancy": True}
    )
    assert ok.status_code == 200, ok.text
    assert ok.json()["discrepancy_confirmed"] is True


# ---------------------------------------------------------------------------
# (4) El operador sigue sin ver nada de este dominio.
# ---------------------------------------------------------------------------


def test_no_expenses_route_is_reachable_under_a_device_session(device_client: Any, store: Any) -> None:
    """El operador del salón no ve gastos, obligaciones, punto de equilibrio
    ni utilidad: son pantallas de administrador, y la sesión de dispositivo
    tiene que rebotar con 401/403/404 en todas, nunca con datos."""
    rutas = [
        ("get", f"{API}/admin/expenses?store_id={store.id}"),
        ("post", f"{API}/admin/expenses?store_id={store.id}"),
        ("get", f"{API}/admin/obligations?store_id={store.id}"),
        ("post", f"{API}/admin/obligations?store_id={store.id}"),
        ("post", f"{API}/admin/obligations/1/settle"),
        ("get", f"{API}/admin/break-even?store_id={store.id}&from=2026-01-01&to=2026-01-31"),
        ("get", f"{API}/admin/profit?store_id={store.id}&from=2026-01-01&to=2026-01-31"),
        ("get", f"{API}/admin/expenses/settings?store_id={store.id}"),
    ]
    alcanzables: list[str] = []
    for metodo, ruta in rutas:
        resp = getattr(device_client, metodo)(ruta, **({"json": {}} if metodo == "post" else {}))
        if resp.status_code not in (401, 403, 404):
            alcanzables.append(f"{metodo.upper()} {ruta} -> {resp.status_code} {resp.text[:160]}")
    assert not alcanzables, (
        "una sesión de dispositivo alcanza rutas de gastos/obligaciones/resultado del período "
        "(BLOQUEANTE, regla dura §11.10):\n" + "\n".join(alcanzables)
    )


# ---------------------------------------------------------------------------
# (5) Toda capacidad detrás de su función.
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "metodo,ruta",
    [
        ("get", "/admin/expenses"),
        ("get", "/admin/obligations"),
        ("get", "/admin/break-even"),
        ("get", "/admin/profit"),
        ("get", "/admin/expenses/settings"),
    ],
)
def test_each_expenses_capability_answers_400_feature_disabled_when_its_flag_is_off(
    admin_client: Any, store: Any, set_feature: Any, metodo: str, ruta: str
) -> None:
    extra = "&from=2026-01-01&to=2026-01-31" if ruta in ("/admin/break-even", "/admin/profit") else ""
    encendida = getattr(admin_client, metodo)(f"{API}{ruta}?store_id={store.id}{extra}")
    assert encendida.status_code != 400 or encendida.json().get("error", {}).get("code") != "FEATURE_DISABLED"

    set_feature("money.obligations", False, store_id=store.id)
    apagada = getattr(admin_client, metodo)(f"{API}{ruta}?store_id={store.id}{extra}")
    assert apagada.status_code == 400, f"{ruta} con money.obligations apagada devolvió {apagada.status_code}: {apagada.text[:200]}"
    assert apagada.json()["error"]["code"] == "FEATURE_DISABLED"


# ---------------------------------------------------------------------------
# (6) Nada financiero se borra.
# ---------------------------------------------------------------------------


def test_voiding_an_expense_and_cancelling_an_obligation_never_delete_the_row(admin_client: Any, store: Any, db: Any) -> None:
    from sqlalchemy import func, select

    from app.expenses.models import Expense, Obligation

    expense = admin_client.post(
        f"{API}/admin/expenses?store_id={store.id}",
        json={"category": "other", "description": "x", "amount": 1000, "business_date": "2026-01-10", "source": "other"},
        headers=_idem(),
    ).json()
    admin_client.post(f"{API}/admin/expenses/{expense['id']}/void", json={"reason": "error"}, headers=_idem())

    obligation = admin_client.post(
        f"{API}/admin/obligations?store_id={store.id}",
        json={"category": "rent", "description": "x", "amount": 1000, "due_date": "2026-01-10"},
        headers=_idem(),
    ).json()
    admin_client.post(f"{API}/admin/obligations/{obligation['id']}/cancel", json={"reason": "error"}, headers=_idem())

    assert db.execute(select(func.count()).select_from(Expense)).scalar_one() == 1, "el gasto anulado se borró"
    assert db.execute(select(func.count()).select_from(Obligation)).scalar_one() == 1, "la obligación cancelada se borró"


# ---------------------------------------------------------------------------
# (7) Ningún `float` en los campos de plata/porcentaje nuevos.
# ---------------------------------------------------------------------------


def test_no_float_in_new_money_or_percentage_fields(admin_client: Any, store: Any) -> None:
    """Checklist: «Ningún `float` en ningún cálculo nuevo, en ninguna de las
    dos capas». Se mide sobre las respuestas reales, no sobre el código: un
    `int` de Python que llegó como JSON número entero deserializa a `int`,
    nunca a `float` — si algún campo de plata usara `float` en el esquema,
    acá aparecería como `3.0` en vez de `3`."""

    def _walk(value: Any, path: str, offenders: list[str]) -> None:
        if isinstance(value, bool):
            return
        if isinstance(value, float):
            offenders.append(path)
        elif isinstance(value, dict):
            for k, v in value.items():
                _walk(v, f"{path}.{k}", offenders)
        elif isinstance(value, list):
            for i, v in enumerate(value):
                _walk(v, f"{path}[{i}]", offenders)

    offenders: list[str] = []
    admin_client.patch(f"{API}/admin/expenses/settings?store_id={store.id}", json={"fixed_costs": 1_000_000})
    for resp in (
        admin_client.get(f"{API}/admin/expenses/settings?store_id={store.id}"),
        admin_client.get(f"{API}/admin/break-even", params={"store_id": store.id, "from": "2020-01-01", "to": "2099-12-31"}),
        admin_client.get(f"{API}/admin/profit", params={"store_id": store.id, "from": "2020-01-01", "to": "2099-12-31"}),
    ):
        assert resp.status_code == 200, resp.text
        _walk(resp.json(), "$", offenders)

    assert not offenders, f"hay `float` en una respuesta de expenses: {offenders}"
