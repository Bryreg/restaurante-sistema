"""Cierre a ciegas en tres pasos: count no revela el esperado, review sí,
confirm valida la diferencia vista y las tolerancias; foto exigida; que es
la única manera de cerrar; y el comportamiento con `cash.handovers` apagado.
"""

from __future__ import annotations

from sqlalchemy.orm import Session

from app.shifts.models import Shift
from tests.shifts.conftest import idem


def _open(db: Session) -> Shift:
    shift = db.query(Shift).filter(Shift.status == "open").order_by(Shift.id.desc()).first()
    assert shift is not None
    return shift


def _count(
    device_client, shift_id: int, *, total: int, photo: str | None = "foto.jpg", card: int | None = None
) -> int:
    cuerpo: dict = {
        "counted_cash": {"denominations": [{"value": 10000, "count": total // 10000}], "total": total},
        "tips_cash_out": 0,
        "photo": photo,
    }
    if card is not None:
        cuerpo["counted_card"] = card
    resp = device_client.post(
        f"/api/v1/shifts/{shift_id}/close/count",
        json=cuerpo,
        headers=idem(),
    )
    assert resp.status_code in (200, 201), resp.text
    return resp.json()["count_id"]


def test_close_count_hides_expected_and_review_reveals_it(device_client, open_shift, db: Session) -> None:
    open_shift(total=200_000, denominations=[{"value": 10000, "count": 20}])
    shift = _open(db)

    count_id = _count(device_client, shift.id, total=200_000)
    count_resp = device_client.post(
        f"/api/v1/shifts/{shift.id}/close/count",
        json={"counted_cash": {"denominations": [{"value": 10000, "count": 20}], "total": 200_000}, "tips_cash_out": 0, "photo": "x.jpg"},
        headers=idem(),
    )
    assert set(count_resp.json().keys()) == {"count_id"}

    review = device_client.get(f"/api/v1/shifts/{shift.id}/close/{count_id}/review")
    assert review.status_code == 200
    body = review.json()
    assert body["expected"] == 200_000
    assert body["difference"] == 0
    assert body["requires_cause"] is False
    assert body["requires_identified_cause"] is False
    assert body["is_critical"] is False


def test_confirm_with_stale_difference_seen_returns_difference_changed(device_client, open_shift, db: Session) -> None:
    open_shift(total=200_000, denominations=[{"value": 10000, "count": 20}])
    shift = _open(db)
    count_id = _count(device_client, shift.id, total=200_000)

    # Un movimiento concurrente cambia el esperado entre el conteo y la confirmación.
    device_client.post(
        f"/api/v1/shifts/{shift.id}/cash-movements",
        json={"kind": "income", "cause": "other_income", "amount": 5_000, "note": "venta tardía"},
        headers=idem(),
    )

    confirm = device_client.post(
        f"/api/v1/shifts/{shift.id}/close/{count_id}/confirm",
        json={"difference_seen": 0, "cause": "unknown", "closes_day": False},
    )
    assert confirm.status_code == 400
    body = confirm.json()
    assert body["error"]["code"] == "DIFFERENCE_CHANGED"
    assert "review" in body["error"].get("extra", body["error"])


def test_within_unknown_tolerance_closes_with_unknown_cause(device_client, open_shift, db: Session) -> None:
    open_shift(total=200_000, denominations=[{"value": 10000, "count": 20}])
    shift = _open(db)
    # Diferencia de 10.000: dentro de tolerance_unknown_cause (20.000 por defecto).
    count_id = _count(device_client, shift.id, total=210_000)

    review = device_client.get(f"/api/v1/shifts/{shift.id}/close/{count_id}/review").json()
    assert review["difference"] == 10_000
    assert review["requires_cause"] is True
    assert review["requires_identified_cause"] is False

    confirm = device_client.post(
        f"/api/v1/shifts/{shift.id}/close/{count_id}/confirm",
        json={"difference_seen": review["difference"], "cause": "unknown", "closes_day": False},
    )
    assert confirm.status_code in (200, 201), confirm.text


def test_between_tolerances_requires_identified_cause(device_client, open_shift, db: Session) -> None:
    open_shift(total=200_000, denominations=[{"value": 10000, "count": 20}])
    shift = _open(db)
    # Diferencia de 50.000: entre tolerance_unknown_cause (20.000) y
    # critical_difference (100.000) -> causa identificada obligatoria.
    count_id = _count(device_client, shift.id, total=250_000)

    review = device_client.get(f"/api/v1/shifts/{shift.id}/close/{count_id}/review").json()
    assert review["requires_identified_cause"] is True
    assert review["is_critical"] is False

    rejected = device_client.post(
        f"/api/v1/shifts/{shift.id}/close/{count_id}/confirm",
        json={"difference_seen": review["difference"], "cause": "unknown", "closes_day": False},
    )
    assert rejected.status_code == 400
    assert rejected.json()["error"]["code"] == "IDENTIFIED_CAUSE_REQUIRED"

    accepted = device_client.post(
        f"/api/v1/shifts/{shift.id}/close/{count_id}/confirm",
        json={"difference_seen": review["difference"], "cause": "counting_error", "closes_day": False},
    )
    assert accepted.status_code in (200, 201), accepted.text


def test_over_critical_still_closes_and_is_flagged(device_client, open_shift, db: Session) -> None:
    open_shift(total=200_000, denominations=[{"value": 10000, "count": 20}])
    shift = _open(db)
    # Diferencia de 150.000: sobre critical_difference (100.000) -> cierra
    # igual (nunca bloquea) y queda marcada como crítica.
    count_id = _count(device_client, shift.id, total=350_000)

    review = device_client.get(f"/api/v1/shifts/{shift.id}/close/{count_id}/review").json()
    assert review["is_critical"] is True

    confirm = device_client.post(
        f"/api/v1/shifts/{shift.id}/close/{count_id}/confirm",
        json={"difference_seen": review["difference"], "cause": "counting_error", "closes_day": False},
    )
    assert confirm.status_code in (200, 201), confirm.text


def test_close_photo_required_when_store_setting_is_on(device_client, open_shift, db: Session, store) -> None:
    # La casilla de la sede es la única fuente (la función `cash.photo_required`
    # se retiró); viene encendida por defecto.
    open_shift(total=200_000, denominations=[{"value": 10000, "count": 20}])
    shift = _open(db)

    resp = device_client.post(
        f"/api/v1/shifts/{shift.id}/close/count",
        json={"counted_cash": {"denominations": [{"value": 10000, "count": 20}], "total": 200_000}, "tips_cash_out": 0},
        headers=idem(),
    )
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "PHOTO_REQUIRED"


def test_close_photo_not_required_where_the_retired_flag_was_off(
    device_client, open_shift, db: Session, set_feature, store
) -> None:
    # Datos de antes: la función `cash.photo_required` (retirada) apagada en la
    # sede ganaba sobre la casilla encendida. Se pliega en la casilla y la foto
    # sigue sin pedirse.
    set_feature("cash.photo_required", False, store_id=store.id)
    open_shift(total=200_000, denominations=[{"value": 10000, "count": 20}])
    shift = _open(db)

    resp = device_client.post(
        f"/api/v1/shifts/{shift.id}/close/count",
        json={"counted_cash": {"denominations": [{"value": 10000, "count": 20}], "total": 200_000}, "tips_cash_out": 0},
        headers=idem(),
    )
    assert resp.status_code in (200, 201), resp.text


def test_handovers_disabled_returns_feature_disabled(device_client, employees, open_shift, db: Session, set_feature, store) -> None:
    set_feature("cash.handovers", False, store_id=store.id)
    open_shift()
    shift = _open(db)

    resp = device_client.post(
        f"/api/v1/shifts/{shift.id}/handovers",
        json={
            "kind": "handover",
            "counted_cash": {"denominations": [{"value": 50000, "count": 4}], "total": 200_000},
            "new_responsible_id": employees["operator"].id,
            "new_responsible_pin": "2222",
        },
        headers=idem(),
    )
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "FEATURE_DISABLED"


def test_the_blind_close_is_the_only_way_to_close_even_with_the_old_flag_saved_off(
    device_client, open_shift, db: Session, set_feature, store
) -> None:
    """Decisión del dueño (cierre «igual al café»): hay UNA sola manera de
    cerrar, a ciegas en tres pasos. El cierre en un paso ya no existe, y una
    fila vieja de `cash.blind_close` apagada no cambia nada: el conteo, la
    revisión y la confirmación siguen abiertos."""
    set_feature("cash.blind_close", False, store_id=store.id)
    open_shift(total=200_000, denominations=[{"value": 10000, "count": 20}])
    shift = _open(db)

    gone = device_client.post(
        f"/api/v1/shifts/{shift.id}/close",
        json={
            "counted_cash": {"denominations": [{"value": 10000, "count": 20}], "total": 200_000},
            "tips_cash_out": 0,
            "closes_day": False,
            "photo": "x.jpg",
        },
        headers=idem(),
    )
    assert gone.status_code in (404, 405), gone.text
    db.refresh(shift)
    assert shift.status == "open"

    count_id = _count(device_client, shift.id, total=200_000)
    review = device_client.get(f"/api/v1/shifts/{shift.id}/close/{count_id}/review")
    assert review.status_code == 200, review.text
    assert (review.json()["expected"], review.json()["difference"]) == (200_000, 0)
    confirm = device_client.post(
        f"/api/v1/shifts/{shift.id}/close/{count_id}/confirm", json={"difference_seen": 0, "closes_day": False}
    )
    assert confirm.status_code == 200, confirm.text
    db.refresh(shift)
    assert shift.status == "closed"


# ---------------------------------------------------------------------------
# El lote del datáfono trae la propina adentro
# ---------------------------------------------------------------------------
#
# Encontrado jugando un día de venta: se cobró una mesa con tarjeta, $116.000
# de venta y $10.741 de propina, y al cerrar el datáfono marcaba $126.741 —
# porque eso es lo que se le pasó a la tarjeta—. El cierre comparaba contra
# `sales.card` sola y reportaba una diferencia de $10.741, al peso la propina.
# Una diferencia que aparece TODOS los días enseña a ignorar las diferencias,
# que es justo lo que el arqueo a ciegas existe para evitar.
#
# El esperado del EFECTIVO no se toca: la propina en efectivo se salda por
# `tips_cash_out`/`to_deposit`, como siempre.


def _pagar_con_tarjeta_y_propina(device_client, db: Session, *, venta: int, propina: int) -> None:
    from tests.shifts.test_tips import _make_product, _pay_with_tip
    from app.stores.models import Store

    store = db.query(Store).first()
    assert store is not None
    product_id = _make_product(db, store, price=venta)
    _pay_with_tip(device_client, product_id, method="card", tip_amount=propina)


def test_card_expected_includes_card_tips(device_client, open_shift, db: Session) -> None:
    open_shift(total=200_000, denominations=[{"value": 10000, "count": 20}])
    shift = _open(db)
    _pagar_con_tarjeta_y_propina(device_client, db, venta=116_000, propina=10_741)

    count_id = _count(device_client, shift.id, total=200_000, card=126_741)
    body = device_client.get(f"/api/v1/shifts/{shift.id}/close/{count_id}/review").json()

    assert body["card"]["registered"] == 126_741, "el lote del datáfono trae la propina adentro"
    assert body["card"]["sales"] == 116_000
    assert body["card"]["tips"] == 10_741
    assert body["card"]["difference"] == 0, "un turno sin errores no puede cerrar con la propina como diferencia"

    # Y el efectivo no se movió: la propina fue por tarjeta, no salió del cajón.
    assert body["expected"] == 200_000
    assert body["difference"] == 0


def test_card_difference_still_catches_a_real_gap(device_client, open_shift, db: Session) -> None:
    """El arreglo no puede tapar un faltante de verdad."""
    open_shift(total=200_000, denominations=[{"value": 10000, "count": 20}])
    shift = _open(db)
    _pagar_con_tarjeta_y_propina(device_client, db, venta=116_000, propina=10_741)

    count_id = _count(device_client, shift.id, total=200_000, card=120_000)
    body = device_client.get(f"/api/v1/shifts/{shift.id}/close/{count_id}/review").json()

    assert body["card"]["registered"] == 126_741
    assert body["card"]["difference"] == -6_741
