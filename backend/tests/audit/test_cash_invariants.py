"""Invariantes de plata del turno de caja — cada test es un enunciado de regla.

Auditor de control interno (rol Contador de `.claude/skills/agentes/`): esto no
prueba "que el endpoint responda", prueba que la **plata no se pueda mover sin
rastro y que el esperado no se pueda inflar**. Las reglas salen de
`docs/SPEC-NEGOCIO.md §3.2, §6.1, §11` y del contrato de API de
`features/fase-1a-cimientos/spec.md`; ninguna sale de leer la implementación.

Convención: el nombre del test dice la regla, el docstring la cita.
"""

from __future__ import annotations

import threading
import uuid
from typing import Any

from sqlalchemy import select

from tests.audit.conftest import (
    OPENING_FIXED,
    deep_contains_text,
    deep_keys,
    denoms,
    idem_headers,
)

API = "/api/v1"


# ---------------------------------------------------------------------------
# Helpers locales (no fixtures: son composición de llamadas HTTP)
# ---------------------------------------------------------------------------


def _movement(client: Any, shift_id: int, *, kind: str, cause: str, amount: int, **extra: Any) -> Any:
    payload: dict[str, Any] = {"kind": kind, "cause": cause, "amount": amount, "note": "auditoría"}
    payload.update(extra)
    return client.post(f"{API}/shifts/{shift_id}/cash-movements", json=payload, headers=idem_headers())


PHOTO = "data:image/png;base64,AAAA"


def _count(client: Any, shift_id: int, counted: int, *, photo: str | None = PHOTO, **extra: Any) -> Any:
    """Paso 1 del cierre. Manda foto por defecto porque la sede la exige
    (`photo_required_on_close`); el test de la foto la omite a propósito."""
    payload: dict[str, Any] = {"counted_cash": denoms(counted), "tips_cash_out": 0}
    if photo is not None:
        payload["photo"] = photo
    payload.update(extra)
    return client.post(f"{API}/shifts/{shift_id}/close/count", json=payload, headers=idem_headers())


def _pickup(client: Any, shift_id: int, amount: int, **extra: Any) -> Any:
    payload: dict[str, Any] = {"amount": amount, "authorizer_pin": "9999", "photo": PHOTO}
    payload.update(extra)
    return client.post(f"{API}/shifts/{shift_id}/pickups", json=payload, headers=idem_headers())


def _review(client: Any, shift_id: int, count_id: int) -> Any:
    return client.get(f"{API}/shifts/{shift_id}/close/{count_id}/review")


def _confirm(client: Any, shift_id: int, count_id: int, difference_seen: int, **extra: Any) -> Any:
    payload: dict[str, Any] = {"difference_seen": difference_seen, "closes_day": True}
    payload.update(extra)
    return client.post(f"{API}/shifts/{shift_id}/close/{count_id}/confirm", json=payload)


# ---------------------------------------------------------------------------
# (a) La reserva declarada no entra al esperado ni a la ecuación
# ---------------------------------------------------------------------------


def test_declared_reserve_never_enters_expected_nor_the_equation(
    device_client: Any, open_shift: Any, expected_of: Any
) -> None:
    """§3.2 y §11.15: «la reserva no entra al cuadre» (Palmetto, 15-ago: una
    reserva contada dentro de la base fabricó un sobrante de $500.000)."""
    shift = open_shift(cash_reserve=100_000)

    assert shift["cash_reserve"] == 100_000, "la reserva se declara y se guarda aparte"
    assert expected_of(shift["id"]) == OPENING_FIXED, "la reserva no puede sumar al esperado"

    count = _count(device_client, shift["id"], OPENING_FIXED)
    assert count.status_code in (200, 201), count.text
    review = _review(device_client, shift["id"], count.json()["count_id"])
    assert review.status_code == 200, review.text
    body = review.json()

    assert body["equation"]["base"] == OPENING_FIXED
    assert body["expected"] == OPENING_FIXED
    assert body["difference"] == 0
    assert "cash_reserve" not in deep_keys(body["equation"]), "la reserva no es un término de la ecuación"


# ---------------------------------------------------------------------------
# (b) El cambio de denominaciones es neto cero y no mueve el esperado
# ---------------------------------------------------------------------------


def test_zero_net_swap_does_not_change_expected(device_client: Any, open_shift: Any, expected_of: Any) -> None:
    """§3.2: el cambio (sencilla) es un canje con neto cero, nunca un egreso —
    «un egreso por cambio baja el esperado y fabrica un sobrante»."""
    shift = open_shift()
    before = expected_of(shift["id"])

    resp = device_client.post(
        f"{API}/shifts/{shift['id']}/cash-swaps",
        json={"out": denoms(100_000), "in": denoms(100_000)},
    )
    assert resp.status_code in (200, 201), resp.text
    assert expected_of(shift["id"]) == before, "un cash_swap no mueve el esperado"


def test_non_zero_swap_is_rejected_with_swap_not_zero(device_client: Any, open_shift: Any) -> None:
    """§3.2: si lo que sale y lo que entra no suman igual, no es un cambio."""
    shift = open_shift()

    resp = device_client.post(
        f"{API}/shifts/{shift['id']}/cash-swaps",
        json={"out": denoms(100_000), "in": denoms(50_000)},
    )
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "SWAP_NOT_ZERO"
    assert resp.json()["error"]["message"], "todo 400 nombra la acción correctiva (§11.18)"


# ---------------------------------------------------------------------------
# (c) La ecuación del esperado, el snapshot del retiro y la reversa
# ---------------------------------------------------------------------------


