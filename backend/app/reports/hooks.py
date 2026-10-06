"""Lo único que otros dominios pueden importar de `reports`.

Hasta acá `app.expenses` leía `app.reports.service.aggregate_sales` directo;
ahora que `app.payroll` también necesita las ventas netas del período (el %
de la nómina sobre la venta), la lectura se publica acá una sola vez, de
sólo lectura, y los dos dominios pasan por la misma puerta
(`docs/CONTEXTO-AGENTES.md §3`). **No suma nada propio**: devuelve el total
de `aggregate_sales` —la única agregación de documentos de venta— tal cual.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date

from sqlalchemy.orm import Session

from app.reports import service

#: Los comprobantes que son venta (no notas) y el ticket promedio: una sola
#: definición, publicada para `app.shifts.activity_metrics` (auditoría u9).
SALE_DOCUMENT_TYPES = service.SALE_DOCUMENT_TYPES
average_ticket = service.average_ticket
ticket_basis = service.ticket_basis


@dataclass(frozen=True)
class PeriodSales:
    """El total de ventas del período, en las unidades de `SalesBucketOut`:
    `net` en pesos sin impuesto ni propina; `theoretical_cost` en pesos o
    `None` si ninguna venta tuvo costo; `costed_pct` en por ciento entero
    (0-100) de la venta neta que tiene costo, `None` sin venta neta."""

    net: int
    orders: int
    theoretical_cost: int | None
    costed_pct: int | None


def period_sales(db: Session, *, store_id: int, date_from: date, date_to: date) -> PeriodSales:
    _rows, total = service.aggregate_sales(db, store_id=store_id, date_from=date_from, date_to=date_to, group_by=None)
    return PeriodSales(
        net=total.net,
        orders=total.orders,
        theoretical_cost=total.theoretical_cost,
        costed_pct=total.costed_pct,
    )


@dataclass(frozen=True)
class BimesterTax:
    """Lo cobrado de impuesto en un bimestre, por tarifa (por ciento entero),
    tal como lo publica el informe del contador (`tax_by_rate` de
    `GET /admin/accountant-report?bimester=`): los mismos documentos de
    venta emitidos y no reversados, sumando `tax_lines` congeladas. `documents`
    es cuántos documentos de venta tuvo el bimestre."""

    date_from: date
    date_to: date
    documents: int
    by_rate: dict[int, tuple[int, int]]


def bimester_tax(db: Session, *, store_id: int, year: int, bimester: int) -> BimesterTax:
    """c5 · La base del INC a agendar (`app.expenses`): **no suma nada
    propio**, lee el mismo cálculo del informe del contador."""
    from app.core import clock
    from app.reports import accountant

    period = accountant._compute(
        db, store_ids=[store_id], year=year, bimester=bimester, month=None, today=clock.now_utc().date()
    )
    return BimesterTax(
        date_from=period.date_from,
        date_to=period.date_to,
        documents=period.summary.documents_count,
        by_rate={r.rate: (r.base, r.tax) for r in period.summary.tax_by_rate},
    )
