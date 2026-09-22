"""Reportes del administrador (`docs/SPEC-NEGOCIO.md §9.3`, §10; contrato de
API en `features/fase-1b-venta/spec.md` «Admin reports»).

**Regla dura de este dominio**: los reportes leen los SNAPSHOTS del ítem y
del documento (`app.orders.models.OrderItem`, `app.fiscal.models.
FiscalDocument`), nunca la carta actual. Una venta pasada no se revalora. La
propina nunca entra en `net`/`gross`/`tax` de ningún reporte, sólo en `tips`.

**Una sola matemática**: la de la venta vive en `app.orders.money`
(`round_half_up`, `prorate`) y en `app.orders.service.compute_order_totals`.
Este módulo no la reimplementa — para promedios (`avg_ticket`,
`avg_per_cover`) y para repartir un documento entre sus medios de pago
(prorateo del impuesto por `split`) llama a esas mismas funciones.

Dominios de los que este módulo sólo LEE (no escribe, no migra):
`app.orders`, `app.fiscal`, `app.payments` (indirecto, vía
`FiscalDocument.payments_snapshot`), `app.shifts`, `app.catalog`,
`app.notifications`. `app.customers`/`app.refunds` se construyeron en
paralelo durante este mismo pedido: se leen con `find_spec_safe` y degradan
limpio si el módulo todavía no existiera.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.orm import Session

import importlib
from types import ModuleType

from app.audit.models import AuditLog
from app.catalog.models import Product
from app.core import clock, features, tz
from app.core.errors import AppError
from app.core.modules import find_spec_safe
from app.core.quantity import format_qty_base, micros_to_pesos
from app.fiscal import service as fiscal_service
from app.fiscal.models import FiscalDocument, FiscalDocumentType
from app.notifications.models import Notification
from app.notifications.service import notify
from app.orders import money
from app.orders import service as orders_service
from app.orders.models import (
    Order,
    OrderItem,
    OrderItemStatus,
    OrderStatus,
    OrderTable,
)
from app.reports.schemas import (
    AccountantRateBreakdownOut,
    AccountantReportOut,
    AccountantRowOut,
    AlertOut,
    EmployeeRefOut,
    HourBucketOut,
    IngredientAlertOut,
    LotAlertOut,
    MethodAmountOut,
    NegativeStockAlertOut,
    OpenOrderAgeOut,
    PayableAlertOut,
    PrepAlertOut,
    SalesBucketOut,
    SalesReportOut,
    TodayOut,
    UncostedProductOut,
    UnavailableLogRowOut,
    UnavailableProductOut,
)
from app.shifts import service as shifts_service
from app.shifts.models import Shift, ShiftStatus
from app.stores.models import Store, Table, Zone

# Documentos que representan una venta real (comprobante emitido al cobrar):
# el documento equivalente POS, la factura y el comprobante interno (sede sin
# `fiscal.dee_pos`). Las notas (`adjustment_note`/`credit_note`/`debit_note`)
# NO entran acá: SPEC-NEGOCIO §8.2/§10 y el informe del contador las reportan
# aparte ("documentos" y "notas" son dos columnas distintas, nunca se netean
# en silencio dentro de "ventas cobradas").
SALE_DOCUMENT_TYPES = (
    FiscalDocumentType.POS_EQUIVALENT,
    FiscalDocumentType.INVOICE,
    FiscalDocumentType.INTERNAL_RECEIPT,
)
NOTE_DOCUMENT_TYPES = (
    FiscalDocumentType.ADJUSTMENT_NOTE,
    FiscalDocumentType.CREDIT_NOTE,
    FiscalDocumentType.DEBIT_NOTE,
)

# Umbrales de "comanda abierta hace demasiado" (SPEC-NEGOCIO §9.3 "Hoy":
# "bandera > X min sin enviar / > Y min sin cobrar"). No existe todavía un
# campo de configuración por sede para esto (`app.stores.models
# .StoreSalesSettings` no lo declara y este territorio no toca `app.stores`):
# quedan como default de producto, declarados en `gaps` del entregable para
# que un pedido futuro los suba a Configuración, igual que
# `discount_daily_limit_pct`/`courtesy_shift_limit`.
UNSENT_MINUTES_THRESHOLD = 15
UNPAID_MINUTES_THRESHOLD = 20

# Ventana de cálculo de venta perdida estimada (`unavailable-log`): tampoco
# hay configuración de sede para esto.
LOST_SALES_LOOKBACK_DAYS = 7


def _bogota_hour(instant_utc: datetime) -> int:
    return tz.to_bogota(instant_utc).hour


def _validate_range(date_from: date, date_to: date) -> None:
    if date_from > date_to:
        raise AppError(
            "VALIDATION_ERROR",
            "from: tiene que ser anterior o igual a to",
            status=400,
        )


# ---------------------------------------------------------------------------
# Agregación de ventas cobradas, compartida por «Hoy» y «Ventas»
# (SPEC-NEGOCIO §10: "Ventas cobradas = Σ documentos no anulados ni
# reversados"; "Ventas netas = ventas cobradas − impuesto, sin propina").
# ---------------------------------------------------------------------------


@dataclass
class _Bucket:
    label: str
    gross: int = 0
    tax: int = 0
    tips: int = 0
    order_ids: set[int] = field(default_factory=set)
    # Pedido 2a: costo teórico (desde `OrderItem.unit_cost`/`unit_cost_micros`
    # CONGELADOS — nunca se revalora con la ficha actual), y las dos sumas de
    # `net` que arman `costed_pct`. `has_theoretical_cost` distingue
    # "no hubo ningún ítem con costo" (`None` en la salida, nunca `0` mudo)
    # de "hubo costo y dio cero" (que sólo pasaría con un `unit_cost=0` real).
    #
    # Ronda 2 (B-2, "el cero mudo congelado"): se acumula en MICROS
    # (`theoretical_cost_micros`, millonésimas de peso), no en pesos — sumar
    # `unit_cost` (pesos, ya redondeado half-up por ítem) pierde plata real
    # cuando muchos ítems tienen un costo menor a $1 (un plato de $0,30
    # congela `unit_cost=0`; 100 de esos daban $0 en vez de $30). Se
    # convierte a pesos con `micros_to_pesos` UNA sola vez, al cerrar el
    # total del bucket (`_to_out`) — `theoretical_cost` en la respuesta
    # sigue siendo `int` de pesos, sin cambiar su tipo publicado.
    theoretical_cost_micros: int = 0
    has_theoretical_cost: bool = False
    costed_net: int = 0


def _document_cost_stats(db: Session, documents: list[FiscalDocument]) -> dict[int, tuple[int | None, int, int]]:
    """`document.id -> (theoretical_cost_micros | None, costed_net, total_net)`,
    leído SIEMPRE de `OrderItem.unit_cost_micros` tal como quedó congelado al
    enviar (`app.orders.service._freeze_item_consumption`, pedido 2a) —
    nunca de la ficha actual: es la misma regla de snapshot que ya protege
    precio e impuesto en este módulo, extendida al costo.

    **Devuelve MICROS, no pesos** (ronda 2, B-2, "el cero mudo congelado"):
    `unit_cost` (pesos) ya viene redondeado half-up POR ÍTEM al enviar — un
    plato de $0,30 de costo real congela correctamente `unit_cost=0` (con
    `cost_source`, no es un cero mudo), pero convertir a pesos ACÁ, por
    documento, no alcanza cuando el período tiene muchos DOCUMENTOS baratos
    en vez de muchos ítems dentro de uno: 100 comandas separadas de un plato
    de $0,30 cada una redondearían a $0 por documento, y sumar cien ceros
    sigue dando $0. Por eso el caller (`aggregate_sales`) acumula estos
    micros en `_Bucket.theoretical_cost_micros` a través de TODOS los
    documentos del grupo y convierte a pesos con `micros_to_pesos` una sola
    vez, al cerrar el bucket (`_to_out`) — nunca acá.

    **Aproximación declarada** para un documento de sub-cuenta (cuenta
    dividida por ítems, `sub_account_id is not None`): `line["qty"]` ahí es
    la cantidad de PORCIONES del ítem que le tocaron a esa sub-cuenta, no la
    cantidad completa (`app.payments.service._sub_account_document_lines`,
    territorio ajeno) — `of_portions` no viaja en el snapshot del documento,
    así que no hay forma exacta de sacar la fracción del costo del ítem
    desde acá sin volver a calcular los totales completos del pedido. Se usa
    `unit_cost_micros * qty` igual que en un documento de comanda completa
    (exacto para el caso común, que es la comanda sin dividir); para una
    comanda dividida por ítems esto sobrestima el costo de cada sub-cuenta.
    Declarado en el entregable de este agente como gap: una corrección
    exacta necesita que `app.payments` guarde `of_portions` en la línea del
    documento."""
    item_ids = {int(line["item_id"]) for doc in documents for line in (doc.lines or [])}
    if not item_ids:
        return {}
    unit_cost_micros_by_item: dict[int, int | None] = {
        item_id: unit_cost_micros
        for item_id, unit_cost_micros in db.execute(
            select(OrderItem.id, OrderItem.unit_cost_micros).where(OrderItem.id.in_(item_ids))
        ).all()
    }

    result: dict[int, tuple[int | None, int, int]] = {}
    for doc in documents:
        total_cost_micros = 0
        any_costed = False
        costed_net = 0
        total_net = 0
        for line in doc.lines or []:
            item_id = int(line["item_id"])
            # `line["net"]` (`app.payments.service._order_document_lines`) es
            # el `LineTotals.net` de `app.orders.money` — con impuesto
            # INCLUIDO (nombre compartido con `money.py`, no con este
            # módulo). El `net` de ESTE reporte (`SalesBucketOut.net` =
            # `gross - tax`) es sin impuesto: usar `line["base"]` (la
            # contraparte sin impuesto de esa misma línea) es lo que hace que
            # `costed_net`/`total_net` queden en la MISMA unidad que `net` al
            # dividir más abajo — si no, la cobertura queda inflada por la
            # tasa de impuesto (108 % en vez de 100 %, el bug real que este
            # comentario documenta habiendo existido).
            base = int(line["base"])
            qty = int(line["qty"])
            total_net += base
            unit_cost_micros = unit_cost_micros_by_item.get(item_id)
            if unit_cost_micros is None:
                continue
            any_costed = True
            costed_net += base
            total_cost_micros += unit_cost_micros * qty
        result[doc.id] = (total_cost_micros if any_costed else None, costed_net, total_net)
    return result


def _order_covers_map(db: Session, order_ids: set[int]) -> dict[int, int | None]:
    if not order_ids:
        return {}
    rows = db.execute(select(Order.id, Order.covers).where(Order.id.in_(order_ids))).all()
    return {oid: covers for oid, covers in rows}


def _order_zone_map(db: Session, order_ids: set[int]) -> dict[int, tuple[str, str]]:
    """`order_id` -> `(key, label)` de la PRIMERA mesa (por número) que tuvo
    esa comanda. Una comanda con mesas unidas puede haber pasado por varias
    zonas: se atribuye a la primera para no partir una venta entre dos
    filas del reporte (declarado en `gaps`)."""
    if not order_ids:
        return {}
    rows = db.execute(
        select(OrderTable.order_id, Zone.id, Zone.name, Table.number)
        .join(Table, OrderTable.table_id == Table.id)
        .join(Zone, Table.zone_id == Zone.id)
        .where(OrderTable.order_id.in_(order_ids))
        .order_by(OrderTable.order_id, Table.number)
    ).all()
    result: dict[int, tuple[str, str]] = {}
    for order_id, zone_id, zone_name, _number in rows:
        if order_id not in result:
            result[order_id] = (str(zone_id), zone_name)
    return result


def _sale_documents(db: Session, *, store_id: int, date_from: date, date_to: date) -> list[FiscalDocument]:
    stmt = (
        select(FiscalDocument)
        .where(
            FiscalDocument.store_id == store_id,
            FiscalDocument.business_date >= date_from,
            FiscalDocument.business_date <= date_to,
            FiscalDocument.document_type.in_(SALE_DOCUMENT_TYPES),
            FiscalDocument.status == "issued",
        )
        .order_by(FiscalDocument.business_date, FiscalDocument.id)
    )
    return list(db.execute(stmt).scalars())


def _group_key(doc: FiscalDocument, group_by: str | None) -> tuple[str, str] | None:
    """`(key, label)` para agrupar UN documento entero (todo `group_by`
    salvo `"method"`, que reparte cada documento entre sus `splits`)."""
    if group_by is None or group_by == "business_date":
        return (doc.business_date.isoformat(), doc.business_date.isoformat())
    if group_by == "shift":
        return (str(doc.shift_id), f"Turno #{doc.shift_id}")
    if group_by == "channel":
        return (doc.channel, doc.channel)
    if group_by == "employee":
        return (str(doc.charged_by_employee_id), doc.charged_by_employee_name)
    if group_by == "hour":
        hour = _bogota_hour(doc.issued_at)
        return (str(hour), f"{hour:02d}:00")
    return None  # "zone" y "method" necesitan datos externos al documento


def aggregate_sales(
    db: Session, *, store_id: int, date_from: date, date_to: date, group_by: str | None
) -> tuple[list[SalesBucketOut], SalesBucketOut]:
    """Agrega documentos de venta (SPEC-NEGOCIO §10) por `group_by` (`None` =
    un solo total). Devuelve `(filas, total)`; el total es la misma
    agregación sin partir por grupo, así "Hoy" y "Ventas" nunca pueden
    mostrar un total distinto de la suma de sus filas."""
    documents = _sale_documents(db, store_id=store_id, date_from=date_from, date_to=date_to)
    # Pedido 2a: costo teórico por documento, en MICROS, leído del
    # `unit_cost_micros` congelado en cada ítem — nunca de la ficha actual
    # (ver docstring de `_document_cost_stats`). Se acumula en micros a
    # través de todos los documentos del bucket/total y se convierte a pesos
    # una sola vez en `_to_out` (ronda 2, B-2).
    cost_stats = _document_cost_stats(db, documents)

    buckets: dict[str, _Bucket] = {}
    total_bucket = _Bucket(label="total")
    order_ids_all: set[int] = {d.order_id for d in documents}

    zone_map: dict[int, tuple[str, str]] = {}
    if group_by == "zone":
        zone_map = _order_zone_map(db, order_ids_all)

    for doc in documents:
        total_bucket.gross += doc.total
        total_bucket.tax += doc.tax_total
        total_bucket.tips += doc.tip_amount
        total_bucket.order_ids.add(doc.order_id)
        doc_cost_micros, doc_costed_net, _doc_total_net = cost_stats.get(doc.id, (None, 0, 0))
        if doc_cost_micros is not None:
            total_bucket.theoretical_cost_micros += doc_cost_micros
            total_bucket.has_theoretical_cost = True
        total_bucket.costed_net += doc_costed_net

        if group_by == "method":
            # El costo teórico no se reparte por medio de pago: un insumo no
            # "pertenece" a un método de cobro, sólo a un plato — el total
            # sigue exacto (se acumuló arriba), las filas por método quedan
            # sin costo (`has_theoretical_cost=False` -> `null`, declarado).
            splits = doc.payments_snapshot or []
            amounts = [int(s.get("amount", 0)) for s in splits]
            tax_shares = money.prorate(doc.tax_total, amounts) if amounts else []
            for split, tax_share in zip(splits, tax_shares):
                key = str(split.get("method", "other"))
                bucket = buckets.setdefault(key, _Bucket(label=key))
                bucket.gross += int(split.get("amount", 0))
                bucket.tax += tax_share
                bucket.tips += int(split.get("tip_amount", 0))
                bucket.order_ids.add(doc.order_id)
            continue

        if group_by == "zone":
            key, label = zone_map.get(doc.order_id, ("none", "Sin zona"))
        else:
            resolved = _group_key(doc, group_by)
            if resolved is None:
                key, label = ("total", "total")
            else:
                key, label = resolved

        bucket = buckets.setdefault(key, _Bucket(label=label))
        bucket.gross += doc.total
        bucket.tax += doc.tax_total
        bucket.tips += doc.tip_amount
        bucket.order_ids.add(doc.order_id)
        if doc_cost_micros is not None:
            bucket.theoretical_cost_micros += doc_cost_micros
            bucket.has_theoretical_cost = True
        bucket.costed_net += doc_costed_net

    covers_map = _order_covers_map(db, order_ids_all)

    def _to_out(key: str, bucket: _Bucket) -> SalesBucketOut:
        net = bucket.gross - bucket.tax
        orders_count = len(bucket.order_ids)
        covers_sum = sum(c for oid in bucket.order_ids if (c := covers_map.get(oid)) is not None)
        avg_ticket = money.round_half_up(net, orders_count) if orders_count > 0 and net >= 0 else None
        avg_per_cover = money.round_half_up(net, covers_sum) if covers_sum > 0 and net >= 0 else None
        # Conversión a pesos ÚNICA, acá, después de sumar micros a través de
        # TODOS los documentos del bucket (ronda 2, B-2) — nunca antes.
        theoretical_cost = micros_to_pesos(bucket.theoretical_cost_micros) if bucket.has_theoretical_cost else None
        gross_margin = (net - theoretical_cost) if theoretical_cost is not None else None
        costed_pct = (
            money.round_half_up(bucket.costed_net * 100, net) if net > 0 and bucket.costed_net > 0 else (0 if net > 0 else None)
        )
        return SalesBucketOut(
            key=key,
            label=bucket.label,
            gross=bucket.gross,
            net=net,
            tax=bucket.tax,
            tips=bucket.tips,
            orders=orders_count,
            covers=covers_sum if orders_count > 0 else None,
            avg_ticket=avg_ticket,
            avg_per_cover=avg_per_cover,
            theoretical_cost=theoretical_cost,
            gross_margin=gross_margin,
            costed_pct=costed_pct,
        )

    order_key: list[str]
    if group_by in (None, "business_date"):
        order_key = sorted(buckets.keys())
    else:
        order_key = sorted(buckets.keys(), key=lambda k: buckets[k].label)

    rows = [_to_out(k, buckets[k]) for k in order_key]
    total_out = _to_out("total", total_bucket)
    return rows, total_out


def sales_report(db: Session, *, store_id: int, date_from: date, date_to: date, group_by: str) -> SalesReportOut:
    _validate_range(date_from, date_to)
    rows, total = aggregate_sales(db, store_id=store_id, date_from=date_from, date_to=date_to, group_by=group_by)
    return SalesReportOut(
        store_id=store_id, date_from=date_from, date_to=date_to, group_by=group_by, rows=rows, total=total  # type: ignore[arg-type]
    )


# ---------------------------------------------------------------------------
# GET /admin/today
# ---------------------------------------------------------------------------


def _sweep_stale_orders(db: Session, store: Store, now: datetime) -> tuple[int, int]:
    """Emite `order_unsent_too_long`/`order_unpaid_too_long` (declaradas en
    `app.notifications.service.NOTIFICATION_TYPES`, este territorio las
    llena) para las comandas abiertas de la sede que superan el umbral.
    Devuelve `(unsent_count, unpaid_count)` — el conteo VIVO, no el de
    notificaciones ya emitidas (que dedupean por día)."""
    open_orders = list(
        db.execute(
            select(Order).where(
                Order.store_id == store.id, Order.status.in_((OrderStatus.OPEN, OrderStatus.TO_PAY))
            )
        ).scalars()
    )
    unsent_count = 0
    unpaid_count = 0
    for order in open_orders:
        if order.kitchen_view_enabled:
            has_pending = db.execute(
                select(OrderItem.id)
                .where(OrderItem.order_id == order.id, OrderItem.status == OrderItemStatus.PENDING)
                .limit(1)
            ).first()
            if has_pending is not None:
                minutes = int((now - order.opened_at).total_seconds() // 60)
                if minutes > UNSENT_MINUTES_THRESHOLD:
                    unsent_count += 1
                    notify(
                        db,
                        organization_id=order.organization_id,
                        store_id=order.store_id,
                        type="order_unsent_too_long",
                        level="warning",
                        title="Comanda sin enviar a cocina",
                        body=f"La comanda #{order.id} lleva {minutes} min abierta sin enviarse a cocina.",
                        payload={"order_id": order.id, "minutes": minutes},
                        dedupe_key=f"order_unsent_too_long:{order.id}",
                    )

        if order.bill_presented_at is not None and order.status == OrderStatus.TO_PAY:
            minutes_bill = int((now - order.bill_presented_at).total_seconds() // 60)
            if minutes_bill > UNPAID_MINUTES_THRESHOLD:
                unpaid_count += 1
                notify(
                    db,
                    organization_id=order.organization_id,
                    store_id=order.store_id,
                    type="order_unpaid_too_long",
                    level="warning",
                    title="Cuenta presentada sin cobrar",
                    body=f"La comanda #{order.id} presentó la cuenta hace {minutes_bill} min y sigue sin cobrarse.",
                    payload={"order_id": order.id, "minutes": minutes_bill},
                    dedupe_key=f"order_unpaid_too_long:{order.id}",
                )
    return unsent_count, unpaid_count


def _open_orders_out(db: Session, store: Store, now: datetime) -> list[OpenOrderAgeOut]:
    orders = list(
        db.execute(
            select(Order)
            .where(Order.store_id == store.id, Order.status.in_((OrderStatus.OPEN, OrderStatus.TO_PAY)))
            .order_by(Order.opened_at)
        ).scalars()
    )
    out: list[OpenOrderAgeOut] = []
    for order in orders:
        tables = [t.number for t in db.execute(
            select(Table).join(OrderTable, OrderTable.table_id == Table.id).where(
                OrderTable.order_id == order.id, OrderTable.released_at.is_(None)
            )
        ).scalars()]
        minutes_since_opened = int((now - order.opened_at).total_seconds() // 60)
        minutes_since_bill = (
            int((now - order.bill_presented_at).total_seconds() // 60) if order.bill_presented_at is not None else None
        )
        has_pending = False
        if order.kitchen_view_enabled:
            has_pending = (
                db.execute(
                    select(OrderItem.id)
                    .where(OrderItem.order_id == order.id, OrderItem.status == OrderItemStatus.PENDING)
                    .limit(1)
                ).first()
                is not None
            )
        unsent_flag = has_pending and minutes_since_opened > UNSENT_MINUTES_THRESHOLD
        unpaid_flag = (
            order.bill_presented_at is not None
            and order.status == OrderStatus.TO_PAY
            and minutes_since_bill is not None
            and minutes_since_bill > UNPAID_MINUTES_THRESHOLD
        )
        total = orders_service.compute_order_totals(db, order).total
        out.append(
            OpenOrderAgeOut(
                id=order.id,
                channel=order.channel.value,  # type: ignore[arg-type]
                tables=tables,
                opened_at=order.opened_at,
                minutes_since_opened=minutes_since_opened,
                bill_presented_at=order.bill_presented_at,
                minutes_since_bill_presented=minutes_since_bill,
                unsent_flag=unsent_flag,
                unpaid_flag=unpaid_flag,
                total=total,
            )
        )
    return out


def _tips_by_method(documents: list[FiscalDocument]) -> list[MethodAmountOut]:
    totals: dict[str, int] = defaultdict(int)
    for doc in documents:
        for split in doc.payments_snapshot or []:
            method = str(split.get("method", "other"))
            totals[method] += int(split.get("tip_amount", 0))
    return [MethodAmountOut(method=m, amount=a) for m, a in sorted(totals.items())]


def _unavailable_products(db: Session, store: Store) -> list[UnavailableProductOut]:
    rows = list(
        db.execute(
            select(Product).where(Product.store_id == store.id, Product.available.is_(False)).order_by(Product.unavailable_at.desc())
        ).scalars()
    )
    out: list[UnavailableProductOut] = []
    for p in rows:
        if p.unavailable_at is None:
            continue
        by = (
            EmployeeRefOut(id=p.unavailable_by_employee_id, name=p.unavailable_by_employee_name or "")
            if p.unavailable_by_employee_id
            else None
        )
        out.append(UnavailableProductOut(product_id=p.id, name=p.name, unavailable_at=p.unavailable_at, by=by))
    return out


def _pending_refunds_count(db: Session, store: Store) -> int:
    """`app.refunds` se construyó en paralelo durante este mismo pedido
    (1b-2): se lee con `find_spec_safe` y degrada a `0` si el módulo
    todavía no existiera (mismo patrón que `app.orders.service
    ._order_document_id` con `app.fiscal` en 1b-1)."""
    if find_spec_safe("app.refunds.models") is None:
        return 0
    import importlib

    module = importlib.import_module("app.refunds.models")
    pending_refund_cls = getattr(module, "PendingRefund", None)
    pending_status = getattr(module, "PendingRefundStatus", None)
    if pending_refund_cls is None or pending_status is None:
        return 0
    return int(
        db.execute(
            select(func.count()).select_from(pending_refund_cls).where(
                pending_refund_cls.store_id == store.id,
                pending_refund_cls.status == pending_status.PENDING,
            )
        ).scalar_one()
    )


def _unreviewed_closes_count(db: Session, store: Store) -> int:
    """No acota por ventana (`UNREVIEWED_CLOSE_LOOKBACK_DAYS` queda
    declarado para cuando este conteo tenga paginación o un listado propio;
    hoy "Requiere tu atención" quiere el total, no sólo los últimos N
    días)."""
    return int(
        db.execute(
            select(func.count()).select_from(Shift).where(
                Shift.store_id == store.id,
                Shift.status == ShiftStatus.CLOSED,
                Shift.reviewed_by_employee_id.is_(None),
            )
        ).scalar_one()
    )


def _recent_alerts(db: Session, store: Store, *, limit: int = 30) -> list[AlertOut]:
    rows = list(
        db.execute(
            select(Notification)
            .where(Notification.store_id == store.id, Notification.read_at.is_(None))
            .order_by(Notification.created_at.desc())
            .limit(limit)
        ).scalars()
    )
    return [
        AlertOut(type=n.type, level=n.level, title=n.title, body=n.body, created_at=n.created_at, payload=n.payload)
        for n in rows
    ]


# ---------------------------------------------------------------------------
# Pedido 2a: las cuatro alertas de esta fase para `GET /admin/today`. Cada
# una llama al hook del dominio DUEÑO del hecho que alertan, protegida con
# `find_spec_safe` (nunca `importlib.util.find_spec` crudo): con los tres
# dominios de 2a apagados o sin montar, las cuatro devuelven `[]` y `Hoy`
# funciona exactamente como en 1b. **Negativo y agotado son alertas
# DISTINTAS** (SPEC-NEGOCIO §5.2): `ingredients_below_min`/
# `ingredients_negative` nunca se confunden porque son dos listas separadas,
# cada una con su propio mensaje en el frontend.
# ---------------------------------------------------------------------------


def _hooks_if_enabled(db: Session, store: Store, *, module: str, feature: str) -> ModuleType | None:
    """El módulo tiene que existir **y** la función tiene que estar encendida.

    `find_spec_safe` sólo contesta «¿está montado este dominio?», que es una
    propiedad del despliegue, no de la sede. Preguntando sólo eso, un
    restaurante con `inventory.perpetual` apagada veía igual las alarmas de
    insumos bajo mínimo y de stock negativo en «Hoy»: seis alertas que no
    puede resolver, sobre un inventario que decidió no llevar. Toda función
    opcional se respeta también al LEER, no sólo al escribir (`AGENTS.md`).
    """
    if find_spec_safe(module) is None:
        return None
    if not features.is_enabled(db, store.organization_id, store.id, feature):
        return None
    return importlib.import_module(module)


def _low_stock_alerts(db: Session, store: Store) -> list[IngredientAlertOut]:
    hooks = _hooks_if_enabled(db, store, module="app.inventory.hooks", feature="inventory.perpetual")
    if hooks is None:
        return []
    # `hooks.low_stock_alerts` devuelve `qty_base`/`min_stock` en milésimas
    # crudas (contrato de `app.inventory.hooks`, territorio ajeno): la
    # ÚNICA forma correcta de publicarlas es texto decimal
    # (`format_qty_base`, pedido 2b — ver el comentario en
    # `IngredientAlertOut`). Formateado acá, en el borde de publicación,
    # nunca dentro del hook ni en el esquema.
    return [
        IngredientAlertOut(**{**row, "qty_base": format_qty_base(row["qty_base"]), "min_stock": format_qty_base(row["min_stock"])})
        for row in hooks.low_stock_alerts(db, store_id=store.id)
    ]


def _negative_stock_alerts(db: Session, store: Store) -> list[NegativeStockAlertOut]:
    hooks = _hooks_if_enabled(db, store, module="app.inventory.hooks", feature="inventory.perpetual")
    if hooks is None:
        return []
    return [
        NegativeStockAlertOut(
            **{**row, "qty_base": format_qty_base(row["qty_base"]), "min_stock": format_qty_base(row["min_stock"])}
        )
        for row in hooks.negative_stock_alerts(db, store_id=store.id)
    ]


def _prep_alerts(db: Session, store: Store) -> list[PrepAlertOut]:
    hooks = _hooks_if_enabled(db, store, module="app.recipes.hooks", feature="catalog.preps")
    if hooks is None:
        return []
    return [PrepAlertOut(**row) for row in hooks.prep_stock_alerts(db, store_id=store.id)]


def _uncosted_products(db: Session, store: Store, *, business_date: date) -> list[UncostedProductOut]:
    hooks = _hooks_if_enabled(db, store, module="app.recipes.hooks", feature="catalog.recipes")
    if hooks is None:
        return []
    rows = hooks.uncosted_products(db, store_id=store.id, date_from=business_date, date_to=business_date)
    return [UncostedProductOut(**row) for row in rows]


# ---------------------------------------------------------------------------
# Pedido 2b: los tres grupos nuevos de alertas de «Hoy» (spec.md «Reads that
# 2a asked for», párrafo de `GET /admin/today`). Mismo patrón de arriba:
# `_hooks_if_enabled` exige módulo montado Y función encendida PARA LA SEDE.
# ---------------------------------------------------------------------------


def _lot_alerts(db: Session, store: Store, *, business_date: date) -> list[LotAlertOut]:
    hooks = _hooks_if_enabled(db, store, module="app.inventory.hooks", feature="inventory.lots")
    if hooks is None:
        return []
    rows = hooks.expiring_or_expired_lots(db, store_id=store.id, today=business_date)
    return [
        LotAlertOut(**{**row, "qty_base": format_qty_base(row["qty_base"])})
        for row in rows
    ]


def _payables_overdue(db: Session, store: Store) -> list[PayableAlertOut]:
    hooks = _hooks_if_enabled(db, store, module="app.purchases.hooks", feature="purchases")
    if hooks is None:
        return []
    return [PayableAlertOut(**row) for row in hooks.overdue_payables(db, store_id=store.id)]


def _payables_pending_review_count(db: Session, store: Store) -> int:
    hooks = _hooks_if_enabled(db, store, module="app.purchases.hooks", feature="purchases")
    if hooks is None:
        return 0
    return int(hooks.pending_review_payables_count(db, store_id=store.id))


def _inventory_reliability(db: Session, store: Store) -> tuple[bool | None, int | None]:
    """`(inventory_unreliable, days_since_last_full_count)`. `(None, None)`
    con `inventory.variance` apagada o `app.inventory` sin montar — "hay o
    no hay control confiable" no es una pregunta que tenga sentido
    responder sin la función encendida (mismo criterio que
    `app.inventory.router.get_control_health`, que exige la misma flag).

    RONDA 2 (hallazgo H-4): esta función YA NO CALCULA nada. En ronda 1
    restaba instantes UTC a mano (`(now - last_applied).days`) — una
    segunda matemática, distinta de la que usaba
    `app.inventory.service.control_health` (fecha de negocio), que podían
    discreparse justo en el borde en que un `cutoff_hour` de madrugada hace
    que un instante UTC ya caiga en el día operativo siguiente. Se borró
    junto con `_CONTROL_HEALTH_STALE_DAYS` (la constante local, otra
    duplicación del mismo `14`). Ahora esta función es un `getattr` +
    lectura, nada más: lee `app.inventory.hooks.inventory_staleness` — la
    ÚNICA fuente de este cálculo, por FECHA DE NEGOCIO
    (`app.core.tz.business_date_for` con el `cutoff_hour` real de la sede,
    nunca restando instantes UTC) — y devuelve exactamente lo que trae, sin
    recalcular ni redondear nada.

    Si el módulo está montado pero `inventory_staleness` todavía no existe
    (construcción en paralelo con `backend-inventario-espejo`, dueño de
    `app/inventory/hooks.py`): `(None, None)` con `getattr` — nunca un
    cálculo propio de reemplazo, que es exactamente el defecto que este
    hallazgo cierra."""
    hooks = _hooks_if_enabled(db, store, module="app.inventory.hooks", feature="inventory.variance")
    if hooks is None:
        return None, None
    staleness_fn = getattr(hooks, "inventory_staleness", None)
    if staleness_fn is None:
        return None, None
    staleness = staleness_fn(db, store_id=store.id, cutoff_hour=store.cutoff_hour)
    return staleness.unreliable, staleness.days_since_last_full_count


def _con_referencia(
    by_hour: dict[int, HourBucketOut], semana_pasada: dict[int, int], hubo: bool
) -> list[HourBucketOut]:
    """Las horas de hoy, más las que SÓLO existieron la semana pasada.

    Si el lunes pasado se vendió a las 11 y hoy esa hora todavía está en
    cero, la hora tiene que aparecer igual: sin ella la gráfica arranca a
    las 12 y la caída de las 11 no se ve — que es justamente la pregunta
    que la comparación viene a contestar.
    """
    if not hubo:
        return list(by_hour.values())
    faltantes = [
        HourBucketOut(hour=h, gross=0, net=0, net_last_week=neto)
        for h, neto in semana_pasada.items()
        if h not in by_hour
    ]
    return list(by_hour.values()) + faltantes


def today_report(db: Session, *, store: Store) -> TodayOut:
    now = clock.now_utc()
    business_date = tz.today_business_date(store.cutoff_hour)

    documents = _sale_documents(db, store_id=store.id, date_from=business_date, date_to=business_date)

    # La misma fecha operativa de la semana pasada: el mismo día de la semana,
    # no «ayer». Un restaurante no tiene la misma curva un martes que un
    # sábado, y comparar contra ayer haría ver todos los lunes como una caída.
    hace_una_semana = business_date - timedelta(days=7)
    documentos_semana_pasada = _sale_documents(
        db, store_id=store.id, date_from=hace_una_semana, date_to=hace_una_semana
    )
    neto_semana_pasada: dict[int, int] = {}
    for doc in documentos_semana_pasada:
        h = _bogota_hour(doc.issued_at)
        neto_semana_pasada[h] = neto_semana_pasada.get(h, 0) + (doc.total - doc.tax_total)
    # Si esa semana no existe en los datos, NO se rellena con ceros: la
    # referencia queda `None` y la pantalla no dibuja una línea en el piso
    # que se leería como «esa hora vendió cero».
    hubo_semana_pasada = len(documentos_semana_pasada) > 0

    by_hour: dict[int, HourBucketOut] = {}
    gross = tax = tips_total = 0
    order_ids: set[int] = set()
    for doc in documents:
        gross += doc.total
        tax += doc.tax_total
        tips_total += doc.tip_amount
        order_ids.add(doc.order_id)
        hour = _bogota_hour(doc.issued_at)
        bucket = by_hour.setdefault(hour, HourBucketOut(hour=hour, gross=0, net=0))
        by_hour[hour] = HourBucketOut(
            hour=hour,
            gross=bucket.gross + doc.total,
            net=bucket.net + (doc.total - doc.tax_total),
            net_last_week=neto_semana_pasada.get(hour, 0) if hubo_semana_pasada else None,
        )

    net = gross - tax
    covers_map = _order_covers_map(db, order_ids)
    covers_sum = sum(c for oid in order_ids if (c := covers_map.get(oid)) is not None)
    orders_count = len(order_ids)
    avg_ticket = money.round_half_up(net, orders_count) if orders_count > 0 else None
    avg_per_cover = money.round_half_up(net, covers_sum) if covers_sum > 0 else None

    tables_status = orders_service.tables_status(db, store_id=store.id)
    tables_total = sum(len(z.tables) for z in tables_status.zones)
    tables_occupied = sum(1 for z in tables_status.zones for t in z.tables if t.status != "free")

    unsent_count, unpaid_count = _sweep_stale_orders(db, store, now)
    # B-3: la contingencia vencida (48 h, `app.fiscal.service.
    # sweep_contingency_overdue`) se barre acá también, no sólo al entrar a
    # `GET /admin/fiscal/documents`/`/export` — Hoy es la pantalla que el
    # dueño abre primero, y sin este sweep un documento en contingencia podía
    # pasar 48 h sin que nadie lo viera salvo que además abriera Documentos
    # fiscales. Llama a la función del dueño de `app/fiscal` (no se replica
    # la consulta ni el umbral acá); `notify(...)` ya dedupea por
    # `fiscal_contingency_overdue:{document.id}`, así que entrar a Hoy varias
    # veces no duplica la alerta. Tiene que correr ANTES de `_recent_alerts`
    # (unas líneas más abajo) para que la notificación que dispara ya esté
    # en la tabla cuando se arma `alerts`.
    fiscal_service.sweep_contingency_overdue(db, store_id=store.id)
    open_orders = _open_orders_out(db, store, now)

    shift = shifts_service.get_current_shift(db, store=store)
    expected_cash = shifts_service.compute_breakdown(db, shift)["expected"] if shift is not None else None

    inventory_unreliable, days_since_last_full_count = _inventory_reliability(db, store)

    return TodayOut(
        store_id=store.id,
        business_date=business_date,
        sales_by_hour=sorted(_con_referencia(by_hour, neto_semana_pasada, hubo_semana_pasada), key=lambda h: h.hour),
        gross=gross,
        net=net,
        tax=tax,
        tips_total=tips_total,
        tips_by_method=_tips_by_method(documents),
        orders=orders_count,
        covers=covers_sum if order_ids else None,
        avg_ticket=avg_ticket,
        avg_per_cover=avg_per_cover,
        tables_occupied=tables_occupied,
        tables_total=tables_total,
        open_orders=open_orders,
        unsent_count=unsent_count,
        unpaid_count=unpaid_count,
        expected_cash=expected_cash,
        unavailable_products=_unavailable_products(db, store),
        pending_refunds_count=_pending_refunds_count(db, store),
        unreviewed_closes_count=_unreviewed_closes_count(db, store),
        alerts=_recent_alerts(db, store),
        ingredients_below_min=_low_stock_alerts(db, store),
        ingredients_negative=_negative_stock_alerts(db, store),
        preps_without_production=_prep_alerts(db, store),
        products_discounting_nothing=_uncosted_products(db, store, business_date=business_date),
        lots_expiring_or_expired=_lot_alerts(db, store, business_date=business_date),
        payables_overdue=_payables_overdue(db, store),
        payables_pending_review_count=_payables_pending_review_count(db, store),
        inventory_unreliable=inventory_unreliable,
        days_since_last_full_count=days_since_last_full_count,
    )


# ---------------------------------------------------------------------------
# GET /admin/accountant-report
# ---------------------------------------------------------------------------

_BIMESTER_MONTHS: dict[int, tuple[int, int]] = {1: (1, 2), 2: (3, 4), 3: (5, 6), 4: (7, 8), 5: (9, 10), 6: (11, 12)}


def _period_range(year: int, *, bimester: int | None, month: int | None) -> tuple[date, date, str, int]:
    if (bimester is None) == (month is None):
        raise AppError("VALIDATION_ERROR", "Indicá exactamente uno de bimester o month", status=400)
    if bimester is not None:
        if bimester not in _BIMESTER_MONTHS:
            raise AppError("VALIDATION_ERROR", "bimester: tiene que estar entre 1 y 6", status=400)
        first_month, last_month = _BIMESTER_MONTHS[bimester]
        date_from = date(year, first_month, 1)
        period_kind, period = "bimester", bimester
    else:
        assert month is not None
        if month < 1 or month > 12:
            raise AppError("VALIDATION_ERROR", "month: tiene que estar entre 1 y 12", status=400)
        date_from = date(year, month, 1)
        last_month = month
        period_kind, period = "month", month
    next_month = last_month % 12 + 1
    next_year = year + 1 if last_month == 12 else year
    date_to = date(next_year, next_month, 1) - timedelta(days=1)
    return date_from, date_to, period_kind, period


def accountant_report(
    db: Session, *, store_id: int, year: int, bimester: int | None, month: int | None
) -> AccountantReportOut:
    date_from, date_to, period_kind, period = _period_range(year, bimester=bimester, month=month)

    sale_docs = _sale_documents(db, store_id=store_id, date_from=date_from, date_to=date_to)
    note_docs = list(
        db.execute(
            select(FiscalDocument).where(
                FiscalDocument.store_id == store_id,
                FiscalDocument.business_date >= date_from,
                FiscalDocument.business_date <= date_to,
                FiscalDocument.document_type.in_(NOTE_DOCUMENT_TYPES),
                FiscalDocument.status == "issued",
            )
        ).scalars()
    )

    # (business_date, rate) -> {documents_base, documents_tax, notes_base, notes_tax}
    by_date_rate: dict[tuple[date, int], dict[str, int]] = {}
    docs_per_date: dict[date, int] = defaultdict(int)
    notes_per_date: dict[date, int] = defaultdict(int)
    tips_per_date: dict[date, int] = defaultdict(int)
    methods_total: dict[str, int] = defaultdict(int)

    for doc in sale_docs:
        docs_per_date[doc.business_date] += 1
        tips_per_date[doc.business_date] += doc.tip_amount
        for line in doc.tax_lines or []:
            key = (doc.business_date, int(line["rate"]))
            bucket = by_date_rate.setdefault(key, {"documents_base": 0, "documents_tax": 0, "notes_base": 0, "notes_tax": 0})
            bucket["documents_base"] += int(line["base"])
            bucket["documents_tax"] += int(line["tax"])
        for split in doc.payments_snapshot or []:
            methods_total[str(split.get("method", "other"))] += int(split.get("amount", 0))

    for doc in note_docs:
        notes_per_date[doc.business_date] += 1
        for line in doc.tax_lines or []:
            key = (doc.business_date, int(line["rate"]))
            bucket = by_date_rate.setdefault(key, {"documents_base": 0, "documents_tax": 0, "notes_base": 0, "notes_tax": 0})
            bucket["notes_base"] += int(line["base"])
            bucket["notes_tax"] += int(line["tax"])

    all_dates = sorted(set(docs_per_date) | set(notes_per_date) | {d for d, _r in by_date_rate})
    rows: list[AccountantRowOut] = []
    documents_total_base = documents_total_tax = notes_total_base = notes_total_tax = 0
    for business_date in all_dates:
        by_rate = [
            AccountantRateBreakdownOut(rate=rate, **values)
            for (d, rate), values in sorted(by_date_rate.items())
            if d == business_date
        ]
        for r in by_rate:
            documents_total_base += r.documents_base
            documents_total_tax += r.documents_tax
            notes_total_base += r.notes_base
            notes_total_tax += r.notes_tax
        rows.append(
            AccountantRowOut(
                business_date=business_date,
                documents_count=docs_per_date.get(business_date, 0),
                notes_count=notes_per_date.get(business_date, 0),
                tips_amount=tips_per_date.get(business_date, 0),
                by_rate=by_rate,
            )
        )

    return AccountantReportOut(
        store_id=store_id,
        year=year,
        period_kind=period_kind,  # type: ignore[arg-type]
        period=period,
        date_from=date_from,
        date_to=date_to,
        rows=rows,
        totals_by_method=[MethodAmountOut(method=m, amount=a) for m, a in sorted(methods_total.items())],
        documents_total_base=documents_total_base,
        documents_total_tax=documents_total_tax,
        notes_total_base=notes_total_base,
        notes_total_tax=notes_total_tax,
        tips_total=sum(tips_per_date.values()),
    )


# ---------------------------------------------------------------------------
# GET /admin/unavailable-log
# ---------------------------------------------------------------------------


def _estimated_lost_sales(db: Session, store: Store, *, product_id: int, price: int, unavailable_business_date: date) -> tuple[int | None, int | None]:
    """Heurística declarada (no hay un modelo de demanda en 1b-2): promedio
    de unidades vendidas por día en los `LOST_SALES_LOOKBACK_DAYS` días de
    negocio ANTERIORES al que quedó agotado, sobre comandas pagadas y ítems
    no anulados de ESE producto, valorizado al precio vigente EN ESE
    MOMENTO (`price`, leído del snapshot de `audit_logs.after`, no del
    catálogo actual). Sin ventas previas -> `None` ("sin datos", no `0`)."""
    since = unavailable_business_date - timedelta(days=LOST_SALES_LOOKBACK_DAYS)
    total_qty = db.execute(
        select(OrderItem.qty)
        .join(Order, OrderItem.order_id == Order.id)
        .where(
            Order.store_id == store.id,
            Order.status == OrderStatus.PAID,
            Order.business_date >= since,
            Order.business_date < unavailable_business_date,
            OrderItem.product_id == product_id,
            OrderItem.status != OrderItemStatus.VOIDED,
        )
    ).scalars().all()
    if not total_qty:
        return None, None
    units_per_day = money.round_half_up(sum(total_qty), LOST_SALES_LOOKBACK_DAYS)
    return units_per_day, units_per_day * price


def _unavailable_events(db: Session, store: Store, date_from: date, date_to: date) -> list[AuditLog]:
    """Bitácora real de "se agotó" (no sólo el snapshot actual de
    `Product`): `app.catalog.router.set_product_availability` (el 86 manual
    del POS/admin) y, desde 1b-2, `app.orders.service._apply_send` (el 86
    automático cuando el contador de porciones del día llega a `0`) auditan
    con el MISMO `entity="product"`, `action="set_availability"` — acá se
    leen los dos por igual. `app.catalog.service.set_product_availability`
    (la función, no el router) no audita por sí sola; los dos llamadores sí
    lo hacen alrededor de ella, así que no hace falta tocar `app.catalog`
    para tener la bitácora completa."""
    rows = list(
        db.execute(
            select(AuditLog)
            .where(AuditLog.store_id == store.id, AuditLog.entity == "product", AuditLog.action == "set_availability")
            .order_by(AuditLog.at.desc())
        ).scalars()
    )
    out: list[AuditLog] = []
    for row in rows:
        after = row.after or {}
        if after.get("available") is not False:
            continue  # sólo el evento que LO DEJÓ agotado, no el que lo reactivó
        business_date = tz.business_date_for(row.at, store.cutoff_hour)
        if date_from <= business_date <= date_to:
            out.append(row)
    return out


def unavailable_log(db: Session, *, store: Store, date_from: date, date_to: date) -> list[UnavailableLogRowOut]:
    """Cada vez que un producto quedó agotado dentro de `[from, to]`
    (manual o automático por contador de porciones), no sólo los que
    SIGUEN agotados ahora mismo: se lee de `audit_logs`, ver
    `_unavailable_events`."""
    _validate_range(date_from, date_to)
    events = _unavailable_events(db, store, date_from, date_to)
    out: list[UnavailableLogRowOut] = []
    for row in events:
        after = row.after or {}
        product_id = int(row.entity_id)
        name = str(after.get("name") or "")
        price = int((after.get("prices") or {}).get("dine_in") or 0)
        business_date = tz.business_date_for(row.at, store.cutoff_hour)
        by = (
            EmployeeRefOut(id=row.actor_employee_id, name=row.actor_employee_name or "")
            if row.actor_employee_id
            else None
        )
        units, lost = _estimated_lost_sales(db, store, product_id=product_id, price=price, unavailable_business_date=business_date)
        out.append(
            UnavailableLogRowOut(
                product_id=product_id,
                name=name,
                unavailable_at=row.at,
                by=by,
                estimated_lost_units=units,
                estimated_lost_sales=lost,
            )
        )
    out.sort(key=lambda r: r.unavailable_at, reverse=True)
    return out