def test_expected_follows_the_single_equation_and_pickup_freezes_its_snapshot(
    device_client: Any, open_shift: Any, expected_of: Any, employees: dict[str, Any]
) -> None:
    """§3.2 y §6.1: `esperado = base + ventas efectivo + ingresos − egresos −
    retiros`, y el retiro guarda el esperado del instante para poder acotar una
    diferencia a «antes o después del retiro»."""
    shift = open_shift()
    sid = shift["id"]

    assert _movement(device_client, sid, kind="income", cause="other_income", amount=30_000).status_code in (200, 201)
    assert _movement(device_client, sid, kind="expense", cause="petty_expense", amount=10_000).status_code in (200, 201)
    assert expected_of(sid) == 220_000

    pickup = _pickup(device_client, sid, 50_000, envelope_ref="SOBRE-1")
    assert pickup.status_code in (200, 201), pickup.text
    pickup_body = pickup.json()

    assert expected_of(sid) == 170_000, "200000 + 30000 − 10000 − 50000"
    assert pickup_body["expected_at_pickup"] == 220_000, "snapshot del esperado en el instante del retiro"
    assert pickup_body["authorized_by_employee_id"] == employees["admin"].id


def test_reversing_a_pickup_restores_expected_and_keeps_the_pickup_row(
    device_client: Any, open_shift: Any, expected_of: Any
) -> None:
    """§3.2 y §11.3: un retiro «no se edita ni se borra: se reversa con motivo
    y ambos quedan». Nada financiero se borra."""
    shift = open_shift()
    sid = shift["id"]
    _movement(device_client, sid, kind="income", cause="other_income", amount=30_000)
    _movement(device_client, sid, kind="expense", cause="petty_expense", amount=10_000)

    pickup = _pickup(device_client, sid, 50_000).json()
    assert expected_of(sid) == 170_000

    reverse = device_client.post(
        f"{API}/shifts/{sid}/pickups/{pickup['id']}/reverse",
        json={"reason": "Sobre devuelto sin consignar", "authorizer_pin": "9999"},
    )
    assert reverse.status_code == 200, reverse.text
    assert expected_of(sid) == 220_000, "el retiro reversado deja de restar"

    summary = device_client.get(f"{API}/shifts/{sid}").json()
    rows = [p for p in summary["pickups"] if p["id"] == pickup["id"]]
    assert len(rows) == 1, "el retiro reversado sigue existiendo: no se borra"
    assert rows[0]["reversed_at"] is not None
    assert rows[0]["reversed_reason"], "la reversa lleva motivo"
    assert rows[0]["amount"] == 50_000, "el monto original no se reescribe"


# ---------------------------------------------------------------------------
# (d) y (e) El cierre a ciegas: contar sin ver, revelar después
# ---------------------------------------------------------------------------


def test_close_count_never_reveals_expected_difference_or_equation(
    device_client: Any, open_shift: Any
) -> None:
    """§3.2 paso 1: se cuenta **sin ver el esperado** — «mostrar el esperado
    antes de contar invita a cuadrar el conteo»."""
    shift = open_shift()
    resp = _count(device_client, shift["id"], 215_000)
    assert resp.status_code in (200, 201), resp.text

    body = resp.json()
    leaked = deep_keys(body) & {"expected", "expected_cash", "difference", "equation", "counted", "to_deposit"}
    assert not leaked, f"el conteo a ciegas filtró {sorted(leaked)}"
    assert set(body.keys()) == {"count_id"}, "el paso 1 devuelve solo el id del conteo"


def test_review_reveals_the_equation_and_it_closes_exactly(
    device_client: Any, open_shift: Any
) -> None:
    """§3.2 paso 2: el backend revela esperado, diferencia y la ecuación;
    `contado − esperado = diferencia`, sin residuos ni redondeos."""
    shift = open_shift()
    sid = shift["id"]
    _movement(device_client, sid, kind="income", cause="other_income", amount=30_000)
    _movement(device_client, sid, kind="expense", cause="petty_expense", amount=10_000)

    count_id = _count(device_client, sid, 215_000).json()["count_id"]
    review = _review(device_client, sid, count_id)
    assert review.status_code == 200, review.text
    body = review.json()
    eq = body["equation"]

    assert eq["base"] + eq["cash_sales"] + eq["incomes"] - eq["expenses"] - eq["pickups"] == body["expected"]
    assert 215_000 - body["expected"] == body["difference"]
    assert body["expected"] == 220_000
    assert body["difference"] == -5_000


# ---------------------------------------------------------------------------
# (f) La diferencia que la interfaz mostró es la que se confirma
# ---------------------------------------------------------------------------


def test_confirm_with_stale_difference_seen_returns_difference_changed_with_the_new_review(
    device_client: Any, open_shift: Any
) -> None:
    """§3.2: «el cierre recibe la diferencia que la interfaz mostró; si un
    movimiento concurrente la cambió, el backend responde con la nueva»
    (carrera M15 de la referencia, documentada y no resuelta allá)."""
    shift = open_shift()
    sid = shift["id"]

    count_id = _count(device_client, sid, OPENING_FIXED).json()["count_id"]
    seen = _review(device_client, sid, count_id).json()["difference"]
    assert seen == 0

    # Un movimiento entra entre el review y el confirm.
    _movement(device_client, sid, kind="expense", cause="petty_expense", amount=7_000)

    resp = _confirm(device_client, sid, count_id, seen, cause="counting_error")
    assert resp.status_code == 400, resp.text
    error = resp.json()["error"]
    assert error["code"] == "DIFFERENCE_CHANGED"
    assert error["message"], "el mensaje nombra la acción correctiva"
    assert "review" in error, "la respuesta trae la review nueva para volver a preguntar"
    assert error["review"]["difference"] == 7_000


# ---------------------------------------------------------------------------
# (g) Tolerancias: alertan, nunca bloquean
# ---------------------------------------------------------------------------


def test_small_difference_closes_with_unknown_cause(device_client: Any, open_shift: Any) -> None:
    """§3.2: hasta $20.000 se cierra con causa `unknown`."""
    shift = open_shift()
    sid = shift["id"]
    count_id = _count(device_client, sid, OPENING_FIXED + 15_000).json()["count_id"]
    review = _review(device_client, sid, count_id).json()
    assert review["difference"] == 15_000
    assert review["requires_identified_cause"] is False

    resp = _confirm(device_client, sid, count_id, 15_000, cause="unknown")
    assert resp.status_code == 200, resp.text


