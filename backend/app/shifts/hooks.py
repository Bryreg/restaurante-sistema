"""Puntos de enganche cruzados del turno de caja.

Este módulo NO importa `app.shifts.service` (evita el ciclo: `service` sí
importa `hooks` para leer los totales de venta al calcular el esperado). Solo
depende de `app.shifts.models`, `app.core.clock` y, con `find_spec` (puede no
existir todavía durante la construcción en paralelo, o directamente no
existir en un proyecto que no vendió nada), de `app.payments.models`.

- `on_employee_identified` lo llama `backend-core` desde `POST
  /auth/device/identify`.
- `payment_bucket` es, desde la ronda 2 del pedido 2c, **el único lugar del
  sistema que decide en qué bolsillo cae un cobro**. Lo llaman
  `get_sales_totals` y `app.shifts.tips.get_shift_tips`: antes cada uno
  clasificaba a mano y las dos respuestas se separaron (H-2). Quien necesite
  repartir pagos por medio lo llama a él, no reescribe la regla.
- `get_sales_totals` lo llama `service.compute_breakdown`/`_evaluate_close`.
  Sin `app.payments` (o sin turno con pagos) devuelve ceros; con el módulo
  presente, lee `Payment` del turno con `voided_at IS NULL`
  (CONTRATO-INTERNO-1b-1.md §2.3) y reparte con `payment_bucket`: `cash` →
  `cash`/`tips_cash`, `card` → `card`/`tips_card`, `transfer` →
  `transfer`/`tips_transfer`, `platform`/`voucher`/`other` →
  `other`/`tips_other` (no entran al cajón), y efectivo con domiciliario →
  `delivery_cash`/`tips_delivery` — que **nunca** vuelven a `.cash`, ni
  antes ni después de liquidar: la VENTA entra al esperado por el
  `CashMovement(cause=DELIVERY_SETTLEMENT)` de la liquidación, y la PROPINA
  liquidada se publica en `cash_out` (`app.shifts.tips`, ronda 3, H-8).
  Sumarlas acá las contaría dos veces.
- `register_supplier_payment_expense` (pedido 2b, `features/fase-2-costo-
  inventario/spec.md § Alcance de 2b`) lo llama
  `app.purchases.service.create_payment` cuando un pago a proveedor sale del
  cajón: busca el turno `OPEN` de la sede y crea el egreso con la causa
  tipada `SUPPLIER_PAYMENT` — nunca `OTHER_EXPENSE` reciclada. Sin turno
  abierto levanta `AppError("NO_OPEN_SHIFT", status=409)` ANTES de escribir
  nada; quien llama valida-antes-de-escribir con esto (crea el egreso antes
  de la fila del pago), así que sin turno abierto no queda ni el egreso ni
  el pago.
- `register_supplier_payment_reversal` (ronda 2 del pedido 2b, H-1
  BLOQUEANTE) es el hermano exacto de `register_supplier_payment_expense`
  en la otra dirección: lo llama `app.purchases.service.void_payment`
  cuando se anula un pago que salió del cajón (`payment.from_cash_drawer`),
  ANTES de tocar una sola línea del pago. Busca el turno `OPEN` de la sede y
  crea un `CashMovement(kind=INCOME, cause=SUPPLIER_PAYMENT)` — nunca
  `OTHER_INCOME` reciclada, nunca un ajuste manual — que devuelve a la caja
  exactamente lo que el egreso original sacó. **Nada se borra ni se
  reescribe**: el `CashMovement` del pago original queda vivo tal cual;
  éste es un movimiento nuevo y compensatorio, en el turno abierto AL
  MOMENTO DE ANULAR (que puede no ser el mismo turno en el que se pagó — la
  plata vuelve al cajón HOY, que es lo que pasa físicamente; un turno ya
  `CLOSED` es inviolable porque su conteo a ciegas ya ocurrió).
  Sin turno abierto levanta `AppError("NO_OPEN_SHIFT", status=409)` ANTES de
  escribir nada, con un mensaje que nombra la acción correctiva; quien llama
  valida-antes-de-escribir con esto, así que sin turno abierto la anulación
  se rechaza completa: ni el reintegro ni el `voided_at` del pago quedan.
"""

from __future__ import annotations

import importlib
from dataclasses import dataclass
from typing import Any

