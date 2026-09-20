"""Invariantes ejecutables de BANKING (T1, fase 3 — `features/fase-3-dinero-
control/spec.md § 4`, bloque «Plata y cajón» + los puntos de D-4).

Cada test de este archivo es un renglón del checklist de la fase convertido
en enunciado ejecutable — no prueban funcionalidad (eso vive en
`tests/banking/`), prueban GARANTÍAS: que ninguna capacidad de este dominio
mueve el esperado del turno, que "por consignar" es derivado y no una
columna, que la llave anti doble conteo no se puede sortear con varios
movimientos chicos, y que la supresión de D-4 nunca deja el dato suprimido
en la auditoría.
"""

from __future__ import annotations

from typing import Any
from uuid import uuid4

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.banking.models import BankDeposit, BankDepositAllocation
from app.shifts.models import Shift
from tests.audit.conftest import deep_contains_text, denoms, idem_headers

API = "/api/v1"


def _close_single_step(
    device_client: Any,
    set_feature: Any,
    store: Any,
    *,
    shift_id: int,
    counted_cash: int,
    cause: str = "unrecorded_sale",
) -> dict:
    """Cierre en un paso, mismo criterio que `tests/banking/conftest.py::
    close_shift` (no se importa de ahí: es un dominio HERMANO, no un
    ancestro en la jerarquía de `conftest.py` de pytest, y este archivo no
    redefine ninguna fixture compartida)."""

    set_feature("cash.blind_close", False, store_id=store.id)
    resp = device_client.post(
        f"{API}/shifts/{shift_id}/close",
        json={
            "counted_cash": denoms(counted_cash),
            "tips_cash_out": 0,
            "photo": "cierre.jpg",
            "cause": cause,
        },
        headers=idem_headers(),
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


# ---------------------------------------------------------------------------
# 1. El esperado del turno no cambió por ninguna capacidad de esta fase.
# ---------------------------------------------------------------------------


def test_deposit_never_touches_the_shift_close_snapshot(
    db: Session,
    admin_client: Any,
    device_client: Any,
    identify: Any,
    employees: Any,
    set_feature: Any,
    open_shift: Any,
    store: Any,
) -> None:
    """Consignar no es un movimiento de caja: `Shift.expected_cash`,
    `.counted_cash`, `.difference` y `.to_deposit` son el snapshot que
    escribió `app.shifts.service._finalize_close` UNA sola vez al cerrar, y
    `app.banking` sólo lo lee. Si una consignación los tocara, sería la
    segunda matemática que las reglas duras del proyecto prohíben."""

    open_shift(total=200_000)
    shift = db.execute(select(Shift).where(Shift.status == "open")).scalars().one()
    _close_single_step(device_client, set_feature, store, shift_id=shift.id, counted_cash=260_000)

    db.expire_all()
    closed = db.get(Shift, shift.id)
    assert closed is not None
    before = (closed.expected_cash, closed.counted_cash, closed.difference, closed.to_deposit)
    assert closed.to_deposit == 60_000

    resp = admin_client.post(
        f"{API}/admin/deposits",
        params={"store_id": store.id},
        json={
            "amount": 40_000,
            "receipt_photo": "c.jpg",
            "allocations": [{"shift_id": shift.id, "amount": 40_000}],
        },
        headers=idem_headers(),
    )
    assert resp.status_code == 201, resp.text

    db.expire_all()
    after_deposit = db.get(Shift, shift.id)
    assert after_deposit is not None
    after = (after_deposit.expected_cash, after_deposit.counted_cash, after_deposit.difference, after_deposit.to_deposit)
    assert after == before, "una consignación no puede mover el snapshot de cierre del turno"

    # Reversar tampoco lo mueve.
    deposit_id = resp.json()["id"]
    reversed_resp = admin_client.post(
        f"{API}/admin/deposits/{deposit_id}/reverse", json={"reason": "prueba"}, headers=idem_headers()
    )
    assert reversed_resp.status_code == 200, reversed_resp.text

    db.expire_all()
    after_reverse = db.get(Shift, shift.id)
    assert after_reverse is not None
    assert (
        after_reverse.expected_cash,
        after_reverse.counted_cash,
        after_reverse.difference,
        after_reverse.to_deposit,
    ) == before


# ---------------------------------------------------------------------------
# 2. "Por consignar" es derivado, no una columna.
# ---------------------------------------------------------------------------


def test_pending_balance_has_no_stored_column() -> None:
    """§6.1: la única columna de este tipo que se desincronizó en el sistema
    de referencia fue justamente una que ALMACENABA el saldo. `bank_deposits`
    guarda `amount` (lo consignado); ninguna tabla de este dominio tiene una
    columna `outstanding`/`pending`/`balance`: eso se suma en cada lectura
    (`app.banking.service._allocated_live_for_shift` + `Shift.to_deposit`)."""

    forbidden = {"outstanding", "pending_amount", "balance", "to_consign"}
    for model in (BankDeposit, BankDepositAllocation):
        columns = {c.name for c in model.__table__.columns}
        leaked = columns & forbidden
        assert not leaked, f"{model.__tablename__} guarda una columna derivada: {leaked}"


# ---------------------------------------------------------------------------
# 3. La llave anti doble conteo no se sortea con imputaciones chicas.
# ---------------------------------------------------------------------------


def test_anti_double_count_holds_across_many_small_deposits(
    db: Session,
    admin_client: Any,
    device_client: Any,
    identify: Any,
    employees: Any,
    set_feature: Any,
    open_shift: Any,
    store: Any,
) -> None:
    """Tres imputaciones parciales que EXACTAMENTE agotan `to_deposit`
    tienen que dejar `outstanding == 0`; una cuarta, de un solo peso, tiene
    que rechazarse igual que si fuera una sola imputación grande — la llave
    no distingue por tamaño."""

    open_shift(total=200_000)
    shift = db.execute(select(Shift).where(Shift.status == "open")).scalars().one()
    close_body = _close_single_step(device_client, set_feature, store, shift_id=shift.id, counted_cash=230_000)
    assert close_body["to_deposit"] == 30_000

    for amount in (10_000, 10_000, 10_000):
        resp = admin_client.post(
            f"{API}/admin/deposits",
            params={"store_id": store.id},
            json={"amount": amount, "receipt_photo": "c.jpg", "allocations": [{"shift_id": shift.id, "amount": amount}]},
            headers=idem_headers(),
        )
        assert resp.status_code == 201, resp.text

    # Rango amplio a propósito: lo único que importa acá es que el turno
    # aparezca con `outstanding == 0`, sin recalcular su fecha de negocio.
    pending = admin_client.get(
        f"{API}/admin/deposits/pending",
        params={"store_id": store.id, "from": "2000-01-01", "to": "2100-01-01"},
    )
    assert pending.status_code == 200, pending.text
    row = next(r for r in pending.json() if r["shift_id"] == shift.id)
    assert row["outstanding"] == 0

    overflow = admin_client.post(
        f"{API}/admin/deposits",
        params={"store_id": store.id},
        json={"amount": 1, "receipt_photo": "c.jpg", "allocations": [{"shift_id": shift.id, "amount": 1}]},
        headers=idem_headers(),
    )
    assert overflow.status_code == 400, overflow.text
    assert overflow.json()["error"]["code"] == "DEPOSIT_EXCEEDS_PENDING"


# ---------------------------------------------------------------------------
# 4. La mano del dueño cuadra: retirado - consignado - gastado = saldo.
# ---------------------------------------------------------------------------


def test_owner_hand_equation_holds_literally(admin_client: Any, store: Any) -> None:
    """No es un cálculo aparte del cliente: el propio backend tiene que
    devolver los cuatro números tales que la ecuación cierre exacto, sea
    cual sea el escenario (acá, el caso trivial: nada pasó)."""

    resp = admin_client.get(
        f"{API}/admin/bank/owner-hand", params={"store_id": store.id, "from": "2000-01-01", "to": "2100-01-01"}
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["balance"] == body["withdrawn"] - body["deposited"] - body["spent"]
    assert body["withdrawn"] == body["withdrawn_from_pickups"] + body["withdrawn_from_shift_close"]
    assert body["spent"] == body["spent_on_tips"] + body["spent_on_refunds"]


# ---------------------------------------------------------------------------
# 5. D-4: la auditoría de la supresión nunca guarda el dato suprimido.
# ---------------------------------------------------------------------------


def test_d4_anonymization_audit_never_leaks_the_name(
    db: Session,
    admin_client: Any,
    device_client: Any,
    identify: Any,
    employees: Any,
    open_shift: Any,
    sales_products: Any,
    store: Any,
) -> None:
    """Cruce obligatorio nº8 del auditor de fase 3: la supresión anonimiza
    y su auditoría guarda sólo NOMBRES de campos. Se cruza con
    `deep_contains_text` (mismo helper que usan los invariantes de
    privacidad de 1b-2) sobre el `AuditLog` completo, no sólo `before`.

    `document_id` (FK real de `PendingRefund`) sale de una venta real por
    HTTP: comanda -> ítem -> cobro, con los helpers ya compartidos de
    `tests/audit/conftest.py` — no hace falta fabricar un documento fiscal
    a mano."""

    from datetime import datetime, timezone

    from app.audit.models import AuditLog
    from app.customers.models import Customer
    from app.refunds import service as refunds_service
    from app.refunds.models import PendingRefund, PendingRefundStatus
    from tests.audit.conftest import NO_TIP, add_items, create_order, pay

    open_shift(total=200_000)
    identify(device_client, employees["cashier"])
    order = create_order(device_client).json()
    order = add_items(device_client, order, [{"product_id": sales_products["inc8"].id, "qty": 1}]).json()
    pay_resp = pay(device_client, order["id"], splits=[{"method": "cash", "amount": order["totals"]["total"]}], tip=NO_TIP)
    assert pay_resp.status_code == 201, pay_resp.text
    document_id = pay_resp.json()["document"]["id"]
    assert document_id is not None

    now = datetime.now(timezone.utc)
    customer = Customer(
        organization_id=store.organization_id,
        store_id=store.id,
        doc_type="13",
        doc_number="9988776655",
        dv=None,
        name="Nombre Secreto Suprimible",
        email=None,
        address=None,
        municipality_dane=None,
        created_at=now,
        updated_at=now,
    )
    db.add(customer)
    db.flush()

    refund = PendingRefund(
        organization_id=store.organization_id,
        store_id=store.id,
        document_id=document_id,
        customer_id=customer.id,
        customer_name="Nombre Secreto Suprimible",
        customer_doc_number="9988776655",
        amount=9_000,
        method="cash",
        authorized_by_employee_id=1,
        authorized_by_employee_name="Admin",
        requested_at=now,
        status=PendingRefundStatus.PENDING,
    )
    db.add(refund)
    db.commit()

    class _Actor:
        employee_id = 1
        employee_name = "Admin"
        kind = "admin"

    refunds_service.anonymize_pending_refunds_for_customer(
        db,
        actor=_Actor(),
        organization_id=store.organization_id,
        customer_id=customer.id,
        reason="Ley 1581 de 2012",
        now=now,
    )
    db.commit()

    logs = list(
        db.execute(select(AuditLog).where(AuditLog.entity == "pending_refund", AuditLog.entity_id == str(refund.id)))
        .scalars()
    )
    assert logs, "la anonimización tiene que dejar rastro de auditoría"
    for log in logs:
        payload = {"before": log.before, "after": log.after, "reason": log.reason}
        assert not deep_contains_text(payload, "secreto"), "la auditoría de D-4 no puede guardar el nombre suprimido"

    # El registro financiero sigue intacto: documento, monto y estado.
    db.refresh(refund)
    assert refund.document_id == document_id
    assert refund.amount == 9_000
    assert refund.status == PendingRefundStatus.PENDING
    assert refund.customer_doc_number == "9988776655"


# ---------------------------------------------------------------------------
# 6. La dependencia de función se valida ANTES que el gate de sede.
# ---------------------------------------------------------------------------


def test_money_bank_feature_gate_beats_store_not_found(admin_client: Any, set_feature: Any) -> None:
    """Error repetido nº6 (`docs/CONTEXTO-AGENTES.md §14`): con la función
    apagada a nivel organización, un `store_id` que directamente no existe
    tiene que responder `400 FEATURE_DISABLED` — nunca `404` —, porque
    `require_feature`/`_require_bank` corren como dependencia de ruta, antes
    de que el código del endpoint llegue a resolver la sede."""

    set_feature("money.bank", False)
    resp = admin_client.get(
        f"{API}/admin/bank/ledger", params={"store_id": 999_999, "from": "2026-01-01", "to": "2026-01-01"}
    )
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "FEATURE_DISABLED"


# ---------------------------------------------------------------------------
# 7. Ninguna ruta de banking es alcanzable sin sesión de administrador.
# ---------------------------------------------------------------------------


def test_no_banking_route_is_reachable_by_device_session(device_client: Any, store: Any) -> None:
    """`features/fase-3-dinero-control/spec.md § 2`: «todas de admin». Un
    dispositivo activado (sin login de administrador) tiene que rebotar en
    cada una — ninguna ruta de este dominio es de kiosko."""

    routes = [
        ("GET", f"{API}/admin/deposits", {"store_id": store.id, "from": "2026-01-01", "to": "2026-01-01"}),
        ("GET", f"{API}/admin/deposits/pending", {"store_id": store.id, "from": "2026-01-01", "to": "2026-01-01"}),
        ("GET", f"{API}/admin/bank/ledger", {"store_id": store.id, "from": "2026-01-01", "to": "2026-01-01"}),
        ("GET", f"{API}/admin/bank/owner-hand", {"store_id": store.id, "from": "2026-01-01", "to": "2026-01-01"}),
        ("GET", f"{API}/admin/reconciliation/card", {"store_id": store.id, "from": "2026-01-01", "to": "2026-01-01"}),
        ("GET", f"{API}/admin/reconciliation/platform", {"store_id": store.id, "from": "2026-01-01", "to": "2026-01-01"}),
    ]
    for method, path, params in routes:
        resp = device_client.get(path, params=params) if method == "GET" else None
        assert resp is not None
        assert resp.status_code in (401, 403), f"{path} respondió {resp.status_code} para un dispositivo sin admin"