def test_medium_difference_requires_an_identified_cause(device_client: Any, open_shift: Any) -> None:
    """§3.2: de $20.001 a $100.000 la causa tiene que ser identificada."""
    shift = open_shift()
    sid = shift["id"]
    count_id = _count(device_client, sid, OPENING_FIXED + 50_000).json()["count_id"]

    rejected = _confirm(device_client, sid, count_id, 50_000, cause="unknown")
    assert rejected.status_code == 400, rejected.text
    assert rejected.json()["error"]["code"] == "IDENTIFIED_CAUSE_REQUIRED"
    assert rejected.json()["error"]["message"]

    accepted = _confirm(device_client, sid, count_id, 50_000, cause="change_error")
    assert accepted.status_code == 200, accepted.text


def test_critical_difference_still_closes_and_raises_a_notification(
    device_client: Any, admin_client: Any, open_shift: Any, store: Any
) -> None:
    """§3.2: sobre $100.000 alerta crítica al administrador y **nunca bloquea**
    — «bloquear deja el turno abierto y vendiendo, que es el bug del turno
    abandonado»."""
    shift = open_shift()
    sid = shift["id"]
    count_id = _count(device_client, sid, OPENING_FIXED + 150_000).json()["count_id"]

    resp = _confirm(device_client, sid, count_id, 150_000, cause="change_error")
    assert resp.status_code == 200, resp.text

    notifications = admin_client.get(f"{API}/admin/notifications", params={"store_id": store.id})
    assert notifications.status_code == 200, notifications.text
    types = [n["type"] for n in notifications.json()]
    assert "cash_difference_critical" in types, "la diferencia crítica avisa al administrador"


# ---------------------------------------------------------------------------
# (g bis) El cierre a ciegas no se puede saltear por la puerta de al lado
# ---------------------------------------------------------------------------


def test_the_one_step_close_is_refused_while_blind_close_is_on(
    device_client: Any, open_shift: Any, set_feature: Any
) -> None:
    """§1.2 (`cash.blind_close`: «cierre a ciegas en tres pasos — **apagado**:
    cierre en un paso, igual con causa») y §11.19 («toda función opcional vive
    detrás de su flag, que hace cumplir el backend»).

    El cierre en un paso es el camino de la sede que apagó el cierre a ciegas.
    Si sigue abierto con la función encendida, cualquiera que hable con la API
    cierra sin pasar por `count → review → confirm`: se saltea el conteo a
    ciegas y el control de `DIFFERENCE_CHANGED`. Bloquear el camino de al lado
    es lo único que hace real al cierre a ciegas.

    Iteración 2 (veredicto del Maestro sobre CONFLICT-INTERPRETATION): los dos
    cierres son **excluyentes por flag**, y el rechazo es tipado —
    `400 BLIND_CLOSE_REQUIRED` con `feature: "cash.blind_close"`—, no un 4xx
    cualquiera. Además el turno tiene que **seguir abierto**: un rechazo que
    deja el turno a medio cerrar es peor que no rechazar.
    """
    shift = open_shift()
    sid = shift["id"]

    atajo = device_client.post(
        f"{API}/shifts/{sid}/close",
        json={
            "counted_cash": denoms(OPENING_FIXED),
            "tips_cash_out": 0,
            "closes_day": True,
            "photo": PHOTO,
        },
        headers=idem_headers(),
    )
    assert atajo.status_code == 400, (
        "con `cash.blind_close` encendida, el cierre en un paso tiene que rechazarse "
        f"con 400; respondió {atajo.status_code}: {atajo.text}"
    )
    error = atajo.json()["error"]
    assert error["code"] == "BLIND_CLOSE_REQUIRED", (
        f"el rechazo tiene que ser tipado, no genérico: {error}"
    )
    assert error["message"].strip(), "el mensaje tiene que nombrar la acción correctiva"
    assert error.get("feature") == "cash.blind_close", (
        "el error tiene que nombrar la función que lo exige, como todo gate de flag "
        f"(§11.19): {error}"
    )

    actual = device_client.get(f"{API}/shifts/current").json()
    assert actual is not None and actual["id"] == sid, "el turno rechazado no puede desaparecer"
    sigue = device_client.get(f"{API}/shifts/{sid}").json()
    assert sigue["status"] == "open", (
        f"el turno tiene que seguir abierto después del rechazo, no a medio cerrar: {sigue['status']}"
    )
    assert sigue["counted_cash"] is None and sigue["difference"] is None, (
        "un cierre rechazado no puede dejar el conteo ni la diferencia escritos"
    )


def test_with_blind_close_off_the_one_step_close_is_the_way_and_the_three_steps_are_refused(
    device_client: Any, open_shift: Any, set_feature: Any
) -> None:
    """La otra mitad de la misma regla: apagada la función, el cierre en un
    paso es el camino y los tres pasos responden `400 FEATURE_DISABLED`
    nombrando la función (checklist del pedido 1a)."""
    shift = open_shift()
    sid = shift["id"]
    set_feature("cash.blind_close", False)

    bloqueado = _count(device_client, sid, OPENING_FIXED)
    assert bloqueado.status_code == 400, bloqueado.text
    error = bloqueado.json()["error"]
    assert error["code"] == "FEATURE_DISABLED", error
    assert error.get("feature") == "cash.blind_close", error

    un_paso = device_client.post(
        f"{API}/shifts/{sid}/close",
        json={
            "counted_cash": denoms(OPENING_FIXED),
            "tips_cash_out": 0,
            "closes_day": True,
            "photo": PHOTO,
        },
        headers=idem_headers(),
    )
    assert un_paso.status_code == 200, un_paso.text


# ---------------------------------------------------------------------------
# (h) Foto exigida en el backend, no en la interfaz
# ---------------------------------------------------------------------------