from sqlalchemy import Select, select
from sqlalchemy.orm import Session

from app.core import clock
from app.core.errors import AppError
from app.core.modules import find_spec_safe
from app.shifts.models import (
    CashMovement,
    CashMovementCause,
    CashMovementKind,
    Shift,
    ShiftCarryIn,
    ShiftRoster,
    ShiftStatus,
)

_OTHER_METHODS = {"platform", "voucher", "other"}

#: Los bolsillos posibles de un cobro, en el orden en que se publican.
#: `delivery` es el que agrega 2c: efectivo que sostiene el domiciliario y
#: que NO está en el cajón.
PAYMENT_BUCKETS = ("cash", "card", "transfer", "other", "delivery")


def payment_bucket(method: Any, courier_employee_id: int | None) -> str:
    """**El único lugar del sistema que decide en qué bolsillo cae un cobro.**

    Ronda 2 del pedido 2c, cierre de H-2: antes esta pregunta se respondía
    dos veces —una acá dentro de `get_sales_totals`, otra a mano en
    `app.shifts.tips.get_shift_tips`— y las dos respuestas se separaron en
    cuanto 2c agregó el efectivo de domicilios. El mismo cuerpo de
    `GET /shifts/{id}/tips` llegó a decir que la propina en efectivo del
    turno era $10.000 por método y $20.000 por empleado. Es H-4 de 2b en su
    forma exacta —la misma pregunta con dos fórmulas— y se cierra igual:
    **una sola función, todos los llamadores**.

    Devuelve uno de `"cash" | "card" | "transfer" | "other" | "delivery"`:

    - `platform` / `voucher` / `other` colapsan en `"other"` (`_OTHER_METHODS`,
      desde 1b-1): son cuentas por cobrar, no plata en el cajón. Una venta
      cobrada por plataforma NO puede mover el esperado del turno.
    - efectivo **con** `courier_employee_id` (no nulo) es `"delivery"`: lo
      tiene el domiciliario, se arquea aparte (SPEC-NEGOCIO §3.3) y entra al
      cajón por un solo camino, el `CashMovement(cause=DELIVERY_SETTLEMENT)`
      de la liquidación.
    - cualquier medio desconocido cae en `"other"` antes que romper el
      esperado del turno con un `KeyError`.

    Lo que esta función **no** decide, y no tiene que decidir: si un cobro de
    domicilio ya está liquidado o sigue pendiente. Eso lo deriva
    `get_sales_totals` de `delivery_settlement_id`, aparte, y lo publica en
    `tips_delivery_pending` / `delivery_cash_pending`, porque es un hecho del
    COBRO y no del bolsillo. **`payment_bucket` no mira
    `delivery_settlement_id` a propósito**: si lo mirara, la propina de un
    domicilio liquidado se mudaría de bolsillo a mitad del turno y
    `by_method.cash` dejaría de coincidir con `sum(by_employee[*].cash)` —
    que es H-2 otra vez—.

    Ronda 3, cierre de H-8: quien necesita saber **cuánta propina se puede
    sacar del cajón hoy** no pregunta acá, pregunta por `cash_out`
    (`app.shifts.tips.get_shift_tips`), que suma la propina de domicilio ya
    liquidada. Son dos preguntas distintas: ésta es «por qué medio entró».
    """

    method_key = method.value if hasattr(method, "value") else str(method)
    bucket = "other" if method_key in _OTHER_METHODS else method_key
    if bucket not in ("cash", "card", "transfer", "other"):
        bucket = "other"
    if bucket == "cash" and courier_employee_id is not None:
        return "delivery"
    return bucket


def methods_in_bucket(bucket: str) -> tuple[str, ...]:
    """Los medios de pago que caen en `bucket`, **derivados de la autoridad**.

    Existe por R-3 del cierre de la fase 3. `app/banking/` necesita saber qué
    medios son «tarjeta» y cuáles «transferencia» para la conciliación y el
    libro del banco. Lo estaba derivando bien —recorriendo
    `PAYMENT_METHOD_VALUES` y preguntándole a `payment_bucket`— pero para
    hacerlo tenía que escribir `... == "card"` en su propio módulo, y un
    invariante que barre literales de medios de pago fuera de `app/shifts/`
    lo marcaba, con razón de forma: desde afuera no se distingue «comparo la
    salida de la autoridad» de «clasifico por mi cuenta», y la segunda es el
    defecto que costó H-2 y H-4.

    La derivación vive acá, al lado de la única función que decide. Un medio
    nuevo en `PAYMENT_METHOD_VALUES` entra solo, sin que ningún otro módulo
    se entere: si `payment_bucket` lo manda a `"card"`, aparece acá.

    Se calcula en cada llamada a propósito (son seis medios): una constante a
    nivel de módulo se congelaría al importar, y la gracia es justamente que
    siga el catálogo.
    """
    from app.payments.models import PAYMENT_METHOD_VALUES

    return tuple(m for m in PAYMENT_METHOD_VALUES if payment_bucket(m, None) == bucket)


