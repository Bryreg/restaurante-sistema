"""«Informes» (`GET /admin/reports/overview`): todas las secciones del
período en una sola respuesta, para una sede o para todas las de la
organización.

**No hay una segunda matemática.** Toda cifra de plata sale de
`service.aggregate_sales` —la misma función de «Ventas» y de «Hoy»—, llamada
una vez por agrupación (método, hora, plato, persona, canal, zona,
categoría). Con «Todas las sedes» la MISMA función corre sobre los
documentos de todas las sedes (`service.StoreScope`), y la sección «Por
sede» es esa misma función por cada sede sola: la suma de las filas es el
consolidado porque son los mismos documentos, no porque alguien sume
totales ya redondeados.

Lo que el servidor no sabe viaja como «sin dato» con su motivo
(`MissingDataOut`), nunca como `0`.
"""

from __future__ import annotations

from datetime import date

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core import features
from app.core.modules import find_spec_safe
from app.orders import money
from app.reports import service
from app.reports.schemas import (
    CategoryRefOut,
    CostSectionOut,
    DeliveryCustomersOut,
    MenuSummaryOut,
    MissingDataOut,
    PeakHourOut,
    ReportsOverviewOut,
    SalesBucketOut,
    StoreRowOut,
    TopProductOut,
)
from app.stores.models import Store

ALL_STORES_MENU_REASON = (
    "La ingeniería de menú se calcula sede por sede (los umbrales dependen de la carta de cada una): "
    "elegí una sede para verla."
)


def _peak_hour(rows: list[SalesBucketOut]) -> PeakHourOut | None:
    """La hora de más venta neta. Las filas ya vienen en el orden del día
    operativo, así que con `>` estricto el empate se queda con la primera.
    Sin ninguna hora con venta, `None` (no hay pico que marcar)."""
    best: SalesBucketOut | None = None
    for row in rows:
        if row.net <= 0:
            continue
        if best is None or row.net > best.net:
            best = row
    if best is None:
        return None
    return PeakHourOut(hour=int(best.key), label=best.label, net=best.net, orders=best.orders, share_bp=best.share_bp)


def _products(
    db: Session, rows: list[SalesBucketOut]
) -> tuple[list[TopProductOut], list[CategoryRefOut]]:
    """Las filas de `group_by="product"` con su categoría (la misma lectura
    que usa `group_by="category"`: `service._product_categories`)."""
    product_ids = {int(r.key) for r in rows if r.key.isdigit()}
    categories = service._product_categories(db, product_ids)
    out: list[TopProductOut] = []
    seen: dict[str, str] = {}
    for r in rows:
        if r.key.isdigit():
            cat_key, cat_label = categories.get(int(r.key), ("none", "Sin categoría"))
        elif r.key.startswith("combo-"):
            cat_key, cat_label = ("combos", "Combos")
        else:
            cat_key, cat_label = ("none", "Sin categoría")
        seen.setdefault(cat_key, cat_label)
        out.append(
            TopProductOut(
                key=r.key,
                label=r.label,
                net=r.net,
                units=r.units,
                share_bp=r.share_bp,
                category_key=cat_key,
                category_label=cat_label,
            )
        )
    cats = sorted((CategoryRefOut(key=k, label=v) for k, v in seen.items()), key=lambda c: c.label.lower())
    return out, cats


def _identified_customers(db: Session, *, store_ids: list[int], date_from: date, date_to: date) -> tuple[int, int]:
    """`(clientes distintos, comandas)` con cliente registrado en el
    comprobante de venta del período. Recuentos, no plata; mismos
    documentos que `aggregate_sales` (`service._sale_documents`)."""
    docs = service._sale_documents(db, store_id=store_ids, date_from=date_from, date_to=date_to)
    customers = {d.customer_id for d in docs if d.customer_id is not None}
    orders = {d.order_id for d in docs if d.customer_id is not None}
    return len(customers), len(orders)


def _delivery_customers(
    db: Session, *, store_ids: list[int], channel_rows: list[SalesBucketOut], date_from: date, date_to: date
) -> DeliveryCustomersOut:
    by_key = {r.key: r for r in channel_rows}
    identified_customers, identified_orders = _identified_customers(
        db, store_ids=store_ids, date_from=date_from, date_to=date_to
    )
    missing = [
        MissingDataOut(
            key="delivery_zone",
            label="Domicilios por zona o barrio",
            reason="La dirección del domicilio se guarda como texto libre: no hay zonas de reparto para agrupar.",
        ),
        MissingDataOut(
            key="returning_customers",
            label="Clientes que vuelven",
            reason="El cliente sólo se registra cuando pide factura con sus datos: no hay historial de visitas.",
        ),
    ]
    return DeliveryCustomersOut(
        delivery=by_key.get("delivery"),
        platform=by_key.get("platform"),
        identified_customers=identified_customers,
        identified_orders=identified_orders,
        missing=missing,
    )


