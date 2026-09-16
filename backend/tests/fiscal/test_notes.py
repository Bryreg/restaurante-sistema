"""`POST /admin/documents/{id}/notes`: consecutivo propio de su propio rango;
el original queda `reversed`; `adjustment_note` sólo corrige `pos_equivalent`
(`credit_note`/`debit_note` sólo `invoice`) — el par equivocado es `400
NOTE_KIND_MISMATCH`; el gancho de devolución (`app.refunds.hooks
.settle_or_queue_refund`) se invoca cuando la nota trae `refund`. El test de
punta a punta del COMPORTAMIENTO del gancho (qué turno recibe el egreso,
cuándo queda pendiente) es de `app.refunds` — acá se prueba que nace con su
consecutivo, que el original queda `reversed` y que el gancho se llamó
(`refund_status` en la respuesta).
"""

from __future__ import annotations

from typing import Any

from tests.payments.conftest import idem_headers

NO_TIP = {"asked": True, "accepted": False, "modified": False, "amount": 0}

CONSENT = {"text_version": "v1", "channel": "pos"}


def _pay_pos_equivalent(
    device_client: Any, identify: Any, employees: Any, open_shift: Any, drink_product: Any
) -> dict[str, Any]:
    open_shift()
    identify(device_client, employees["cashier"])
    order_resp = device_client.post("/api/v1/orders", json={"channel": "counter"}, headers=idem_headers())
    order = order_resp.json()
    items_resp = device_client.post(
        f"/api/v1/orders/{order['id']}/items",
        json={"expected_version": order["version"], "items": [{"product_id": drink_product.id, "qty": 1}]},
        headers=idem_headers(),
    )
    order = items_resp.json()
    resp = device_client.post(
        f"/api/v1/orders/{order['id']}/payments",
        json={"pin": "1111", "tip": NO_TIP, "splits": [{"method": "cash", "amount": order["totals"]["total"]}]},
        headers=idem_headers(),
    )
    assert resp.status_code == 201, resp.text
    return resp.json()["document"]


def _pay_invoice(
    device_client: Any, identify: Any, employees: Any, open_shift: Any, main_product: Any
) -> dict[str, Any]:
    open_shift()
    identify(device_client, employees["cashier"])
    order_resp = device_client.post("/api/v1/orders", json={"channel": "counter"}, headers=idem_headers())
    order = order_resp.json()
    items_resp = device_client.post(
        f"/api/v1/orders/{order['id']}/items",
        json={"expected_version": order["version"], "items": [{"product_id": main_product.id, "qty": 1}]},
        headers=idem_headers(),
    )
    order = items_resp.json()
    resp = device_client.post(
        f"/api/v1/orders/{order['id']}/payments",
        json={
            "pin": "1111",
            "tip": NO_TIP,
            "splits": [{"method": "cash", "amount": order["totals"]["total"]}],
            "requests_invoice": True,
            "customer": {
                "doc_type": "13",
                "doc_number": "1010101010",
                "name": "Cliente de prueba",
                "email": "cliente@test.local",
                "consent": CONSENT,
            },
        },
        headers=idem_headers(),
    )
    assert resp.status_code == 201, resp.text
    return resp.json()["document"]


def test_adjustment_note_on_pos_equivalent_reverses_original_and_gets_own_consecutive(
    device_client: Any, identify: Any, employees: Any, open_shift: Any, drink_product: Any, admin_client: Any, db: Any
) -> None:
    document = _pay_pos_equivalent(device_client, identify, employees, open_shift, drink_product)

    printable = device_client.get(f"/api/v1/documents/{document['id']}")
    item_id = printable.json()["lines"][0]["item_id"]

    resp = admin_client.post(
        f"/api/v1/admin/documents/{document['id']}/notes",
        json={
            "kind": "adjustment",
            "reason": "Precio mal cobrado",
            "lines": [{"item_id": item_id, "used": True}],
        },
        headers=idem_headers(),
    )
    assert resp.status_code == 201, resp.text
    note = resp.json()
    assert note["document_type"] == "adjustment_note"
    assert note["number"] == 1  # rango propio: NA, arranca en 1 aunque POS ya vaya por 1+
    assert note["reverses_document_id"] == document["id"]
    assert note["total"] == printable.json()["total"]
    assert note["refund_status"] is None  # sin `refund` en el body

    from app.fiscal.models import FiscalDocument

    original_row = db.get(FiscalDocument, document["id"])
    assert original_row.status == "reversed"