@dataclass(frozen=True)
class SalesTotals:
    """Ventas y propinas del turno por medio de pago. Sin `app.payments`
    (o sin pagos todavía) siempre cero.

    **Pedido 2c — los cuatro campos nuevos, y por qué existen.** El efectivo
    de domicilios se arquea APARTE del cajón (SPEC-NEGOCIO §3.3): lo tiene
    el domiciliario hasta que liquida. Por eso un cobro en efectivo con
    `Payment.delivery_courier_employee_id` no nulo **nunca** entra a `.cash`
    (ni su propina a `.tips_cash`) — ni antes ni después de liquidar — y se
    publica acá en su propio renglón:

    - `delivery_cash` / `tips_delivery`: todo el efectivo de domicilios
      cobrado EN ESTE TURNO, liquidado o no.
    - `delivery_cash_pending` / `tips_delivery_pending`: el subconjunto que
      el domiciliario todavía no entregó.

    La plata entra al cajón por **un solo camino**: el
    `CashMovement(kind=INCOME, cause=DELIVERY_SETTLEMENT)` que escribe la
    liquidación en el turno ABIERTO en ese momento (que puede no ser éste).
    Así `compute_breakdown` no cambia de fórmula y nada se cuenta dos veces:
    si `.cash` también los sumara, el mismo billete estaría en el esperado
    dos veces.

    **Ronda 2, cierre de H-1 — por cuánto mueve el esperado.** Ese `INCOME`
    se escribe por el monto de la **venta sola** (`DeliverySettlement.amount`),
    nunca por venta + propina. La propina en efectivo de un domicilio se
    trata **exactamente igual** que la propina en efectivo de cualquier otra
    venta: no mueve el esperado del turno (la fórmula heredada de 1b sólo
    lee `.cash`, y la propina vive en `tips_*`) y se salda al cierre por
    `tips_cash_out`/`to_deposit` (`app/shifts/service.py:1035`). Si el
    `INCOME` incluyera la propina, el mismo billete movería el esperado
    distinto según el canal por el que entró, y la diferencia del arqueo a
    ciegas cambiaría por el valor de la propina.

    El domiciliario sigue entregando venta + propina, y eso se sigue
    registrando (`DeliverySettlement.amount` y `.tip_amount`, y el renglón
    informativo `delivery_cash_pending` del desglose, que los suma porque es
    cierto: el domiciliario sostiene las dos cosas). Lo que NO cambia por la
    propina es el **esperado**.
    """

    cash: int = 0
    card: int = 0
    transfer: int = 0
    other: int = 0
    tips_cash: int = 0
    tips_card: int = 0
    tips_transfer: int = 0
    tips_other: int = 0
    # Pedido 2c: el efectivo de domicilios, siempre FUERA de `.cash`.
    delivery_cash: int = 0
    delivery_cash_pending: int = 0
    tips_delivery: int = 0
    tips_delivery_pending: int = 0
    # Cuántos cobros de domicilio siguen sin liquidar, y de cuántos
    # domiciliarios: conteos, no plata. Los lee el chequeo previo al cierre
    # (`service.close_precheck`), que no puede publicar ningún monto.
    delivery_pending_payments: int = 0
    delivery_pending_couriers: int = 0


