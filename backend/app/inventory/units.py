"""La unidad cómoda en que se teclea un insumo en el POS, y su única
conversión a la unidad base.

Carnes y vegetales por **peso** (kg); licores por **botella** (la unidad de
compra del insumo en ml, p. ej. «botella» de 750 ml o «garrafa» de 5000 ml);
otros líquidos en litros; lo demás por unidad. La usan el conteo corto por
área (`area_counts`) y la merma del POS (`service.register_waste`): la
pantalla manda el texto tal cual, en la unidad que declara `entry_unit`, y el
servidor convierte una sola vez, acá. La pantalla nunca multiplica.
"""

from __future__ import annotations

from dataclasses import dataclass

from app.core.errors import AppError
from app.core.quantity import parse_qty_base
from app.inventory.models import BaseUnit, Ingredient

#: Milésimas por unidad entera (`parse_qty_base` guarda milésimas).
_THOUSANDTHS = 1000


@dataclass(frozen=True)
class EntrySpec:
    mode: str  # weight | bottle | volume | unit
    unit: str  # rótulo de la unidad en que se teclea
    factor: int  # unidades BASE enteras por unidad de entrada


def entry_spec(ingredient: Ingredient) -> EntrySpec:
    if ingredient.base_unit == BaseUnit.G:
        return EntrySpec("weight", "kg", 1000)
    if ingredient.base_unit == BaseUnit.ML:
        if ingredient.purchase_factor > 1:
            return EntrySpec("bottle", ingredient.purchase_unit, ingredient.purchase_factor)
        return EntrySpec("volume", "L", 1000)
    return EntrySpec("unit", "unidad", 1)


def entry_qty_to_base(ingredient: Ingredient, raw: str, *, whole_units: bool = True) -> int:
    """Lo tecleado en la unidad cómoda → milésimas de la unidad base.
    `parse_qty_base` da milésimas de la unidad de entrada y el factor es
    entero, así que no hay redondeo. Nunca acepta negativos.

    `whole_units`: un artículo que se cuenta por unidad no admite fracción
    («5,5 huevos» es un error de tecleo, no una cantidad)."""
    spec = entry_spec(ingredient)
    qty = parse_qty_base(raw, field=ingredient.name)
    if qty < 0:
        raise AppError(code="VALIDATION_ERROR", message=f"{ingredient.name}: la cantidad no puede ser negativa")
    if whole_units and spec.mode == "unit" and qty % _THOUSANDTHS != 0:
        raise AppError(
            code="VALIDATION_ERROR",
            message=f"{ingredient.name}: se cuenta en unidades enteras, sin decimales",
        )
    return qty * spec.factor
