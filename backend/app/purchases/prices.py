"""Precios de compra por proveedor (auditoría del dueño, tanda 5, i1).

Todo sale de las líneas de las recepciones **confirmadas** (una revertida no
fue una compra): no hay tabla de precios propia, el historial se deriva
siempre del libro de recepciones («derivar en vez de almacenar»).

El precio que se compara es `ReceptionLine.unit_cost_micros`: el costo por
unidad BASE sin impuesto. Es el mismo contra el que mide la deriva de la
confiabilidad (`service._supplier_reliability_data`) y no depende de que el
factor de compra del insumo haya cambiado entre dos compras. En pantalla se
publica además el precio por unidad de compra, tal como se tecleó.

**Aviso de subida (`supplier_price_rise`)**: al confirmar una recepción,
cada línea se compara contra la compra ANTERIOR del mismo insumo al MISMO
proveedor. Si subió más que el umbral de la regla de la sede (Notificaciones
› Reglas, por defecto 10 %), sale un aviso por `app.notifications`, con
`dedupe_key` por proveedor e insumo (uno por día). Se compara contra el
mismo proveedor porque la pregunta es «¿me subió el precio?»; la
comparación entre proveedores es otra pantalla (`supplier_comparison`).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.money import format_cop
from app.core.percent import format_pct_bp
from app.core.quantity import format_cost_micros, format_qty_base, micros_to_pesos
from app.inventory.models import Ingredient
from app.notifications.service import notify, rule_threshold
from app.purchases.models import Reception, ReceptionLine, ReceptionStatus, Supplier
from app.stores.models import Store

#: Tipo de aviso (declarado en `app.notifications.service.NOTIFICATION_TYPES`).
PRICE_RISE_TYPE = "supplier_price_rise"
#: Cuántas compras por proveedor muestra el historial.
HISTORY_PER_SUPPLIER = 5


def signed_bp(numerator: int, denominator: int) -> int:
    """`numerator / denominator` en puntos básicos, mitad hacia arriba sobre
    el valor absoluto y con signo (`denominator > 0`)."""
    magnitude = (abs(numerator) * 20_000 + denominator) // (2 * denominator)
    return -magnitude if numerator < 0 else magnitude


# ---------------------------------------------------------------------------
# Aviso de subida de precio al confirmar una recepción.
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class PreviousPrice:
    unit_cost_micros: int
    purchase_unit_price_micros: int
    business_date: date


def previous_supplier_prices(
    db: Session, *, store_id: int, supplier_id: int, ingredient_ids: list[int]
) -> dict[int, PreviousPrice]:
    """La última compra confirmada de cada insumo a ese proveedor. Se lee
    ANTES de escribir la recepción nueva, así que nunca se compara contra sí
    misma."""
    if not ingredient_ids:
        return {}
    rows = db.execute(
        select(ReceptionLine, Reception)
        .join(Reception, Reception.id == ReceptionLine.reception_id)
        .where(
            Reception.store_id == store_id,
            Reception.supplier_id == supplier_id,
            Reception.status == ReceptionStatus.CONFIRMED,
            ReceptionLine.ingredient_id.in_(sorted(set(ingredient_ids))),
        )
        .order_by(Reception.at.desc(), Reception.id.desc(), ReceptionLine.id.desc())
    ).all()
    out: dict[int, PreviousPrice] = {}
    for line, reception in rows:
        if line.ingredient_id not in out:
            out[line.ingredient_id] = PreviousPrice(
                unit_cost_micros=line.unit_cost_micros,
                purchase_unit_price_micros=line.purchase_unit_price_micros,
                business_date=reception.business_date,
            )
    return out


def notify_price_rises(
    db: Session,
    *,
    store: Store,
    supplier: Supplier,
    reception: Reception,
    lines: list[ReceptionLine],
    previous: dict[int, PreviousPrice],
    ingredients: dict[int, Ingredient],
) -> int:
    """Un aviso por cada insumo cuyo precio subió más del umbral contra la
    compra anterior al mismo proveedor. Devuelve cuántos avisos salieron
    (los deduplicados no cuentan)."""
    threshold_pct = rule_threshold(db, store.id, PRICE_RISE_TYPE)
    sent = 0
    seen: set[int] = set()
    for line in lines:
        if line.ingredient_id in seen:
            continue
        seen.add(line.ingredient_id)
        prev = previous.get(line.ingredient_id)
        if prev is None or prev.unit_cost_micros <= 0:
            continue
        diff = line.unit_cost_micros - prev.unit_cost_micros
        # Entero: sube más del X % si diff × 100 > X × anterior.
        if diff * 100 <= threshold_pct * prev.unit_cost_micros:
            continue
        ingredient = ingredients.get(line.ingredient_id)
        name = ingredient.name if ingredient is not None else f"Insumo #{line.ingredient_id}"
        unit = ingredient.purchase_unit if ingredient is not None else "unidad de compra"
        rise_bp = signed_bp(diff, prev.unit_cost_micros)
        row = notify(
            db,
            organization_id=store.organization_id,
            store_id=store.id,
            type=PRICE_RISE_TYPE,
            level="warning",
            title="Un proveedor subió el precio",
            body=(
                f"{supplier.name} subió «{name}» {format_pct_bp(rise_bp)}: de "
                f"{format_cop(micros_to_pesos(prev.purchase_unit_price_micros))} a "
                f"{format_cop(micros_to_pesos(line.purchase_unit_price_micros))} por {unit} "
                f"(compra anterior del {prev.business_date.isoformat()})"
            ),
            payload={
                "supplier_id": supplier.id,
                "ingredient_id": line.ingredient_id,
                "reception_id": reception.id,
                "rise_bp": rise_bp,
                "threshold_pct": threshold_pct,
            },
            dedupe_key=f"{PRICE_RISE_TYPE}:{supplier.id}:{line.ingredient_id}",
            push_url="/admin/compras?tab=precios",
        )
        if row is not None:
            sent += 1
    return sent


# ---------------------------------------------------------------------------
# Historial por proveedor (`GET /admin/ingredients/{id}/supplier-prices`).
# ---------------------------------------------------------------------------


def _confirmed_lines(db: Session, *, store_id: int, ingredient_id: int) -> list[tuple[ReceptionLine, Reception]]:
    """Todas las compras confirmadas del insumo, de la más vieja a la más
    nueva (el orden en que se calcula el cambio contra la anterior)."""
    return [
        (line, reception)
        for line, reception in db.execute(
            select(ReceptionLine, Reception)
            .join(Reception, Reception.id == ReceptionLine.reception_id)
            .where(
                Reception.store_id == store_id,
                Reception.status == ReceptionStatus.CONFIRMED,
                ReceptionLine.ingredient_id == ingredient_id,
            )
            .order_by(Reception.at, Reception.id, ReceptionLine.id)
        ).all()
    ]


def supplier_price_history(db: Session, *, store: Store, ingredient: Ingredient) -> dict[str, Any]:
    """Las últimas compras del insumo por proveedor, la más nueva primero,
    cada una con su cambio contra la compra anterior AL MISMO proveedor
    (`change_bp`, con signo; `None` en la primera compra: no hay contra qué
    medir). Proveedores ordenados por su compra más reciente."""
    per_supplier: dict[int, list[dict[str, Any]]] = {}
    last_cost: dict[int, int] = {}
    last_at: dict[int, tuple[Any, int]] = {}
    for line, reception in _confirmed_lines(db, store_id=store.id, ingredient_id=ingredient.id):
        prev = last_cost.get(reception.supplier_id)
        change_bp = signed_bp(line.unit_cost_micros - prev, prev) if prev is not None and prev > 0 else None
        last_cost[reception.supplier_id] = line.unit_cost_micros
        last_at[reception.supplier_id] = (reception.at, reception.id)
        per_supplier.setdefault(reception.supplier_id, []).append(
            {
                "reception_id": reception.id,
                "business_date": reception.business_date,
                "purchase_unit_price": format_cost_micros(line.purchase_unit_price_micros),
                "unit_cost": format_cost_micros(line.unit_cost_micros),
                "qty_received": format_qty_base(line.qty_received_base),
                "change_bp": change_bp,
            }
        )
    suppliers = (
        {s.id: s for s in db.execute(select(Supplier).where(Supplier.id.in_(sorted(per_supplier)))).scalars()}
        if per_supplier
        else {}
    )
    rows: list[dict[str, Any]] = []
    for supplier_id in sorted(per_supplier, key=lambda sid: last_at[sid], reverse=True):
        supplier = suppliers.get(supplier_id)
        history = list(reversed(per_supplier[supplier_id]))[:HISTORY_PER_SUPPLIER]
        rows.append(
            {
                "supplier_id": supplier_id,
                "supplier_name": supplier.name if supplier is not None else f"Proveedor #{supplier_id}",
                "supplier_active": supplier.active if supplier is not None else False,
                "purchases": history,
            }
        )
    return {
        "ingredient_id": ingredient.id,
        "ingredient_name": ingredient.name,
        "base_unit": ingredient.base_unit.value,
        "purchase_unit": ingredient.purchase_unit,
        "alert_threshold_pct": rule_threshold(db, store.id, PRICE_RISE_TYPE),
        "suppliers": rows,
    }