def get_sales_totals(db: Session, shift_id: int) -> SalesTotals:
    """Totales de venta y propina por medio para el turno `shift_id`, leyendo
    `app.payments.models.Payment` (protegido con `find_spec`: sin el módulo
    de pagos devuelve ceros, no falla). `compute_breakdown` sigue leyendo
    sólo `.cash`, sin cambios.

    Pedido 2c: un pago en efectivo que sostiene un domiciliario sale de
    `.cash`/`.tips_cash` y va a `.delivery_cash`/`.tips_delivery` (y a los
    `_pending` mientras no haya liquidación). Las columnas se leen con
    `getattr` sobre el modelo: si `app.payments.models.Payment` todavía no
    las tiene (construcción en paralelo, o una base vieja), el
    comportamiento es exactamente el de 2b — todo el efectivo al cajón —
    en vez de un `AttributeError` que tumbaría el esperado del turno.
    """

    if find_spec_safe("app.payments.models") is None:
        return SalesTotals()

    payments_module = importlib.import_module("app.payments.models")
    payment_model = getattr(payments_module, "Payment", None)
    if payment_model is None:
        return SalesTotals()

    courier_col = getattr(payment_model, "delivery_courier_employee_id", None)
    settlement_col = getattr(payment_model, "delivery_settlement_id", None)

    totals = {
        "cash": 0,
        "card": 0,
        "transfer": 0,
        "other": 0,
        "tips_cash": 0,
        "tips_card": 0,
        "tips_transfer": 0,
        "tips_other": 0,
        "delivery_cash": 0,
        "delivery_cash_pending": 0,
        "tips_delivery": 0,
        "tips_delivery_pending": 0,
    }

    pending_couriers: set[int] = set()
    pending_payments = 0

    columns = [payment_model.method, payment_model.amount, payment_model.tip_amount]
    if courier_col is not None and settlement_col is not None:
        columns += [courier_col, settlement_col]
    rows = db.execute(
        select(*columns).where(payment_model.shift_id == shift_id, payment_model.voided_at.is_(None))
    ).all()

    for row in rows:
        method, amount, tip_amount = row[0], row[1], row[2]
        courier_id = row[3] if len(row) > 3 else None
        settlement_id = row[4] if len(row) > 4 else None
        # Una sola función decide el bolsillo (ronda 2, cierre de H-2).
        bucket = payment_bucket(method, courier_id)

        if bucket == "delivery":
            # Efectivo que tiene el domiciliario: NUNCA al cajón por acá.
            totals["delivery_cash"] += int(amount or 0)
            totals["tips_delivery"] += int(tip_amount or 0)
            if settlement_id is None:
                # Pendiente/liquidado se deriva del cobro, no del bolsillo.
                totals["delivery_cash_pending"] += int(amount or 0)
                totals["tips_delivery_pending"] += int(tip_amount or 0)
                pending_payments += 1
                if courier_id is not None:
                    pending_couriers.add(int(courier_id))
            continue

        totals[bucket] += int(amount or 0)
        totals[f"tips_{bucket}"] += int(tip_amount or 0)

    return SalesTotals(
        **totals, delivery_pending_payments=pending_payments, delivery_pending_couriers=len(pending_couriers)
    )


def on_employee_identified(db: Session, *, store_id: int, employee: object) -> None:
    """Agrega al empleado identificado al roster del turno abierto de su sede.

    Lo llama `backend-core` en `POST /auth/device/identify`
    (`docs/SPEC-NEGOCIO.md §2.1`: "Identificarse la agrega automáticamente al
    roster del turno con hora de entrada"). Si no hay turno abierto, no hace
    nada (identificarse no exige turno abierto). Es idempotente: si la persona
    ya tiene una entrada abierta en el roster, no duplica.
    """

    shift = db.execute(
        select(Shift).where(Shift.store_id == store_id, Shift.status == ShiftStatus.OPEN)
    ).scalar_one_or_none()
    if shift is None:
        return

    employee_id = getattr(employee, "id")
    employee_name = getattr(employee, "name")

    existing = db.execute(
        select(ShiftRoster).where(
            ShiftRoster.shift_id == shift.id,
            ShiftRoster.employee_id == employee_id,
            ShiftRoster.out_at.is_(None),
        )
    ).scalar_one_or_none()
    if existing is not None:
        return

    db.add(
        ShiftRoster(
            organization_id=shift.organization_id,
            store_id=shift.store_id,
            shift_id=shift.id,
            employee_id=employee_id,
            employee_name=employee_name,
            in_at=clock.now_utc(),
            pauses=[],
        )
    )
    db.flush()


# ---------------------------------------------------------------------------
# Inicio por rol: quién puede tocar la plata del cajón.
# ---------------------------------------------------------------------------