def _menu_summary(db: Session, *, stores: list[Store], all_stores: bool, date_from: date, date_to: date) -> MenuSummaryOut:
    def unavailable(reason: str) -> MenuSummaryOut:
        return MenuSummaryOut(
            available=False, reason=reason, star=None, plowhorse=None, puzzle=None, dog=None,
            unclassified=None, insufficient_sample=None,
        )

    if all_stores and len(stores) != 1:
        return unavailable(ALL_STORES_MENU_REASON)
    store = stores[0]
    if find_spec_safe("app.analytics.hooks") is None:
        return unavailable("La ingeniería de menú no está instalada en este sistema.")
    for key in ("catalog.recipes", "analytics.menu_engineering"):
        if not features.is_enabled(db, store.organization_id, store.id, key):
            return unavailable("La función «Ingeniería de menú» está apagada para esta sede.")
    from app.analytics import hooks as analytics_hooks

    counts = analytics_hooks.menu_class_counts(db, store=store, date_from=date_from, date_to=date_to)
    if not counts.available:
        return unavailable(counts.reason or "No hay datos suficientes para clasificar los platos.")
    return MenuSummaryOut(
        available=True,
        reason=None,
        star=counts.star,
        plowhorse=counts.plowhorse,
        puzzle=counts.puzzle,
        dog=counts.dog,
        unclassified=counts.unclassified,
        insufficient_sample=counts.insufficient_sample,
    )


def _by_store(db: Session, *, stores: list[Store], date_from: date, date_to: date) -> list[StoreRowOut]:
    """Una fila por sede: `aggregate_sales` de esa sede sola. La
    participación se reparte con `money.prorate` (las filas suman 10.000)."""
    rows: list[StoreRowOut] = []
    for store in stores:
        _rows, total = service.aggregate_sales(
            db, store_id=store.id, date_from=date_from, date_to=date_to, group_by=None
        )
        rows.append(
            StoreRowOut(
                store_id=store.id,
                store_name=store.name,
                net=total.net,
                orders=total.orders,
                avg_ticket=total.avg_ticket,
                share_bp=None,
            )
        )
    nets = [r.net for r in rows]
    if rows and all(n >= 0 for n in nets) and sum(nets) > 0:
        shares = money.prorate(10_000, nets)
        rows = [r.model_copy(update={"share_bp": s}) for r, s in zip(rows, shares)]
    return sorted(rows, key=lambda r: (-r.net, r.store_name))


def organization_stores(db: Session, organization_id: int) -> list[Store]:
    """Todas las sedes de la organización, activas o no: una sede cerrada
    sigue teniendo su historia de ventas."""
    return list(
        db.execute(select(Store).where(Store.organization_id == organization_id).order_by(Store.id)).scalars()
    )


def reports_overview(
    db: Session, *, stores: list[Store], all_stores: bool, date_from: date, date_to: date
) -> ReportsOverviewOut:
    service._validate_range(date_from, date_to)
    store_ids = [s.id for s in stores]
    scope: service.StoreScope = store_ids if all_stores else store_ids[0]

    def agg(group_by: str | None) -> tuple[list[SalesBucketOut], SalesBucketOut]:
        return service.aggregate_sales(db, store_id=scope, date_from=date_from, date_to=date_to, group_by=group_by)

    _none, total = agg(None)
    total = total.model_copy(
        update={
            "previous_period": service._previous_period(
                db, store_id=scope, date_from=date_from, date_to=date_to, current=total
            )
        }
    )
    by_method, _ = agg("method")
    by_hour, _ = agg("hour")
    product_rows, _ = agg("product")
    by_employee, _ = agg("employee")
    by_channel, _ = agg("channel")
    by_zone, _ = agg("zone")
    by_category, _ = agg("category")
    products, categories = _products(db, product_rows)

    return ReportsOverviewOut(
        scope="all" if all_stores else "store",
        store_id=None if all_stores else store_ids[0],
        store_ids=store_ids,
        date_from=date_from,
        date_to=date_to,
        total=total,
        by_method=by_method,
        by_hour=by_hour,
        peak_hour=_peak_hour(by_hour),
        products=products,
        categories=categories,
        by_employee=by_employee,
        by_channel=by_channel,
        by_zone=by_zone,
        delivery_customers=_delivery_customers(
            db, store_ids=store_ids, channel_rows=by_channel, date_from=date_from, date_to=date_to
        ),
        menu_engineering=_menu_summary(db, stores=stores, all_stores=all_stores, date_from=date_from, date_to=date_to),
        cost=CostSectionOut(
            theoretical_cost=total.theoretical_cost,
            gross_margin=total.gross_margin,
            costed_pct=total.costed_pct,
            by_category=by_category,
        ),
        by_store=_by_store(db, stores=stores, date_from=date_from, date_to=date_to) if all_stores else None,
    )