def test_note_kind_mismatch_adjustment_on_invoice_is_400(
    device_client: Any, identify: Any, employees: Any, open_shift: Any, main_product: Any, admin_client: Any,
    set_feature: Any,
) -> None:
    set_feature("fiscal.invoice", True)
    document = _pay_invoice(device_client, identify, employees, open_shift, main_product)
    resp = admin_client.post(
        f"/api/v1/admin/documents/{document['id']}/notes",
        json={"kind": "adjustment", "reason": "no aplica", "lines": [{"item_id": 1, "used": True}]},
        headers=idem_headers(),
    )
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "NOTE_KIND_MISMATCH"


def test_note_kind_mismatch_credit_on_pos_equivalent_is_400(
    device_client: Any, identify: Any, employees: Any, open_shift: Any, drink_product: Any, admin_client: Any
) -> None:
    document = _pay_pos_equivalent(device_client, identify, employees, open_shift, drink_product)
    resp = admin_client.post(
        f"/api/v1/admin/documents/{document['id']}/notes",
        json={"kind": "credit", "reason": "no aplica", "lines": [{"item_id": 1, "used": True}]},
        headers=idem_headers(),
    )
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "NOTE_KIND_MISMATCH"


def test_credit_note_on_invoice_has_its_own_range_and_reverses_original(
    device_client: Any, identify: Any, employees: Any, open_shift: Any, main_product: Any, admin_client: Any,
    set_feature: Any, db: Any,
) -> None:
    set_feature("fiscal.invoice", True)
    document = _pay_invoice(device_client, identify, employees, open_shift, main_product)
    assert document["document_type"] == "invoice"

    printable = device_client.get(f"/api/v1/documents/{document['id']}")
    item_id = printable.json()["lines"][0]["item_id"]

    resp = admin_client.post(
        f"/api/v1/admin/documents/{document['id']}/notes",
        json={"kind": "credit", "reason": "Devolución del cliente", "lines": [{"item_id": item_id, "used": True}]},
        headers=idem_headers(),
    )
    assert resp.status_code == 201, resp.text
    note = resp.json()
    assert note["document_type"] == "credit_note"
    assert note["prefix"] != document["prefix"]

    from app.fiscal.models import FiscalDocument

    assert db.get(FiscalDocument, document["id"]).status == "reversed"


def test_note_twice_on_the_same_document_is_400(
    device_client: Any, identify: Any, employees: Any, open_shift: Any, drink_product: Any, admin_client: Any
) -> None:
    document = _pay_pos_equivalent(device_client, identify, employees, open_shift, drink_product)
    printable = device_client.get(f"/api/v1/documents/{document['id']}")
    item_id = printable.json()["lines"][0]["item_id"]
    body = {"kind": "adjustment", "reason": "primera", "lines": [{"item_id": item_id, "used": True}]}

    first = admin_client.post(
        f"/api/v1/admin/documents/{document['id']}/notes", json=body, headers=idem_headers()
    )
    assert first.status_code == 201, first.text

    second = admin_client.post(
        f"/api/v1/admin/documents/{document['id']}/notes",
        json={**body, "reason": "segunda"},
        headers=idem_headers(),
    )
    assert second.status_code == 400, second.text
    assert second.json()["error"]["code"] == "DOCUMENT_ALREADY_REVERSED"