CASH_PERMISSION_CODE = "CASH_PERMISSION_REQUIRED"


def can_handle_cash(db: Session, *, actor: Any, shift: Shift | None) -> bool:
    """**El único lugar que decide quién puede hacer una operación de caja**
    (abrir el turno, entrada y salida de plata, cambio, retiros, relevo,
    consignar desde el POS, liquidar domicilios, cierre).

    Puede: el administrador (por tipo de actor o por rol), el supervisor, la
    persona con permiso de cobrar (`Employee.can_charge`) y el responsable de
    caja del turno abierto —que puede no tener `can_charge` si recibió el
    cajón en un relevo—. Nadie más: antes bastaba con estar identificado, y
    un cocinero podía sellar el cierre a ciegas o hacerse un relevo a sí mismo.

    `actor` es un `app.auth.deps.Actor` (tipado como `Any` para que este
    módulo no dependa de las dependencias HTTP).
    """

    if getattr(actor, "kind", None) == "admin" or getattr(actor, "role", None) in ("admin", "supervisor"):
        return True
    employee_id = getattr(actor, "employee_id", None)
    if employee_id is None:
        return False
    if shift is not None and shift.cash_responsible_id == employee_id:
        return True
    from app.auth.models import Employee

    employee = db.get(Employee, employee_id)
    return bool(employee is not None and employee.active and employee.can_charge)


def require_cash_permission(db: Session, *, actor: Any, shift: Shift | None) -> None:
    """`403 CASH_PERMISSION_REQUIRED` si `actor` no puede tocar la caja
    (`can_handle_cash`). Se llama ANTES de escribir nada y antes de reservar
    la llave de idempotencia: el rechazo no queda grabado como respuesta."""

    if can_handle_cash(db, actor=actor, shift=shift):
        return
    responsible = f" ({shift.cash_responsible_name})" if shift is not None else ""
    raise AppError(
        CASH_PERMISSION_CODE,
        "Esta acción es de caja: la hace quien tiene la caja del turno"
        f"{responsible}, alguien con permiso de cobrar o un supervisor. "
        "Pedile a esa persona que se identifique en la tablet",
        status=403,
    )


def require_cash_permission_for_store(db: Session, *, actor: Any, store_id: int) -> None:
    """Igual que `require_cash_permission`, contra el turno abierto de la
    sede (o sin turno, donde sólo cuentan `can_charge` y el rol). Para los
    dominios que mueven el cajón sin recibir el turno (consignar desde el
    POS, liquidar domicilios)."""

    shift = db.execute(
        select(Shift).where(Shift.store_id == store_id, Shift.status == ShiftStatus.OPEN)
    ).scalar_one_or_none()
    require_cash_permission(db, actor=actor, shift=shift)


# ---------------------------------------------------------------------------
# Pedido 2b: el egreso del cajón por un pago a proveedor.
# ---------------------------------------------------------------------------


def register_supplier_payment_expense(
    db: Session,
    *,
    organization_id: int,
    store_id: int,
    amount: int,
    actor: Any,
    note: str | None = None,
    reference: str | None = None,
) -> CashMovement:
    """Egreso de caja de un pago en efectivo de una cuenta por pagar
    (`app.purchases.service.create_payment`). Busca el turno `OPEN` de la
    sede; sin uno, `AppError("NO_OPEN_SHIFT", status=409)` — el mensaje
    nombra la acción correctiva (`AGENTS.md §11.18`). `amount` siempre
    positivo (mismo contrato que el resto de `CashMovement`); el signo lo da
    `kind=EXPENSE` al sumar en `service.compute_breakdown`, sin cambios ahí.
    """
    shift = db.execute(
        select(Shift).where(Shift.store_id == store_id, Shift.status == ShiftStatus.OPEN)
    ).scalar_one_or_none()
    if shift is None:
        raise AppError(
            code="NO_OPEN_SHIFT",
            message="No hay un turno abierto en esta sede; abrí un turno para pagar en efectivo desde el cajón, o registrá el pago por otro medio",
            status=409,
        )

    full_note = note or "Pago a proveedor"
    if reference:
        full_note = f"{full_note} (ref: {reference})"

    movement = CashMovement(
        organization_id=organization_id,
        store_id=store_id,
        shift_id=shift.id,
        kind=CashMovementKind.EXPENSE,
        cause=CashMovementCause.SUPPLIER_PAYMENT,
        amount=amount,
        note=full_note,
        employee_id=actor.employee_id,
        employee_name=actor.employee_name,
        authorized_by_employee_id=actor.employee_id,
        authorized_by_employee_name=actor.employee_name,
        at=clock.now_utc(),
    )
    db.add(movement)
    db.flush()
    return movement


