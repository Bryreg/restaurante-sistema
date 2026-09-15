"""Invariantes del documento fiscal: rango, consecutivo, proveedor,
contingencia, concurrencia y evidencia.

Auditor de los pedidos 1b-1 y **1b-2** (rol Contador + Legal). En 1b-1 el
comprobante no se transmitía a nadie; en 1b-2 el documento es de verdad:
reserva su número **dentro de un rango autorizado por la DIAN**, pasa por un
`FiscalProvider` y cambia de estado (`pending → sent → validated | rejected |
contingency`). Lo que no cambió —y no se puede arreglar hacia atrás— es el
consecutivo: un hueco en la numeración de marzo no se tapa en abril
(`docs/SPEC-NEGOCIO.md §8.3`, Res. DIAN 000165/2023; sanción del art. 657 ET).

**El invariante que no se negocia de todo el pedido**: un rechazo NO libera
el número. Se audita en
`test_the_series_survives_a_hundred_sales_three_notes_and_two_rejections`,
que es el ítem literal del checklist de `features/fase-1b-venta/spec.md`.

Reglas de `CONTRATO-INTERNO-1b-1.md §5.4`, del checklist de
`features/fase-1b-venta/spec.md` y de `SPEC-NEGOCIO §8.3`. Los tests con
hilos se escriben **siempre** sobre `race_env`/`race_app` (contrato §3): la
fixture `db` entrega una sola `Session` a todos los requests y no es segura
entre hilos — es el defecto D-2 del pedido 1a. El tiempo se mueve **siempre**
con la fixture `clock` (`advance(hours=49)`), nunca con `sleep`.
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta
from typing import Any


from sqlalchemy import delete, func, select

from tests.audit.conftest import (
    NO_TIP,
    add_items,
    create_order,
    get_order,
    idem_headers,
    pay,
    seed_fiscal_ranges,
    seed_race_fiscal_range,
)

API = "/api/v1"

SALES_FOR_THE_SEQUENCE = 100
NOTES_FOR_THE_SEQUENCE = 3
REJECTIONS_FOR_THE_SEQUENCE = 2


def _note_on(admin_client: Any, document_id: int, *, kind: str = "adjustment", **extra: Any) -> Any:
    """`POST /admin/documents/{id}/notes` con todas las líneas usadas."""
    printable = admin_client.get(f"{API}/documents/{document_id}")
    assert printable.status_code == 200, printable.text
    lines = [{"item_id": line["item_id"], "used": True} for line in printable.json()["lines"]]
    body: dict[str, Any] = {"kind": kind, "reason": "Auditoría del consecutivo", "lines": lines, **extra}
    return admin_client.post(f"{API}/admin/documents/{document_id}/notes", json=body, headers=idem_headers())


def _sell_and_charge(
    client: Any, product_id: int, *, qty: int = 1, tip: dict[str, Any] | None = None
) -> Any:
    """Una venta de mostrador completa por API: crear, agregar, cobrar."""
    order = create_order(client, channel="counter").json()
    order = add_items(client, order, [{"product_id": product_id, "qty": qty}]).json()
    return pay(
        client,
        order["id"],
        splits=[{"method": "cash", "amount": order["totals"]["total"]}],
        tip=tip if tip is not None else NO_TIP,
    )


# ---------------------------------------------------------------------------
# (a) Consecutivo sin huecos (§5.4, SPEC §8.3)
# ---------------------------------------------------------------------------


def test_the_series_survives_a_hundred_sales_three_notes_and_two_rejections(
    device_client: Any, admin_client: Any, db: Any, open_shift: Any, sales_products: Any
) -> None:
    """**El ítem del checklist que no se puede saltar** (`spec.md`,
    «Verificación del pedido»): «Consecutivo por tipo y sede sin huecos tras
    100 ventas, 3 notas y 2 rechazos del `FakeProvider`; un rechazo no libera
    el número».

    Y §8.3: «Consecutivo estrictamente creciente, **sin huecos ni
    reutilización**, asignado en la misma transacción de la emisión… Un
    documento rechazado no libera su consecutivo: se corrige y reenvía o se
    anula por nota».

    Se auditan las **dos** series a la vez, porque el consecutivo es por tipo
    **y** por sede: el documento equivalente va 1..100 y la nota de ajuste
    1..3, en su propio rango y con su propio prefijo. Si una nota tomara un
    número de la serie de la venta (o al revés), la numeración que la DIAN
    revisa quedaría con un hueco del lado que perdió el número, y eso no se
    repara: se explica.

    Los dos rechazos son del `FakeProvider` (la DIAN dice «no»), no de una
    validación del cobro: el documento **existe**, ya consumió su número, y
    sigue existiendo con ese número después del rechazo. Es exactamente el
    caso que tienta a "reciclar" el número, y el que la norma prohíbe.
    """
    from app.fiscal.models import FiscalDocument, FiscalDocumentType, FiscalRange
    from app.fiscal.provider import FakeProvider, set_provider_override

    open_shift()
    rechazados: list[int] = []
    numeros: list[int] = []
    documentos: list[int] = []
    prefijos: set[str] = set()

    try:
        for i in range(SALES_FOR_THE_SEQUENCE):
            # Las ventas 50 y 51 se emiten con un proveedor que RECHAZA.
            rechaza = SALES_FOR_THE_SEQUENCE // 2 <= i < SALES_FOR_THE_SEQUENCE // 2 + REJECTIONS_FOR_THE_SEQUENCE
            set_provider_override(FakeProvider(outcome="reject") if rechaza else None)
            cobro = _sell_and_charge(device_client, sales_products["inc8"].id)
            assert cobro.status_code == 201, cobro.text
            documento = cobro.json()["document"]
            assert documento["document_type"] == "pos_equivalent"
            numeros.append(documento["number"])
            documentos.append(documento["id"])
            prefijos.add(documento["prefix"])
            if rechaza:
                assert documento["dian_status"] == "rejected", (
                    "el FakeProvider tenía que rechazar esta emisión y el estado tiene que decirlo"
                )
                rechazados.append(documento["number"])
    finally:
        set_provider_override(None)

    assert len(rechazados) == REJECTIONS_FOR_THE_SEQUENCE, rechazados
    assert len(prefijos) == 1, f"un solo prefijo por sede y tipo: {prefijos}"
    assert numeros == list(range(1, SALES_FOR_THE_SEQUENCE + 1)), (
        f"la serie de la venta tiene huecos, saltos o repetidos: {numeros}"
    )

    # Tres notas de ajuste sobre tres documentos ya emitidos: consecutivo
    # propio, en su propio rango y con su propio prefijo.
    numeros_nota: list[int] = []
    prefijos_nota: set[str] = set()
    for document_id in documentos[:NOTES_FOR_THE_SEQUENCE]:
        nota = _note_on(admin_client, document_id)
        assert nota.status_code == 201, nota.text
        cuerpo = nota.json()
        assert cuerpo["document_type"] == "adjustment_note"
        numeros_nota.append(cuerpo["number"])
        prefijos_nota.add(cuerpo["prefix"])

    assert numeros_nota == list(range(1, NOTES_FOR_THE_SEQUENCE + 1)), (
        f"la serie de las notas tiene huecos o arrancó pisando la de la venta: {numeros_nota}"
    )
    assert prefijos_nota.isdisjoint(prefijos), (
        "la nota tiene que llevar su propio prefijo y su propio rango, no el de la venta: "
        f"{prefijos_nota} vs {prefijos}"
    )

    # Y el invariante que no se negocia, leído en la base: ningún número se
    # liberó ni se repitió, y los dos rechazados siguen ahí con el suyo.
    db.expire_all()
    por_tipo: dict[str, list[int]] = {}
    for row in db.execute(select(FiscalDocument)).scalars():
        por_tipo.setdefault(row.document_type.value, []).append(row.number)
    assert sorted(por_tipo["pos_equivalent"]) == list(range(1, SALES_FOR_THE_SEQUENCE + 1))
    assert sorted(por_tipo["adjustment_note"]) == list(range(1, NOTES_FOR_THE_SEQUENCE + 1))

    vivos = {
        row.number
        for row in db.execute(
            select(FiscalDocument).where(
                FiscalDocument.document_type == FiscalDocumentType.POS_EQUIVALENT,
                FiscalDocument.dian_status == "rejected",
            )
        ).scalars()
    }
    assert vivos == set(rechazados), (
        f"un rechazo liberó su número: los rechazados eran {rechazados} y quedaron {sorted(vivos)}"
    )

    rangos = {r.document_type.value: r for r in db.execute(select(FiscalRange)).scalars()}
    assert rangos["pos_equivalent"].next_number == SALES_FOR_THE_SEQUENCE + 1, (
        "el rango no avanzó exactamente una vez por documento emitido"
    )
    assert rangos["adjustment_note"].next_number == NOTES_FOR_THE_SEQUENCE + 1


def test_a_rejected_payment_does_not_consume_a_number(
    device_client: Any, db: Any, open_shift: Any, sales_products: Any
) -> None:
    """§8.3: «Un documento rechazado no libera su consecutivo» — y su reverso,
    que es el que se rompe solo: un cobro **rechazado antes de emitir** no
    puede consumir uno.

    Importa el doble en este proyecto porque `get_db` hace commit también ante
    `AppError` (`docs/ESTADO.md`, decisiones de implementación): si el número
    se reservara antes de validar, cada `400 SPLITS_DO_NOT_MATCH` —un error de
    tecleo en hora pico— dejaría un hueco permanente en la numeración de la
    sede.
    """
    from app.fiscal.models import FiscalDocumentType, FiscalRange

    open_shift()
    primera = _sell_and_charge(device_client, sales_products["inc8"].id)
    assert primera.status_code == 201, primera.text
    assert primera.json()["document"]["number"] == 1

    def _next_number() -> int:
        db.expire_all()
        row = (
            db.execute(
                select(FiscalRange).where(
                    FiscalRange.document_type == FiscalDocumentType.POS_EQUIVALENT
                )
            )
            .scalars()
            .one()
        )
        return int(row.next_number)

    antes = _next_number()
    assert antes == 2

    order = create_order(device_client, channel="counter").json()
    order = add_items(
        device_client, order, [{"product_id": sales_products["inc8"].id, "qty": 1}]
    ).json()

    rechazos = [
        # Los splits no suman el total: error de tecleo del cajero.
        ({"splits": [{"method": "cash", "amount": 1}], "tip": NO_TIP}, "SPLITS_DO_NOT_MATCH"),
        # Medio de pago que la sede no habilitó.
        (
            {
                "splits": [{"method": "voucher", "amount": order["totals"]["total"]}],
                "tip": NO_TIP,
            },
            "PAYMENT_METHOD_INVALID",
        ),
        # PIN equivocado: cobrar re-pide el PIN propio (§2.1).
        (
            {
                "splits": [{"method": "cash", "amount": order["totals"]["total"]}],
                "tip": NO_TIP,
                "pin": "0000",
            },
            "PIN_INVALID",
        ),
    ]
    for body, code in rechazos:
        fallido = pay(device_client, order["id"], **body)
        assert fallido.status_code == 400, f"{code}: {fallido.text}"
        assert fallido.json()["error"]["code"] == code, fallido.text
        assert _next_number() == antes, (
            f"el rechazo {code} consumió un consecutivo: la numeración quedó con un hueco"
        )

    buena = pay(
        device_client,
        order["id"],
        splits=[{"method": "cash", "amount": order["totals"]["total"]}],
        tip=NO_TIP,
    )
    assert buena.status_code == 201, buena.text
    assert buena.json()["document"]["number"] == 2, (
        "el cobro bueno toma el número que los rechazos no consumieron"
    )


# ---------------------------------------------------------------------------
# (b) Concurrencia: un solo cobro gana (§5.4, SPEC §3.4)
# ---------------------------------------------------------------------------


def test_two_concurrent_payments_leave_one_sale_one_payment_and_one_document(
    race_env: Any,
) -> None:
    """§3.4: «Dos dispositivos cobrando la misma comanda: uno gana, el otro
    `409`». Checklist del pedido 1b: «Dos `payments` concurrentes: `200` y
    `409`; un solo documento».

    Acá se mide la mitad que decide si la plata está bien: **exactamente una**
    venta cobrada, **un** pago en el turno y **un** documento con **un**
    consecutivo. Si los dos ganaran, el cajón tendría que cuadrar con el doble
    de lo que entró y habría dos consecutivos para una sola venta. La otra
    mitad —qué código recibe la perdedora— está en el test siguiente, separada
    a propósito para que un código equivocado no tape un problema de plata ni
    al revés.

    **Sobre `race_env`**, la única fixture con una sesión por request
    (contrato §3, defecto D-2 de 1a): sobre la fixture `db` los dos hilos se
    matan entre sí antes de tocar la regla y el test daría un verde falso.
    """
    from app.fiscal.models import FiscalDocument
    from app.payments.models import Payment

    seed_race_fiscal_range(race_env)
    race_env.open_shift()
    product_id = race_env.seed_product(name="Gaseosa carrera", price=5_000)

    order = create_order(race_env.client, channel="counter").json()
    order = add_items(race_env.client, order, [{"product_id": product_id, "qty": 1}]).json()
    total = order["totals"]["total"]

    results = _charge_twice_in_parallel(race_env, order["id"], total)

    ganadores = [status for status, _ in results if status == 201]
    assert len(ganadores) == 1, f"tiene que ganar exactamente una: {results}"
    perdedora = [(status, code) for status, code in results if status != 201]
    assert len(perdedora) == 1 and perdedora[0][0] >= 400, (
        f"la otra tiene que ser rechazada, no ignorada: {results}"
    )

    with race_env.session_factory() as db:
        documentos = list(
            db.execute(select(FiscalDocument).where(FiscalDocument.order_id == order["id"])).scalars()
        )
        assert len(documentos) == 1, f"una venta, un documento: salieron {len(documentos)}"
        pagos = list(db.execute(select(Payment).where(Payment.order_id == order["id"])).scalars())
        assert len(pagos) == 1, f"y un solo pago en el turno: salieron {len(pagos)}"
        assert sum(p.amount for p in pagos) == total, "el turno no puede cobrar la venta dos veces"


def _charge_twice_in_parallel(race_env: Any, order_id: int, total: int) -> list[tuple[int, str]]:
    def _charge(_: int) -> tuple[int, str]:
        resp = pay(
            race_env.client,
            order_id,
            splits=[{"method": "cash", "amount": total}],
            tip=NO_TIP,
            pin=race_env.employee_pin,
        )
        code = ""
        if resp.status_code >= 400:
            code = resp.json().get("error", {}).get("code", "")
        return resp.status_code, code

    with ThreadPoolExecutor(max_workers=2) as pool:
        return list(pool.map(_charge, range(2)))


def test_a_payment_on_an_already_paid_order_or_sub_account_is_a_409_already_paid(
    device_client: Any, open_shift: Any, sales_products: Any
) -> None:
    """`CONTRATO-INTERNO-1b-1.md §4`: `ORDER_ALREADY_PAID` y
    `SUB_ACCOUNT_ALREADY_PAID` son **409**, no 400; `spec.md` (checklist del
    pedido 1b) pide literalmente «Dos `payments` concurrentes: `200` y `409`».

    No es una discusión de números HTTP. El contrato del frontend (§6.3 y §6.2
    de `CONTRATO-INTERNO-1b-1.md`) distingue: un `400` es un error de negocio
    que la persona corrige y reintenta; un `409` es «alguien más ya lo hizo,
    andá a mirar el comprobante». Con el código y el mensaje equivocados, la
    segunda tablet de una mesa le dice al cajero «La comanda no está abierta»
    —que suena a error del sistema— en vez de «Esta comanda ya fue cobrada;
    consultá el comprobante», y el cajero vuelve a intentar o, peor, vuelve a
    cobrar en efectivo sin documento.

    Dos caminos, la misma causa: `app/orders/service.py:1555` (comanda) y
    `app/orders/service.py:1563` (sub-cuenta) responden antes de que
    `claim_payment` (`:1591`, que sí levanta el `409` correcto) llegue a
    ejecutarse.
    """
    # (1) Cobrar dos veces la misma comanda. Es exactamente lo que le pasa a
    #     la perdedora de una carrera real (verificado sobre `race_env` en
    #     `test_two_concurrent_payments_...`: la perdedora vuelve con
    #     `400 ORDER_NOT_OPEN`), sin depender de la temporización de dos hilos.
    open_shift()
    otra = create_order(device_client, channel="counter").json()
    otra = add_items(
        device_client, otra, [{"product_id": sales_products["inc8"].id, "qty": 1}]
    ).json()
    splits = [{"method": "cash", "amount": otra["totals"]["total"]}]
    assert pay(device_client, otra["id"], splits=splits, tip=NO_TIP).status_code == 201
    repetido = pay(device_client, otra["id"], splits=splits, tip=NO_TIP)
    assert repetido.status_code == 409, repetido.text
    assert repetido.json()["error"]["code"] == "ORDER_ALREADY_PAID", repetido.text

    # (2) Y la sub-cuenta ya cobrada, que el contrato §4 marca 409 explícito.
    dividida = create_order(device_client, channel="counter").json()
    dividida = add_items(
        device_client,
        dividida,
        [
            {"product_id": sales_products["inc8"].id, "qty": 1},
            {"product_id": sales_products["iva19"].id, "qty": 1},
        ],
    ).json()
    item_ids = [item["id"] for item in dividida["items"]]
    division = device_client.post(
        f"{API}/orders/{dividida['id']}/bill/split",
        json={
            "expected_version": dividida["version"],
            "mode": "items",
            "groups": [
                {"label": "Uno", "item_ids": [item_ids[0]]},
                {"label": "Dos", "item_ids": [item_ids[1]]},
            ],
        },
    )
    assert division.status_code == 200, division.text
    primera_sub = division.json()["sub_accounts"][0]
    cobro = pay(
        device_client,
        dividida["id"],
        splits=[{"method": "cash", "amount": primera_sub["totals"]["total"]}],
        tip=NO_TIP,
        sub_account_id=primera_sub["id"],
    )
    assert cobro.status_code == 201, cobro.text
    otra_vez = pay(
        device_client,
        dividida["id"],
        splits=[{"method": "cash", "amount": primera_sub["totals"]["total"]}],
        tip=NO_TIP,
        sub_account_id=primera_sub["id"],
    )
    assert otra_vez.status_code == 409, otra_vez.text
    assert otra_vez.json()["error"]["code"] == "SUB_ACCOUNT_ALREADY_PAID", otra_vez.text


def test_replaying_the_same_idempotency_key_returns_the_same_document(
    device_client: Any, db: Any, open_shift: Any, sales_products: Any
) -> None:
    """§11.9 y checklist 1b: «misma clave → misma respuesta, un solo
    documento». El doble toque del cajero sobre «Cobrar» en una tablet lenta
    es el caso real; la referencia no aplicó la clave al cobro y duplicaba la
    venta."""
    from app.fiscal.models import FiscalDocument

    open_shift()
    order = create_order(device_client, channel="counter").json()
    order = add_items(
        device_client, order, [{"product_id": sales_products["inc8"].id, "qty": 2}]
    ).json()
    total = order["totals"]["total"]

    headers = idem_headers()
    splits = [{"method": "cash", "amount": total}]

    primera = pay(device_client, order["id"], splits=splits, tip=NO_TIP, headers=headers)
    assert primera.status_code == 201, primera.text
    segunda = pay(device_client, order["id"], splits=splits, tip=NO_TIP, headers=headers)
    assert segunda.status_code == 201, segunda.text

    assert segunda.json()["document"]["id"] == primera.json()["document"]["id"]
    assert segunda.json()["document"]["number"] == primera.json()["document"]["number"]
    assert segunda.json()["paid_at"] == primera.json()["paid_at"], (
        "la repetición devuelve la respuesta guardada, no una venta nueva"
    )

    # Y una clave NUEVA sobre una comanda ya pagada tampoco emite nada: el
    # código con que se rechaza se audita en
    # `test_a_payment_on_an_already_paid_order_or_sub_account_is_a_409_already_paid`.
    tercera = pay(device_client, order["id"], splits=splits, tip=NO_TIP)
    assert tercera.status_code >= 400, tercera.text

    db.expire_all()
    cuantos = db.execute(
        select(func.count()).select_from(FiscalDocument).where(FiscalDocument.order_id == order["id"])
    ).scalar_one()
    assert cuantos == 1, f"un solo documento por comanda: salieron {cuantos}"
    assert get_order(device_client, order["id"])["document_id"] == primera.json()["document"]["id"]


# ---------------------------------------------------------------------------
# (c) El documento emitido es inmutable (§5.4, SPEC §8.3)
# ---------------------------------------------------------------------------


def test_an_issued_document_is_immutable_and_reprinting_only_counts(
    device_client: Any, db: Any, open_shift: Any, sales_products: Any
) -> None:
    """§8.3: «Inmutable después de validado… Toda corrección va **por nota**,
    nunca editando ni borrando un documento expedido»; §3.4: «se cuentan las
    **reimpresiones** por persona».

    Reimprimir es la única escritura que 1b-1 admite sobre un documento
    emitido, y sólo puede tocar contadores: si además pudiera reescribir un
    total, el comprobante dejaría de ser evidencia. Las notas de ajuste, que
    son la vía legal para corregir, son de 1b-2 y todavía no existen — así que
    hoy no tiene que existir **ninguna** forma de cambiar un documento.
    """
    from app.fiscal.models import DocumentReprint, FiscalDocument

    open_shift()
    cobro = _sell_and_charge(device_client, sales_products["inc8"].id, qty=2)
    assert cobro.status_code == 201, cobro.text
    doc_id = cobro.json()["document"]["id"]

    antes = device_client.get(f"{API}/documents/{doc_id}").json()
    assert antes["print_count"] == 1 and antes["reprint_count"] == 0

    reimpresion = device_client.post(f"{API}/documents/{doc_id}/reprint")
    assert reimpresion.status_code == 200, reimpresion.text
    despues = reimpresion.json()

    assert despues["reprint_count"] == 1, "la reimpresión se cuenta (§3.4)"
    assert len(despues["reprints"]) == 1
    assert despues["reprints"][0]["by"], "y queda a nombre de quien la pidió"

    inmutables = (
        "number",
        "prefix",
        "full_number",
        "document_type",
        "dian_status",
        "legend",
        "business_date",
        "issued_at",
        "subtotal",
        "discount_total",
        "tax_total",
        "total",
        "tax_lines",
        "lines",
        "payments",
        "customer",
        "store",
    )
    for campo in inmutables:
        assert despues[campo] == antes[campo], f"reimprimir cambió `{campo}` del documento emitido"

    db.expire_all()
    filas = list(db.execute(select(DocumentReprint).where(DocumentReprint.document_id == doc_id)).scalars())
    assert len(filas) == 1, "una fila de reimpresión por reimpresión, nunca un contador suelto"
    fila = db.get(FiscalDocument, doc_id)
    assert fila is not None and fila.status == "issued", (
        "en 1b-1 ningún documento puede quedar `reversed`: eso llega con las notas de 1b-2"
    )


def test_a_document_never_claims_evidence_the_provider_did_not_give_it(
    device_client: Any, db: Any, open_shift: Any, sales_products: Any
) -> None:
    """§8.3: «Evidencia persistida por documento: CUDE (o CUFE), XML firmado o
    referencia inmutable más hash, QR con URL de consulta, respuesta de la
    DIAN».

    En 1b-2 el proveedor real sigue siendo `PendingTransmissionProvider` (el
    dueño todavía no eligió uno): el documento queda `pending`, **sin** CUDE
    ni QR, y lo dice en su leyenda. Un `cude` o un `qr_url` inventado sería
    una afirmación falsa impresa en un papel que el cliente se lleva — y el
    papel es el único soporte que tiene.

    Lo que sí cambió respecto de 1b-1: ahora el documento SÍ apunta a su
    rango (`fiscal_range_id`), porque el número salió de una resolución real.
    """
    from app.fiscal.models import FiscalDocument

    open_shift()
    for _ in range(3):
        assert _sell_and_charge(device_client, sales_products["inc8"].id).status_code == 201

    db.expire_all()
    documentos = list(db.execute(select(FiscalDocument)).scalars())
    assert len(documentos) == 3

    for row in documentos:
        assert row.dian_status is not None and row.dian_status.value == "pending", (
            "sin proveedor tecnológico conectado el documento queda pendiente de transmisión"
        )
        assert row.cude is None, "no hay CUDE hasta que un proveedor lo firme"
        assert row.qr_url is None, "ni QR de consulta"
        assert row.xml_ref is None
        assert row.validated_at is None
        assert row.fiscal_range_id is not None, (
            "el número salió de un rango autorizado: el documento tiene que poder probar cuál"
        )
        assert "PENDIENTE DE TRANSMISIÓN" in row.legend.upper(), (
            "y lo dice en la leyenda que se imprime, sin ambigüedad"
        )

    printable = device_client.get(f"{API}/documents/{documentos[0].id}").json()
    assert printable["fiscal"]["cude"] is None and printable["fiscal"]["qr_url"] is None, (
        "la representación impresa tampoco inventa evidencia"
    )
    assert printable["fiscal"]["contingency"] is False
    assert printable["fiscal"]["range"] is not None, (
        "la representación gráfica lleva el rango y su vigencia (§8.3)"
    )
    for campo in ("prefix", "from_number", "to_number", "resolution_number", "valid_until"):
        assert campo in printable["fiscal"]["range"], campo


# ---------------------------------------------------------------------------
# (d) Rango de numeración: sin rango no se vende, y falla con 400 (§8.3)
# ---------------------------------------------------------------------------


def test_charging_without_a_valid_range_is_a_400_that_names_the_corrective_action(
    device_client: Any, db: Any, store: Any, open_shift: Any, sales_products: Any
) -> None:
    """Pedido 1b-2: «un cobro sin rango vigente tiene que fallar con un `400`
    que nombre la acción correctiva, nunca un `500`», y §11.18: «todo 4xx
    operativo nombra la acción correctiva».

    Importa más de lo que parece: el cajero que recibe un `500` a las 13:10 de
    un sábado no sabe qué hacer y cobra por fuera del sistema. Con el `400` y
    el texto correcto, el administrador sabe exactamente qué cargar.

    Y la segunda mitad, que es la que de verdad cuesta plata: el cobro
    rechazado **no puede dejar la comanda cobrada sin documento**. `get_db`
    comitea también ante `AppError` (`docs/ESTADO.md`), así que si el chequeo
    de rango viviera después de `claim_payment` la venta quedaría `paid`, sin
    comprobante y sin pago registrado — la venta se pierde entera.
    """
    from app.fiscal.models import FiscalDocument, FiscalRange
    from app.payments.models import Payment

    open_shift()
    db.execute(delete(FiscalRange))
    db.commit()

    order = create_order(device_client, channel="counter").json()
    order = add_items(device_client, order, [{"product_id": sales_products["inc8"].id, "qty": 1}]).json()
    cobro = pay(
        device_client,
        order["id"],
        splits=[{"method": "cash", "amount": order["totals"]["total"]}],
        tip=NO_TIP,
    )
    assert cobro.status_code == 400, cobro.text
    error = cobro.json()["error"]
    assert error["code"] == "NO_FISCAL_RANGE", cobro.text
    assert "rango" in error["message"].lower() and "dian" in error["message"].lower(), (
        f"el mensaje tiene que nombrar la acción correctiva: {error['message']!r}"
    )

    db.expire_all()
    vigente = get_order(device_client, order["id"])
    assert vigente["status"] != "paid", (
        "el cobro falló: la comanda tiene que seguir cobrable — «un cobro que falla conserva la cuenta» (§3.4)"
    )
    assert db.execute(select(func.count()).select_from(FiscalDocument)).scalar_one() == 0
    assert db.execute(select(func.count()).select_from(Payment)).scalar_one() == 0

    # Y con el rango cargado, la misma comanda se cobra y arranca en 1.
    seed_fiscal_ranges(db, store)
    buena = pay(
        device_client,
        order["id"],
        splits=[{"method": "cash", "amount": order["totals"]["total"]}],
        tip=NO_TIP,
    )
    assert buena.status_code == 201, buena.text
    assert buena.json()["document"]["number"] == 1


def test_an_exhausted_range_is_also_a_400_and_a_new_range_continues_the_series(
    device_client: Any, db: Any, store: Any, open_shift: Any, sales_products: Any
) -> None:
    """§8.3: el rango tiene «desde» y «hasta»; agotado, no se puede seguir
    emitiendo con él. El código tiene que distinguir «no hay rango» de «el
    rango se acabó», porque la acción correctiva es distinta (cargar el
    primero vs. pedir una resolución nueva), y ninguno de los dos puede ser
    un `500`.
    """
    from app.fiscal.models import FiscalRange

    open_shift()
    db.execute(delete(FiscalRange))
    db.commit()
    # Un rango de exactamente dos números.
    seed_fiscal_ranges(db, store, from_number=900, to_number=901, types=("pos_equivalent",))

    numeros = []
    for _ in range(2):
        cobro = _sell_and_charge(device_client, sales_products["inc8"].id)
        assert cobro.status_code == 201, cobro.text
        numeros.append(cobro.json()["document"]["number"])
    assert numeros == [900, 901], f"el consecutivo arranca en el «desde» del rango: {numeros}"

    order = create_order(device_client, channel="counter").json()
    order = add_items(device_client, order, [{"product_id": sales_products["inc8"].id, "qty": 1}]).json()
    agotado = pay(
        device_client,
        order["id"],
        splits=[{"method": "cash", "amount": order["totals"]["total"]}],
        tip=NO_TIP,
    )
    assert agotado.status_code == 400, agotado.text
    assert agotado.json()["error"]["code"] == "FISCAL_RANGE_EXHAUSTED", agotado.text
    assert "rango" in agotado.json()["error"]["message"].lower()

    # Rango nuevo (otra resolución): la serie sigue donde diga el rango nuevo,
    # y el anterior queda como histórico. Nada se reutiliza.
    seed_fiscal_ranges(db, store, from_number=1_000, to_number=1_050, types=("pos_equivalent",))
    siguiente = pay(
        device_client,
        order["id"],
        splits=[{"method": "cash", "amount": order["totals"]["total"]}],
        tip=NO_TIP,
    )
    assert siguiente.status_code == 201, siguiente.text
    assert siguiente.json()["document"]["number"] == 1_000


def _range_low_alerts(db: Any) -> list[Any]:
    from app.notifications.models import Notification

    db.expire_all()
    return list(db.execute(select(Notification).where(Notification.type == "fiscal_range_low")).scalars())


def test_the_range_alerts_at_eighty_percent_consumed_and_not_before(
    device_client: Any, db: Any, store: Any, open_shift: Any, sales_products: Any
) -> None:
    """Pedido 1b-2 y §8.3: «Alertas al 80 % del rango… antes del
    vencimiento» → notificación `fiscal_range_low`.

    Es la alerta que evita el único incidente que no tiene salida operativa:
    el rango agotado en hora pico, con el restaurante lleno. Se audita el
    umbral **por abajo** también: una alerta que salta desde el primer
    documento es una alerta que nadie mira a los tres días, y entonces no
    existe.
    """
    from app.fiscal.models import FiscalRange

    open_shift()
    db.execute(delete(FiscalRange))
    db.commit()
    seed_fiscal_ranges(db, store, from_number=1, to_number=5, types=("pos_equivalent",))

    # 1/5 y 2/5 consumidos: 20 % y 40 %, por debajo del umbral.
    for _ in range(2):
        assert _sell_and_charge(device_client, sales_products["inc8"].id).status_code == 201
    assert _range_low_alerts(db) == [], "el 40 % de un rango no es una alerta: sería ruido diario"

    # 3/5 = 60 %, 4/5 = 80 % -> acá sí.
    for _ in range(2):
        assert _sell_and_charge(device_client, sales_products["inc8"].id).status_code == 201
    disparadas = _range_low_alerts(db)
    assert disparadas, "al 80 % consumido el rango tiene que avisar antes de agotarse"
    assert "80" in disparadas[0].body or "4/5" in disparadas[0].body, disparadas[0].body


def test_the_range_alerts_thirty_days_before_it_expires(
    device_client: Any, db: Any, store: Any, open_shift: Any, sales_products: Any
) -> None:
    """La otra mitad de la alerta (§8.3): «y 30 días antes del vencimiento».

    Un rango puede vencer con el 99 % sin usar: la vigencia de la resolución
    y el consumo son dos relojes distintos, y el que sorprende es el de la
    fecha, porque no se ve venir en ningún número.
    """
    from app.core import clock as clock_module
    from app.fiscal import service as fiscal_service
    from app.fiscal.models import FiscalDocumentType, FiscalRange

    open_shift()
    db.execute(delete(FiscalRange))
    db.commit()

    hoy = clock_module.now_utc().date()
    fiscal_service.create_range(
        db,
        organization_id=store.organization_id,
        store_id=store.id,
        document_type=FiscalDocumentType.POS_EQUIVALENT,
        prefix="POS",
        from_number=1,
        to_number=1_000_000,  # consumo irrelevante: sólo vence pronto
        resolution_number="18760000002",
        resolution_date=hoy - timedelta(days=300),
        valid_from=hoy - timedelta(days=300),
        valid_until=hoy + timedelta(days=10),
        technical_key="vence-pronto",
        now=clock_module.now_utc(),
    )
    db.commit()

    assert _sell_and_charge(device_client, sales_products["inc8"].id).status_code == 201
    por_vencer = _range_low_alerts(db)
    assert por_vencer, "un rango a 10 días de vencer tiene que avisar (umbral 30 días)"
    assert "vence" in por_vencer[0].body.lower(), por_vencer[0].body


# ---------------------------------------------------------------------------
# (e) Proveedor, estados DIAN y contingencia (§8.3)
# ---------------------------------------------------------------------------


def test_a_rejected_document_keeps_its_number_notifies_and_can_be_retried(
    device_client: Any, admin_client: Any, db: Any, store: Any, open_shift: Any, sales_products: Any
) -> None:
    """§8.3: «Un documento rechazado no libera su consecutivo: se corrige y
    reenvía o se anula por nota», y la notificación `fiscal_rejected` del
    pedido.

    El rechazo cambia el estado, la leyenda y la evidencia — nunca el número,
    ni el total, ni las líneas. Esa es la diferencia entre "el documento se
    corrige" y "el documento se reescribe", y sólo la primera es legal.
    """
    from app.fiscal.models import FiscalDocument
    from app.fiscal.provider import FakeProvider, set_provider_override
    from app.notifications.models import Notification

    open_shift()
    try:
        set_provider_override(FakeProvider(outcome="reject", reject_reason="NIT del adquirente inválido"))
        cobro = _sell_and_charge(device_client, sales_products["inc8"].id)
        assert cobro.status_code == 201, cobro.text
        documento = cobro.json()["document"]
        assert documento["dian_status"] == "rejected"
        doc_id = documento["id"]

        antes = admin_client.get(f"{API}/documents/{doc_id}").json()
        assert "RECHAZADO" in antes["legend"].upper(), antes["legend"]

        db.expire_all()
        avisos = list(
            db.execute(select(Notification).where(Notification.type == "fiscal_rejected")).scalars()
        )
        assert avisos, "un documento rechazado por la DIAN tiene que llegar a «Requiere tu atención»"
        assert avisos[0].level == "critical"

        # Reintentar con un proveedor que ahora valida: mismo número, misma
        # plata, mismas líneas; cambian estado, leyenda y evidencia.
        set_provider_override(FakeProvider(outcome="validate"))
        reintento = admin_client.post(
            f"{API}/admin/fiscal/documents/{doc_id}/retry", headers=idem_headers()
        )
        assert reintento.status_code == 200, reintento.text
        assert reintento.json()["dian_status"] == "validated"
    finally:
        set_provider_override(None)

    despues = admin_client.get(f"{API}/documents/{doc_id}").json()
    for campo in ("number", "prefix", "full_number", "document_type", "total", "tax_total", "lines"):
        assert despues[campo] == antes[campo], f"el reintento cambió `{campo}` de un documento emitido"
    assert despues["dian_status"] == "validated"
    assert despues["legend"] != antes["legend"], (
        "la leyenda depende del estado DIAN y la manda siempre el servidor (A-11)"
    )

    db.expire_all()
    fila = db.get(FiscalDocument, doc_id)
    assert fila is not None and fila.cude is not None and fila.qr_url is not None
    assert fila.validated_at is not None


def test_a_contingency_document_prints_its_legend_and_fires_overdue_at_48_hours(
    device_client: Any, admin_client: Any, db: Any, store: Any, clock: Any, open_shift: Any, sales_products: Any
) -> None:
    """§8.3: «Si el proveedor o la DIAN no responden, el documento queda en
    **contingencia** con su fecha de generación, el POS sigue vendiendo e
    imprimiendo con leyenda de contingencia… el plazo legal es de **48
    horas** (art. 616-1 ET); los vencidos aparecen en "Requiere tu
    atención"».

    Con **reloj simulado** (`clock.advance(hours=…)`), nunca con `sleep`: un
    test que duerme 48 horas no es un test. Se auditan los dos lados del
    umbral — a las 47 h todavía no, a las 49 h sí — porque una alerta que
    salta antes de tiempo se apaga y deja de mirarse.
    """
    from app.fiscal.provider import FakeProvider, set_provider_override
    from app.notifications.models import Notification

    open_shift()
    try:
        set_provider_override(FakeProvider(outcome="contingency"))
        cobro = _sell_and_charge(device_client, sales_products["inc8"].id)
        assert cobro.status_code == 201, cobro.text
        documento = cobro.json()["document"]
        assert documento["dian_status"] == "contingency"
        assert documento["contingency"] is True
        doc_id = documento["id"]
    finally:
        set_provider_override(None)

    # (1) Se imprime CON su leyenda, y la leyenda la manda el servidor.
    printable = device_client.get(f"{API}/documents/{doc_id}").json()
    assert "CONTINGENCIA" in printable["legend"].upper(), printable["legend"]
    assert "616-1" in printable["legend"], (
        "la leyenda de contingencia cita la norma que la ampara: es lo que la hace válida"
    )
    assert printable["fiscal"]["contingency"] is True

    def _vencidos() -> list[Notification]:
        db.expire_all()
        return list(
            db.execute(
                select(Notification).where(Notification.type == "fiscal_contingency_overdue")
            ).scalars()
        )

    # (2) A las 47 horas todavía está dentro del plazo legal.
    clock.advance(hours=47)
    listado = admin_client.get(f"{API}/admin/fiscal/documents", params={"store_id": store.id})
    assert listado.status_code == 200, listado.text
    fila = next(r for r in listado.json() if r["id"] == doc_id)
    assert fila["contingency"] is True and fila["contingency_overdue"] is False
    assert _vencidos() == [], "a las 47 h el plazo del art. 616-1 ET todavía no venció"

    # (3) A las 49 horas venció: la alerta existe y el listado lo marca.
    clock.advance(hours=2)
    listado = admin_client.get(f"{API}/admin/fiscal/documents", params={"store_id": store.id})
    assert listado.status_code == 200, listado.text
    fila = next(r for r in listado.json() if r["id"] == doc_id)
    assert fila["contingency_overdue"] is True
    disparadas = _vencidos()
    assert len(disparadas) == 1, f"a las 48 h tiene que disparar `fiscal_contingency_overdue`: {disparadas}"
    assert disparadas[0].payload["document_id"] == doc_id

    # (4) Y no se duplica al volver a mirar el mismo día (dedupe).
    admin_client.get(f"{API}/admin/fiscal/documents", params={"store_id": store.id})
    assert len(_vencidos()) == 1, "la alerta se deduplica por día; si no, tapa todo lo demás"


def test_the_legend_always_comes_from_the_server_and_follows_the_dian_state(
    device_client: Any, db: Any, store: Any, open_shift: Any, sales_products: Any, set_feature: Any
) -> None:
    """**A-11** (`outputs-1b-1/auditor-venta.md §3`), cerrado del lado del
    servidor: la leyenda legal depende del estado DIAN y de la contingencia,
    así que sólo el servidor puede escribirla. Acá se prueba que **cada
    estado tiene su leyenda propia y distinta** — que es lo que convierte una
    leyenda hardcodeada en el cliente en un riesgo legal y no en una
    prolijidad.
    """
    from app.fiscal.provider import FakeProvider, set_provider_override

    open_shift()
    leyendas: dict[str, str] = {}
    for outcome, esperado in (("validate", "validated"), ("reject", "rejected"), ("contingency", "contingency")):
        try:
            set_provider_override(FakeProvider(outcome=outcome))  # type: ignore[arg-type]
            cobro = _sell_and_charge(device_client, sales_products["inc8"].id)
        finally:
            set_provider_override(None)
        assert cobro.status_code == 201, cobro.text
        documento = cobro.json()["document"]
        assert documento["dian_status"] == esperado
        leyendas[esperado] = documento["legend"]

    # Y el `pending` del proveedor real de esta fase.
    cobro = _sell_and_charge(device_client, sales_products["inc8"].id)
    assert cobro.status_code == 201, cobro.text
    leyendas["pending"] = cobro.json()["document"]["legend"]

    assert len(set(leyendas.values())) == 4, (
        f"cada estado ante la DIAN necesita su propia leyenda impresa: {leyendas}"
    )
    for estado, texto in leyendas.items():
        assert texto.strip(), f"el estado {estado} quedó sin leyenda"


# ---------------------------------------------------------------------------
# (f) Factura electrónica: umbral en UVT y adquirente identificado (§8.3)
# ---------------------------------------------------------------------------


def test_an_invoice_over_the_uvt_threshold_needs_an_identified_customer(
    device_client: Any, db: Any, store: Any, open_shift: Any, sales_products: Any, set_feature: Any
) -> None:
    """§8.3: «Cuando el cliente pide factura o el neto supera el **umbral**
    (`invoice_threshold_uvt`, default 5 UVT ≈ $261.870 en 2026)… el POS ofrece
    factura electrónica y captura tipo y número de documento»; checklist:
    `400 CUSTOMER_REQUIRED_FOR_INVOICE` si no está identificado.

    El umbral se mide sobre el **neto** (§8.2: «venta neta = total ÷ (1 +
    tasa)»), no sobre lo cobrado: medirlo sobre el bruto empujaría a factura
    ventas que la norma no obliga, y con ellas a pedirle datos personales a
    quien no tiene por qué darlos (§8.4, minimización).
    """
    from app.core import clock as clock_module
    from app.fiscal.models import FiscalDocument
    from app.stores.models import UvtValue

    set_feature("fiscal.invoice", True)
    open_shift()

    # UVT chiquita a propósito: 5 UVT = $500, así una venta normal ya lo pasa
    # y el test no depende de vender un millón de pesos.
    anio = clock_module.now_utc().date().year
    existentes = list(db.execute(select(UvtValue)).scalars())
    for row in existentes:
        db.delete(row)
    db.add(UvtValue(organization_id=store.organization_id, year=anio, value=100))
    db.commit()

    order = create_order(device_client, channel="counter").json()
    order = add_items(device_client, order, [{"product_id": sales_products["inc8"].id, "qty": 1}]).json()
    splits = [{"method": "cash", "amount": order["totals"]["total"]}]

    sin_cliente = pay(device_client, order["id"], splits=splits, tip=NO_TIP)
    assert sin_cliente.status_code == 400, sin_cliente.text
    assert sin_cliente.json()["error"]["code"] == "CUSTOMER_REQUIRED_FOR_INVOICE", sin_cliente.text
    assert "cliente" in sin_cliente.json()["error"]["message"].lower()

    db.expire_all()
    assert db.execute(select(func.count()).select_from(FiscalDocument)).scalar_one() == 0, (
        "el cobro rechazado no emitió nada: tampoco puede haber consumido un número"
    )
    assert get_order(device_client, order["id"])["status"] != "paid"

    con_cliente = pay(
        device_client,
        order["id"],
        splits=splits,
        tip=NO_TIP,
        customer={
            "doc_type": "31",
            "doc_number": "900123456",
            "dv": "1",
            "name": "Empresa Auditada SAS",
            "email": "facturas@auditada.test",
            "consent": {"text_version": "v1", "channel": "pos"},
        },
    )
    assert con_cliente.status_code == 201, con_cliente.text
    assert con_cliente.json()["document"]["document_type"] == "invoice"
    assert con_cliente.json()["requires_invoice"] is True
    assert con_cliente.json()["document"]["prefix"] == "FE", (
        "la factura lleva su propio rango y su propio prefijo, no el del documento equivalente"
    )


def test_with_fiscal_invoice_off_asking_for_an_invoice_is_a_feature_disabled(
    device_client: Any, open_shift: Any, sales_products: Any, set_feature: Any
) -> None:
    """§1.1 y `AGENTS.md`: «toda función opcional detrás de su flag, exigida
    por el backend con `400 FEATURE_DISABLED`, probada encendida Y apagada».
    `fiscal.invoice` es opcional; `fiscal.dee_pos` (el documento equivalente)
    sólo se apaga si la organización declaró no estar obligada.
    """
    set_feature("fiscal.invoice", False)
    open_shift()
    order = create_order(device_client, channel="counter").json()
    order = add_items(device_client, order, [{"product_id": sales_products["inc8"].id, "qty": 1}]).json()
    splits = [{"method": "cash", "amount": order["totals"]["total"]}]

    apagada = pay(device_client, order["id"], splits=splits, tip=NO_TIP, requests_invoice=True)
    assert apagada.status_code == 400, apagada.text
    assert apagada.json()["error"]["code"] == "FEATURE_DISABLED", apagada.text
    assert apagada.json()["error"].get("feature") == "fiscal.invoice" or (
        "fiscal.invoice" in apagada.text
    ), apagada.text

    # Encendida, la misma petición emite una factura.
    set_feature("fiscal.invoice", True)
    encendida = pay(
        device_client,
        order["id"],
        splits=splits,
        tip=NO_TIP,
        requests_invoice=True,
        customer={
            "doc_type": "13",
            "doc_number": "1020304050",
            "name": "Cliente Identificado",
            "consent": {"text_version": "v1", "channel": "pos"},
        },
    )
    assert encendida.status_code == 201, encendida.text
    assert encendida.json()["document"]["document_type"] == "invoice"


def test_the_amount_due_is_summed_by_the_server_never_by_the_client(
    device_client: Any, open_shift: Any, sales_products: Any
) -> None:
    """**A-10** (`outputs-1b-1/auditor-venta.md §3`), cerrado del lado del
    servidor: «Que lo mande el backend». `PaymentOut.amount_due` = venta +
    propina, siempre presente, calculado por la única matemática del backend.

    `null` no es 0 (§11.13): el campo es obligatorio en el esquema, así que un
    cliente nunca tiene que elegir entre sumar por su cuenta y pintar `$0`.
    """
    open_shift()
    order = create_order(device_client, channel="counter").json()
    order = add_items(device_client, order, [{"product_id": sales_products["inc8"].id, "qty": 2}]).json()
    total = order["totals"]["total"]
    propina = 3_000

    cobro = pay(
        device_client,
        order["id"],
        splits=[{"method": "cash", "amount": total + propina}],
        tip={"asked": True, "accepted": True, "modified": True, "amount": propina},
    )
    assert cobro.status_code == 201, cobro.text
    cuerpo = cobro.json()
    assert cuerpo["amount_due"] == total + propina, (
        "el monto a cobrar lo suma el servidor, no la pantalla"
    )
    assert cuerpo["total"] == total and cuerpo["tip_amount"] == propina, (
        "y sigue discriminado: la propina nunca se mezcla con la venta"
    )


def test_with_the_electronic_document_off_it_is_an_internal_receipt_that_never_claims_otherwise(
    device_client: Any, db: Any, open_shift: Any, sales_products: Any, set_feature: Any
) -> None:
    """Pedido 1b: «Con `fiscal.dee_pos` apagado (sólo si la organización
    declaró no estar obligada) el documento es un comprobante interno con
    consecutivo propio, y **nunca dice ser documento equivalente**».

    Es un invariante legal, no de plata: un comprobante interno que se hiciera
    pasar por documento equivalente induce al cliente a creer que tiene un
    soporte fiscal que no tiene. El consecutivo sigue siendo propio y sin
    huecos, porque el control interno no depende de la obligación fiscal.
    """
    from app.fiscal.models import FiscalDocument

    set_feature("fiscal.dee_pos", False)
    open_shift()

    numeros = []
    for _ in range(3):
        cobro = _sell_and_charge(device_client, sales_products["inc8"].id)
        assert cobro.status_code == 201, cobro.text
        documento = cobro.json()["document"]
        assert documento["document_type"] == "internal_receipt"
        assert documento["dian_status"] is None, (
            "un comprobante interno no tiene estado ante la DIAN: no se le transmite"
        )
        numeros.append(documento["number"])

        leyenda = documento["legend"].lower()
        assert "no es factura" in leyenda and "documento equivalente" in leyenda, (
            f"la leyenda tiene que negar ambas cosas explícitamente: {documento['legend']!r}"
        )
        assert "pendiente de transmisión" not in leyenda, (
            "no está pendiente de transmitir nada: no es un documento electrónico"
        )

    assert numeros == [1, 2, 3], f"el comprobante interno lleva su propio consecutivo: {numeros}"

    printable = device_client.get(f"{API}/documents/{numeros and 1}").json()
    assert printable["document_type"] == "internal_receipt"
    assert "equivalente" not in printable["type_label"].lower(), (
        f"ni la etiqueta del tipo puede llamarlo equivalente: {printable['type_label']!r}"
    )

    db.expire_all()
    for row in db.execute(select(FiscalDocument)).scalars():
        assert row.document_type.value == "internal_receipt"
        assert row.cude is None and row.qr_url is None and row.fiscal_range_id is None
