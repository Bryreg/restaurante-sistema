"""Contrato numérico (`app.core.quantity`, real o el doble de
`tests/recipes/_quantity_stub.py`): cantidades sin `float`, rendimiento
aplicado con `ceil`, sólo se convierte a pesos en el borde.

Checklist del pedido: "cantidades sin float: un consumo de 0,1 + 0,2 de la
unidad base da exactamente 0,3 (test de propiedad sobre 1.000 casos
aleatorios)"; "rendimiento aplicado (qty ÷ yield_pct), test numérico
explícito, que es el error que subestima todos los costos".
"""

from __future__ import annotations

import random
from decimal import Decimal

from app.core.quantity import QTY_SCALE, apply_yield, micros_to_pesos
from app.recipes import units


def test_no_float_property_1000_random_cases() -> None:
    """`0.1 + 0.2` en la unidad base (milésimas enteras) da exactamente
    `0.3`, sobre 1.000 casos aleatorios de dos cantidades cualquiera que
    conviertan a milésimas enteras — nunca el error de redondeo binario de
    `float` (`0.1 + 0.2 == 0.30000000000000004`)."""
    rng = random.Random(20260915)
    for _ in range(1000):
        a_str = f"{rng.randint(0, 999_999)}.{rng.randint(0, 999):03d}"
        b_str = f"{rng.randint(0, 999_999)}.{rng.randint(0, 999):03d}"
        a_base = units.to_base_qty(a_str, "g", "g")
        b_base = units.to_base_qty(b_str, "g", "g")
        # Cada uno es un `int` exacto (nunca `float`); la suma en milésimas
        # es exacta por definición de la aritmética entera.
        assert isinstance(a_base, int) and isinstance(b_base, int)
        expected = int((Decimal(a_str) + Decimal(b_str)) * QTY_SCALE)
        assert a_base + b_base == expected


def test_apply_yield_85_percent_discounts_more_than_the_clean_quantity() -> None:
    """"La receta expresa cantidad LIMPIA y el consumo descuenta cantidad ÷
    rendimiento": una pechuga con hueso al 85 % de rendimiento, para una
    receta que pide 400 g limpios, descuenta MÁS de 400 g del insumo crudo —
    el error que subestima todos los costos si no se aplica."""
    clean_qty_base = units.to_base_qty("400", "g", "g")  # 400_000 (milésimas)
    consumed = apply_yield(clean_qty_base, 85)
    assert consumed > clean_qty_base
    # 400 / 0.85 = 470.588..23 -> ceil a milésimas = 470.589 g.
    assert consumed == 470_589


def test_apply_yield_100_percent_is_identity() -> None:
    qty_base = units.to_base_qty("123.456", "g", "g")
    assert apply_yield(qty_base, 100) == qty_base


def test_micros_to_pesos_rounds_half_up_only_at_the_border() -> None:
    from app.core.quantity import COST_SCALE

    assert micros_to_pesos(0) == 0
    assert micros_to_pesos(COST_SCALE // 2) == 1  # 0.5 -> 1 (half-up)
    assert micros_to_pesos(COST_SCALE // 2 - 1) == 0
    assert micros_to_pesos(1_280_000) == 1  # "1 g de mezcla vale $1,28": redondea a $1, no a $3.600.