def register_supplier_payment_reversal(
    db: Session,
    *,
    organization_id: int,
    store_id: int,
    amount: int,
    actor: Any,
    note: str | None = None,
    reference: str | None = None,
) -> CashMovement:
    """Reintegro de caja cuando se anula un pago a proveedor que había
    salido del cajón (`app.purchases.service.void_payment`, ronda 2 del
    pedido 2b — H-1 BLOQUEANTE). Hermano exacto de
    `register_supplier_payment_expense` en la otra dirección: busca el
    turno `OPEN` de la sede; sin uno, `AppError("NO_OPEN_SHIFT", status=409)`
    — el mensaje nombra la acción correctiva — y **no se escribe nada**
    (ni este movimiento ni, aguas arriba, el `voided_at` del pago que lo
    disparó). Con turno abierto, crea un `CashMovement(kind=INCOME,
    cause=SUPPLIER_PAYMENT)` — causa tipada existente, nunca `OTHER_INCOME`
    reciclada — con `amount` siempre positivo (mismo contrato que el resto
    de `CashMovement`; el signo lo da `kind=INCOME` al sumar en
    `service.compute_breakdown`, sin cambios ahí). El `CashMovement` del
    egreso original NO se toca ni se borra: éste es un movimiento nuevo,
    en el turno abierto AL MOMENTO DE ANULAR (nunca el turno original si ya
    cerró: un turno `CLOSED` es inviolable porque su conteo a ciegas ya
    ocurrió; la plata vuelve al cajón HOY, que es lo que pasa físicamente).
    """
    shift = db.execute(
        select(Shift).where(Shift.store_id == store_id, Shift.status == ShiftStatus.OPEN)
    ).scalar_one_or_none()
    if shift is None:
        raise AppError(
            code="NO_OPEN_SHIFT",
            message=(
                "No hay un turno abierto en esta sede; abrí un turno para registrar el reintegro del pago "
                "anulado, y recién ahí anulá el pago"
            ),
            status=409,
        )

    full_note = note or "Reintegro por anulación de pago a proveedor"
    if reference:
        full_note = f"{full_note} (ref: {reference})"

    movement = CashMovement(
        organization_id=organization_id,
        store_id=store_id,
        shift_id=shift.id,
        kind=CashMovementKind.INCOME,
        cause=CashMovementCause.SUPPLIER_PAYMENT,
        amount=amount,
        note=full_note,
        employee_id=actor.employee_id,
        employee_name=actor.employee_name,
        authorized_by_employee_id=actor.employee_id,
        authorized_by_employee_name=actor.employee_name,
        at=clock.now_utc(),
    )
    db.add(movement)
    db.flush()
    return movement


# ---------------------------------------------------------------------------
# Pedido 2c: el efectivo de domicilios que entra al cajón al liquidar.
# ---------------------------------------------------------------------------
#
# CONTRATO — el IDA Y VUELTA de la liquidación de domicilios.
#
#   Publica:  `app.shifts.hooks` (agente `backend-dinero-canales`).
#   Llama:    `app.channels.service.settle_delivery_cash`   -> `_income`
#             `app.channels.service.void_delivery_settlement` -> `_reversal`
#   Dónde:    SIEMPRE el turno `OPEN` de la sede EN ESE MOMENTO, nunca el
#             turno en que se vendió (puede estar cerrado, y un turno
#             `CLOSED` es inviolable: su conteo a ciegas ya ocurrió). La
#             plata entra —o sale— del cajón HOY, que es lo que pasa
#             físicamente.
#   Sin turno abierto: `AppError("NO_OPEN_SHIFT", status=409)` levantado
#             ANTES de escribir nada. Quien llama valida-antes-de-escribir
#             con esto, así que la operación entera se rechaza y **no queda
#             nada a medias**: ni el movimiento, ni la liquidación, ni el
#             `delivery_settlement_id` de los pagos.
#   Qué pasa cuando se deshace: NADA se borra ni se reescribe. El
#             `CashMovement` original queda vivo tal cual; el reintegro es
#             un movimiento NUEVO y compensatorio (`kind` opuesto, MISMA
#             causa tipada `DELIVERY_SETTLEMENT`), y la fila de
#             `delivery_settlements` pasa a `VOIDED` con motivo, quién y
#             cuándo. Los pagos vuelven a `delivery_settlement_id = NULL`:
#             eso no borra plata, la devuelve al estado "pendiente de
#             liquidar", que es lo que físicamente vuelve a ser cierta.
#
# Es literalmente el cierre de H-1 de 2b (`register_supplier_payment_expense`
# / `register_supplier_payment_reversal`), en el sentido opuesto: allá el
# egreso salía del cajón y anularlo lo devolvía; acá el ingreso entra al
# cajón y deshacerlo lo saca.