def test_note_with_refund_settles_in_the_open_shift(
    device_client: Any, identify: Any, employees: Any, open_shift: Any, drink_product: Any, admin_client: Any
) -> None:
    """El turno que abrió `_pay_pos_equivalent` sigue abierto: el egreso
    `refund` de `app.refunds.hooks.settle_or_queue_refund` se crea ahí
    (`RefundOutcome.status == "settled_in_shift"`) — se prueba que el gancho
    SE LLAMÓ con los datos de la nota; el comportamiento fino es de su
    dueño."""
    document = _pay_pos_equivalent(device_client, identify, employees, open_shift, drink_product)
    printable = device_client.get(f"/api/v1/documents/{document['id']}")
    item_id = printable.json()["lines"][0]["item_id"]

    resp = admin_client.post(
        f"/api/v1/admin/documents/{document['id']}/notes",
        json={
            "kind": "adjustment",
            "reason": "Devolución en efectivo",
            "lines": [{"item_id": item_id, "used": True}],
            "refund": {"method": "cash", "amount": printable.json()["total"]},
        },
        headers=idem_headers(),
    )
    assert resp.status_code == 201, resp.text
    assert resp.json()["refund_status"] == "settled_in_shift"


def test_admin_notes_listing_and_csv(
    device_client: Any, identify: Any, employees: Any, open_shift: Any, drink_product: Any, admin_client: Any, store: Any
) -> None:
    document = _pay_pos_equivalent(device_client, identify, employees, open_shift, drink_product)
    printable = device_client.get(f"/api/v1/documents/{document['id']}")
    item_id = printable.json()["lines"][0]["item_id"]
    admin_client.post(
        f"/api/v1/admin/documents/{document['id']}/notes",
        json={"kind": "adjustment", "reason": "listado", "lines": [{"item_id": item_id, "used": True}]},
        headers=idem_headers(),
    )

    resp = admin_client.get(f"/api/v1/admin/notes?store_id={store.id}")
    assert resp.status_code == 200, resp.text
    rows = resp.json()
    assert any(r["reverses_document_id"] == document["id"] for r in rows)

    csv_resp = admin_client.get(f"/api/v1/admin/notes?store_id={store.id}&format=csv")
    assert csv_resp.status_code == 200, csv_resp.text
    assert csv_resp.headers["content-type"].startswith("text/csv")


def test_note_idempotency_key_replays_same_response(
    device_client: Any, identify: Any, employees: Any, open_shift: Any, drink_product: Any, admin_client: Any
) -> None:
    document = _pay_pos_equivalent(device_client, identify, employees, open_shift, drink_product)
    printable = device_client.get(f"/api/v1/documents/{document['id']}")
    item_id = printable.json()["lines"][0]["item_id"]
    body = {"kind": "adjustment", "reason": "idempotente", "lines": [{"item_id": item_id, "used": True}]}
    headers = idem_headers()

    first = admin_client.post(f"/api/v1/admin/documents/{document['id']}/notes", json=body, headers=headers)
    assert first.status_code == 201, first.text
    second = admin_client.post(f"/api/v1/admin/documents/{document['id']}/notes", json=body, headers=headers)
    assert second.status_code == 201, second.text
    assert first.json() == second.json()


# ---------------------------------------------------------------------------
# Ronda 2 — B-1 (bloqueante conflict-001-b1): la nota «vuelve»/«se usó»
# (SPEC-NEGOCIO §3.5) revierte de verdad el consumo teórico registrado al
# enviar, vía `app.orders.hooks.reverse_item_consumption` (el espejo exacto
# construido en la ronda 1, leído del LIBRO — nunca de la ficha actual).
#
# `returns_to_stock: bool = True` (`NoteLineIn`, decisión de contrato del
# Maestro): `True` = "vuelve" (default — SPEC-NEGOCIO §3.5 escribe "se usó"
# como la EXCEPCIÓN marcada entre paréntesis), `False` = "se usó" (no
# revierte). Una nota `kind="debit"` fuerza `False` en TODAS sus líneas
# (cobra más, nunca devuelve producto) sin importar lo que mande el cliente.
# ---------------------------------------------------------------------------