def test_photo_required_on_close_is_enforced_by_the_backend(
    device_client: Any, admin_client: Any, open_shift: Any, store: Any
) -> None:
    """§3.2: «foto obligatoria en cierre y retiro, validada en el backend» (en
    la referencia vivía sólo en la interfaz y la foto se perdía al fallar el
    POST). Configurable por sede: apagada, cierra sin foto."""
    shift = open_shift()
    sid = shift["id"]

    sin_foto = _count(device_client, sid, OPENING_FIXED, photo=None)
    assert sin_foto.status_code == 400, sin_foto.text
    assert sin_foto.json()["error"]["code"] == "PHOTO_REQUIRED"
    assert sin_foto.json()["error"]["message"]

    con_foto = _count(device_client, sid, OPENING_FIXED)
    assert con_foto.status_code in (200, 201), con_foto.text

    # Ahora la sede deja de exigirla: el mismo cierre pasa sin foto.
    settings = admin_client.get(f"{API}/admin/stores/{store.id}/cash-settings").json()
    settings["photo_required_on_close"] = False
    assert admin_client.put(f"{API}/admin/stores/{store.id}/cash-settings", json=settings).status_code == 200

    otra_vez = _count(device_client, sid, OPENING_FIXED, photo=None)
    assert otra_vez.status_code in (200, 201), otra_vez.text


# ---------------------------------------------------------------------------
# (i) Lo que se debe consignar
# ---------------------------------------------------------------------------


def test_to_deposit_is_counted_minus_fixed_base_minus_cash_tips(
    device_client: Any, open_shift: Any
) -> None:
    """§6.1: «cada turno cerrado sabe cuánto debe consignarse = contado − base
    fija − propinas en efectivo retiradas»."""
    shift = open_shift()
    sid = shift["id"]
    counted = OPENING_FIXED + 80_000

    count_id = _count(device_client, sid, counted, tips_cash_out=30_000).json()["count_id"]
    resp = _confirm(device_client, sid, count_id, 80_000, cause="change_error")
    assert resp.status_code == 200, resp.text
    assert resp.json()["to_deposit"] == counted - OPENING_FIXED - 30_000


# ---------------------------------------------------------------------------
# (j) Un solo turno abierto por sede
# ---------------------------------------------------------------------------


def test_one_open_shift_per_store_is_defended_by_a_partial_unique_index() -> None:
    """§11.9: la última línea de defensa es la base, no el servicio — índice
    único parcial sobre `shifts(store_id)` con `status='open'`."""
    from app.shifts.models import Shift

    indexes = Shift.__table__.indexes  # type: ignore[attr-defined]
    index = next((i for i in indexes if i.name == "uq_shifts_one_open_per_store"), None)
    assert index is not None, "falta el índice único parcial de «un turno abierto por sede»"
    assert index.unique is True
    assert [c.name for c in index.columns] == ["store_id"]
    dialect_options = {k: v for k, v in index.dialect_options.items() if "where" in dict(v)}
    assert dialect_options, "el índice tiene que ser parcial (postgresql_where / sqlite_where)"


