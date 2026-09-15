"""Invariantes del comprobante de venta: consecutivo, concurrencia y evidencia.

Auditor del pedido 1b-1 (rol Contador + Legal). El comprobante de 1b-1 **no
se transmite a nadie**: es el comprobante interno que 1b-2 convierte en
documento equivalente electrónico. Pero el consecutivo, la unicidad y la
inmutabilidad son exactamente las mismas reglas desde hoy, porque son las que
después no se pueden arreglar hacia atrás: un hueco en la numeración de marzo
no se tapa en abril (`docs/SPEC-NEGOCIO.md §8.3`, Res. DIAN 000165/2023;
sanción del art. 657 ET).

Reglas de `CONTRATO-INTERNO-1b-1.md §5.4` y del checklist de
`features/fase-1b-venta/spec.md`. Los tests con hilos se escriben **siempre**
sobre `race_env`/`race_app` (contrato §3): la fixture `db` entrega una sola
`Session` a todos los requests y no es segura entre hilos — es el defecto D-2
del pedido 1a.
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from typing import Any


from sqlalchemy import func, select

from tests.audit.conftest import (
    NO_TIP,
    add_items,
    create_order,
    get_order,
    idem_headers,
    pay,
)

API = "/api/v1"

SALES_FOR_THE_SEQUENCE = 100


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


def test_one_hundred_sales_produce_a_sequence_without_holes(
    device_client: Any, open_shift: Any, sales_products: Any
) -> None:
    """§8.3: «Consecutivo estrictamente creciente, **sin huecos ni
    reutilización**, asignado en la misma transacción de la emisión».

    Cien ventas seguidas de mostrador: los números tienen que ser 1..100 sin
    saltos, sin repetidos y todos con el mismo prefijo y la misma sede. Es el
    único invariante de este archivo que no se puede recuperar después: un
    hueco en la numeración se descubre cuando la DIAN lo pregunta.
    """
    open_shift()
    numeros: list[int] = []
    prefijos: set[str] = set()
    for _ in range(SALES_FOR_THE_SEQUENCE):
        cobro = _sell_and_charge(device_client, sales_products["inc8"].id)
        assert cobro.status_code == 201, cobro.text
        documento = cobro.json()["document"]
        numeros.append(documento["number"])
        prefijos.add(documento["prefix"])

    assert len(prefijos) == 1, f"un solo prefijo por sede y tipo en 1b-1: {prefijos}"
    assert numeros == list(range(1, SALES_FOR_THE_SEQUENCE + 1)), (
        f"la serie tiene huecos, saltos o repetidos: {numeros}"
    )


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
    from app.fiscal.models import FiscalCounter

    open_shift()
    primera = _sell_and_charge(device_client, sales_products["inc8"].id)
    assert primera.status_code == 201, primera.text
    assert primera.json()["document"]["number"] == 1

    def _next_number() -> int:
        db.expire_all()
        row = db.execute(select(FiscalCounter)).scalars().one()
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


def test_no_document_of_this_phase_carries_dian_evidence(
    device_client: Any, db: Any, open_shift: Any, sales_products: Any
) -> None:
    """`CONTRATO-INTERNO-1b-1.md §2.2` y el pedido: «NADA de eso se emite ni
    se transmite en este pedido».

    El modelo ya se llama `fiscal_document` para que 1b-2 sólo agregue el
    adaptador de proveedor, pero **la evidencia tiene que estar vacía**: un
    `cude` o un `qr_url` inventado en 1b-1 sería una afirmación falsa impresa
    en un comprobante que el cliente se lleva. `dian_status` queda `pending` y
    el documento lo dice en su leyenda.
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
            "con `fiscal.dee_pos` encendida el documento nace pendiente de transmisión"
        )
        assert row.cude is None, "no hay CUDE hasta que un proveedor lo firme (1b-2)"
        assert row.qr_url is None, "ni QR de consulta"
        assert row.xml_ref is None and row.provider_response is None
        assert row.fiscal_range_id is None, "ni rango DIAN: los rangos son de 1b-2"
        assert row.validated_at is None
        assert "PENDIENTE DE TRANSMISIÓN" in row.legend.upper(), (
            "y lo dice en la leyenda que se imprime, sin ambigüedad"
        )

    printable = device_client.get(f"{API}/documents/{documentos[0].id}").json()
    assert printable["fiscal"] == {"range": None, "cude": None, "qr_url": None}, (
        "la representación impresa tampoco inventa evidencia"
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