def _stock(db: Any, store: Any, ingredient: Any) -> int:
    from app.inventory import hooks as inventory_hooks

    return inventory_hooks.current_stock(db, store_id=store.id, ingredient_id=ingredient.id)


def test_a_adjustment_note_without_the_field_defaults_to_returns_and_stock_goes_back_exact(
    db: Any, store: Any, device_client: Any, identify: Any, employees: Any, open_shift: Any, admin_client: Any,
    drink_product: Any, ingredient_seeded: Any, set_recipe: Any,
) -> None:
    """(a) Nota de ajuste SIN el campo `returns_to_stock` en el body (el caso
    real: `{"item_id": X, "used": true}` sin conocer el campo nuevo) — el
    default `True` tiene que revertir el consumo exacto, sin que el cliente
    tenga que enterarse de que el campo existe."""
    set_recipe(drink_product.id, lines=[{"ingredient_id": ingredient_seeded.id, "qty": "100", "unit": "g"}])
    antes = _stock(db, store, ingredient_seeded)

    document = _pay_pos_equivalent(device_client, identify, employees, open_shift, drink_product)
    db.expire_all()
    despues_de_vender = _stock(db, store, ingredient_seeded)
    assert despues_de_vender < antes, "la venta tiene que haber descontado el insumo"

    printable = device_client.get(f"/api/v1/documents/{document['id']}")
    item_id = printable.json()["lines"][0]["item_id"]

    resp = admin_client.post(
        f"/api/v1/admin/documents/{document['id']}/notes",
        json={
            "kind": "adjustment",
            "reason": "El cliente devolvió el producto sin abrir; vuelve al inventario",
            "lines": [{"item_id": item_id, "used": True}],  # SIN `returns_to_stock`: default True
        },
        headers=idem_headers(),
    )
    assert resp.status_code == 201, resp.text
    assert resp.json()["returned_to_stock_item_ids"] == [item_id]

    db.expire_all()
    assert _stock(db, store, ingredient_seeded) == antes, "el saldo tiene que volver EXACTO al valor previo al envío"


def test_b_returns_to_stock_false_keeps_the_consumption_and_writes_no_note_return_movement(
    db: Any, store: Any, device_client: Any, identify: Any, employees: Any, open_shift: Any, admin_client: Any,
    drink_product: Any, ingredient_seeded: Any, set_recipe: Any,
) -> None:
    """(b) `returns_to_stock=False` ("se usó"): el saldo NO vuelve y no existe
    NINGÚN `StockMovement` con `cause=note_return` para este ítem — la línea
    se ignora por completo para efectos de inventario, no sólo "no se ve"."""
    set_recipe(drink_product.id, lines=[{"ingredient_id": ingredient_seeded.id, "qty": "100", "unit": "g"}])

    document = _pay_pos_equivalent(device_client, identify, employees, open_shift, drink_product)
    db.expire_all()
    despues_de_vender = _stock(db, store, ingredient_seeded)

    printable = device_client.get(f"/api/v1/documents/{document['id']}")
    item_id = printable.json()["lines"][0]["item_id"]

    resp = admin_client.post(
        f"/api/v1/admin/documents/{document['id']}/notes",
        json={
            "kind": "adjustment",
            "reason": "El plato se sirvió y se consumió; no vuelve",
            "lines": [{"item_id": item_id, "used": True, "returns_to_stock": False}],
        },
        headers=idem_headers(),
    )
    assert resp.status_code == 201, resp.text
    assert resp.json()["returned_to_stock_item_ids"] == []

    db.expire_all()
    assert _stock(db, store, ingredient_seeded) == despues_de_vender, "«se usó» no repone nada"

    from sqlalchemy import select

    from app.inventory.models import MovementCause, StockMovement

    note_return_rows = list(
        db.execute(
            select(StockMovement).where(
                StockMovement.ref_type == "order_item",
                StockMovement.ref_id == item_id,
                StockMovement.cause == MovementCause.NOTE_RETURN,
            )
        ).scalars()
    )
    assert note_return_rows == [], "«se usó» no puede escribir ningún movimiento de reversión"


