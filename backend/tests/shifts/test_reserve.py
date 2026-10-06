"""La base de respaldo (`cash.reserve`, decisión del dueño 2026-09-26).

Plata aparte del cajón, con monto fijo por sede. No entra al cuadre; lo que
se le presta al cajón sí:

- tomar exige el PIN de un supervisor o administrador (el del cajero no
  sirve) y no más de lo disponible; lo tomado suma al esperado;
- devolver lo hace quien tiene la caja, no más de lo que el cajón debe;
- con préstamo abierto el conteo de cierre no entra, y el paso 0 lo lista;
- la base la verifica su custodio a ciegas, aparte del cuadre del cajero;
- un movimiento equivocado se reversa con motivo, nunca se borra;
- la bandeja de Hoy publica los préstamos sin devolver;
- con la función apagada no hay base (`null`, no `0`) y las rutas responden
  `FEATURE_DISABLED`.
"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.shifts import service
from app.shifts.models import Shift
from app.stores import service as stores_service
from tests.conftest import KNOWN_PINS
from tests.shifts.conftest import idem

API = "/api/v1"
RESERVE = 100_000
SUPERVISOR_PIN = KNOWN_PINS["Supervisor"]


def _configure(db: Session, store: Any, amount: int = RESERVE) -> None:
    settings = stores_service.get_cash_settings(db, store.id)
    settings.cash_reserve_default = amount
    db.commit()


def _denoms(total: int) -> dict[str, Any]:
    return {"denominations": [{"value": 50_000, "count": total // 50_000}], "total": total}


def _take(client: TestClient, shift_id: int, amount: int, pin: str | None = SUPERVISOR_PIN) -> Any:
    body: dict[str, Any] = {"amount": amount}
    if pin is not None:
        body["authorizer_pin"] = pin
    return client.post(f"{API}/shifts/{shift_id}/reserve/take", json=body, headers=idem())


def _give_back(client: TestClient, shift_id: int, amount: int) -> Any:
    return client.post(f"{API}/shifts/{shift_id}/reserve/return", json={"amount": amount}, headers=idem())


def _expected(db: Session, shift_id: int) -> int:
    shift = db.get(Shift, shift_id)
    assert shift is not None
    db.refresh(shift)
    return service.compute_breakdown(db, shift)["expected"]


def test_taking_needs_a_supervisor_pin_and_enters_the_drawer_as_a_loan(
    db: Session, device_client: TestClient, open_shift: Any, store: Any
) -> None:
    _configure(db, store)
    shift = open_shift()
    antes = _expected(db, shift["id"])

    sin_pin = _take(device_client, shift["id"], 50_000, pin=None)
    assert sin_pin.status_code == 400
    assert sin_pin.json()["error"]["code"] == "AUTHORIZATION_REQUIRED"

    con_pin_del_cajero = _take(device_client, shift["id"], 50_000, pin=KNOWN_PINS["Cashier"])
    assert con_pin_del_cajero.status_code in (400, 403)

    ok = _take(device_client, shift["id"], 50_000)
    assert ok.status_code == 201, ok.text
    assert ok.json()["kind"] == "take"
    assert ok.json()["authorized_by_employee_name"] == "Supervisor"
    assert _expected(db, shift["id"]) == antes + 50_000

    current = device_client.get(f"{API}/shifts/current").json()
    assert current["reserve_loan"] == 50_000


def test_nobody_takes_more_than_what_the_reserve_has(
    db: Session, device_client: TestClient, open_shift: Any, store: Any
) -> None:
    _configure(db, store)
    shift = open_shift()
    assert _take(device_client, shift["id"], 80_000).status_code == 201
    resp = _take(device_client, shift["id"], 50_000)
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "RESERVE_INSUFFICIENT"
    assert resp.json()["error"]["available"] == 20_000


def test_without_an_amount_the_reserve_cannot_be_used(
    db: Session, device_client: TestClient, open_shift: Any, store: Any
) -> None:
    _configure(db, store, 0)
    shift = open_shift()
    resp = _take(device_client, shift["id"], 10_000)
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "RESERVE_NOT_CONFIGURED"


def test_the_closing_count_waits_until_the_loan_is_returned(
    db: Session, device_client: TestClient, open_shift: Any, store: Any, set_feature: Any
) -> None:
    _configure(db, store)
    shift = open_shift()
    assert _take(device_client, shift["id"], 50_000).status_code == 201

    precheck = device_client.get(f"{API}/shifts/{shift['id']}/close/precheck").json()
    assert precheck["reserve_loan_open"] is True
    item = next(i for i in precheck["items"] if i["code"] == "RESERVE_LOAN_OPEN")
    assert item["level"] == "blocking"
    assert "$" not in item["message"], "el paso 0 no publica montos"

    count = device_client.post(
        f"{API}/shifts/{shift['id']}/close/count",
        json={"counted_cash": _denoms(250_000), "photo": "cierre.jpg"},
        headers=idem(),
    )
    assert count.status_code == 400
    assert count.json()["error"]["code"] == "RESERVE_LOAN_OPEN"
    assert "Devolver a la base" in count.json()["error"]["message"]

    de_mas = _give_back(device_client, shift["id"], 60_000)
    assert de_mas.status_code == 400
    assert de_mas.json()["error"]["code"] == "RESERVE_RETURN_OVER_LOAN"

    assert _give_back(device_client, shift["id"], 50_000).status_code == 201
    assert device_client.get(f"{API}/shifts/current").json()["reserve_loan"] == 0

    count = device_client.post(
        f"{API}/shifts/{shift['id']}/close/count",
        json={"counted_cash": _denoms(200_000), "photo": "cierre.jpg"},
        headers=idem(),
    )
    assert count.status_code == 201, count.text
    count_id = count.json()["count_id"]
    review = device_client.get(f"{API}/shifts/{shift['id']}/close/{count_id}/review").json()
    assert review["difference"] == 0
    closed = device_client.post(
        f"{API}/shifts/{shift['id']}/close/{count_id}/confirm", json={"difference_seen": 0, "closes_day": False}
    )
    assert closed.status_code == 200, closed.text
    # Lo prestado volvió a la base: no aparece en lo que hay que consignar.
    # Se consignan sólo los $200.000 con que abrió el cajón sin días por
    # consignar (el sobrante de la apertura «igual al café»).
    assert closed.json()["to_deposit"] == 200_000


def test_returning_without_a_loan_is_rejected(
    db: Session, device_client: TestClient, open_shift: Any, store: Any
) -> None:
    _configure(db, store)
    shift = open_shift()
    resp = _give_back(device_client, shift["id"], 10_000)
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "RESERVE_NOTHING_TO_RETURN"


def test_a_wrong_take_is_reversed_by_the_admin_with_a_reason_and_both_rows_stay(
    db: Session, device_client: TestClient, admin_client: TestClient, open_shift: Any, store: Any, employees: dict
) -> None:
    """La tarjeta de la base de respaldo en Caja › Dinero: el administrador
    ve los movimientos y reversa uno equivocado con motivo (él lo autoriza);
    los dos quedan. La reversa ya no es una ruta del dispositivo."""
    _configure(db, store)
    shift = open_shift()
    take = _take(device_client, shift["id"], 50_000).json()

    viejo = device_client.post(
        f"{API}/shifts/{shift['id']}/reserve/movements/{take['id']}/reverse",
        json={"reason": "Se tecleó mal", "authorizer_pin": SUPERVISOR_PIN},
    )
    assert viejo.status_code in (404, 405), viejo.text

    card = admin_client.get(f"{API}/admin/stores/{store.id}/reserve").json()
    fila = next(m for m in card["movements"] if m["id"] == take["id"])
    assert (fila["kind"], fila["amount"], fila["shift_open"], fila["reversed_at"]) == ("take", 50_000, True, None)

    url = f"{API}/admin/stores/{store.id}/reserve/movements/{take['id']}/reverse"
    sin_motivo = admin_client.post(url, json={"reason": ""})
    assert sin_motivo.status_code in (400, 422)
    resp = admin_client.post(url, json={"reason": "Se tecleó mal"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["reversed_reason"] == "Se tecleó mal"
    assert resp.json()["reversed_by_employee_name"] == employees["admin"].name
    status = device_client.get(f"{API}/shifts/{shift['id']}/reserve").json()
    assert status["loan"] == 0
    assert len(status["movements"]) == 1

    otra_vez = admin_client.post(url, json={"reason": "Otra vez"})
    assert otra_vez.status_code == 400
    assert otra_vez.json()["error"]["code"] == "RESERVE_ALREADY_REVERSED"

    # Un id de otra sede (o inexistente) es 404.
    assert admin_client.post(f"{API}/admin/stores/{store.id}/reserve/movements/999999/reverse", json={"reason": "x"}).status_code == 404


def test_the_custodian_verifies_the_reserve_blind_and_the_cashier_cannot(
    db: Session, device_client: TestClient, open_shift: Any, store: Any, identify: Any, employees: dict
) -> None:
    _configure(db, store)
    shift = open_shift()
    assert _take(device_client, shift["id"], 50_000).status_code == 201

    cajero = device_client.post(f"{API}/reserve/checks", json={"counted": _denoms(50_000)}, headers=idem())
    assert cajero.status_code == 403
    assert cajero.json()["error"]["code"] == "RESERVE_CUSTODIAN_REQUIRED"

    identify(device_client, employees["supervisor"])
    check = device_client.post(f"{API}/reserve/checks", json={"counted": _denoms(0)}, headers=idem())
    assert check.status_code == 201, check.text
    body = check.json()
    # Monto fijo 100.000 − 50.000 prestados al cajón = 50.000 esperados.
    assert (body["expected"], body["counted"], body["difference"]) == (50_000, 0, -50_000)
    assert body["employee_name"] == "Supervisor"


def test_the_today_tray_lists_the_loans_not_returned(
    db: Session, device_client: TestClient, admin_client: TestClient, open_shift: Any, store: Any
) -> None:
    _configure(db, store)
    shift = open_shift()
    assert _take(device_client, shift["id"], 30_000).status_code == 201
    today = admin_client.get(f"{API}/admin/today", params={"store_id": store.id})
    assert today.status_code == 200, today.text
    assert today.json()["reserve_loans_open_count"] == 1
    assert today.json()["reserve_loans_open_total"] == 30_000

    admin = admin_client.get(f"{API}/admin/stores/{store.id}/reserve").json()
    assert admin["loans_outstanding"] == 30_000
    assert admin["open_loans"] == [{"shift_id": shift["id"], "amount": 30_000, "shift_open": True}]


def test_with_the_feature_off_there_is_no_reserve(
    db: Session, device_client: TestClient, admin_client: TestClient, open_shift: Any, store: Any, set_feature: Any
) -> None:
    _configure(db, store)
    set_feature("cash.reserve", False, store_id=store.id)
    shift = open_shift()
    resp = _take(device_client, shift["id"], 10_000)
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "FEATURE_DISABLED"
    assert device_client.get(f"{API}/shifts/current").json()["reserve_loan"] is None
    today = admin_client.get(f"{API}/admin/today", params={"store_id": store.id}).json()
    assert today["reserve_loans_open_total"] is None


# ---------------------------------------------------------------------------
# Aviso grave al celular (0031): plata de la base sin devolver.
# ---------------------------------------------------------------------------


def _reserve_notices(db: Session) -> list[Any]:
    from sqlalchemy import select

    from app.notifications.models import Notification

    db.expire_all()
    return list(
        db.execute(select(Notification).where(Notification.type == "reserve_loan_open").order_by(Notification.id)).scalars()
    )


def test_trying_to_close_with_the_loan_open_leaves_a_critical_notice(
    db: Session, device_client: TestClient, open_shift: Any, store: Any
) -> None:
    """El rechazo del cierre deja el aviso (sobrevive al 400, como el
    contador de PIN): crítico, con el monto para el dueño y sin monto para el
    supervisor custodio. Reintentar no lo repite."""
    from app.notifications import push

    _configure(db, store)
    shift = open_shift()
    assert _take(device_client, shift["id"], 50_000).status_code == 201
    for _ in range(2):
        count = device_client.post(
            f"{API}/shifts/{shift['id']}/close/count",
            json={"counted_cash": _denoms(250_000), "photo": "cierre.jpg"},
            headers=idem(),
        )
        assert count.json()["error"]["code"] == "RESERVE_LOAN_OPEN"
    notices = _reserve_notices(db)
    assert len(notices) == 1
    assert notices[0].level == "critical"
    assert notices[0].payload == {"shift_id": shift["id"], "owed": 50_000, "when": "close"}
    assert "$" in notices[0].body
    assert push.pending_jobs(db) == [], "sin celulares suscritos no se encola nada"


def test_a_loan_past_the_cutoff_is_noticed_when_today_is_read(
    db: Session, device_client: TestClient, admin_client: TestClient, open_shift: Any, store: Any, clock: Any
) -> None:
    from datetime import datetime, timezone

    # El reloj de mentira arranca en el presente: las sesiones ya firmadas
    # siguen vigentes, y después se adelanta dos días.
    clock.set(datetime.now(timezone.utc))
    _configure(db, store)
    shift = open_shift()
    assert _take(device_client, shift["id"], 30_000).status_code == 201

    admin_client.get(f"{API}/admin/today", params={"store_id": store.id})
    assert _reserve_notices(db) == [], "el mismo día, antes del corte, todavía no es un aviso"

    clock.advance(days=2)
    today = admin_client.get(f"{API}/admin/today", params={"store_id": store.id})
    assert today.status_code == 200, today.text
    admin_client.get(f"{API}/admin/panel", params={"store_id": store.id})
    notices = _reserve_notices(db)
    assert len(notices) == 1, "Hoy y el panel leen lo mismo: un solo aviso"
    assert notices[0].level == "critical" and notices[0].payload["when"] == "overdue"
