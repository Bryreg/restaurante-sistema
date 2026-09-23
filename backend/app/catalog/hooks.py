"""Contrato publicado de `catalog` para otros dominios: sólo lectura.

Hasta ahora nadie lo necesitaba por fuera (`app.orders` usa `catalog.service`
directamente para vender). Nace con la ingeniería de menú de `app.analytics`,
que necesita saber de cada plato vendido su categoría y si es un CARGO
(`Product.is_delivery_fee`) en vez de un plato — un dato de la carta de hoy
que no cambia el valor de ninguna venta pasada (el snapshot de precio y costo
sigue en `OrderItem`), sólo cómo se agrupa y si entra o no a la matriz.
"""

from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.catalog.models import Category, Product


@dataclass(frozen=True)
class ProductFacts:
    product_id: int
    category_id: int
    category_name: str
    is_delivery_fee: bool


def product_facts(db: Session, *, store_id: int, product_ids: list[int]) -> dict[int, ProductFacts]:
    """`product_id -> ProductFacts` de los productos pedidos que existen en
    la sede (un id ajeno o borrado simplemente no aparece)."""
    if not product_ids:
        return {}
    rows = db.execute(
        select(Product.id, Product.category_id, Category.name, Product.is_delivery_fee)
        .join(Category, Product.category_id == Category.id)
        .where(Product.store_id == store_id, Product.id.in_(product_ids))
    ).all()
    return {
        pid: ProductFacts(product_id=pid, category_id=cid, category_name=cname, is_delivery_fee=bool(fee))
        for pid, cid, cname, fee in rows
    }