def _delivery_cash_movement(
    db: Session,
    *,
    organization_id: int,
    store_id: int,
    amount: int,
    kind: CashMovementKind,
    actor: Any,
    note: str,
    no_shift_message: str,
) -> tuple[CashMovement, Shift]:
    shift = db.execute(
        select(Shift).where(Shift.store_id == store_id, Shift.status == ShiftStatus.OPEN)
    ).scalar_one_or_none()
    if shift is None:
        raise AppError(code="NO_OPEN_SHIFT", message=no_shift_message, status=409)

    movement = CashMovement(
        organization_id=organization_id,
        store_id=store_id,
        shift_id=shift.id,
        kind=kind,
        cause=CashMovementCause.DELIVERY_SETTLEMENT,
        amount=amount,
        note=note,
        employee_id=actor.employee_id,
        employee_name=actor.employee_name,
        authorized_by_employee_id=actor.employee_id,
        authorized_by_employee_name=actor.employee_name,
        at=clock.now_utc(),
    )
    db.add(movement)
    db.flush()
    return movement, shift


def register_delivery_settlement_income(
    db: Session,
    *,
    organization_id: int,
    store_id: int,
    amount: int,
    actor: Any,
    courier_name: str,
    note: str | None = None,
) -> tuple[CashMovement, Shift]:
    """IDA. El domiciliario entrega el efectivo: entra al turno ABIERTO como
    `CashMovement(kind=INCOME, cause=DELIVERY_SETTLEMENT)`.

    **`amount` es la VENTA sola, sin la propina** (ronda 2, cierre de H-1).
    El efectivo de domicilios entra al cajón por `incomes` **sólo por el
    monto de la venta**; la propina en efectivo del domicilio se trata igual
    que la propina en efectivo de cualquier otra venta: **no mueve el
    esperado**, porque la fórmula heredada de 1b
    (`expected = base + sales.cash + incomes − expenses − pickups`,
    `app/shifts/service.py:259`) sólo lee `.cash`, y la propina se salda al
    cierre por `tips_cash_out`/`to_deposit` (`app/shifts/service.py:1035`).
    Quien llama (`app.channels.service.settle_delivery_cash`) sigue
    registrando venta y propina por separado en la liquidación y en su
    respuesta: el domiciliario entrega las dos cosas. Lo único que esta
    función mueve es el ESPERADO, y lo mueve por la venta.

    `amount` siempre positivo (mismo contrato que el resto de
    `CashMovement`); el signo lo da `kind` al sumar en
    `service.compute_breakdown`, que **no cambia**: la liquidación entra por
    `incomes`, que ya existía. No hay una segunda fórmula del esperado, y no
    hay dos matemáticas del esperado según el canal.

    Devuelve `(movimiento, turno)` para que quien llama guarde los dos ids
    en la liquidación sin volver a buscar el turno (y sin poder buscar OTRO).
    """
    full_note = note or f"Liquidación de domicilios de {courier_name}"
    return _delivery_cash_movement(
        db,
        organization_id=organization_id,
        store_id=store_id,
        amount=amount,
        kind=CashMovementKind.INCOME,
        actor=actor,
        note=full_note,
        no_shift_message=(
            "No hay un turno abierto en esta sede; abrí un turno para recibir el efectivo de domicilios "
            "y volvé a liquidar"
        ),
    )