def test_two_concurrent_opens_leave_exactly_one_winner(race_app: Any) -> None:
    """§3.2 y §11.9 + checklist 1a: «dos `POST /shifts/open` concurrentes: uno
    `200`, otro `409`».

    Corre sobre `race_app` (fixture propia, `tests/audit/conftest.py`) y no
    sobre `device_client`: la fixture compartida `db` entrega **una sola**
    `Session` a todos los requests, y una `Session` de SQLAlchemy no es
    thread-safe — dos hilos sobre ella mueren con `ResourceClosedError` antes
    de llegar al índice único, así que la regla quedaría sin verificar. Acá
    cada request recibe su propia sesión, como en producción.
    """
    client, employee_id = race_app
    payload = {
        "opening_cash": denoms(OPENING_FIXED),
        "cash_reserve": 0,
        "cash_responsible_id": employee_id,
    }

    outcomes: list[str] = []
    lock = threading.Lock()

    def _attempt() -> None:
        try:
            resp = client.post(
                f"{API}/shifts/open", json=payload, headers={"Idempotency-Key": str(uuid.uuid4())}
            )
            result = str(resp.status_code)
        except Exception as exc:  # la request murió: también es un resultado
            result = f"EXC:{type(exc).__name__}"
        with lock:
            outcomes.append(result)

    threads = [threading.Thread(target=_attempt) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    winners = [c for c in outcomes if c in ("200", "201")]
    assert len(winners) == 1, f"exactamente una apertura gana: {outcomes}"

    # La perdedora es un rechazo limpio y declarado en el contrato
    # (`400 SHIFT_ALREADY_OPEN` o `409 SHIFT_OPEN_RACE`), nunca un 500 ni una
    # excepción. Cuál de los dos depende del motor: SQLite serializa las
    # escrituras, así que la segunda request ya ve el turno confirmado y para
    # en la validación (400); en Postgres las dos pueden pasar la validación y
    # la que pierde choca contra el índice único parcial (409). Las dos ramas
    # existen en `app/shifts/service.py: open_shift`.
    losers = [c for c in outcomes if c not in ("200", "201")]
    assert losers == ["400"] or losers == ["409"], (
        f"la perdedora tiene que ser 400 SHIFT_ALREADY_OPEN o 409 SHIFT_OPEN_RACE: {outcomes}"
    )

    # Lo que de verdad no se negocia: quedó UN solo turno abierto en la sede.
    current = client.get(f"{API}/shifts/current")
    assert current.status_code == 200, current.text
    assert current.json() is not None, "la apertura ganadora tiene que haber quedado"


# ---------------------------------------------------------------------------
# (k) Idempotencia: un doble toque no duplica plata
# ---------------------------------------------------------------------------


def test_replaying_an_idempotency_key_does_not_duplicate_the_movement(
    device_client: Any, open_shift: Any, expected_of: Any
) -> None:
    """§11.9: idempotencia en toda escritura que mueve plata; el replay
    devuelve la respuesta original — «el guardián del front es cortesía, no
    garantía»."""
    shift = open_shift()
    sid = shift["id"]
    headers = idem_headers()
    payload = {"kind": "expense", "cause": "petty_expense", "amount": 12_000, "note": "hielo"}

    first = device_client.post(f"{API}/shifts/{sid}/cash-movements", json=payload, headers=headers)
    assert first.status_code in (200, 201), first.text
    second = device_client.post(f"{API}/shifts/{sid}/cash-movements", json=payload, headers=headers)
    assert second.status_code == first.status_code, second.text
    assert second.json() == first.json(), "el replay devuelve la misma respuesta"

    summary = device_client.get(f"{API}/shifts/{sid}").json()
    assert len(summary["movements"]) == 1, "un solo movimiento, no dos"
    assert expected_of(sid) == OPENING_FIXED - 12_000


def test_cash_movement_without_idempotency_key_is_rejected(device_client: Any, open_shift: Any) -> None:
    """CONTRATO-INTERNO §2: sin `Idempotency-Key`, la escritura no entra."""
    shift = open_shift()
    resp = device_client.post(
        f"{API}/shifts/{shift['id']}/cash-movements",
        json={"kind": "expense", "cause": "petty_expense", "amount": 1_000},
    )
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "IDEMPOTENCY_KEY_REQUIRED"


# ---------------------------------------------------------------------------
# (l) Abrir con una base distinta de la fija exige causa tipada
# ---------------------------------------------------------------------------


def test_opening_with_a_different_base_needs_a_typed_cause(
    device_client: Any, identify: Any, employees: dict[str, Any]
) -> None:
    """§3.2 y §11.14: «si la contada difiere de la base fija: justificación con
    causa tipada obligatoria», y el mensaje nombra la acción correctiva."""
    identify(device_client, employees["cashier"])
    base_payload: dict[str, Any] = {
        "opening_cash": denoms(150_000),
        "cash_reserve": 0,
        "cash_responsible_id": employees["cashier"].id,
    }

    rejected = device_client.post(f"{API}/shifts/open", json=base_payload, headers=idem_headers())
    assert rejected.status_code == 400, rejected.text
    error = rejected.json()["error"]
    assert error["code"] == "OPENING_DIFFERENCE_NEEDS_CAUSE"
    assert "causa" in error["message"].lower(), f"el mensaje tiene que nombrar la acción: {error['message']}"

    accepted = device_client.post(
        f"{API}/shifts/open",
        json={**base_payload, "opening_cause": "counting_error"},
        headers=idem_headers(),
    )
    assert accepted.status_code in (200, 201), accepted.text


# ---------------------------------------------------------------------------
# (m) Rescate: cierre administrativo sólo sobre un turno abandonado
# ---------------------------------------------------------------------------


def test_administrative_close_only_applies_to_an_abandoned_shift(
    device_client: Any, admin_client: Any, open_shift: Any, clock: Any
) -> None:
    """§3.7: el cierre administrativo es para el turno abandonado (pasada la
    hora de corte); cierra con el esperado, diferencia 0 y
    `closed_without_count`. Sobre un turno vivo no se puede usar."""
    shift = open_shift()
    sid = shift["id"]
    _movement(device_client, sid, kind="income", cause="other_income", amount=40_000)

    temprano = admin_client.post(
        f"{API}/admin/shifts/{sid}/close-administrative", json={"reason": "probando"}
    )
    assert temprano.status_code == 400, temprano.text
    assert temprano.json()["error"]["code"] == "SHIFT_NOT_STALE"

    clock.advance(days=1)  # más allá de la hora de corte del día siguiente

    tarde = admin_client.post(
        f"{API}/admin/shifts/{sid}/close-administrative",
        json={"reason": "Turno abandonado: nadie cerró"},
    )
    assert tarde.status_code == 200, tarde.text

    summary = admin_client.get(f"{API}/shifts/{sid}").json()
    assert summary["status"] == "closed"
    assert summary["difference"] == 0, "el cierre administrativo no inventa una diferencia"
    assert summary["closed_without_count"] is True
    assert summary["expected_cash"] == 240_000


def test_adjust_opening_rewrites_everything_derived_with_the_same_formula(
    device_client: Any, admin_client: Any, open_shift: Any
) -> None:
    """§3.7: ajustar la apertura «reescribe base, reserva y **todo lo derivado**
    con la misma función del flujo normal». Si el esperado, la diferencia y lo
    que hay que consignar quedaran calculados en otro lado, acá se vería."""
    shift = open_shift()
    sid = shift["id"]
    counted = OPENING_FIXED + 10_000
    count_id = _count(device_client, sid, counted).json()["count_id"]
    assert _confirm(device_client, sid, count_id, 10_000, cause="unknown").status_code == 200

    ajuste = admin_client.post(
        f"{API}/admin/shifts/{sid}/adjust-opening",
        json={"opening_cash": denoms(190_000), "cash_reserve": 0, "reason": "Base mal contada"},
    )
    assert ajuste.status_code == 200, ajuste.text
    body = ajuste.json()

    assert body["opening_cash_total"] == 190_000
    assert body["expected_cash"] == 190_000, "el esperado se recalcula con la base nueva"
    assert body["counted_cash"] - body["expected_cash"] == body["difference"], "la diferencia no queda vieja"
    assert body["to_deposit"] == counted - OPENING_FIXED, "a consignar sigue siendo contado − base fija"


# ---------------------------------------------------------------------------
# Nada financiero se borra
# ---------------------------------------------------------------------------


def test_a_shift_with_activity_cannot_be_deleted(device_client: Any, admin_client: Any, open_shift: Any) -> None:
    """§11.3 y §3.7: cancelar un turno es sólo para el abierto por error, «sin
    ninguna actividad». Con un movimiento adentro, la salida es el cierre
    administrativo, no el borrado."""
    shift = open_shift()
    sid = shift["id"]
    _movement(device_client, sid, kind="expense", cause="petty_expense", amount=3_000)

    resp = admin_client.delete(f"{API}/admin/shifts/{sid}")
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "SHIFT_HAS_ACTIVITY"
    assert resp.json()["error"]["message"]

    assert admin_client.get(f"{API}/shifts/{sid}").status_code == 200, "el turno sigue existiendo"


def test_cancelling_an_empty_shift_is_a_logical_delete(admin_client: Any, open_shift: Any) -> None:
    """§11.3: «nada financiero se borra: baja lógica y auditoría». El turno
    cancelado sigue siendo consultable."""
    shift = open_shift()
    sid = shift["id"]

    resp = admin_client.delete(f"{API}/admin/shifts/{sid}")
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "cancelled"

    summary = admin_client.get(f"{API}/shifts/{sid}")
    assert summary.status_code == 200, "una baja lógica se sigue pudiendo leer"
    assert summary.json()["status"] == "cancelled"

    rows = admin_client.get(f"{API}/admin/audit", params={"entity": "shift"}).json()
    assert any(r["action"] == "cancel" and r["entity_id"] == str(sid) for r in rows), (
        f"la cancelación tiene que quedar en auditoría: {rows}"
    )


# ---------------------------------------------------------------------------
# (n) El sistema nunca calcula deuda de un empleado (CST art. 149)
# ---------------------------------------------------------------------------


def test_no_shift_payload_ever_speaks_of_employee_debt(
    device_client: Any, admin_client: Any, open_shift: Any, store: Any
) -> None:
    """§3.2 y §11.16: «el sistema nunca calcula una deuda del empleado por
    faltantes ni genera descuentos de nómina» (CST art. 149 prohíbe deducir del
    salario sin orden escrita para cada caso)."""
    shift = open_shift()
    sid = shift["id"]
    count_id = _count(device_client, sid, OPENING_FIXED - 40_000).json()["count_id"]
    assert _confirm(device_client, sid, count_id, -40_000, cause="change_error").status_code == 200

    payloads = [
        admin_client.get(f"{API}/shifts/{sid}").json(),
        admin_client.get(f"{API}/admin/shifts", params={"store_id": store.id}).json(),
        admin_client.get(f"{API}/admin/shifts/{sid}/timeline").json(),
    ]
    forbidden = ("debt", "deuda", "owes", "payroll_deduction")
    for payload in payloads:
        keys = {k.lower() for k in deep_keys(payload)}
        for word in forbidden:
            assert not any(word in k for k in keys), f'aparece "{word}" en una respuesta de turno'
            assert not deep_contains_text(payload, word), f'aparece "{word}" en el texto de una respuesta de turno'


# ---------------------------------------------------------------------------
# (o) El esperado es información del responsable y del administrador
# ---------------------------------------------------------------------------


def test_expected_cash_is_hidden_from_an_operator_who_is_not_the_cash_responsible(
    device_client: Any, open_shift: Any, identify: Any, employees: dict[str, Any]
) -> None:
    """Contrato de API 1a: en `GET /shifts/current`, `expected_cash` sólo para
    el administrador o el responsable de caja. Un mesero cualquiera no ve el
    esperado del cajón."""
    open_shift(responsible=employees["cashier"])
    identify(device_client, employees["operator"])

    body = device_client.get(f"{API}/shifts/current").json()
    assert body["expected_cash"] is None, "un operador que no es el responsable no ve el esperado"


def test_the_expected_does_not_leak_to_a_non_responsible_operator_through_pickups(
    device_client: Any, open_shift: Any, identify: Any, employees: dict[str, Any]
) -> None:
    """La misma regla, mirada de cerca: esconder `expected_cash` no sirve de
    nada si el mismo número viaja en `pickups[].expected_at_pickup` dentro del
    mismo `GET /shifts/{id}`."""
    shift = open_shift(responsible=employees["cashier"])
    sid = shift["id"]
    assert _pickup(device_client, sid, 50_000).status_code == 201

    identify(device_client, employees["operator"])  # no es el responsable
    body = device_client.get(f"{API}/shifts/{sid}").json()

    assert body["expected_cash"] is None, "el esperado está deliberadamente oculto para este operador"
    for pickup in body["pickups"]:
        assert pickup.get("expected_at_pickup") is None, (
            f"el esperado se filtró por el retiro: {pickup}"
        )


def test_the_expected_does_not_leak_to_a_non_responsible_operator_through_handovers(
    device_client: Any, open_shift: Any, identify: Any, employees: dict[str, Any]
) -> None:
    """Y tampoco por `handovers[].breakdown`, que congela la ecuación entera
    (`base`, `expected`, `counted`, `difference`) del §3.2."""
    shift = open_shift(responsible=employees["cashier"])
    sid = shift["id"]
    arqueo = device_client.post(
        f"{API}/shifts/{sid}/handovers",
        json={"kind": "spot_check", "counted_cash": denoms(150_000), "authorizer_pin": "9999"},
        headers=idem_headers(),
    )
    assert arqueo.status_code == 201, arqueo.text

    identify(device_client, employees["operator"])  # no es el responsable
    body = device_client.get(f"{API}/shifts/{sid}").json()

    assert body["expected_cash"] is None, "el esperado está deliberadamente oculto para este operador"
    for handover in body["handovers"]:
        leaked = deep_keys(handover) & {"expected", "difference"}
        assert not leaked, f"el esperado se filtró por el relevo: {sorted(leaked)}"


def test_with_blind_close_on_the_cash_responsible_does_not_see_the_expected(
    device_client: Any, open_shift: Any, employees: dict[str, Any]
) -> None:
    """**O-1, resuelto por default en 1b-1** (`CONTRATO-INTERNO-1b-1.md §2.4
    «Caja»`, §5.8): con `cash.blind_close` encendida el cierre es a ciegas, y
    un cierre a ciegas al que se llega mirando el esperado toda la noche no es
    a ciegas. El responsable de caja **no** ve `expected_cash`, ni `sales`, ni
    `tips` en `GET /shifts/current` ni en `GET /shifts/{id}`: lo ve recién en
    el paso 2 del cierre (`review`).

    El `org` de los tests tiene perfil `full`, donde `cash.blind_close` viene
    encendida: éste es el comportamiento por default del producto.

    Invierte deliberadamente el invariante que 1a había escrito acá
    (`test_expected_cash_is_visible_to_the_cash_responsible`): la tensión
    entre el contrato de 1a y §3.2 estaba declarada como O-1 y el dueño de la
    spec la resolvió a favor del cierre a ciegas.
    """
    shift = open_shift(responsible=employees["cashier"])

    actual = device_client.get(f"{API}/shifts/current").json()
    assert actual["expected_cash"] is None, (
        "con cierre a ciegas el responsable no ve el esperado antes del paso 2"
    )
    assert actual["sales"] is None, "ni las ventas del turno, que dejan deducir el esperado"
    assert actual["tips"] is None, "ni las propinas, por la misma razón"

    detalle = device_client.get(f"{API}/shifts/{shift['id']}").json()
    assert detalle["expected_cash"] is None
    assert detalle["sales"] is None
    assert detalle["tips"] is None


def test_with_blind_close_off_the_cash_responsible_sees_the_expected_again(
    device_client: Any, open_shift: Any, employees: dict[str, Any], set_feature: Any
) -> None:
    """La otra mitad de O-1: la sede que **no** cierra a ciegas (perfil
    `basic`, o la flag apagada a mano) vuelve al contrato de 1a — el
    responsable ve su esperado, sus ventas y sus propinas. La flag es la única
    diferencia; no hay un segundo predicado escondido
    (`app.shifts.router._can_see_expected`).
    """
    set_feature("cash.blind_close", False)
    shift = open_shift(responsible=employees["cashier"])

    actual = device_client.get(f"{API}/shifts/current").json()
    assert actual["expected_cash"] == OPENING_FIXED, (
        "sin cierre a ciegas el responsable sí ve el esperado de su cajón"
    )
    assert actual["sales"] is not None and actual["sales"]["cash"] == 0, (
        "y las ventas del turno, que todavía son cero"
    )
    assert actual["tips"] is not None and actual["tips"]["cash"] == 0

    detalle = device_client.get(f"{API}/shifts/{shift['id']}").json()
    assert detalle["expected_cash"] == OPENING_FIXED
    assert detalle["sales"] is not None


def test_the_expected_reaches_the_responsible_only_in_step_two_of_the_close(
    device_client: Any, open_shift: Any, employees: dict[str, Any]
) -> None:
    """Cierre de O-1: con la flag encendida el esperado no desaparece del
    sistema, se **posterga**. El paso 1 (`close/count`) sigue sin revelarlo y
    el paso 2 (`review`) se lo entrega al mismo responsable que no lo veía en
    `current`. Sin esta mitad, «no lo ve» sería indistinguible de «no existe».
    """
    shift = open_shift(responsible=employees["cashier"])
    sid = shift["id"]

    assert device_client.get(f"{API}/shifts/current").json()["expected_cash"] is None

    conteo = _count(device_client, sid, OPENING_FIXED)
    assert conteo.status_code in (200, 201), conteo.text
    count_id = conteo.json()["count_id"]
    assert "expected" not in deep_keys(conteo.json()), "el paso 1 sigue siendo a ciegas"

    review = _review(device_client, sid, count_id)
    assert review.status_code == 200, review.text
    assert review.json()["expected"] == OPENING_FIXED, (
        "el paso 2 le revela el esperado al responsable: ahí termina la ceguera"
    )


def test_expected_cash_is_visible_to_the_admin(
    admin_client: Any, open_shift: Any, employees: dict[str, Any]
) -> None:
    """Contrato de API 1a: el administrador ve el esperado del turno."""
    shift = open_shift(responsible=employees["cashier"])

    admin_view = admin_client.get(f"{API}/shifts/{shift['id']}").json()
    assert admin_view["expected_cash"] == OPENING_FIXED, "el administrador ve el esperado"


def test_reading_the_current_shift_does_not_extend_the_person_session(
    device_client: Any, open_shift: Any, employees: dict[str, Any], clock: Any, db: Any
) -> None:
    """§2.1: la persona activa expira «cuando pasan N minutos **sin uso**».

    `GET /shifts/current` es la consulta que el POS repite por polling: si
    renovara la ventana, una tablet abandonada con la pantalla del turno
    abierta nunca expiraría y todo lo que se tecleara después seguiría yendo a
    nombre de quien se fue (atribución cruzada, auditoría H9 de la
    referencia). La renovación es de `current_operator` —el uso real—, no de
    la lectura. Verificado con el reloj controlado y leyendo la fila
    `device_sessions`, no la respuesta.

    De paso encarna O-1 (`CONTRATO-INTERNO-1b-1.md §5.8`): con
    `cash.blind_close` encendida —el default del perfil `full`, el de estos
    tests— el responsable de caja **no** ve `expected_cash` en
    `GET /shifts/current`; la lectura sigue siendo legítima (el turno, el
    roster, los movimientos) y sigue sin renovar la ventana.
    """
    from app.auth.models import DeviceSession

    shift = open_shift(responsible=employees["cashier"])
    sid = shift["id"]

    def _expires_at() -> Any:
        db.expire_all()
        row = db.execute(select(DeviceSession)).scalars().first()
        assert row is not None and row.employee_id == employees["cashier"].id
        return row.employee_expires_at

    vence_al_abrir = _expires_at()
    assert vence_al_abrir is not None, "identificarse tiene que fijar una expiración"

    clock.advance(minutes=1)

    lectura = device_client.get(f"{API}/shifts/current")
    assert lectura.status_code == 200, lectura.text
    assert lectura.json()["expected_cash"] is None, (
        "con `cash.blind_close` encendida el responsable no ve el esperado en "
        "`/shifts/current` (O-1 resuelto en 1b-1)"
    )
    assert _expires_at() == vence_al_abrir, (
        "una lectura no puede correr la expiración por inactividad: si lo hiciera, "
        "el polling del POS mantendría viva para siempre la sesión de quien ya se fue"
    )

    # Contraprueba: el uso real (una escritura, `current_operator`) sí la renueva.
    uso = _movement(device_client, sid, kind="income", cause="other_income", amount=1_000)
    assert uso.status_code in (200, 201), uso.text
    assert _expires_at() > vence_al_abrir, (
        "una escritura sí renueva la ventana de inactividad (sliding window de §2.1)"
    )


def test_a_handover_moves_the_responsibility_and_with_blind_close_off_the_expected_moves_with_it(
    device_client: Any, open_shift: Any, identify: Any, employees: dict[str, Any], set_feature: Any
) -> None:
    """§3.2: el relevo «cambia el responsable de caja» con conteo de por medio.

    Dos mitades de la misma regla, y la segunda es la que importa para el
    control: después del relevo el esperado es de quien **ahora** responde por
    el cajón. Si el anterior siguiera viéndolo, el relevo sería papeleo; si el
    nuevo no lo viera, respondería por una plata que no puede mirar.

    Esta mitad se mide con `cash.blind_close` **apagada**, porque es la única
    configuración en la que el responsable ve el esperado fuera del cierre
    (O-1, `CONTRATO-INTERNO-1b-1.md §5.8`). La variante con la flag encendida
    está en el test siguiente.
    """
    set_feature("cash.blind_close", False)
    shift = open_shift(responsible=employees["cashier"])
    sid = shift["id"]

    relevo = device_client.post(
        f"{API}/shifts/{sid}/handovers",
        json={
            "kind": "handover",
            "counted_cash": denoms(OPENING_FIXED),
            "new_responsible_id": employees["operator2"].id,
            # Inicio por rol (0027): quien recibe el cajón confirma con su
            # PIN. Se agrega el dato que el contrato ahora exige; no cambia
            # ninguna aserción de este invariante.
            "new_responsible_pin": "3333",
        },
        headers=idem_headers(),
    )
    assert relevo.status_code == 201, relevo.text
    cuerpo = relevo.json()
    assert cuerpo["kind"] == "handover", f"el tipo se guarda y se devuelve tal cual: {cuerpo}"
    assert cuerpo["from_responsible"]["id"] == employees["cashier"].id
    assert cuerpo["new_responsible"]["id"] == employees["operator2"].id

    # El turno quedó a nombre del nuevo responsable.
    admin_ajeno = device_client.get(f"{API}/shifts/{sid}").json()
    assert admin_ajeno["cash_responsible"]["id"] == employees["operator2"].id

    # El anterior responsable deja de ver el esperado…
    identify(device_client, employees["cashier"])
    anterior = device_client.get(f"{API}/shifts/current").json()
    assert anterior["expected_cash"] is None, (
        "quien entregó el cajón ya no responde por él y deja de ver el esperado"
    )
    detalle_anterior = device_client.get(f"{API}/shifts/{sid}").json()
    assert detalle_anterior["expected_cash"] is None
    assert all(h["breakdown"] is None for h in detalle_anterior["handovers"]), (
        "ni por el desglose congelado del relevo (que trae `expected` y `difference`)"
    )

    # …y el nuevo pasa a verlo.
    identify(device_client, employees["operator2"])
    nuevo = device_client.get(f"{API}/shifts/current").json()
    assert nuevo["expected_cash"] == OPENING_FIXED, (
        "el nuevo responsable ve el esperado del cajón por el que ahora responde"
    )
    assert nuevo["cash_responsible"]["id"] == employees["operator2"].id


def test_with_blind_close_on_a_handover_hides_the_expected_from_both_responsibles(
    device_client: Any, admin_client: Any, open_shift: Any, identify: Any, employees: dict[str, Any]
) -> None:
    """La misma regla bajo el default del producto (O-1, §5.8): el relevo
    sigue moviendo la responsabilidad —eso no depende de ninguna flag— pero
    con `cash.blind_close` encendida **ninguno de los dos** ve el esperado ni
    el desglose congelado del relevo en `current`/`{id}`. El único que lo ve
    es el administrador, que no cuenta el cajón.

    Que el relevo mueva la responsabilidad se comprueba por `cash_responsible`
    y por el cuerpo del relevo, no por quién ve el número: si el invariante se
    escribiera sólo sobre la visibilidad, apagar el esperado lo volvería
    verde por accidente.
    """
    shift = open_shift(responsible=employees["cashier"])
    sid = shift["id"]

    relevo = device_client.post(
        f"{API}/shifts/{sid}/handovers",
        json={
            "kind": "handover",
            "counted_cash": denoms(OPENING_FIXED),
            "new_responsible_id": employees["operator2"].id,
            # Inicio por rol (0027): quien recibe el cajón confirma con su
            # PIN. Se agrega el dato que el contrato ahora exige; no cambia
            # ninguna aserción de este invariante.
            "new_responsible_pin": "3333",
        },
        headers=idem_headers(),
    )
    assert relevo.status_code == 201, relevo.text
    assert relevo.json()["new_responsible"]["id"] == employees["operator2"].id

    identify(device_client, employees["cashier"])
    anterior = device_client.get(f"{API}/shifts/{sid}").json()
    assert anterior["expected_cash"] is None
    assert all(h["breakdown"] is None for h in anterior["handovers"])

    identify(device_client, employees["operator2"])
    nuevo = device_client.get(f"{API}/shifts/current").json()
    assert nuevo["cash_responsible"]["id"] == employees["operator2"].id, (
        "el relevo movió la responsabilidad aunque el esperado siga oculto"
    )
    assert nuevo["expected_cash"] is None, (
        "el nuevo responsable tampoco ve el esperado: cierra a ciegas como el anterior"
    )
    assert nuevo["sales"] is None and nuevo["tips"] is None

    vista_admin = admin_client.get(f"{API}/shifts/{sid}").json()
    assert vista_admin["expected_cash"] == OPENING_FIXED, (
        "el administrador, que no cuenta el cajón, sí lo ve siempre"
    )
    assert any(h["breakdown"] is not None for h in vista_admin["handovers"]), (
        "y ve el desglose congelado del relevo, que es su herramienta de control"
    )
