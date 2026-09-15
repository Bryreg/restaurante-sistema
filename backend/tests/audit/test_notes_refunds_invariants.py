"""Invariantes de las notas y de las devoluciones pendientes (pedido 1b-2).

Rol Contador + Legal. Dos reglas que se rompen juntas y se pagan por
separado:

1. **Un documento emitido es inmutable** (`docs/SPEC-NEGOCIO.md §8.3`, §11.3,
   art. 616-1 ET): «Toda corrección va por nota, nunca editando ni borrando un
   documento expedido». La nota reversa: el original queda `reversed` y
   **ningún otro campo suyo cambia**. Si el sistema pudiera reescribir un
   total, el comprobante dejaría de ser evidencia y la contabilidad del mes
   dejaría de cuadrar contra la caja del día.
2. **La plata se devuelve siempre** (§3.5, §6.3): en efectivo con turno
   abierto, egreso `refund` en ESE turno; sin turno abierto, **devolución
   pendiente** que se salda después desde un turno (egreso en el turno que la
   salda, nunca en el original) o de la mano del dueño. «A diferencia de la
   referencia, una nota nunca reescribe los totales de un turno cerrado».

Ítems literales del checklist de `features/fase-1b-venta/spec.md` que viven
acá: «Nota sin turno abierto → devolución pendiente; `settle` desde un turno
crea el egreso `refund` en ese turno y no toca el original».
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import func, select

from tests.audit.conftest import (
    NO_TIP,
    add_items,
    create_order,
    denoms,
    idem_headers,
    pay,
)

API = "/api/v1"

PHOTO = "data:image/png;base64,AAAA"


def _sell(client: Any, product_id: int, *, qty: int = 1) -> dict[str, Any]:
    order = create_order(client, channel="counter").json()
    order = add_items(client, order, [{"product_id": product_id, "qty": qty}]).json()
    resp = pay(
        client,
        order["id"],
        splits=[{"method": "cash", "amount": order["totals"]["total"]}],
        tip=NO_TIP,
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def _note(admin_client: Any, document_id: int, *, kind: str = "adjustment", **extra: Any) -> Any:
    printable = admin_client.get(f"{API}/documents/{document_id}")
    assert printable.status_code == 200, printable.text
    lines = [{"item_id": line["item_id"], "used": True} for line in printable.json()["lines"]]
    body: dict[str, Any] = {"kind": kind, "reason": "Plato devuelto por el cliente", "lines": lines}
    body.update(extra)
    return admin_client.post(
        f"{API}/admin/documents/{document_id}/notes", json=body, headers=idem_headers()
    )


def _close_shift(device_client: Any, shift_id: int, counted: int) -> None:
    """Cierre a ciegas en tres pasos (el default del perfil `full`)."""
    count = device_client.post(
        f"{API}/shifts/{shift_id}/close/count",
        json={"counted_cash": denoms(counted), "tips_cash_out": 0, "photo": PHOTO},
        headers=idem_headers(),
    )
    assert count.status_code in (200, 201), count.text
    count_id = count.json()["count_id"]
    review = device_client.get(f"{API}/shifts/{shift_id}/close/{count_id}/review")
    assert review.status_code == 200, review.text
    confirm = device_client.post(
        f"{API}/shifts/{shift_id}/close/{count_id}/confirm",
        json={
            "difference_seen": review.json()["difference"],
            "closes_day": True,
            "close_cause": "unknown",
            "close_note": "auditoría",
        },
    )
    assert confirm.status_code in (200, 201), confirm.text


# ---------------------------------------------------------------------------
# (a) La nota reversa; nunca edita ni borra (§8.3, §11.3)
# ---------------------------------------------------------------------------


def test_a_note_reverses_the_original_without_touching_a_single_field_of_it(
    device_client: Any, admin_client: Any, db: Any, open_shift: Any, sales_products: Any
) -> None:
    """§8.3: «Toda corrección va por nota, nunca editando ni borrando un
    documento expedido»; §3.5: «El documento original queda `reversed`; nada
    se borra».

    Se comparan **todos** los campos imprimibles del original antes y después
    de la nota. Lo único que puede moverse es el `status`, y eso porque
    "reversado" es un hecho nuevo sobre el documento, no una corrección de lo
    que decía: el papel que el cliente se llevó sigue diciendo exactamente lo
    mismo.
    """
    from app.fiscal.models import FiscalDocument

    open_shift()
    venta = _sell(device_client, sales_products["inc8"].id, qty=2)
    doc_id = venta["document"]["id"]

    antes = admin_client.get(f"{API}/documents/{doc_id}").json()

    nota = _note(admin_client, doc_id)
    assert nota.status_code == 201, nota.text
    cuerpo = nota.json()
    assert cuerpo["reverses_document_id"] == doc_id
    assert cuerpo["document_type"] == "adjustment_note"
    assert cuerpo["reason"], "la nota lleva su motivo declarado (§3.5, causa tipada + texto)"

    despues = admin_client.get(f"{API}/documents/{doc_id}").json()
    for campo in sorted(set(antes) & set(despues)):
        assert despues[campo] == antes[campo], (
            f"la nota cambió `{campo}` del documento original: un documento expedido es inmutable"
        )

    db.expire_all()
    original = db.get(FiscalDocument, doc_id)
    assert original is not None
    assert original.status == "reversed", "el original queda reversado, no borrado"
    assert original.number == antes["number"] and original.total == antes["total"]

    # Y la nota **suma** lo que el documento ya decía: no vuelve a calcular
    # impuesto ni base (la única matemática sigue siendo `app.orders.money`).
    assert cuerpo["total"] == antes["total"]
    assert cuerpo["tax_total"] == antes["tax_total"]
    assert cuerpo["subtotal"] == antes["subtotal"]


def test_a_note_takes_its_own_consecutive_and_never_a_number_of_the_sale_series(
    device_client: Any, admin_client: Any, db: Any, open_shift: Any, sales_products: Any
) -> None:
    """§8.3: «nota de ajuste (corrige un documento equivalente)… con
    numeración propia sin huecos».

    Dos ventas, una nota sobre la primera: la nota arranca en 1 de SU serie y
    la venta siguiente toma el 3 de la suya. Si la nota consumiera un número
    de la serie de la venta, la numeración que la DIAN revisa quedaría con un
    salto — y un salto no se explica con un correo.
    """
    from app.fiscal.models import FiscalDocument, FiscalDocumentType

    open_shift()
    primera = _sell(device_client, sales_products["inc8"].id)
    segunda = _sell(device_client, sales_products["iva19"].id)
    assert [primera["document"]["number"], segunda["document"]["number"]] == [1, 2]

    nota = _note(admin_client, primera["document"]["id"])
    assert nota.status_code == 201, nota.text
    assert nota.json()["number"] == 1, "la nota tiene su propia serie, que arranca en su propio rango"
    assert nota.json()["prefix"] != primera["document"]["prefix"]

    tercera = _sell(device_client, sales_products["inc8"].id)
    assert tercera["document"]["number"] == 3, (
        "la serie de la venta siguió donde estaba: la nota no le movió el consecutivo"
    )

    db.expire_all()
    ventas = sorted(
        row.number
        for row in db.execute(
            select(FiscalDocument).where(
                FiscalDocument.document_type == FiscalDocumentType.POS_EQUIVALENT
            )
        ).scalars()
    )
    assert ventas == [1, 2, 3], ventas


def test_a_second_note_on_the_same_document_is_a_400_and_the_kind_has_to_match(
    device_client: Any, admin_client: Any, open_shift: Any, sales_products: Any
) -> None:
    """§8.3: la nota de ajuste corrige un **documento equivalente**; la nota
    crédito y la nota débito corrigen una **factura**. Cruzarlos no es un
    detalle de tipo: es emitir un documento que la DIAN no puede casar con su
    original.

    Y un documento ya reversado no se reversa de nuevo (`400`, nunca `500`):
    corregir dos veces el mismo comprobante deja dos notas que se anulan
    entre sí en los reportes y ninguna que explique la plata.
    """
    open_shift()
    venta = _sell(device_client, sales_products["inc8"].id)
    doc_id = venta["document"]["id"]

    cruzada = _note(admin_client, doc_id, kind="credit")
    assert cruzada.status_code == 400, cruzada.text
    assert cruzada.json()["error"]["code"] == "NOTE_KIND_MISMATCH", cruzada.text

    primera = _note(admin_client, doc_id)
    assert primera.status_code == 201, primera.text

    repetida = _note(admin_client, doc_id)
    assert repetida.status_code == 400, repetida.text
    assert repetida.json()["error"]["code"] == "DOCUMENT_ALREADY_REVERSED", repetida.text


def test_replaying_the_idempotency_key_of_a_note_does_not_issue_a_second_one(
    device_client: Any, admin_client: Any, db: Any, open_shift: Any, sales_products: Any
) -> None:
    """`AGENTS.md` / §11.9: «`Idempotency-Key` en toda escritura que mueve
    plata o estado». Una nota mueve plata (devuelve) y estado (reversa): el
    doble clic del administrador no puede emitir dos notas ni consumir dos
    consecutivos.
    """
    from app.fiscal.models import FiscalDocument, FiscalDocumentType

    open_shift()
    venta = _sell(device_client, sales_products["inc8"].id)
    doc_id = venta["document"]["id"]

    printable = admin_client.get(f"{API}/documents/{doc_id}").json()
    body = {
        "kind": "adjustment",
        "reason": "Doble clic del administrador",
        "lines": [{"item_id": line["item_id"], "used": True} for line in printable["lines"]],
    }
    headers = idem_headers()

    primera = admin_client.post(f"{API}/admin/documents/{doc_id}/notes", json=body, headers=headers)
    assert primera.status_code == 201, primera.text
    segunda = admin_client.post(f"{API}/admin/documents/{doc_id}/notes", json=body, headers=headers)
    assert segunda.status_code == 201, segunda.text
    assert segunda.json()["id"] == primera.json()["id"], "la repetición devuelve la nota guardada"
    assert segunda.json()["number"] == primera.json()["number"]

    db.expire_all()
    cuantas = db.execute(
        select(func.count())
        .select_from(FiscalDocument)
        .where(FiscalDocument.document_type == FiscalDocumentType.ADJUSTMENT_NOTE)
    ).scalar_one()
    assert cuantas == 1, f"salieron {cuantas} notas de un solo pedido"


# ---------------------------------------------------------------------------
# (b) La devolución: turno abierto vs. devolución pendiente (§3.5, §6.3)
# ---------------------------------------------------------------------------


def test_a_cash_refund_with_an_open_shift_is_an_expense_in_that_shift(
    device_client: Any, admin_client: Any, db: Any, open_shift: Any, sales_products: Any
) -> None:
    """§3.5: «si fue en efectivo y hay turno abierto, egreso `refund`».

    La causa es **tipada** (`refund`), nunca texto libre (§11.14): el día que
    el dueño pregunte «¿por qué faltan $50.000 en la caja del martes?», la
    respuesta tiene que ser una columna, no la lectura de una nota escrita a
    mano.
    """
    from app.refunds.models import PendingRefund
    from app.shifts.models import CashMovement, CashMovementCause, CashMovementKind

    turno = open_shift()
    venta = _sell(device_client, sales_products["inc8"].id)
    total = venta["total"]

    nota = _note(
        admin_client, venta["document"]["id"], refund={"method": "cash", "amount": total}
    )
    assert nota.status_code == 201, nota.text
    assert nota.json()["refund_status"] == "settled_in_shift", nota.text

    db.expire_all()
    movimientos = list(
        db.execute(
            select(CashMovement).where(CashMovement.cause == CashMovementCause.REFUND)
        ).scalars()
    )
    assert len(movimientos) == 1, f"un egreso por devolución, ni cero ni dos: {movimientos}"
    movimiento = movimientos[0]
    assert movimiento.shift_id == turno["id"], "el egreso va al turno abierto, no a otro"
    assert movimiento.kind == CashMovementKind.EXPENSE
    assert movimiento.amount == total
    assert db.execute(select(func.count()).select_from(PendingRefund)).scalar_one() == 0, (
        "con turno abierto no queda ninguna devolución pendiente"
    )


def test_a_note_without_an_open_shift_leaves_a_pending_refund_and_notifies(
    device_client: Any, admin_client: Any, db: Any, store: Any, open_shift: Any, sales_products: Any
) -> None:
    """**Ítem del checklist**: «Nota sin turno abierto → devolución
    pendiente»; §6.3: «Una nota emitida sin turno abierto deja una devolución
    pendiente: monto, cliente, documento, quién la autorizó. Aparece en
    "Requiere tu atención"».

    Es la regla que impide el agujero silencioso: sin ella, devolver plata a
    las 11 de la noche con la caja cerrada o no deja rastro (y el faltante
    aparece mañana sin causa) o fuerza a reabrir un turno cerrado para
    "acomodar" la cifra — que es exactamente lo que la referencia hacía y lo
    que §3.5 prohíbe.
    """
    from app.notifications.models import Notification
    from app.refunds.models import PendingRefund, PendingRefundStatus
    from app.shifts.models import CashMovement, CashMovementCause

    turno = open_shift()
    venta = _sell(device_client, sales_products["inc8"].id)
    total = venta["total"]
    _close_shift(device_client, turno["id"], counted=200_000 + total)

    nota = _note(
        admin_client, venta["document"]["id"], refund={"method": "cash", "amount": total}
    )
    assert nota.status_code == 201, nota.text
    assert nota.json()["refund_status"] == "pending", nota.text

    db.expire_all()
    pendientes = list(db.execute(select(PendingRefund)).scalars())
    assert len(pendientes) == 1, f"tiene que quedar exactamente una devolución pendiente: {pendientes}"
    pendiente = pendientes[0]
    assert pendiente.status == PendingRefundStatus.PENDING
    assert pendiente.amount == total
    assert pendiente.authorized_by_employee_id is not None, "queda a nombre de quien la autorizó (§6.3)"
    assert pendiente.customer_name and pendiente.customer_doc_number, (
        "y con el cliente del documento congelado, nunca `NULL`"
    )

    assert db.execute(
        select(func.count()).select_from(CashMovement).where(CashMovement.cause == CashMovementCause.REFUND)
    ).scalar_one() == 0, "sin turno abierto no se puede haber movido ni un peso de ningún cajón"

    avisos = list(
        db.execute(select(Notification).where(Notification.type == "pending_refund")).scalars()
    )
    assert avisos, "la devolución pendiente tiene que llegar a «Requiere tu atención» (§9.3)"

    listado = admin_client.get(f"{API}/admin/pending-refunds", params={"store_id": store.id})
    assert listado.status_code == 200, listado.text
    assert [r["id"] for r in listado.json()] == [pendiente.id]


def test_settling_from_a_shift_creates_the_expense_in_that_shift_and_never_in_the_original(
    device_client: Any, admin_client: Any, db: Any, store: Any, open_shift: Any, sales_products: Any
) -> None:
    """**Ítem del checklist**: «`settle` desde un turno crea el egreso
    `refund` en ese turno y no toca el original»; §6.3: «entra al esperado de
    ese turno».

    El invariante de plata es doble y los dos lados importan: el turno que
    paga tiene que ver el egreso en su esperado (si no, mañana aparece un
    faltante sin causa) y el turno cerrado no puede moverse ni un peso (si
    no, el cierre firmado de ayer deja de ser un hecho).
    """
    from app.refunds.models import PendingRefundStatus
    from app.shifts.models import CashMovement, CashMovementCause, Shift

    primero = open_shift()
    venta = _sell(device_client, sales_products["inc8"].id)
    total = venta["total"]
    _close_shift(device_client, primero["id"], counted=200_000 + total)

    db.expire_all()
    cerrado = db.get(Shift, primero["id"])
    assert cerrado is not None
    esperado_del_cerrado = cerrado.expected_cash
    contado_del_cerrado = cerrado.counted_cash
    diferencia_del_cerrado = cerrado.difference

    nota = _note(
        admin_client, venta["document"]["id"], refund={"method": "cash", "amount": total}
    )
    assert nota.status_code == 201, nota.text
    pendiente_id = admin_client.get(
        f"{API}/admin/pending-refunds", params={"store_id": store.id}
    ).json()[0]["id"]

    segundo = open_shift()
    saldar = admin_client.post(
        f"{API}/admin/pending-refunds/{pendiente_id}/settle",
        json={"from": "shift", "shift_id": segundo["id"]},
        headers=idem_headers(),
    )
    assert saldar.status_code == 200, saldar.text
    assert saldar.json()["status"] == "settled"
    assert saldar.json()["settled_shift_id"] == segundo["id"]

    db.expire_all()
    movimientos = list(
        db.execute(
            select(CashMovement).where(CashMovement.cause == CashMovementCause.REFUND)
        ).scalars()
    )
    assert len(movimientos) == 1, movimientos
    assert movimientos[0].shift_id == segundo["id"], (
        "el egreso va al turno que la salda, jamás al turno donde se vendió"
    )
    assert movimientos[0].amount == total

    de_nuevo = db.get(Shift, primero["id"])
    assert de_nuevo is not None
    assert (de_nuevo.expected_cash, de_nuevo.counted_cash, de_nuevo.difference) == (
        esperado_del_cerrado,
        contado_del_cerrado,
        diferencia_del_cerrado,
    ), "el turno cerrado se movió: «una nota nunca reescribe los totales de un turno cerrado» (§3.5)"

    # Y el esperado del turno que la saldó sí bajó: la devolución entra a SU cuadre.
    revision = admin_client.get(f"{API}/shifts/{segundo['id']}")
    assert revision.status_code == 200, revision.text
    assert revision.json()["expected_cash"] == 200_000 - total, (
        "la devolución tiene que bajar el esperado del turno que la pagó (§6.3)"
    )

    # Saldarla dos veces es `400`, no un segundo egreso.
    repetido = admin_client.post(
        f"{API}/admin/pending-refunds/{pendiente_id}/settle",
        json={"from": "shift", "shift_id": segundo["id"]},
        headers=idem_headers(),
    )
    assert repetido.status_code == 400, repetido.text
    assert repetido.json()["error"]["code"] == "PENDING_REFUND_ALREADY_SETTLED", repetido.text
    db.expire_all()
    assert db.execute(
        select(func.count()).select_from(CashMovement).where(CashMovement.cause == CashMovementCause.REFUND)
    ).scalar_one() == 1
    assert (
        admin_client.get(f"{API}/admin/pending-refunds", params={"store_id": store.id})
        .json()[0]["status"]
        == PendingRefundStatus.SETTLED.value
    )


def test_settling_from_the_owner_moves_no_cash_but_closes_the_pending_refund(
    device_client: Any, admin_client: Any, db: Any, store: Any, open_shift: Any, sales_products: Any
) -> None:
    """§6.3: «Se salda desde un turno (egreso `refund`, entra al esperado de
    ese turno) **o desde la mano del dueño**».

    De la mano del dueño no toca el cajón: un egreso inventado ahí bajaría el
    esperado de un turno que nunca vio esa plata y fabricaría un faltante —
    el error tolerable es el que muestra menos plata, pero éste mostraría
    menos plata *en el cajón equivocado*.
    """
    from app.shifts.models import CashMovement, CashMovementCause

    turno = open_shift()
    venta = _sell(device_client, sales_products["inc8"].id)
    total = venta["total"]
    _close_shift(device_client, turno["id"], counted=200_000 + total)

    nota = _note(admin_client, venta["document"]["id"], refund={"method": "cash", "amount": total})
    assert nota.status_code == 201, nota.text
    pendiente_id = admin_client.get(
        f"{API}/admin/pending-refunds", params={"store_id": store.id}
    ).json()[0]["id"]

    saldar = admin_client.post(
        f"{API}/admin/pending-refunds/{pendiente_id}/settle",
        json={"from": "owner"},
        headers=idem_headers(),
    )
    assert saldar.status_code == 200, saldar.text
    assert saldar.json()["settled_from"] == "owner"
    assert saldar.json()["settled_shift_id"] is None
    assert saldar.json()["settled_cash_movement_id"] is None

    db.expire_all()
    assert db.execute(
        select(func.count()).select_from(CashMovement).where(CashMovement.cause == CashMovementCause.REFUND)
    ).scalar_one() == 0, "saldar de la mano del dueño no mueve el cajón de ningún turno"


def test_the_pending_refund_of_another_organization_is_a_404(
    device_client: Any, admin_client: Any, db: Any, open_shift: Any, sales_products: Any, other_org: Any
) -> None:
    """§1.1 y §11.19: «toda consulta se acota por organización y sede; un id
    ajeno es `404`» — nunca `403` (que confirma que existe) ni `200`. La
    devolución pendiente es plata por pagar: verla de más ya es una fuga,
    saldarla de más es pagar dos veces.
    """
    listado = admin_client.get(
        f"{API}/admin/pending-refunds", params={"store_id": other_org["store"].id}
    )
    assert listado.status_code == 404, listado.text
    assert listado.json()["error"]["code"], listado.text

    saldo = admin_client.post(
        f"{API}/admin/pending-refunds/999999/settle",
        json={"from": "owner"},
        headers=idem_headers(),
    )
    assert saldo.status_code == 404, saldo.text
