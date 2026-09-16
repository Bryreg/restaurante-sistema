"""Conversión de la unidad que teclea la carta/cocina a la unidad base entera
del insumo o la preparación (`docs/ESTADO.md`, contrato numérico de
`backend-inventario` en `app/core/quantity.py`).

Sólo unidades métricas simples (`kg`/`g`, `l`/`ml`) con factor exacto 1000, y
`unit` (unidad discreta, factor 1). "Lo dudoso se pregunta, nunca se adivina"
(SPEC-NEGOCIO §4.1): una línea en `kg` sobre un insumo cuya unidad base es `g`
convierte sola (18 kg -> 18000 g); una línea en una unidad que no corresponde
a la base del componente (ni por conversión métrica) es `400 UNIT_MISMATCH`,
nunca una adivinanza silenciosa.
"""

from __future__ import annotations

from decimal import Decimal, InvalidOperation

from app.core.errors import AppError

BASE_UNIT_VALUES = ("g", "ml", "unit")

# unidad de entrada -> (unidad base a la que corresponde, factor entero hacia esa base)
_INPUT_UNITS: dict[str, tuple[str, int]] = {
    "g": ("g", 1),
    "kg": ("g", 1000),
    "ml": ("ml", 1),
    "l": ("ml", 1000),
    "unit": ("unit", 1),
}

INPUT_UNIT_VALUES = tuple(_INPUT_UNITS.keys())


def parse_positive_qty(qty_str: str, *, field: str = "qty") -> Decimal:
    """Convierte el texto que manda el cliente (nunca `float` en el borde) a
    `Decimal`. `400 VALIDATION_ERROR` ante texto no numérico o `<= 0`."""
    try:
        value = Decimal(str(qty_str))
    except (InvalidOperation, ValueError):
        raise AppError(code="VALIDATION_ERROR", message=f'{field}: "{qty_str}" no es una cantidad válida') from None
    if value <= 0:
        raise AppError(code="VALIDATION_ERROR", message=f"{field}: la cantidad tiene que ser mayor que cero")
    return value


def _exact_scaled_int(scaled: Decimal, *, field: str) -> int:
    """`400 VALIDATION_ERROR` si `scaled` no es un entero exacto (más
    precisión que la milésima de la unidad base) — nunca truncar en
    silencio, mismo espíritu que `app.core.quantity.parse_qty_base`."""
    if scaled != scaled.to_integral_value():
        raise AppError(
            code="VALIDATION_ERROR",
            message=f"{field}: no admite más precisión que la milésima de la unidad base",
        )
    return int(scaled)


def to_base_qty(qty_str: str, unit: str, expected_base_unit: str, *, field: str = "qty") -> int:
    """`qty_str` (decimal como texto) en `unit` -> milésimas enteras de
    `expected_base_unit` (`QTY_SCALE` de `app.core.quantity`)."""
    from app.core.quantity import QTY_SCALE

    if unit not in _INPUT_UNITS:
        raise AppError(
            code="VALIDATION_ERROR",
            message=f'unit: "{unit}" no es una unidad reconocida (usá g, kg, ml, l o unit)',
        )
    base_unit, factor = _INPUT_UNITS[unit]
    if base_unit != expected_base_unit:
        raise AppError(
            code="UNIT_MISMATCH",
            message=(
                f'"{unit}" no corresponde a la unidad base "{expected_base_unit}" de este insumo o '
                "preparación; convertí la cantidad a su propia unidad antes de guardar"
            ),
        )
    qty = parse_positive_qty(qty_str, field=field)
    return _exact_scaled_int(qty * factor * QTY_SCALE, field=field)


def parse_nonnegative_qty(qty_str: str, *, field: str = "qty") -> Decimal:
    """Como `parse_positive_qty`, pero acepta `0` (un lote que salió en cero:
    se quemó la producción entera; el registro es igual de válido que uno con
    resultado positivo, `PrepBatch.qty_real` sólo exige `>= 0`)."""
    try:
        value = Decimal(str(qty_str))
    except (InvalidOperation, ValueError):
        raise AppError(code="VALIDATION_ERROR", message=f'{field}: "{qty_str}" no es una cantidad válida') from None
    if value < 0:
        raise AppError(code="VALIDATION_ERROR", message=f"{field}: la cantidad no puede ser negativa")
    return value


def to_base_qty_nonnegative(qty_str: str, unit: str, expected_base_unit: str, *, field: str = "qty") -> int:
    """Como `to_base_qty`, pero acepta `0` (ver `parse_nonnegative_qty`)."""
    from app.core.quantity import QTY_SCALE

    if unit not in _INPUT_UNITS:
        raise AppError(
            code="VALIDATION_ERROR",
            message=f'unit: "{unit}" no es una unidad reconocida (usá g, kg, ml, l o unit)',
        )
    base_unit, factor = _INPUT_UNITS[unit]
    if base_unit != expected_base_unit:
        raise AppError(
            code="UNIT_MISMATCH",
            message=(
                f'"{unit}" no corresponde a la unidad base "{expected_base_unit}" de este insumo o '
                "preparación; convertí la cantidad a su propia unidad antes de guardar"
            ),
        )
    qty = parse_nonnegative_qty(qty_str, field=field)
    return _exact_scaled_int(qty * factor * QTY_SCALE, field=field)


def base_qty_to_decimal(qty_base: int, unit: str) -> Decimal:
    """Inverso de `to_base_qty`: reconstruye el valor mostrable en la unidad
    original guardada en la línea, para prellenar un formulario de edición."""
    from app.core.quantity import QTY_SCALE

    _base_unit, factor = _INPUT_UNITS.get(unit, (unit, 1))
    return Decimal(qty_base) / Decimal(factor * QTY_SCALE)
