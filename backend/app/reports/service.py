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
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

import importlib
from types import ModuleType

from app.audit.models import AuditLog
from app.catalog.models import Category, Product
from app.core import clock, features, tz
from app.core.errors import AppError
from app.core.money import format_cop
from app.core.modules import find_spec_safe
from app.core.quantity import format_qty_base, line_cost_micros, micros_to_pesos
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
    DayCloseOut,
    PayableAlertOut,
    PrepAlertOut,
    PreviousPeriodOut,
    TodayComparisonOut,
    SalesBucketOut,
    SalesReportOut,
    TodayOut,
    UncostedProductOut,
    UnavailableLogRowOut,
    UnavailableProductOut,
)
from app.shifts import hooks as shifts_hooks
from app.shifts import service as shifts_service
from app.shifts.models import BusinessDay, Shift, ShiftStatus
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
    # Revisión de datos (sep. 2026). `covers_net`: neto SÓLO de las comandas
    # que tienen comensales (numerador de `avg_per_cover`, científico #1).
    # `payments`: pagos (partes de un cobro) en `group_by=method`
    # (científico #10). `units`/`item_ids`: unidades por ítem distinto en
    # `group_by=product|category`.
    covers_net: int = 0
    payments: int = 0
    units: int = 0
    item_ids: set[int] = field(default_factory=set)


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
    salvo `"method"`, que reparte cada documento entre sus `splits`, y
    `"product"`/`"category"`, que lo reparten entre sus líneas)."""
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


def _hours_from_cutoff(cutoff_hour: int) -> list[int]:
    """Las 24 horas de reloj en el orden del DÍA OPERATIVO: arranca en la
    hora de corte de la sede (una venta a la 01:00 con corte a las 06:00 es
    el final del día, no el principio — científico #12)."""
    return [(cutoff_hour + i) % 24 for i in range(24)]


def _first_activity_date(db: Session, store_id: int) -> date | None:
    """Primer día operativo con actividad real de la sede (un día abierto o
    un comprobante emitido), o `None` si nunca operó. Es el piso de los
    períodos rellenados: antes de esto la sede «no existía», y eso es
    `null`, no «vendió $0»."""
    first_day = db.execute(
        select(func.min(BusinessDay.business_date)).where(BusinessDay.store_id == store_id)
    ).scalar_one()
    first_doc = db.execute(
        select(func.min(FiscalDocument.business_date)).where(
            FiscalDocument.store_id == store_id, FiscalDocument.document_type.in_(SALE_DOCUMENT_TYPES)
        )
    ).scalar_one()
    candidates = [d for d in (first_day, first_doc) if d is not None]
    return min(candidates) if candidates else None


def _operated_dates(db: Session, store_id: int, date_from: date, date_to: date) -> set[date]:
    """Días operativos que la sede ABRIÓ (hay `BusinessDay`) dentro del rango."""
    return set(
        db.execute(
            select(BusinessDay.business_date).where(
                BusinessDay.store_id == store_id,
                BusinessDay.business_date >= date_from,
                BusinessDay.business_date <= date_to,
            )
        ).scalars()
    )


def _signed_bp(numerator: int, denominator: int) -> int:
    """`numerator / denominator` en puntos básicos, half-up sobre el valor
    absoluto y con el signo del numerador (`money.round_half_up` sólo acepta
    no negativos; la variación de un período puede ser negativa)."""
    magnitude = money.round_half_up(abs(numerator) * 10_000, denominator)
    return magnitude if numerator >= 0 else -magnitude


def _delta_bp(current: int | None, previous: int | None) -> int | None:
    """Variación de `current` contra `previous`, en puntos básicos con signo.
    `None` sin valor anterior o con anterior `<= 0`: sin divisor no hay
    variación (nunca un «+100 %» inventado contra cero)."""
    if current is None or previous is None or previous <= 0:
        return None
    return _signed_bp(current - previous, previous)


@dataclass
class _ItemInfo:
    product_id: int | None
    combo_id: int | None
    name: str
    qty: int
    unit_cost_micros: int | None


def _items_info(db: Session, documents: list[FiscalDocument]) -> dict[int, _ItemInfo]:
    """Ítems de las líneas de los documentos, con lo CONGELADO al vender
    (`OrderItem.name`, `qty`, `unit_cost_micros`) — nunca la carta actual."""
    item_ids = {int(line["item_id"]) for doc in documents for line in (doc.lines or [])}
    if not item_ids:
        return {}
    rows = db.execute(
        select(
            OrderItem.id, OrderItem.product_id, OrderItem.combo_id, OrderItem.name, OrderItem.qty, OrderItem.unit_cost_micros
        ).where(OrderItem.id.in_(item_ids))
    ).all()
    return {
        item_id: _ItemInfo(product_id=pid, combo_id=cid, name=name, qty=qty, unit_cost_micros=ucm)
        for item_id, pid, cid, name, qty, ucm in rows
    }


def _product_categories(db: Session, product_ids: set[int]) -> dict[int, tuple[str, str]]:
    """`product_id -> (key, label)` de su categoría. **Aproximación
    declarada**: el ítem vendido no congela la categoría (no hay columna, y
    agregarla es migración), así que se lee la categoría ACTUAL del
    producto. Mover un plato de categoría mueve su historia; cambiar el
    precio o el nombre, no (esos sí están congelados)."""
    if not product_ids:
        return {}
    rows = db.execute(
        select(Product.id, Category.id, Category.name)
        .join(Category, Product.category_id == Category.id)
        .where(Product.id.in_(product_ids))
    ).all()
    return {pid: (str(cid), cname) for pid, cid, cname in rows}


def aggregate_sales(
    db: Session, *, store_id: int, date_from: date, date_to: date, group_by: str | None
) -> tuple[list[SalesBucketOut], SalesBucketOut]:
    """Agrega documentos de venta (SPEC-NEGOCIO §10) por `group_by` (`None` =
    un solo total). Devuelve `(filas, total)`; el total es la misma
    agregación sin partir por grupo, así "Hoy" y "Ventas" nunca pueden
    mostrar un total distinto de la suma de sus filas.

    **Orden de las filas** (revisión de datos sep. 2026, científico #2 y #13
    — decidido acá, una sola vez, para que ninguna pantalla lo reordene):

    - `business_date`: cronológico, y con TODOS los días entre el primer
      día con actividad de la sede y hoy (acotados a `[from, to]`); un día
      sin ventas es una fila con `net=0` y `operated` dice si abrió.
    - `hour`: las 24 horas en el orden del día operativo (desde el
      `cutoff_hour` de la sede), con `0` explícito.
    - `shift`: por apertura real del turno (`Shift.opened_at`, luego id) —
      nunca por la etiqueta como texto («#10» antes que «#2»).
    - `method`, `channel`, `employee`, `zone`, `product`, `category`: por
      `net` descendente (la pregunta es «quién/qué pesa más»), empate por
      etiqueta.
    """
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
    covers_map = _order_covers_map(db, order_ids_all)

    zone_map: dict[int, tuple[str, str]] = {}
    if group_by == "zone":
        zone_map = _order_zone_map(db, order_ids_all)
    items: dict[int, _ItemInfo] = {}
    categories: dict[int, tuple[str, str]] = {}
    if group_by in ("product", "category"):
        items = _items_info(db, documents)
        if group_by == "category":
            categories = _product_categories(db, {i.product_id for i in items.values() if i.product_id is not None})

    def _has_covers(order_id: int) -> bool:
        covers = covers_map.get(order_id)
        return covers is not None and covers > 0

    for doc in documents:
        doc_net = doc.total - doc.tax_total
        total_bucket.gross += doc.total
        total_bucket.tax += doc.tax_total
        total_bucket.tips += doc.tip_amount
        total_bucket.order_ids.add(doc.order_id)
        if _has_covers(doc.order_id):
            total_bucket.covers_net += doc_net
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
            # Revisión de datos (científico #10): cada `split` es UN pago y
            # se cuenta como tal (`payments`), no como una comanda más.
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
                bucket.payments += 1
                total_bucket.payments += 1
            continue

        if group_by in ("product", "category"):
            # Cada línea del comprobante va a su plato: `line["net"]` es la
            # línea CON impuesto (nombre de `app.orders.money`) y
            # `line["base"]` sin impuesto — la misma unidad que el `net` de
            # este reporte. Unidades: la `qty` congelada del ítem, UNA vez
            # por ítem (una sub-cuenta trae porciones, no platos).
            for line in doc.lines or []:
                item_id = int(line["item_id"])
                info = items.get(item_id)
                if info is None:
                    continue
                if group_by == "product":
                    if info.product_id is not None:
                        key, label = (str(info.product_id), info.name)
                    elif info.combo_id is not None:
                        key, label = (f"combo-{info.combo_id}", info.name)
                    else:
                        key, label = (f"item-{info.name}", info.name)
                else:
                    if info.product_id is not None:
                        key, label = categories.get(info.product_id, ("none", "Sin categoría"))
                    elif info.combo_id is not None:
                        key, label = ("combos", "Combos")
                    else:
                        key, label = ("none", "Sin categoría")
                bucket = buckets.setdefault(key, _Bucket(label=label))
                if group_by == "product":
                    # La etiqueta es el nombre congelado del ítem MÁS
                    # RECIENTE (los documentos vienen en orden cronológico).
                    bucket.label = label
                line_net = int(line["net"])
                line_tax = int(line["tax"])
                bucket.gross += line_net
                bucket.tax += line_tax
                bucket.order_ids.add(doc.order_id)
                if item_id not in bucket.item_ids:
                    bucket.item_ids.add(item_id)
                    bucket.units += info.qty
                if info.unit_cost_micros is not None:
                    bucket.theoretical_cost_micros += info.unit_cost_micros * int(line["qty"])
                    bucket.has_theoretical_cost = True
                    bucket.costed_net += int(line["base"])
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
        if _has_covers(doc.order_id):
            bucket.covers_net += doc_net
        if doc_cost_micros is not None:
            bucket.theoretical_cost_micros += doc_cost_micros
            bucket.has_theoretical_cost = True
        bucket.costed_net += doc_costed_net

    by_method = group_by == "method"
    by_line = group_by in ("product", "category")

    def _to_out(key: str, bucket: _Bucket, *, is_total: bool = False) -> SalesBucketOut:
        net = bucket.gross - bucket.tax
        orders_count = len(bucket.order_ids)
        covers_sum = sum(c for oid in bucket.order_ids if (c := covers_map.get(oid)) is not None)
        method_row = by_method and not is_total
        # En una fila por medio, `orders` cuenta pagos (científico #10): el
        # ticket promedio es por pago, no por una comanda contada dos veces.
        count_for_ticket = bucket.payments if method_row else orders_count
        avg_ticket = (
            money.round_half_up(net, count_for_ticket) if count_for_ticket > 0 and net >= 0 and not (by_line and not is_total) else None
        )
        # Científico #1: el ticket por comensal divide el neto de las
        # comandas QUE TIENEN comensales por esos comensales — antes dividía
        # el neto de TODAS (mostrador y domicilio incluidos) y lo inflaba.
        avg_per_cover = (
            money.round_half_up(bucket.covers_net, covers_sum)
            if covers_sum > 0 and bucket.covers_net >= 0 and not method_row and not (by_line and not is_total)
            else None
        )
        # Conversión a pesos ÚNICA, acá, después de sumar micros a través de
        # TODOS los documentos del bucket (ronda 2, B-2) — nunca antes.
        theoretical_cost = micros_to_pesos(bucket.theoretical_cost_micros) if bucket.has_theoretical_cost else None
        gross_margin = (net - theoretical_cost) if theoretical_cost is not None else None
        if method_row:
            costed_pct: int | None = None
        else:
            costed_pct = (
                money.round_half_up(bucket.costed_net * 100, net) if net > 0 and bucket.costed_net > 0 else (0 if net > 0 else None)
            )
        if method_row:
            covers_out: int | None = None
        elif by_line and not is_total:
            covers_out = None
        else:
            covers_out = covers_sum if orders_count > 0 else None
        return SalesBucketOut(
            key=key,
            label=bucket.label,
            gross=bucket.gross,
            net=net,
            tax=bucket.tax,
            tips=None if (by_line and not is_total) else bucket.tips,
            orders=bucket.payments if method_row else orders_count,
            covers=covers_out,
            avg_ticket=avg_ticket,
            avg_per_cover=avg_per_cover,
            theoretical_cost=theoretical_cost,
            gross_margin=gross_margin,
            costed_pct=costed_pct,
            payments=bucket.payments if by_method else None,
            units=bucket.units if (by_line and not is_total) else None,
        )

    order_key: list[str]
    if group_by is None:
        order_key = sorted(buckets.keys())
    elif group_by == "business_date":
        order_key = _business_date_keys(db, store_id, date_from, date_to, buckets)
    elif group_by == "hour":
        cutoff_hour = db.execute(select(Store.cutoff_hour).where(Store.id == store_id)).scalar_one_or_none() or 0
        for hour in range(24):
            buckets.setdefault(str(hour), _Bucket(label=f"{hour:02d}:00"))
        order_key = [str(h) for h in _hours_from_cutoff(cutoff_hour)]
    elif group_by == "shift":
        shift_ids = [int(k) for k in buckets if k.isdigit()]
        opened: dict[int, datetime] = (
            {sid: at for sid, at in db.execute(select(Shift.id, Shift.opened_at).where(Shift.id.in_(shift_ids))).all()}
            if shift_ids
            else {}
        )
        order_key = sorted(
            buckets.keys(),
            key=lambda k: (0, opened[int(k)], int(k)) if k.isdigit() and int(k) in opened else (1, clock.now_utc(), 0),
        )
    else:
        order_key = sorted(buckets.keys(), key=lambda k: (-(buckets[k].gross - buckets[k].tax), buckets[k].label))

    rows = [_to_out(k, buckets[k]) for k in order_key]
    if group_by == "business_date":
        operated = _operated_dates(db, store_id, date_from, date_to)
        rows = [r.model_copy(update={"operated": date.fromisoformat(r.key) in operated}) for r in rows]
    total_out = _to_out("total", total_bucket, is_total=True)

    # Participación de cada fila en el neto (científico #10): repartida con
    # `money.prorate` para que las filas sumen EXACTO 10.000 bp.
    nets = [r.net for r in rows]
    if rows and total_out.net > 0 and all(n >= 0 for n in nets) and sum(nets) > 0:
        shares = money.prorate(10_000, nets)
        rows = [r.model_copy(update={"share_bp": s}) for r, s in zip(rows, shares)]
    return rows, total_out


def _business_date_keys(
    db: Session, store_id: int, date_from: date, date_to: date, buckets: dict[str, _Bucket]
) -> list[str]:
    """TODOS los días del rango (científico #2): un día sin ventas es una
    fila con `net=0`, no un hueco que el gráfico de línea se come. El rango
    se acota al tramo en que la sede EXISTIÓ — desde su primer día con
    actividad hasta hoy (o el último comprobante, si un reloj de prueba
    quedó atrás) —: antes de abrir no «vendió $0», no existía; y un rango
    `2020-01-01..2099-12-31` no puede devolver 29.000 filas."""
    store = db.get(Store, store_id)
    cutoff_hour = store.cutoff_hour if store is not None else 0
    first = _first_activity_date(db, store_id)
    if first is None:
        return sorted(buckets.keys())
    last = tz.today_business_date(cutoff_hour)
    if buckets:
        last = max(last, max(date.fromisoformat(k) for k in buckets))
    start = max(date_from, first)
    end = min(date_to, last)
    day = start
    while day <= end:
        key = day.isoformat()
        buckets.setdefault(key, _Bucket(label=key))
        day += timedelta(days=1)
    return sorted(buckets.keys())


def _previous_period(
    db: Session, *, store_id: int, date_from: date, date_to: date, current: SalesBucketOut
) -> PreviousPeriodOut:
    """El período del mismo largo inmediatamente anterior (analista #7):
    `[from − n, from − 1]`, con `n = to − from + 1` días. Se calcula con la
    MISMA agregación (`aggregate_sales`), nunca con una suma aparte."""
    length = (date_to - date_from).days + 1
    prev_to = date_from - timedelta(days=1)
    prev_from = date_from - timedelta(days=length)
    first = _first_activity_date(db, store_id)
    if first is None or first > prev_to:
        return PreviousPeriodOut(
            date_from=prev_from,
            date_to=prev_to,
            net=None,
            orders=None,
            avg_ticket=None,
            delta_bp=None,
            orders_delta_bp=None,
            avg_ticket_delta_bp=None,
            partial=False,
            null_reason="La sede todavía no operaba en el período anterior: no hay contra qué comparar.",
        )
    _rows, prev = aggregate_sales(db, store_id=store_id, date_from=prev_from, date_to=prev_to, group_by=None)
    return PreviousPeriodOut(
        date_from=prev_from,
        date_to=prev_to,
        net=prev.net,
        orders=prev.orders,
        avg_ticket=prev.avg_ticket,
        delta_bp=_delta_bp(current.net, prev.net),
        orders_delta_bp=_delta_bp(current.orders, prev.orders),
        avg_ticket_delta_bp=_delta_bp(current.avg_ticket, prev.avg_ticket),
        partial=first > prev_from,
        null_reason=None,
    )


def sales_report(db: Session, *, store_id: int, date_from: date, date_to: date, group_by: str) -> SalesReportOut:
    _validate_range(date_from, date_to)
    rows, total = aggregate_sales(db, store_id=store_id, date_from=date_from, date_to=date_to, group_by=group_by)
    total = total.model_copy(
        update={"previous_period": _previous_period(db, store_id=store_id, date_from=date_from, date_to=date_to, current=total)}
    )
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


# Tipos de notificación de diferencias de caja que el riel de «Hoy» agrupa en
# UN aviso resumen (`cash_diff_summary`, analista #4): ocho tarjetas sueltas
# de «Diferencia de caja al cierre» con el mismo peso tapaban lo demás. Las
# notificaciones siguen existiendo tal cual en la campana
# (`GET /admin/notifications`); sólo el riel de Hoy las resume.
CASH_DIFF_NOTIFICATION_TYPES = ("cash_difference", "cash_difference_critical", "difference_streak")
CASH_DIFF_SUMMARY_TYPE = "cash_diff_summary"
_ALERT_LEVEL_RANK = {"critical": 0, "warning": 1, "info": 2}


def _alert_sort_key(alert: AlertOut) -> tuple[int, int, int, float]:
    """Gravedad, después plata en juego (`|amount|` desc, sin monto al
    final), después lo más reciente primero."""
    return (
        _ALERT_LEVEL_RANK.get(alert.level, 3),
        1 if alert.amount is None else 0,
        -abs(alert.amount or 0),
        -alert.created_at.timestamp(),
    )


def _recent_alerts(db: Session, store: Store, *, limit: int = 30) -> list[AlertOut]:
    rows = list(
        db.execute(
            select(Notification)
            .where(
                Notification.store_id == store.id,
                Notification.read_at.is_(None),
                Notification.type.not_in(CASH_DIFF_NOTIFICATION_TYPES),
            )
            .order_by(Notification.created_at.desc())
            .limit(limit)
        ).scalars()
    )
    alerts = [
        AlertOut(type=n.type, level=n.level, title=n.title, body=n.body, created_at=n.created_at, payload=n.payload)
        for n in rows
    ]
    summary = _cash_diff_summary(db, store)
    if summary is not None:
        alerts.append(summary)
    alerts.sort(key=_alert_sort_key)
    return alerts


def _current_difference_streak(db: Session, store: Store, employee_id: int) -> int:
    """La racha de diferencias de caja de esa persona, con LA regla de
    turnos (`app.shifts.hooks.difference_streak`: cierres contados seguidos
    por fuera de la tolerancia de la sede; un cierre sin conteo ni suma ni
    corta). Antes se recontaba acá con otra regla y el aviso de Hoy podía
    decir una racha distinta de la que muestra Dinero."""
    return shifts_hooks.difference_streak(db, store_id=store.id, employee_id=employee_id)


def _cash_diff_summary(db: Session, store: Store) -> AlertOut | None:
    """UN aviso con todas las diferencias de caja al cierre sin leer
    (analista #4): cuántos cierres, faltante y sobrante por separado (se
    compensan en el neto y el dueño tiene que ver los dos), el neto con
    signo en `amount`, y quién está en racha. La diferencia se lee del
    TURNO (`Shift.difference`, la fuente), no del texto de la notificación:
    un turno reabierto y vuelto a cerrar cuadrado sale del resumen."""
    notifications = list(
        db.execute(
            select(Notification).where(
                Notification.store_id == store.id,
                Notification.read_at.is_(None),
                Notification.type.in_(CASH_DIFF_NOTIFICATION_TYPES),
            )
        ).scalars()
    )
    if not notifications:
        return None
    shift_ids: set[int] = set()
    critical_shift_ids: set[int] = set()
    streak_employee_ids: set[int] = set()
    for n in notifications:
        payload = n.payload or {}
        if n.type == "difference_streak":
            if payload.get("employee_id") is not None:
                streak_employee_ids.add(int(payload["employee_id"]))
            continue
        if payload.get("shift_id") is None:
            continue
        shift_ids.add(int(payload["shift_id"]))
        if n.type == "cash_difference_critical":
            critical_shift_ids.add(int(payload["shift_id"]))

    shifts = (
        list(db.execute(select(Shift).where(Shift.id.in_(shift_ids), Shift.store_id == store.id)).scalars())
        if shift_ids
        else []
    )
    with_difference = [s for s in shifts if s.difference is not None and s.difference != 0]
    shortage = [s for s in with_difference if s.difference < 0]  # type: ignore[operator]
    surplus = [s for s in with_difference if s.difference > 0]  # type: ignore[operator]
    shortage_total = sum(s.difference for s in shortage)  # type: ignore[misc]
    surplus_total = sum(s.difference for s in surplus)  # type: ignore[misc]

    streaks: list[dict[str, Any]] = []
    for employee_id in sorted(streak_employee_ids):
        streak = _current_difference_streak(db, store, employee_id)
        if streak < 2:
            continue
        name = db.execute(
            select(Shift.cash_responsible_name)
            .where(Shift.store_id == store.id, Shift.cash_responsible_id == employee_id)
            .order_by(Shift.closed_at.desc().nulls_last(), Shift.id.desc())
            .limit(1)
        ).scalar_one_or_none()
        streaks.append({"employee_id": employee_id, "employee_name": name or f"#{employee_id}", "streak": streak})
    streaks.sort(key=lambda s: (-s["streak"], s["employee_name"]))

    if not with_difference and not streaks:
        return None

    closed_dates = [tz.business_date_for(s.closed_at, store.cutoff_hour) for s in with_difference if s.closed_at is not None]
    today = tz.today_business_date(store.cutoff_hour)
    first_date = min(closed_dates) if closed_dates else None
    last_date = max(closed_dates) if closed_dates else None
    days = (today - first_date).days + 1 if first_date is not None else None
    count = len(with_difference)

    parts: list[str] = []
    if shortage:
        parts.append(f"faltante {format_cop(shortage_total)} en {len(shortage)} {'cierre' if len(shortage) == 1 else 'cierres'}")
    if surplus:
        parts.append(f"sobrante {format_cop(surplus_total)} en {len(surplus)} {'cierre' if len(surplus) == 1 else 'cierres'}")
    body = ""
    if parts:
        body = parts[0][0].upper() + "; ".join(parts)[1:] + "."
    if count and days is not None:
        body = f"{body} En {'el último día' if days == 1 else f'los últimos {days} días'}.".strip()
    for s in streaks:
        body = f"{body} {s['employee_name']} lleva {s['streak']} cierres seguidos con diferencia.".strip()

    if count:
        title = f"{count} {'cierre' if count == 1 else 'cierres'} de caja con diferencia"
    else:
        title = "Racha de diferencias de caja"
    level = "critical" if (critical_shift_ids & {s.id for s in with_difference}) else "warning"
    return AlertOut(
        type=CASH_DIFF_SUMMARY_TYPE,
        level=level,
        title=title,
        body=body,
        created_at=max(n.created_at for n in notifications),
        amount=(shortage_total + surplus_total) if count else None,
        payload={
            "count": count,
            "shortage_count": len(shortage),
            "shortage_total": shortage_total,
            "surplus_count": len(surplus),
            "surplus_total": surplus_total,
            "net_total": shortage_total + surplus_total,
            "critical_count": len(critical_shift_ids & {s.id for s in with_difference}),
            "shift_ids": sorted(s.id for s in with_difference),
            "first_business_date": first_date.isoformat() if first_date else None,
            "last_business_date": last_date.isoformat() if last_date else None,
            "days": days,
            "streaks": streaks,
        },
    )


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
    out: list[NegativeStockAlertOut] = []
    for row in hooks.negative_stock_alerts(db, store_id=store.id):
        out.append(
            NegativeStockAlertOut(
                **{**row, "qty_base": format_qty_base(row["qty_base"]), "min_stock": format_qty_base(row["min_stock"])},
                amount=_negative_stock_amount(db, hooks, store, ingredient_id=row["ingredient_id"], qty_base=row["qty_base"]),
            )
        )
    # Analista #4: primero lo que más plata tiene en juego; los sin costo al
    # final (no se sabe cuánto pesan, no que pesen cero).
    out.sort(key=lambda n: (n.amount is None, -(n.amount or 0), n.name))
    return out


def _negative_stock_amount(db: Session, hooks: ModuleType, store: Store, *, ingredient_id: int, qty_base: int) -> int | None:
    """Cuánto vale lo que falta: `|qty_base|` × costo vigente del insumo,
    con la jerarquía COMPLETA del dueño del dato
    (`app.inventory.hooks.resolve_ingredient_cost`) — acumulado en micros
    (`line_cost_micros`) y redondeado a pesos una sola vez. `None` cuando el
    insumo no tiene costo todavía (nunca `0` mudo)."""
    ingredient = hooks.get_ingredient(db, store_id=store.id, ingredient_id=ingredient_id)
    if ingredient is None:
        return None
    cost_micros, _source = hooks.resolve_ingredient_cost(db, ingredient)
    if cost_micros is None:
        return None
    return micros_to_pesos(line_cost_micros(abs(qty_base), cost_micros))


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


# ---------------------------------------------------------------------------
# Revisión de datos (sep. 2026): ventas por hora completas, comparación
# contra la semana pasada y el cierre de ayer para «Hoy».
# ---------------------------------------------------------------------------


def _hour_buckets(
    documents: list[FiscalDocument], *, cutoff_hour: int, now_local_hour: int | None
) -> list[HourBucketOut]:
    """Las 24 horas del día operativo, desde `cutoff_hour`, con `0`
    explícito (científico #12). `now_local_hour` es la hora actual para el
    día EN CURSO: las horas posteriores salen con `pending=True` (su `0` es
    «todavía no pasó»). `None` = día completo (referencia), nada pendiente."""
    gross: dict[int, int] = defaultdict(int)
    net: dict[int, int] = defaultdict(int)
    orders: dict[int, set[int]] = defaultdict(set)
    for doc in documents:
        hour = _bogota_hour(doc.issued_at)
        gross[hour] += doc.total
        net[hour] += doc.total - doc.tax_total
        orders[hour].add(doc.order_id)
    hours = _hours_from_cutoff(cutoff_hour)
    current_index = hours.index(now_local_hour) if now_local_hour is not None else 23
    return [
        HourBucketOut(hour=h, gross=gross[h], net=net[h], orders=len(orders[h]), pending=index > current_index)
        for index, h in enumerate(hours)
    ]


def _today_comparison(
    db: Session, store: Store, *, business_date: date, now: datetime, net: int, orders: int, first_activity: date | None
) -> tuple[TodayComparisonOut, list[HourBucketOut]]:
    """Hoy contra el mismo día de la semana pasada, hasta la misma hora
    (analista #3), y la serie por hora de ese día COMPLETO (la línea gris
    de referencia)."""
    reference_date = business_date - timedelta(days=7)
    # Al minuto, no al microsegundo: el mismo `GET /admin/today` pedido dos
    # veces seguidas tiene que dar el mismo payload (el invariante de
    # snapshots de `tests/audit/test_reports_invariants.py` lo compara
    # entero). Cuentan los comprobantes de ese día hasta el FINAL de ese
    # minuto.
    until = (now - timedelta(days=7)).replace(second=0, microsecond=0)
    if first_activity is None or first_activity > reference_date:
        return (
            TodayComparisonOut(
                reference_business_date=reference_date,
                until=until,
                net=None,
                orders=None,
                delta_bp=None,
                orders_delta_bp=None,
                reference_operated=None,
                null_reason="La sede todavía no operaba el mismo día de la semana pasada: no hay contra qué comparar.",
            ),
            [],
        )
    reference_docs = _sale_documents(db, store_id=store.id, date_from=reference_date, date_to=reference_date)
    same_hour_docs = [d for d in reference_docs if d.issued_at < until + timedelta(minutes=1)]
    ref_net = sum(d.total - d.tax_total for d in same_hour_docs)
    ref_orders = len({d.order_id for d in same_hour_docs})
    operated = reference_date in _operated_dates(db, store.id, reference_date, reference_date)
    comparison = TodayComparisonOut(
        reference_business_date=reference_date,
        until=until,
        net=ref_net,
        orders=ref_orders,
        delta_bp=_delta_bp(net, ref_net),
        orders_delta_bp=_delta_bp(orders, ref_orders),
        reference_operated=operated,
        null_reason=None,
    )
    return comparison, _hour_buckets(reference_docs, cutoff_hour=store.cutoff_hour, now_local_hour=None)


def _yesterday_close(db: Session, store: Store, *, business_date: date, first_activity: date | None) -> DayCloseOut | None:
    """El día operativo anterior completo: lo que Hoy muestra antes de la
    primera venta (analista #3). `None` si la sede todavía no operaba."""
    yesterday = business_date - timedelta(days=1)
    if first_activity is None or first_activity > yesterday:
        return None
    _rows, total = aggregate_sales(db, store_id=store.id, date_from=yesterday, date_to=yesterday, group_by=None)
    return DayCloseOut(
        business_date=yesterday,
        net=total.net,
        orders=total.orders,
        avg_ticket=total.avg_ticket,
        operated=yesterday in _operated_dates(db, store.id, yesterday, yesterday),
    )


def today_report(db: Session, *, store: Store) -> TodayOut:
    now = clock.now_utc()
    business_date = tz.today_business_date(store.cutoff_hour)

    documents = _sale_documents(db, store_id=store.id, date_from=business_date, date_to=business_date)

    gross = tax = tips_total = 0
    covers_net = 0
    order_ids: set[int] = set()
    covers_map = _order_covers_map(db, {d.order_id for d in documents})
    for doc in documents:
        gross += doc.total
        tax += doc.tax_total
        tips_total += doc.tip_amount
        order_ids.add(doc.order_id)
        covers = covers_map.get(doc.order_id)
        if covers is not None and covers > 0:
            covers_net += doc.total - doc.tax_total

    net = gross - tax
    covers_sum = sum(c for oid in order_ids if (c := covers_map.get(oid)) is not None)
    orders_count = len(order_ids)
    avg_ticket = money.round_half_up(net, orders_count) if orders_count > 0 else None
    # Científico #1: neto de las comandas CON comensales ÷ esos comensales
    # (mismo arreglo que `aggregate_sales`); antes el numerador era el neto
    # de todas las comandas, mostrador y domicilio incluidos.
    avg_per_cover = money.round_half_up(covers_net, covers_sum) if covers_sum > 0 and covers_net >= 0 else None

    first_activity = _first_activity_date(db, store.id)
    comparison, sales_by_hour_reference = _today_comparison(
        db, store, business_date=business_date, now=now, net=net, orders=orders_count, first_activity=first_activity
    )
    yesterday_close = _yesterday_close(db, store, business_date=business_date, first_activity=first_activity)

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

    negatives = _negative_stock_alerts(db, store)
    costed_negatives = [n.amount for n in negatives if n.amount is not None]
    inventory_enabled = _hooks_if_enabled(db, store, module="app.inventory.hooks", feature="inventory.perpetual") is not None
    if not inventory_enabled:
        negative_amount: int | None = None
    elif costed_negatives:
        negative_amount = sum(costed_negatives)
    else:
        negative_amount = 0 if not negatives else None
    negative_uncosted = sum(1 for n in negatives if n.amount is None)
    payables_enabled = _hooks_if_enabled(db, store, module="app.purchases.hooks", feature="purchases") is not None
    payables_overdue = _payables_overdue(db, store)

    return TodayOut(
        store_id=store.id,
        business_date=business_date,
        sales_by_hour=_hour_buckets(documents, cutoff_hour=store.cutoff_hour, now_local_hour=_bogota_hour(now)),
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
        ingredients_negative=negatives,
        preps_without_production=_prep_alerts(db, store),
        products_discounting_nothing=_uncosted_products(db, store, business_date=business_date),
        lots_expiring_or_expired=_lot_alerts(db, store, business_date=business_date),
        payables_overdue=payables_overdue,
        payables_pending_review_count=_payables_pending_review_count(db, store),
        inventory_unreliable=inventory_unreliable,
        days_since_last_full_count=days_since_last_full_count,
        payables_overdue_total=(sum(p.balance for p in payables_overdue) if payables_enabled else None),
        ingredients_negative_amount=negative_amount,
        ingredients_negative_uncosted=negative_uncosted,
        comparison=comparison,
        sales_by_hour_reference=sales_by_hour_reference,
        yesterday_close=yesterday_close,
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