def test_c_note_mirrors_the_book_not_todays_recipe_when_it_changed_in_between(
    db: Any, store: Any, device_client: Any, identify: Any, employees: Any, open_shift: Any, admin_client: Any,
    main_product: Any, ingredient_seeded: Any, set_recipe: Any,
) -> None:
    """(c) La ficha cambia DESPUÉS del envío y ANTES de la nota: el espejo
    tiene que ignorar la ficha nueva por completo y devolver EXACTAMENTE lo
    que el libro tenía registrado — nunca recalcular con `expand_consumption`
    contra la v2. Es la razón por la que `issue_note` llama
    `app.orders.hooks.reverse_item_consumption` (lee el libro) y no
    `app.recipes.hooks.expand_consumption` (leería la ficha de hoy)."""
    recipe_v1 = set_recipe(main_product.id, lines=[{"ingredient_id": ingredient_seeded.id, "qty": "100", "unit": "g"}])
    assert recipe_v1.version == 1
    antes = _stock(db, store, ingredient_seeded)

    document = _pay_pos_equivalent(device_client, identify, employees, open_shift, main_product)
    db.expire_all()
    assert _stock(db, store, ingredient_seeded) < antes

    # La ficha cambia DESPUÉS del envío (v2, cien veces más cantidad): si el
    # espejo recalculara con la ficha de hoy, "vuelve" repondría muchísimo
    # más de lo que la venta original había descontado.
    set_recipe(main_product.id, lines=[{"ingredient_id": ingredient_seeded.id, "qty": "9999", "unit": "g"}], version=1)

    printable = device_client.get(f"/api/v1/documents/{document['id']}")
    item_id = printable.json()["lines"][0]["item_id"]

    resp = admin_client.post(
        f"/api/v1/admin/documents/{document['id']}/notes",
        json={"kind": "adjustment", "reason": "Devolución, ficha cambió entremedio", "lines": [{"item_id": item_id, "used": True}]},
        headers=idem_headers(),
    )
    assert resp.status_code == 201, resp.text

    db.expire_all()
    assert _stock(db, store, ingredient_seeded) == antes, (
        "el espejo tiene que cancelar EXACTAMENTE lo que el libro tenía, no lo que da la ficha v2"
    )


def test_d_same_idempotency_key_twice_reverts_only_once(
    db: Any, store: Any, device_client: Any, identify: Any, employees: Any, open_shift: Any, admin_client: Any,
    drink_product: Any, ingredient_seeded: Any, set_recipe: Any,
) -> None:
    """(d) `run_idempotent` devuelve la respuesta guardada en el replay sin
    volver a correr `_do` (`app.core.idempotency`) — esto se prueba de
    verdad, no se asume: la segunda llamada con la MISMA `Idempotency-Key`
    NO puede revertir el consumo una segunda vez."""
    set_recipe(drink_product.id, lines=[{"ingredient_id": ingredient_seeded.id, "qty": "100", "unit": "g"}])
    antes = _stock(db, store, ingredient_seeded)

    document = _pay_pos_equivalent(device_client, identify, employees, open_shift, drink_product)
    printable = device_client.get(f"/api/v1/documents/{document['id']}")
    item_id = printable.json()["lines"][0]["item_id"]

    body = {"kind": "adjustment", "reason": "idempotente, vuelve", "lines": [{"item_id": item_id, "used": True}]}
    headers = idem_headers()

    first = admin_client.post(f"/api/v1/admin/documents/{document['id']}/notes", json=body, headers=headers)
    assert first.status_code == 201, first.text
    db.expire_all()
    stock_after_first = _stock(db, store, ingredient_seeded)
    assert stock_after_first == antes, "la primera llamada tiene que haber revertido el consumo"

    second = admin_client.post(f"/api/v1/admin/documents/{document['id']}/notes", json=body, headers=headers)
    assert second.status_code == 201, second.text
    assert second.json() == first.json(), "el replay devuelve la MISMA respuesta guardada, no vuelve a correr `_do`"

    db.expire_all()
    assert _stock(db, store, ingredient_seeded) == stock_after_first, "el replay no puede revertir una segunda vez"


