"""Invariantes de datos personales del adquirente (Ley 1581 de 2012, Decreto
1377 de 2013; `docs/SPEC-NEGOCIO.md §8.4`). Pedido 1b-2.

Rol Legal. Acá vive la tensión central del pedido: **el derecho de supresión
choca con la inmutabilidad fiscal**. §8.4 la resuelve en una sola frase —
«Suprimir **anonimiza el maestro** y conserva intacto el snapshot dentro de
los documentos fiscales ya emitidos (no se puede borrar evidencia fiscal)» —
y esa frase es un invariante ejecutable, no una aspiración: si el `erase`
tocara el documento, el establecimiento estaría alterando evidencia (art.
616-1 ET, sanción del art. 657 ET); si no anonimizara el maestro, estaría
incumpliendo un derecho fundamental del titular.

Las otras tres reglas de §8.4 que se auditan acá:

- **Autorización previa, expresa e informada con finalidad, conservando la
  prueba** (fecha, canal, texto, quién la registró). El consentimiento se
  **agrega**, nunca se edita: revocar es una fila nueva.
- **Minimización**: nada de datos en ventas a consumidor final; el operador
  no exporta el maestro de clientes.
- **Lo que es ley no es un flag** (`AGENTS.md`): `customers` se puede apagar
  —es la función de llevar un CRM—, pero el ejercicio de un derecho
  (consultar la bitácora, pedir la supresión) no.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import func, select

from tests.audit.conftest import (
    NO_TIP,
    add_items,
    create_order,
    deep_contains_text,
    idem_headers,
    pay,
)

API = "/api/v1"

CUSTOMER = {
    "doc_type": "31",
    "doc_number": "901234567",
    "dv": "8",
    "name": "Carolina Restrepo Uribe",
    "email": "carolina.restrepo@correo.test",
    "address": "Calle 10 # 43-21 apto 502",
    "municipality_dane": "05001",
    "consent": {"text_version": "politica-v3", "channel": "pos"},
}


def _sell_to_customer(client: Any, product_id: int, *, customer: dict[str, Any] | None = None) -> dict[str, Any]:
    order = create_order(client, channel="counter").json()
    order = add_items(client, order, [{"product_id": product_id, "qty": 1}]).json()
    resp = pay(
        client,
        order["id"],
        splits=[{"method": "cash", "amount": order["totals"]["total"]}],
        tip=NO_TIP,
        customer=customer if customer is not None else CUSTOMER,
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


# ---------------------------------------------------------------------------
# (a) Supresión: anonimiza el maestro, no toca el documento (§8.4 vs §8.3)
# ---------------------------------------------------------------------------


def test_erase_anonymizes_the_master_and_leaves_the_document_snapshot_field_by_field(
    device_client: Any, admin_client: Any, db: Any, open_shift: Any, sales_products: Any
) -> None:
    """**Ítem del checklist**: «`customers/{id}/erase` anonimiza el maestro y
    deja intacto el snapshot del documento».

    §8.4 (Ley 1581 de 2012, art. 8 lit. e): el titular puede pedir la
    supresión. §8.3 (art. 616-1 ET): el documento expedido es inmutable y se
    conserva 5 años. Las dos cosas a la vez sólo se pueden cumplir si el
    borrado vive en el maestro y la evidencia vive en el snapshot — que es
    exactamente lo que se comprueba campo por campo acá.
    """
    from app.customers.models import Customer
    from app.fiscal.models import FiscalDocument

    open_shift()
    venta = _sell_to_customer(device_client, sales_products["inc8"].id)
    doc_id = venta["document"]["id"]

    db.expire_all()
    cliente = db.execute(select(Customer)).scalars().one()
    documento_antes = {
        c.name: getattr(db.get(FiscalDocument, doc_id), c.name)
        for c in FiscalDocument.__table__.columns
    }
    assert documento_antes["customer_doc_number"] == CUSTOMER["doc_number"]
    assert documento_antes["customer_name"] == CUSTOMER["name"]
    assert documento_antes["customer_email"] == CUSTOMER["email"]

    borrado = admin_client.post(
        f"{API}/admin/customers/{cliente.id}/erase",
        json={"reason": "Solicitud de supresión del titular (Ley 1581 de 2012)"},
    )
    assert borrado.status_code == 200, borrado.text
    cuerpo = borrado.json()
    assert cuerpo["erased_at"] is not None
    assert CUSTOMER["name"] not in cuerpo["name"]
    assert cuerpo["email"] is None and cuerpo["address"] is None
    assert cuerpo["doc_number"] != CUSTOMER["doc_number"], "el documento del maestro se reemplaza"

    db.expire_all()
    maestro = db.get(Customer, cliente.id)
    assert maestro is not None
    for campo, valor in (
        ("name", CUSTOMER["name"]),
        ("email", CUSTOMER["email"]),
        ("address", CUSTOMER["address"]),
        ("doc_number", CUSTOMER["doc_number"]),
    ):
        assert getattr(maestro, campo) != valor, f"el maestro conservó `{campo}` después de la supresión"

    documento_despues = {
        c.name: getattr(db.get(FiscalDocument, doc_id), c.name)
        for c in FiscalDocument.__table__.columns
    }
    assert documento_despues == documento_antes, (
        "el `erase` tocó el documento fiscal: "
        + str(
            {
                k: (documento_antes[k], documento_despues[k])
                for k in documento_antes
                if documento_antes[k] != documento_despues[k]
            }
        )
    )

    # Y el comprobante se sigue pudiendo imprimir con el adquirente que tenía.
    printable = admin_client.get(f"{API}/documents/{doc_id}").json()
    assert printable["customer"]["doc_number"] == CUSTOMER["doc_number"]
    assert printable["customer"]["name"] == CUSTOMER["name"]


def test_erase_is_idempotent_and_frees_the_document_number_for_a_new_person(
    device_client: Any, admin_client: Any, db: Any, open_shift: Any, sales_products: Any
) -> None:
    """Dos consecuencias prácticas de la anonimización que conviene fijar:

    - pedir la supresión dos veces no pisa la fecha ni el autor de la
      primera (la bitácora de §8.4 tiene que poder decir **cuándo** se
      ejerció el derecho, y una segunda llamada no es un segundo ejercicio);
    - el número de documento queda libre: la misma persona puede volver a
      comprar mañana y pedir factura, y el sistema no puede rechazarla por
      una unicidad que quedó ocupada por su propio borrado.
    """
    from app.customers.models import Customer

    open_shift()
    _sell_to_customer(device_client, sales_products["inc8"].id)
    db.expire_all()
    cliente = db.execute(select(Customer)).scalars().one()

    primera = admin_client.post(
        f"{API}/admin/customers/{cliente.id}/erase", json={"reason": "Supresión"}
    )
    assert primera.status_code == 200, primera.text
    segunda = admin_client.post(
        f"{API}/admin/customers/{cliente.id}/erase", json={"reason": "Supresión otra vez"}
    )
    assert segunda.status_code == 200, segunda.text
    assert segunda.json()["erased_at"] == primera.json()["erased_at"], (
        "la segunda supresión no puede pisar la fecha de la primera"
    )
    assert segunda.json()["doc_number"] == primera.json()["doc_number"]

    # Vuelve a comprar con el mismo documento: entra como persona nueva.
    _sell_to_customer(device_client, sales_products["inc8"].id)
    db.expire_all()
    vivos = [
        c
        for c in db.execute(select(Customer)).scalars()
        if c.erased_at is None and c.doc_number == CUSTOMER["doc_number"]
    ]
    assert len(vivos) == 1, "el número de documento tiene que quedar libre después de la supresión"
    assert vivos[0].id != cliente.id


def test_erase_does_not_leave_the_erased_data_in_the_audit_trail(
    device_client: Any, admin_client: Any, db: Any, open_shift: Any, sales_products: Any
) -> None:
    """**ROJO A PROPÓSITO — hallazgo B-1 de 1b-2.**

    §8.4: el derecho de supresión se ejerce sobre «los datos» del titular; la
    única excepción declarada por la spec es el snapshot del documento fiscal
    («no se puede borrar evidencia fiscal»). `audit_logs` **no** es evidencia
    fiscal: es la bitácora interna de quién cambió qué, que se conserva años
    y se exporta.

    El proyecto ya resolvió esta misma tensión en 1b-1 para los empleados
    (**A-7**, `docs/ESTADO.md`: «`document` y `email` de empleados quedan
    fuera del `before`/`after` de `record_audit(entity="employee")`»). La
    regla es la misma y es más fuerte acá: el titular pidió que se borraran,
    y `app/customers/service.py::erase_customer` los copia enteros al
    `before` de la auditoría **en el mismo acto de borrarlos**.

    Lo que esta auditoría exige es que quede la traza del hecho (quién
    suprimió, cuándo, por qué — eso ya está en `customer_data_requests` y en
    el `after`), no una copia de lo suprimido.
    """
    from app.audit.models import AuditLog
    from app.customers.models import Customer

    open_shift()
    _sell_to_customer(device_client, sales_products["inc8"].id)
    db.expire_all()
    cliente = db.execute(select(Customer)).scalars().one()

    borrado = admin_client.post(
        f"{API}/admin/customers/{cliente.id}/erase", json={"reason": "Supresión del titular"}
    )
    assert borrado.status_code == 200, borrado.text

    db.expire_all()
    filas = list(
        db.execute(select(AuditLog).where(AuditLog.entity.in_(("customer", "customer_consent")))).scalars()
    )
    assert filas, "la supresión sí tiene que dejar traza del hecho (§6.1: nada se borra en silencio)"

    for fila in filas:
        assert fila.action, "cada fila de auditoría dice qué pasó"
        for lado, contenido in (("before", fila.before), ("after", fila.after)):
            for dato in (CUSTOMER["name"], CUSTOMER["email"], CUSTOMER["address"], CUSTOMER["doc_number"]):
                assert not deep_contains_text(contenido, dato.lower()), (
                    f"la auditoría de `{fila.entity}.{fila.action}` guarda `{dato}` en `{lado}`: "
                    "el dato que el titular pidió suprimir sobrevive en una bitácora que se "
                    "conserva años y se exporta (§8.4; mismo criterio que A-7 para empleados)"
                )


# ---------------------------------------------------------------------------
# (b) Autorización: finalidad, prueba y bitácora (§8.4)
# ---------------------------------------------------------------------------


def test_every_sale_with_customer_data_records_its_own_proof_of_consent(
    device_client: Any, db: Any, open_shift: Any, sales_products: Any
) -> None:
    """§8.4: «Autorización previa, expresa e informada con finalidad al crear
    un cliente, **conservando la prueba** (fecha, canal, texto, quién la
    registró)».

    Una prueba por cobro, no una sola para siempre: el dato que importa
    cuando la SIC pregunta no es «¿alguna vez autorizó?», sino «¿autorizó
    cuando le pidieron estos datos?». Por eso el segundo cobro de la misma
    persona agrega una fila nueva en vez de reutilizar la anterior.
    """
    from app.customers.models import ConsentPurpose, Customer, CustomerConsent

    open_shift()
    _sell_to_customer(device_client, sales_products["inc8"].id)
    _sell_to_customer(device_client, sales_products["iva19"].id)

    db.expire_all()
    clientes = list(db.execute(select(Customer)).scalars())
    assert len(clientes) == 1, "los clientes se reutilizan por número de documento (§8.3)"

    consentimientos = list(db.execute(select(CustomerConsent)).scalars())
    assert len(consentimientos) == 2, (
        f"cada cobro que recolectó datos conserva su propia prueba: salieron {len(consentimientos)}"
    )
    for fila in consentimientos:
        assert fila.purpose == ConsentPurpose.INVOICE, "la finalidad se declara, no se deduce"
        assert fila.granted is True
        assert fila.text_version == CUSTOMER["consent"]["text_version"], "qué texto aceptó"
        assert fila.channel == CUSTOMER["consent"]["channel"], "por qué canal"
        assert fila.at is not None, "cuándo"
        assert fila.registered_by_employee_id is not None, "y quién la registró"


def test_a_revoked_consent_is_a_new_row_and_never_edits_the_previous_proof(
    device_client: Any, admin_client: Any, db: Any, open_shift: Any, sales_products: Any
) -> None:
    """§8.4: «cualquier uso adicional (marketing, WhatsApp) requiere
    autorización separada» y «conservando la prueba».

    Revocar no borra lo anterior: el establecimiento tiene que poder probar
    que **hasta** el día de la revocación tenía autorización, y desde ese día
    no. Si revocar editara la fila, se perdería la mitad de la prueba que lo
    protege.
    """
    from app.customers.models import Customer, CustomerConsent

    open_shift()
    _sell_to_customer(device_client, sales_products["inc8"].id)
    db.expire_all()
    cliente = db.execute(select(Customer)).scalars().one()

    otorga = admin_client.post(
        f"{API}/admin/customers/{cliente.id}/consents",
        json={"purpose": "marketing", "granted": True, "channel": "whatsapp", "text_version": "mkt-v1"},
    )
    assert otorga.status_code == 201, otorga.text
    revoca = admin_client.post(
        f"{API}/admin/customers/{cliente.id}/consents",
        json={"purpose": "marketing", "granted": False, "channel": "whatsapp", "text_version": "mkt-v1"},
    )
    assert revoca.status_code == 201, revoca.text
    assert revoca.json()["id"] != otorga.json()["id"], "revocar es una fila nueva, no una edición"

    db.expire_all()
    marketing = [
        c for c in db.execute(select(CustomerConsent)).scalars() if c.purpose.value == "marketing"
    ]
    assert len(marketing) == 2
    assert {c.granted for c in marketing} == {True, False}

    # Y la revocación entra en la bitácora de habeas data, que es el registro
    # de solicitudes que §8.4 exige.
    bitacora = admin_client.get(f"{API}/admin/customers/{cliente.id}/requests")
    assert bitacora.status_code == 200, bitacora.text
    assert "revoke" in {r["kind"] for r in bitacora.json()}, bitacora.text


def test_the_habeas_data_log_and_the_erase_survive_the_customers_feature_being_off(
    device_client: Any, admin_client: Any, db: Any, open_shift: Any, sales_products: Any, set_feature: Any
) -> None:
    """`AGENTS.md` y §1.1: «Lo que es ley o integridad **no es un flag**».

    `customers` es una función de producto (llevar un maestro y buscarlo);
    ejercer un derecho del titular no lo es. Una sede que apagó la función
    después de haber cobrado con datos no puede quedarse sin vía para
    tramitar una supresión: eso convertiría un interruptor comercial en un
    incumplimiento legal.
    """
    from app.customers.models import Customer

    open_shift()
    _sell_to_customer(device_client, sales_products["inc8"].id)
    db.expire_all()
    cliente = db.execute(select(Customer)).scalars().one()

    set_feature("customers", False)

    # La función de producto sí se apaga.
    listado = admin_client.get(f"{API}/admin/customers")
    assert listado.status_code == 400, listado.text
    assert listado.json()["error"]["code"] == "FEATURE_DISABLED", listado.text
    assert listado.json()["error"].get("feature") == "customers", listado.text

    # El derecho, no.
    bitacora = admin_client.get(f"{API}/admin/customers/{cliente.id}/requests")
    assert bitacora.status_code == 200, bitacora.text
    borrado = admin_client.post(
        f"{API}/admin/customers/{cliente.id}/erase", json={"reason": "Supresión con la función apagada"}
    )
    assert borrado.status_code == 200, borrado.text
    assert borrado.json()["erased_at"] is not None

    set_feature("customers", True)
    de_vuelta = admin_client.get(f"{API}/admin/customers")
    assert de_vuelta.status_code == 200, de_vuelta.text


def test_charging_with_customer_data_while_the_feature_is_off_does_not_swallow_the_sale(
    device_client: Any, db: Any, open_shift: Any, sales_products: Any, set_feature: Any
) -> None:
    """**ROJO A PROPÓSITO — hallazgo B-2 de 1b-2.**

    Dos reglas duras a la vez:

    - §1.1 / `AGENTS.md`: una función apagada responde `400 FEATURE_DISABLED`
      nombrando la función. El gate vive en
      `app/customers/hooks.py::upsert_customer_with_consent`
      (`features.assert_feature(..., "customers")`) — correcto.
    - §3.4 y `docs/ESTADO.md`: «La venta es **todo o nada**… un cobro que
      falla **conserva la cuenta**», y «`get_db` hace commit también ante
      `AppError`: **validar antes de escribir**».

    El problema es dónde vive ese gate en el orden del cobro:
    `app/payments/service.py` llama `resolve_customer_snapshot` (y con él el
    gancho que valida la flag) **después** de `claim_payment`, es decir
    después del punto sin retorno. El `AppError` se comitea igual, así que la
    comanda queda `paid`, sin documento y sin pago: la venta desaparece del
    turno y la mesa queda cobrada sin comprobante. Es el mismo defecto que
    `backend-fiscal` ya encontró y corrigió para `NO_FISCAL_RANGE` con
    `assert_range_available`, en la ruta de al lado.
    """
    from app.fiscal.models import FiscalDocument
    from app.payments.models import Payment

    set_feature("customers", False)
    open_shift()

    order = create_order(device_client, channel="counter").json()
    order = add_items(device_client, order, [{"product_id": sales_products["inc8"].id, "qty": 1}]).json()
    resp = pay(
        device_client,
        order["id"],
        splits=[{"method": "cash", "amount": order["totals"]["total"]}],
        tip=NO_TIP,
        customer=CUSTOMER,
    )
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "FEATURE_DISABLED", resp.text

    db.expire_all()
    vigente = device_client.get(f"{API}/orders/{order['id']}")
    assert vigente.status_code == 200, vigente.text
    assert vigente.json()["status"] != "paid", (
        "el cobro fue rechazado pero la comanda quedó cobrada: la venta se pierde entera "
        "(sin documento, sin pago y sin plata en el turno). «Un cobro que falla conserva "
        "la cuenta» (§3.4) — el gate de la flag tiene que correr ANTES de `claim_payment`"
    )
    assert db.execute(select(func.count()).select_from(FiscalDocument)).scalar_one() == 0
    assert db.execute(select(func.count()).select_from(Payment)).scalar_one() == 0


# ---------------------------------------------------------------------------
# (c) Minimización: el dispositivo no ve el maestro (§8.4)
# ---------------------------------------------------------------------------


def test_the_customer_master_is_never_reachable_from_a_device_session(
    device_client: Any, db: Any, open_shift: Any, sales_products: Any
) -> None:
    """§8.4: «Minimización: nada de datos en ventas a consumidor final; **el
    operador no exporta el maestro de clientes**».

    La tablet vive en el mostrador, la usa cualquiera del turno y su sesión
    dura 180 días. Un listado de clientes con correos y direcciones ahí es
    una base de datos personal a la vista del salón; que el POS pueda
    *crear* un cliente al cobrar no implica que pueda *leerlos todos*.
    """
    rutas = [
        f"{API}/admin/customers",
        f"{API}/admin/customers?format=csv",
        f"{API}/admin/customers/1/requests",
    ]
    for ruta in rutas:
        resp = device_client.get(ruta)
        assert resp.status_code in (401, 403, 404), (
            f"un dispositivo alcanzó `{ruta}` con {resp.status_code}: {resp.text[:200]}"
        )
        assert "error" in resp.json(), resp.text

    escrituras = [
        (f"{API}/admin/customers/1/erase", {"reason": "x"}),
        (
            f"{API}/admin/customers/1/consents",
            {"purpose": "marketing", "granted": True, "channel": "x", "text_version": "v"},
        ),
    ]
    for ruta, cuerpo in escrituras:
        resp = device_client.post(ruta, json=cuerpo)
        assert resp.status_code in (401, 403, 404), f"{ruta}: {resp.status_code} {resp.text[:200]}"


def test_a_sale_to_consumidor_final_stores_no_personal_data_at_all(
    device_client: Any, db: Any, open_shift: Any, sales_products: Any
) -> None:
    """§8.4: «nada de datos en ventas a consumidor final» y §8.3: «Adquirente:
    por defecto "consumidor final" (tipo 13, número 222222222222, sin
    responsabilidades)… **Nunca se obligan datos** si la venta va como
    consumidor final».

    Es la mitad que se olvida: la protección más fuerte del titular es que
    sus datos no se recolecten. Un POS que crea una fila de `customers` por
    cada venta convierte cada almuerzo en un dato personal tratado sin
    finalidad declarada.
    """
    from app.customers.models import Customer, CustomerConsent

    open_shift()
    order = create_order(device_client, channel="counter").json()
    order = add_items(device_client, order, [{"product_id": sales_products["inc8"].id, "qty": 1}]).json()
    cobro = pay(
        device_client,
        order["id"],
        splits=[{"method": "cash", "amount": order["totals"]["total"]}],
        tip=NO_TIP,
    )
    assert cobro.status_code == 201, cobro.text

    db.expire_all()
    assert db.execute(select(func.count()).select_from(Customer)).scalar_one() == 0
    assert db.execute(select(func.count()).select_from(CustomerConsent)).scalar_one() == 0

    printable = device_client.get(f"{API}/documents/{cobro.json()['document']['id']}").json()
    assert printable["customer"] == {
        "doc_type": "13",
        "doc_number": "222222222222",
        "name": "Consumidor final",
        "email": None,
        "address": None,
        "municipality_dane": None,
    }, printable["customer"]


def test_a_customer_of_another_organization_is_a_404_in_read_and_in_write(
    device_client: Any, admin_client: Any, db: Any, open_shift: Any, sales_products: Any, other_org: Any
) -> None:
    """§1.1, §2.2 y §11.19: «un id de otra organización responde `404`», nunca
    `403` ni `200`. Sobre el maestro de clientes es doblemente serio: leer de
    más es una fuga de datos personales de la organización vecina, y escribir
    de más (una supresión ajena) destruye su maestro.
    """
    from app.customers.models import Customer

    open_shift()
    _sell_to_customer(device_client, sales_products["inc8"].id)
    db.expire_all()
    propio = db.execute(select(Customer)).scalars().one()

    # Un cliente de OTRA organización: se fabrica en la sede vecina.
    from app.core import clock as clock_module

    ajeno = Customer(
        organization_id=other_org["org"].id,
        store_id=other_org["store"].id,
        doc_type="13",
        doc_number="777777777",
        dv=None,
        name="Vecino Ajeno",
        email="vecino@ajeno.test",
        address=None,
        municipality_dane=None,
        created_at=clock_module.now_utc(),
        updated_at=clock_module.now_utc(),
    )
    db.add(ajeno)
    db.commit()

    lecturas = [
        admin_client.get(f"{API}/admin/customers/{ajeno.id}/requests"),
    ]
    escrituras = [
        admin_client.patch(f"{API}/admin/customers/{ajeno.id}", json={"name": "Robado"}),
        admin_client.post(
            f"{API}/admin/customers/{ajeno.id}/consents",
            json={"purpose": "marketing", "granted": True, "channel": "x", "text_version": "v"},
        ),
        admin_client.post(f"{API}/admin/customers/{ajeno.id}/erase", json={"reason": "ajeno"}),
    ]
    for resp in lecturas + escrituras:
        assert resp.status_code == 404, f"{resp.request.method} {resp.request.url}: {resp.status_code}"
        assert resp.json()["error"]["code"], resp.text

    # Y el listado propio nunca lo muestra.
    listado = admin_client.get(f"{API}/admin/customers")
    assert listado.status_code == 200, listado.text
    assert [c["id"] for c in listado.json()] == [propio.id]

    db.expire_all()
    intacto = db.get(Customer, ajeno.id)
    assert intacto is not None and intacto.name == "Vecino Ajeno" and intacto.erased_at is None


# ---------------------------------------------------------------------------
# (f) RONDA 2 — contrapruebas de los cierres B-1 y B-2
#
# Los tres tests de arriba que estaban en rojo a propósito (B-1, B-2 y el B-3
# de `test_reports_invariants.py`) pasaron a verde sin que se tocara una sola
# de sus aserciones. Estas contrapruebas cubren el riesgo propio de un cierre:
# que el verde se haya conseguido **quitando** algo (la traza de la supresión)
# o **rompiendo** el camino feliz (el cobro con cliente cuando la función sí
# está encendida).
# ---------------------------------------------------------------------------


def test_the_erase_still_leaves_its_own_trail_after_the_pii_left_the_audit_log(
    device_client: Any, admin_client: Any, db: Any, open_shift: Any, sales_products: Any
) -> None:
    """**Contraprueba de B-1.** §6.1: «nada financiero ni de configuración se
    borra en silencio: baja lógica + auditoría». §8.4 exige además la
    **bitácora de habeas data** («quién pidió qué, cuándo y qué se respondió»).

    B-1 se cerró sacando el VALOR del dato personal del `before`/`after` de
    `record_audit`. Un cierre equivalente pero equivocado —borrar el
    `record_audit` entero, o dejar de escribir el `CustomerDataRequest`— haría
    pasar el test de B-1 igual y sería una regresión: la supresión dejaría de
    poder demostrarse. Este test fija el piso: después de suprimir tiene que
    existir la fila de auditoría con `action="erase"` **y** la fila de
    `customer_data_requests`, con actor, motivo y respuesta.
    """
    from app.audit.models import AuditLog
    from app.customers.models import Customer, CustomerDataRequest, DataRequestKind

    open_shift()
    _sell_to_customer(device_client, sales_products["inc8"].id)
    db.expire_all()
    cliente = db.execute(select(Customer)).scalars().one()

    motivo = "Supresión del titular — radicado SIC 2026-0001"
    borrado = admin_client.post(
        f"{API}/admin/customers/{cliente.id}/erase", json={"reason": motivo}
    )
    assert borrado.status_code == 200, borrado.text

    db.expire_all()

    # (1) La auditoría del hecho sigue existiendo, con su acción y su actor.
    auditoria = list(
        db.execute(
            select(AuditLog).where(AuditLog.entity == "customer", AuditLog.action == "erase")
        ).scalars()
    )
    assert len(auditoria) == 1, (
        "la supresión tiene que dejar exactamente una fila de auditoría `customer.erase`: "
        f"hay {len(auditoria)}. Sacar la PII del `before` (B-1) no autoriza a sacar la traza "
        "del hecho (§6.1)"
    )
    fila = auditoria[0]
    assert str(fila.entity_id) == str(cliente.id)
    assert fila.reason == motivo, "el motivo de la supresión es parte de la prueba (§8.4)"
    assert fila.actor_employee_id is not None or fila.actor_employee_name, (
        "la auditoría dice QUIÉN suprimió; sin actor no hay traza que oponer ante la SIC"
    )

    # (2) La bitácora de habeas data, también.
    solicitudes = list(
        db.execute(
            select(CustomerDataRequest).where(CustomerDataRequest.customer_id == cliente.id)
        ).scalars()
    )
    supresiones = [s for s in solicitudes if s.kind == DataRequestKind.ERASE]
    assert len(supresiones) == 1, (
        "§8.4 pide bitácora de habeas data: una supresión sin su fila en "
        f"`customer_data_requests` no se puede acreditar. Filas: {[s.kind for s in solicitudes]}"
    )
    solicitud = supresiones[0]
    assert solicitud.note == motivo
    assert solicitud.responded_at is not None, "una solicitud atendida lleva fecha de respuesta"
    assert solicitud.response, "y qué se respondió"

    # (3) Y la bitácora se puede leer por la ruta que la spec expone.
    bitacora = admin_client.get(f"{API}/admin/customers/{cliente.id}/requests")
    assert bitacora.status_code == 200, bitacora.text
    assert any(r["kind"] == "erase" for r in bitacora.json()), bitacora.text


def test_charging_with_customer_data_while_the_feature_is_on_still_creates_master_consent_and_document(
    device_client: Any, db: Any, open_shift: Any, sales_products: Any, set_feature: Any
) -> None:
    """**Contraprueba de B-2.** El cierre de B-2 agregó un
    `features.assert_feature(..., "customers")` **antes** de `claim_payment`
    (`app/payments/service.py`). La forma más fácil de que ese gate esté mal
    escrito es que corte también con la flag encendida, o que corte cuando el
    body no trae `customer`.

    Este test fija el camino feliz completo: con `customers` ENCENDIDA, el
    mismo cobro del test de B-2 tiene que seguir creando el maestro, el
    consentimiento y el documento fiscal, con el snapshot del cliente dentro
    del documento (§8.3: el documento lleva su propia copia).
    """
    from app.customers.models import Customer, CustomerConsent
    from app.fiscal.models import FiscalDocument
    from app.payments.models import Payment

    set_feature("customers", True)
    open_shift()

    cobro = _sell_to_customer(device_client, sales_products["inc8"].id)
    assert cobro["document"] is not None, "con la función encendida el cobro emite documento"

    db.expire_all()
    clientes = list(db.execute(select(Customer)).scalars())
    assert len(clientes) == 1, f"el cobro tiene que crear el maestro: {clientes}"
    assert clientes[0].name == CUSTOMER["name"]
    assert clientes[0].doc_number == CUSTOMER["doc_number"]
    assert clientes[0].erased_at is None

    consentimientos = list(db.execute(select(CustomerConsent)).scalars())
    assert len(consentimientos) == 1, (
        "§8.4: «autorización previa, expresa e informada… conservando la prueba». "
        f"Consentimientos guardados: {len(consentimientos)}"
    )
    assert consentimientos[0].text_version == CUSTOMER["consent"]["text_version"]

    documentos = list(db.execute(select(FiscalDocument)).scalars())
    assert len(documentos) == 1, "un cobro, un documento"
    assert db.execute(select(func.count()).select_from(Payment)).scalar_one() == 1
    emitido = documentos[0]
    assert emitido.customer_doc_number == CUSTOMER["doc_number"], (
        "el documento emitido lleva su propio snapshot del cliente (§8.3)"
    )
    assert emitido.customer_name == CUSTOMER["name"]
    assert emitido.customer_id == clientes[0].id

    # Y sin `customer` en el body, con la misma flag encendida, sigue sin
    # crear nada de PII: el gate nuevo no convirtió el cliente en obligatorio.
    otro = create_order(device_client, channel="counter").json()
    otro = add_items(device_client, otro, [{"product_id": sales_products["inc8"].id, "qty": 1}]).json()
    anonimo = pay(
        device_client,
        otro["id"],
        splits=[{"method": "cash", "amount": otro["totals"]["total"]}],
        tip=NO_TIP,
    )
    assert anonimo.status_code == 201, anonimo.text
    db.expire_all()
    assert db.execute(select(func.count()).select_from(Customer)).scalar_one() == 1, (
        "una venta a consumidor final no crea un cliente más"
    )


def test_a_staff_meal_behaves_the_same_with_and_without_customer_data_flag_on_or_off(
    device_client: Any, db: Any, open_shift: Any, sales_products: Any, employees: Any, set_feature: Any
) -> None:
    """**Contraprueba de B-2 (el borde).** El gate nuevo es
    `if split_results and payload.customer is not None`. La mitad
    `split_results` importa: una comanda 100 % cortesía o de consumo de
    personal se cobra con `splits: []` y **no emite documento** (§3.3, §8.2),
    así que nunca llega a tocar el maestro de clientes.

    Este test fija que ese borde no cambió: con la flag apagada **y** con la
    flag encendida, con `customer` en el body **y** sin él, un `staff_meal` da
    exactamente el mismo resultado —`201`, total 0, sin documento, sin pago y
    sin ninguna fila de PII—. Si el gate se moviera a un `if payload.customer
    is not None` pelado, la primera de las cuatro combinaciones pasaría a ser
    un `400 FEATURE_DISABLED` sobre una comida de empleado que nada tiene que
    ver con el maestro de clientes.
    """
    from app.customers.models import Customer
    from app.fiscal.models import FiscalDocument
    from app.payments.models import Payment

    open_shift()

    resultados: list[tuple[str, int, int | None, Any]] = []
    for flag in (False, True):
        set_feature("customers", flag)
        for con_cliente in (False, True):
            creada = create_order(
                device_client,
                channel="staff_meal",
                consumed_by_employee_id=employees["operator"].id,
            )
            assert creada.status_code == 201, creada.text
            order = creada.json()
            order = add_items(
                device_client, order, [{"product_id": sales_products["inc8"].id, "qty": 1}]
            ).json()
            extra = {"customer": CUSTOMER} if con_cliente else {}
            cobro = pay(device_client, order["id"], splits=[], **extra)
            etiqueta = f"customers={flag}, customer_en_body={con_cliente}"
            assert cobro.status_code == 201, f"{etiqueta}: {cobro.text}"
            cuerpo = cobro.json()
            resultados.append((etiqueta, cuerpo["total"], None, cuerpo["document"]))

    assert {r[1] for r in resultados} == {0}, f"un staff_meal siempre vale 0: {resultados}"
    assert all(r[3] is None for r in resultados), (
        f"un staff_meal nunca emite documento, traiga o no `customer` en el body: {resultados}"
    )

    db.expire_all()
    assert db.execute(select(func.count()).select_from(FiscalDocument)).scalar_one() == 0
    assert db.execute(select(func.count()).select_from(Payment)).scalar_one() == 0
    assert db.execute(select(func.count()).select_from(Customer)).scalar_one() == 0, (
        "mandar `customer` junto a un consumo de personal no puede crear un maestro: "
        "no hubo venta ni documento al que asociarlo, y §8.4 manda minimizar"
    )
