"""Análisis de mermas del período (auditoría del dueño, tanda 5, i6).

Las mermas de un período, en plata al costo, por motivo, por insumo y por
persona responsable. **Sólo administración** (lleva costos).

- **Costo**: el congelado en cada merma al registrarla (`Waste.cost_micros`,
  el mismo que valoriza `weekly_waste_kpi`), acumulado en micros por grupo y
  redondeado a pesos una vez, al final. Nunca se revaloriza con el costo de
  hoy.
- **`null` no es 0**: una merma sin costo (una preparación, o un insumo que
  nunca tuvo costo) no suma 0 a escondidas: se cuenta en
  `uncosted_entries`, y un grupo donde ninguna merma tiene costo publica
  `cost: null`.
- **Pérdida vs. salida explicada**: el consumo interno y el traslado a otra
  sede (`EXPLAINED_WASTE_TYPES`) no son pérdida. Salen en «por motivo»
  marcados `loss: false`, y quedan fuera del total, de «por insumo» y de
  «por persona» — la misma regla que el KPI semanal y el aviso de merma
  alta.
"""

from __future__ import annotations

from datetime import date
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.errors import AppError
from app.core.quantity import format_qty_base, line_cost_micros, micros_to_pesos
from app.inventory.models import EXPLAINED_WASTE_TYPES, Ingredient, Waste, WasteType
from app.stores.models import Store


class _Acc:
    __slots__ = ("entries", "uncosted", "micros", "qty")

    def __init__(self) -> None:
        self.entries = 0
        self.uncosted = 0
        self.micros = 0
        self.qty = 0

    def add(self, waste: Waste) -> None:
        self.entries += 1
        self.qty += waste.qty_base
        if waste.cost_micros is None:
            self.uncosted += 1
        else:
            self.micros += line_cost_micros(waste.qty_base, waste.cost_micros)

    def cost(self) -> int | None:
        # Ninguna con costo: no se sabe (null), no es $0.
        if self.entries > 0 and self.uncosted == self.entries:
            return None
        return micros_to_pesos(self.micros)


def _share_bp(cost: int | None, total: int) -> int | None:
    if cost is None or total <= 0:
        return None
    return (cost * 20_000 + total) // (2 * total)


def waste_analysis(db: Session, *, store: Store, date_from: date, date_to: date) -> dict[str, Any]:
    if date_from > date_to:
        raise AppError(code="VALIDATION_ERROR", message="from: tiene que ser anterior o igual a to", status=400)
    rows = list(
        db.execute(
            select(Waste).where(
                Waste.store_id == store.id,
                Waste.business_date >= date_from,
                Waste.business_date <= date_to,
            )
        ).scalars()
    )

    total = _Acc()
    by_reason: dict[WasteType, _Acc] = {}
    by_item: dict[tuple[str, int], _Acc] = {}
    by_person: dict[int, _Acc] = {}
    person_names: dict[int, str] = {}
    for waste in rows:
        by_reason.setdefault(waste.type, _Acc()).add(waste)
        if waste.type in EXPLAINED_WASTE_TYPES:
            continue
        total.add(waste)
        key = ("ingredient", waste.ingredient_id) if waste.ingredient_id is not None else ("preparation", int(waste.preparation_id or 0))
        by_item.setdefault(key, _Acc()).add(waste)
        by_person.setdefault(waste.employee_id, _Acc()).add(waste)
        person_names[waste.employee_id] = waste.employee_name

    total_cost = total.cost()
    total_for_share = total_cost or 0

    ingredient_ids = [i for kind, i in by_item if kind == "ingredient"]
    ingredients = (
        {i.id: i for i in db.execute(select(Ingredient).where(Ingredient.id.in_(ingredient_ids))).scalars()}
        if ingredient_ids
        else {}
    )
    prep_ids = [i for kind, i in by_item if kind == "preparation"]
    preps: dict[int, Any] = {}
    if prep_ids:
        from app.recipes.models import Preparation

        preps = {p.id: p for p in db.execute(select(Preparation).where(Preparation.id.in_(prep_ids))).scalars()}

    item_rows: list[dict[str, Any]] = []
    for (kind, item_id), acc in by_item.items():
        if kind == "ingredient":
            ing = ingredients.get(item_id)
            name = ing.name if ing is not None else f"Insumo #{item_id}"
            unit = ing.base_unit.value if ing is not None else ""
        else:
            prep = preps.get(item_id)
            name = prep.name if prep is not None else f"Preparación #{item_id}"
            unit = prep.standard_yield_unit if prep is not None else ""
        cost = acc.cost()
        item_rows.append(
            {
                "kind": kind,
                "item_id": item_id,
                "name": name,
                "unit": unit,
                "qty": format_qty_base(acc.qty),
                "entries": acc.entries,
                "uncosted_entries": acc.uncosted,
                "amount": cost,
                "share_bp": _share_bp(cost, total_for_share),
            }
        )
    item_rows.sort(key=lambda r: (-(r["amount"] or 0), r["name"].casefold()))

    reason_rows: list[dict[str, Any]] = []
    for waste_type in WasteType:
        reason_acc = by_reason.get(waste_type)
        if reason_acc is None:
            continue
        acc = reason_acc
        loss = waste_type not in EXPLAINED_WASTE_TYPES
        cost = acc.cost()
        reason_rows.append(
            {
                "type": waste_type.value,
                "loss": loss,
                "entries": acc.entries,
                "uncosted_entries": acc.uncosted,
                "amount": cost,
                "share_bp": _share_bp(cost, total_for_share) if loss else None,
            }
        )
    reason_rows.sort(key=lambda r: (not r["loss"], -(r["amount"] or 0), r["type"]))

    person_rows: list[dict[str, Any]] = []
    for employee_id, acc in by_person.items():
        cost = acc.cost()
        person_rows.append(
            {
                "employee_id": employee_id,
                "employee_name": person_names[employee_id],
                "entries": acc.entries,
                "uncosted_entries": acc.uncosted,
                "amount": cost,
                "share_bp": _share_bp(cost, total_for_share),
            }
        )
    person_rows.sort(key=lambda r: (-(r["amount"] or 0), r["employee_name"].casefold()))

    return {
        "store_id": store.id,
        "date_from": date_from.isoformat(),
        "date_to": date_to.isoformat(),
        "entries": total.entries,
        "uncosted_entries": total.uncosted,
        "amount": total_cost if total.entries > 0 else 0,
        "by_reason": reason_rows,
        "by_ingredient": item_rows,
        "by_person": person_rows,
    }
