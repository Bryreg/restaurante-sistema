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


#: Paso al que se redondea HACIA ARRIBA una cantidad sugerida en la unidad
#: cómoda, en milésimas de esa unidad: medio kilo o medio litro para lo que
#: se pesa o se mide; enteros para botellas y unidades (no se compra media
#: botella). Nadie pide «503,177 g»: pide medio kilo. Redondear para arriba
#: es el sesgo declarado: se sugiere un poco más, nunca de menos.
_SUGGEST_STEP_MILLI = {"weight": 500, "volume": 500, "bottle": 1000, "unit": 1000}


def base_to_entry_milli(ingredient: Ingredient, qty_base: int) -> int:
    """Milésimas de la unidad base → milésimas de la unidad cómoda, con
    redondeo mitad hacia arriba en la milésima. Sólo para MOSTRAR: lo que se
    guarda sigue siendo la cantidad base."""
    factor = entry_spec(ingredient).factor
    sign = -1 if qty_base < 0 else 1
    return sign * ((abs(qty_base) * 2 + factor) // (2 * factor))


def rounded_entry_suggestion(ingredient: Ingredient, qty_base: int) -> tuple[int, int]:
    """Una cantidad sugerida (milésimas de la unidad base) redondeada HACIA
    ARRIBA al paso cómodo (`_SUGGEST_STEP_MILLI`). Devuelve `(milésimas de la
    unidad cómoda, milésimas de la unidad base equivalentes)`; la segunda es
    exacta porque el factor es entero. Sin nada que sugerir, `(0, 0)`."""
    if qty_base <= 0:
        return 0, 0
    spec = entry_spec(ingredient)
    step = _SUGGEST_STEP_MILLI[spec.mode]
    per_step_base = spec.factor * step
    steps = -(-qty_base // per_step_base)
    entry_milli = steps * step
    return entry_milli, entry_milli * spec.factor