def test_e_inventory_perpetual_off_returns_201_with_no_movements_and_no_exception(
    device_client: Any, identify: Any, employees: Any, open_shift: Any, admin_client: Any,
    drink_product: Any, ingredient_seeded: Any, set_recipe: Any, set_feature: Any,
) -> None:
    """(e) `inventory.perpetual` apagada: la venta no escribió ningún
    movimiento (`app.orders.service._freeze_item_consumption` corta antes de
    llamar `record_movement`), así que la nota tampoco tiene nada que
    revertir — `reverse_item_consumption` lee el libro, lo encuentra vacío
    para este ítem y devuelve `[]` **sin lanzar**. `201`, no `500` ni `400`."""
    set_feature("inventory.perpetual", False)
    set_recipe(drink_product.id, lines=[{"ingredient_id": ingredient_seeded.id, "qty": "100", "unit": "g"}])

    document = _pay_pos_equivalent(device_client, identify, employees, open_shift, drink_product)
    printable = device_client.get(f"/api/v1/documents/{document['id']}")
    item_id = printable.json()["lines"][0]["item_id"]

    resp = admin_client.post(
        f"/api/v1/admin/documents/{document['id']}/notes",
        json={"kind": "adjustment", "reason": "sin inventario perpetuo", "lines": [{"item_id": item_id, "used": True}]},
        headers=idem_headers(),
    )
    assert resp.status_code == 201, resp.text
    assert resp.json()["returned_to_stock_item_ids"] == []


def test_f_debit_note_never_reverts_even_if_the_client_asks_for_it(
    db: Any, store: Any, device_client: Any, identify: Any, employees: Any, open_shift: Any, admin_client: Any,
    main_product: Any, ingredient_seeded: Any, set_recipe: Any, set_feature: Any,
) -> None:
    """(f) Regla de la nota débito: COBRA MÁS, nunca devuelve producto. Se
    fuerza `returns_to_stock=False` para TODAS sus líneas — incluso si el
    cliente manda `returns_to_stock: true` explícito, se ignora, y NUNCA
    responde `400` por eso (el default `True` de `NoteLineIn` existe
    justamente para que un campo no reconocido no rompa el request)."""
    set_feature("fiscal.invoice", True)
    set_recipe(main_product.id, lines=[{"ingredient_id": ingredient_seeded.id, "qty": "100", "unit": "g"}])
    antes = _stock(db, store, ingredient_seeded)

    document = _pay_invoice(device_client, identify, employees, open_shift, main_product)
    db.expire_all()
    despues_de_vender = _stock(db, store, ingredient_seeded)
    assert despues_de_vender < antes

    printable = device_client.get(f"/api/v1/documents/{document['id']}")
    item_id = printable.json()["lines"][0]["item_id"]

    resp = admin_client.post(
        f"/api/v1/admin/documents/{document['id']}/notes",
        json={
            "kind": "debit",
            "reason": "Cobro adicional por un ítem faltante en la cuenta",
            "lines": [{"item_id": item_id, "used": True, "returns_to_stock": True}],  # se IGNORA
        },
        headers=idem_headers(),
    )
    assert resp.status_code == 201, resp.text
    assert resp.json()["returned_to_stock_item_ids"] == [], "una nota débito nunca revierte, aunque se lo pidan"

    db.expire_all()
    assert _stock(db, store, ingredient_seeded) == despues_de_vender, "el consumo de la venta original sigue intacto"
