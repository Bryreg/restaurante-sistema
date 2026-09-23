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