def register_delivery_settlement_reversal(
    db: Session,
    *,
    organization_id: int,
    store_id: int,
    amount: int,
    actor: Any,
    courier_name: str,
    note: str | None = None,
) -> tuple[CashMovement, Shift]:
    """VUELTA. Se deshace una liquidación: el espejo exacto, `kind=EXPENSE`
    con la MISMA causa tipada, en el turno abierto AL MOMENTO DE DESHACER.

    **Espejo quiere decir el MISMO monto que la ida**: `DeliverySettlement.
    amount`, la venta sola, sin la propina. Si la ida movió el esperado por
    la venta, la vuelta lo devuelve por la venta.

    Sin turno abierto, `409 NO_OPEN_SHIFT` **antes** de tocar la liquidación
    o los pagos: la anulación entera se rechaza y no queda nada a medias.
    El movimiento del ingreso original NO se toca ni se borra — nada
    financiero se borra.
    """
    full_note = note or f"Anulación de la liquidación de domicilios de {courier_name}"
    return _delivery_cash_movement(
        db,
        organization_id=organization_id,
        store_id=store_id,
        amount=amount,
        kind=CashMovementKind.EXPENSE,
        actor=actor,
        note=full_note,
        no_shift_message=(
            "No hay un turno abierto en esta sede; abrí un turno para registrar la salida del efectivo "
            "de la liquidación, y recién ahí anulala"
        ),
    )


def open_shift_ids_query(store_id: int) -> Select[tuple[int]]:
    """Los turnos abiertos de la sede, como subconsulta para un `IN`. La usa
    la cocina (`app.kitchen.service.live_rounds`): mientras el turno que
    cobró siga abierto, lo que todavía no se cocinó sigue siendo trabajo,
    aunque ya haya pasado la hora de corte."""
    from app.shifts.models import Shift, ShiftStatus

    return select(Shift.id).where(Shift.store_id == store_id, Shift.status == ShiftStatus.OPEN)


def difference_streak(db: Session, *, store_id: int, employee_id: int) -> int:
    """La racha actual de diferencias de caja de una persona (cierres
    contados seguidos por fuera de la tolerancia de la sede; un cierre sin
    conteo ni suma ni corta). Es LA regla del aviso «Racha de diferencias de
    caja»: quien muestre una racha la pide acá en vez de recontarla.

    Import perezoso de `service`: este módulo no puede importarlo arriba
    (ver docstring)."""
    from app.shifts import service

    return service.current_difference_streak(db, store_id=store_id, employee_id=employee_id)


def carried_into(db: Session, shift_id: int) -> dict[int, int]:
    """`{turno de origen: saldo que tenía al abrir}` de la plata de días
    anteriores que el turno `shift_id` encontró en el cajón
    (`ShiftCarryIn`). Lo lee `app.banking.service` para consignar desde el POS."""
    rows = db.execute(
        select(ShiftCarryIn.source_shift_id, ShiftCarryIn.amount).where(ShiftCarryIn.shift_id == shift_id)
    ).all()
    return {source: amount for source, amount in rows}


def cash_swap_store_id(db: Session, cash_swap_id: int) -> int | None:
    """La sede de un Cambio (`CashSwap`), o `None` si no existe. Lo lee
    `app.requests` para atar una sencilla recibida al Cambio que la registró."""
    from app.shifts.models import CashSwap

    return db.execute(select(CashSwap.store_id).where(CashSwap.id == cash_swap_id)).scalar_one_or_none()


def reserve_loans_tray(db: Session, store: Any) -> dict[str, Any]:
    """**Base de respaldo** (2026-09-26): los préstamos al cajón sin devolver,
    para la bandeja de Hoy (`app.reports`). Un préstamo vuelve el mismo día,
    antes del conteo de cierre; si un turno se cerró por rescate con plata de
    la base adentro, sigue acá hasta que alguien la devuelva. Con
    `cash.reserve` apagada el total es `None` («no hay base», no «nada que
    devolver»)."""
    from app.core import features
    from app.shifts import reserve

    if not features.is_enabled(db, store.organization_id, store.id, reserve.FEATURE):
        return {"reserve_loans_open_count": 0, "reserve_loans_open_total": None}
    loans = reserve.open_loans(db, store_id=store.id)
    return {
        "reserve_loans_open_count": len(loans),
        "reserve_loans_open_total": sum(loan.amount for loan in loans),
    }
