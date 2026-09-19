"""`app.core.quantity`: el contrato numérico de cantidades de insumo que
importa el resto del equipo de 2a. Sin `float`, sin `hypothesis` (no hay
dependencias nuevas): propiedad sobre 1.000 casos con `random.Random(20260915)`
(misma semilla que usa el auditor de 1b-1 para las 1.000 comandas)."""

from __future__ import annotations

import random
import typing
from decimal import Decimal

import pytest

from app.core.errors import AppError
from app.core.modules import find_spec_safe
from app.core.quantity import (
    COST_SCALE,
    QTY_SCALE,
    apply_yield,
    format_cost_micros,
    format_qty_base,
    line_cost_micros,
    micros_to_pesos,
    parse_cost_micros,
    parse_qty_base,
)


def test_scales_are_documented_powers_of_ten() -> None:
    assert QTY_SCALE == 1000
    assert COST_SCALE == 1_000_000


# ---------------------------------------------------------------------------
# (a) 0,1 + 0,2 == 0,3 exacto, y suma asociativa/conmutativa sobre 1.000 casos.
# ---------------------------------------------------------------------------


def test_zero_point_one_plus_zero_point_two_is_exact_in_base_units() -> None:
    # El caso de manual: 0,1 g + 0,2 g de la unidad base tiene que dar
    # exactamente 0,3 g -- 100 + 200 == 300 en milésimas -- nunca 0.30000000000000004.
    tenth = parse_qty_base("0.1")
    two_tenths = parse_qty_base("0.2")
    assert tenth == 100
    assert two_tenths == 200
    assert tenth + two_tenths == 300
    assert tenth + two_tenths == parse_qty_base("0.3")


def test_sum_of_quantities_is_associative_and_commutative_over_1000_cases() -> None:
    rng = random.Random(20260915)
    for _ in range(1000):
        n = rng.randint(2, 8)
        values = [rng.randint(-500_000, 500_000) for _ in range(n)]

        left_to_right = 0
        for v in values:
            left_to_right += v

        right_to_left = 0
        for v in reversed(values):
            right_to_left += v

        shuffled = values[:]
        rng.shuffle(shuffled)
        any_order = sum(shuffled)

        assert left_to_right == sum(values)
        assert right_to_left == sum(values)
        assert any_order == sum(values)
        # Ningún redondeo fraccionario se coló: todo es aritmética entera.
        assert isinstance(sum(values), int)


def test_sum_of_decimal_strings_matches_decimal_sum_exactly() -> None:
    # Ida y vuelta contra `Decimal` puro, para confirmar que escalar a
    # milésimas y sumar en enteros da lo mismo que sumar en decimal y
    # escalar al final -- la propiedad que hace seguro no usar `float`.
    rng = random.Random(20260915)
    for _ in range(1000):
        n = rng.randint(2, 5)
        decimals = [Decimal(rng.randint(-50_000, 50_000)) / 1000 for _ in range(n)]
        expected = sum(decimals) * QTY_SCALE

        scaled_sum = sum(parse_qty_base(str(d)) for d in decimals)

        assert scaled_sum == int(expected)


# ---------------------------------------------------------------------------
# (b) apply_yield: el rendimiento aplicado, numérico y explícito.
# ---------------------------------------------------------------------------


def test_apply_yield_85_percent_rounds_up_to_the_gross_quantity() -> None:
    # 850 milésimas limpias (0,85 g) al 85 % de rendimiento: el insumo BRUTO
    # que hay que descontar es 1000 milésimas (1 g) -- exacto en este caso,
    # porque 850 / 0.85 == 1000 sin residuo.
    assert apply_yield(850, 85) == 1000


def test_apply_yield_100_percent_is_identity() -> None:
    rng = random.Random(20260915)
    for _ in range(200):
        qty = rng.randint(1, 1_000_000)
        assert apply_yield(qty, 100) == qty


def test_apply_yield_rounds_up_never_down_when_inexact() -> None:
    # 1 milésima limpia al 50 %: el bruto exacto sería 2 milésimas -- exacto
    # acá también, probemos un caso con residuo real.
    # 100 % rendimiento vs 99 %: 100 milésimas limpias al 99 % necesitan
    # 100/0.99 = 101.0101... -> ceil = 102, nunca 101 (que subestimaría).
    result = apply_yield(100, 99)
    assert result == 102
    assert result > 100  # el bruto siempre es >= la cantidad limpia pedida


def test_apply_yield_rejects_out_of_range_percent() -> None:
    with pytest.raises(AppError):
        apply_yield(100, 0)
    with pytest.raises(AppError):
        apply_yield(100, 101)


# ---------------------------------------------------------------------------
# line_cost_micros / micros_to_pesos
# ---------------------------------------------------------------------------


def test_line_cost_micros_and_micros_to_pesos_round_trip() -> None:
    # 500 milésimas (0,5 g) a $18.000.000 de millonésimas por gramo entero
    # ($18/g) -> 9.000.000 micros -> $9 al borde.
    line = line_cost_micros(500, 18_000_000)
    assert line == 9_000_000
    assert micros_to_pesos(line) == 9


def test_micros_to_pesos_rounds_half_up() -> None:
    assert micros_to_pesos(1_500_000) == 2  # 1,5 -> 2
    assert micros_to_pesos(1_499_999) == 1
    assert micros_to_pesos(500_000) == 1  # 0,5 -> 1 (half-up, no banker's)
    assert micros_to_pesos(0) == 0


def test_line_cost_micros_accumulates_without_intermediate_rounding() -> None:
    # Tres líneas de 0,167 g a $3/g: cada línea sola redondea a $1 (0,501 ->
    # 1 half-up), así que sumar redondeado-por-línea da $3. Acumulado en
    # millonésimas y redondeado UNA sola vez al final da $2 (0,501 * 3 =
    # 1,503 -> $2) -- la cifra correcta, y la razón de no redondear línea por
    # línea a lo largo de una ficha.
    lines = [(167, 3_000_000)] * 3
    total_micros = sum(line_cost_micros(qty, cost) for qty, cost in lines)
    per_line_then_summed = sum(micros_to_pesos(line_cost_micros(qty, cost)) for qty, cost in lines)

    assert micros_to_pesos(total_micros) == 2
    assert per_line_then_summed == 3
    assert micros_to_pesos(total_micros) != per_line_then_summed


# ---------------------------------------------------------------------------
# parse_qty_base / format_qty_base
# ---------------------------------------------------------------------------


def test_parse_qty_base_rejects_python_float() -> None:
    with pytest.raises(AppError):
        parse_qty_base(18.5)  # type: ignore[arg-type]


def test_parse_qty_base_rejects_more_than_three_decimals() -> None:
    with pytest.raises(AppError):
        parse_qty_base("18.5001")


def test_parse_qty_base_accepts_comma_decimal() -> None:
    assert parse_qty_base("18,5") == 18_500


def test_parse_qty_base_rejects_garbage() -> None:
    with pytest.raises(AppError):
        parse_qty_base("dieciocho")
    with pytest.raises(AppError):
        parse_qty_base("")


def test_format_qty_base_round_trips_parse_qty_base() -> None:
    rng = random.Random(20260915)
    for _ in range(500):
        raw = rng.randint(-1_000_000, 1_000_000)
        text = format_qty_base(raw)
        assert parse_qty_base(text) == raw


def test_format_qty_base_examples() -> None:
    assert format_qty_base(1250) == "1.25"
    assert format_qty_base(-400) == "-0.4"
    assert format_qty_base(3000) == "3"
    assert format_qty_base(0) == "0"


# ---------------------------------------------------------------------------
# parse_cost_micros / format_cost_micros
# ---------------------------------------------------------------------------


def test_parse_cost_micros_scales_pesos_to_micros() -> None:
    assert parse_cost_micros("18000.5") == 18_000_500_000


def test_parse_cost_micros_rejects_negative() -> None:
    with pytest.raises(AppError):
        parse_cost_micros("-1")


def test_parse_cost_micros_rejects_float() -> None:
    with pytest.raises(AppError):
        parse_cost_micros(18000.5)  # type: ignore[arg-type]


def test_parse_cost_micros_rejects_more_than_six_decimals() -> None:
    with pytest.raises(AppError):
        parse_cost_micros("1.0000001")


def test_format_cost_micros_round_trips_parse_cost_micros() -> None:
    rng = random.Random(20260915)
    for _ in range(500):
        raw = rng.randint(0, 50_000_000_000)
        text = format_cost_micros(raw)
        assert parse_cost_micros(text) == raw


def test_format_cost_micros_examples() -> None:
    assert format_cost_micros(18_000_500_000) == "18000.5"
    assert format_cost_micros(3_000_000) == "3"
    assert format_cost_micros(0) == "0"


# ---------------------------------------------------------------------------
# Contrato de PUBLICACIÓN de costo (raíz de B-2 / conflict-002-b2): un campo
# de costo por unidad base tiene que salir por `format_cost_micros` -- texto
# decimal, precisión completa -- nunca por `micros_to_pesos` (que es sólo
# para totales de plata de venta ya cerrados) ni como `int` crudo. Un campo
# `int | None` ahí es, sin ambigüedad, o pesos redondeados (el cero mudo que
# SPEC-NEGOCIO §4.1 prohíbe: la sal de mesa del seed cuesta $0,003/g y
# redondear eso a pesos da $0) o micros sin escalar filtrándose a la
# respuesta -- las dos formas en que se manifestó B-2, porque el contrato
# nunca dejó la regla por escrito. Este test recorre las anotaciones de los
# esquemas PUBLICADOS de los dos dominios de 2a y falla nombrando el campo
# exacto si alguno sale entero. `app.recipes.schemas` se importa protegido
# con `find_spec_safe` (igual que `app/seed.py`) para no acoplar este test a
# que ese dominio, de otro agente, ya exista en el árbol.
# ---------------------------------------------------------------------------


def _assert_cost_field_is_decimal_string(model: type, field: str) -> None:
    annotation = model.model_fields[field].annotation  # type: ignore[attr-defined]
    args = set(typing.get_args(annotation))
    is_str_or_none = annotation is str or args == {str, type(None)}
    assert is_str_or_none, (
        f"{model.__module__}.{model.__qualname__}.{field} está anotado "
        f"{annotation!r}, y tiene que ser `str | None`. Un costo por unidad "
        "base se publica SIEMPRE con `app.core.quantity.format_cost_micros` "
        "(texto decimal, precisión completa) -- nunca con `micros_to_pesos` "
        "(pesos redondeados, sólo para totales de venta ya cerrados) ni como "
        "`int` crudo. Un `int` acá es o el cero mudo que SPEC-NEGOCIO §4.1 "
        "prohíbe (un costo real como $0,003/g redondeado a pesos da $0) o "
        "micros sin escalar filtrándose a la respuesta HTTP: exactamente lo "
        "que causó el conflicto B-2 entre `inventory` y `recipes`."
    )


def test_inventory_cost_fields_are_published_as_decimal_strings() -> None:
    from app.inventory import schemas as inv

    for model, fields in (
        (inv.IngredientOut, ("cost", "official_cost", "estimated_cost")),
        (inv.StockMovementOut, ("cost",)),
        (inv.StockRowOut, ("cost",)),
        (inv.WasteAdminOut, ("cost",)),
    ):
        for field in fields:
            _assert_cost_field_is_decimal_string(model, field)


def test_recipes_cost_fields_are_published_as_decimal_strings() -> None:
    if find_spec_safe("app.recipes.schemas") is None:
        pytest.skip(
            "app.recipes.schemas todavía no existe en este árbol "
            "(territorio de backend-recetas) -- este test no se acopla a su presencia."
        )
    from app.recipes import schemas as rec

    for model, fields in (
        (rec.PreparationAdminOut, ("unit_cost",)),
        (rec.PrepBatchAdminOut, ("total_cost", "unit_cost")),
        (rec.ProductRecipeOut, ("theoretical_cost",)),
    ):
        for field in fields:
            _assert_cost_field_is_decimal_string(model, field)


# ---------------------------------------------------------------------------
# Contrato de PUBLICACIÓN de cantidad (deuda cerrada en 2b, A-5 de
# `outputs-2a/ENTREGA.md § 5`): igual que el bloque de arriba, pero para
# cantidades de insumo. La misma magnitud (`qty_base`/`min_stock`) salía de
# `app.inventory.schemas` como texto decimal y de `app.reports.schemas` como
# `int` en milésimas crudas -- dos escalas para un mismo número, el mismo
# modo de falla de B-2. La forma ganadora, declarada en
# `app.core.quantity` (arriba): `format_qty_base`, texto decimal.
#
# `app.reports.schemas` lo corrige OTRO agente contra esta misma regla (no es
# territorio de este dominio); mientras esa corrección no esté hecha, este
# test es un ROJO DECLARADO -- no lo escondas bajando su severidad ni
# comentándolo: es la prueba de que la deuda sigue abierta, y tiene que
# ponerse en verde sola en cuanto ese agente publique `str`.
# ---------------------------------------------------------------------------


def _assert_qty_field_is_decimal_string(model: type, field: str) -> None:
    annotation = model.model_fields[field].annotation  # type: ignore[attr-defined]
    args = set(typing.get_args(annotation))
    is_str_or_none = annotation is str or args == {str, type(None)}
    assert is_str_or_none, (
        f"{model.__module__}.{model.__qualname__}.{field} está anotado "
        f"{annotation!r}, y tiene que ser `str | None`. Una cantidad de "
        "insumo se publica SIEMPRE con `app.core.quantity.format_qty_base` "
        "(texto decimal) -- nunca como `int` crudo en milésimas. Un `int` "
        "acá es milésimas sin escalar filtrándose a la respuesta HTTP: "
        "`117648` en vez de `\"117.648\"` -- la misma manifestación de B-2, "
        "para cantidades en vez de costos."
    )


def test_inventory_qty_fields_are_published_as_decimal_strings() -> None:
    from app.inventory import schemas as inv

    for model, fields in (
        (inv.IngredientOut, ("min_stock",)),
        (inv.StockMovementOut, ("qty_base",)),
        (inv.StockRowOut, ("qty_base", "min_stock")),
        (inv.WasteOut, ("qty",)),
        (inv.WasteAdminOut, ("qty",)),
        (inv.AdjustmentOut, ("qty_delta",)),
    ):
        for field in fields:
            _assert_qty_field_is_decimal_string(model, field)


def test_reports_qty_fields_are_published_as_decimal_strings() -> None:
    """Rojo declarado hasta que el dueño de `app/reports/schemas.py` corrija
    `IngredientAlertOut`/`NegativeStockAlertOut` contra la misma regla (ver
    docstring del bloque, arriba, y `outputs-2b/backend-inventario-espejo.md
    § 8`). No se usa `find_spec_safe`: `app.reports` existe desde 1b, no es
    un dominio opcional de este pedido."""
    from app.reports import schemas as rep

    for model, fields in (
        (rep.IngredientAlertOut, ("qty_base", "min_stock")),
        (rep.NegativeStockAlertOut, ("qty_base", "min_stock")),
    ):
        for field in fields:
            _assert_qty_field_is_decimal_string(model, field)


def test_openapi_has_no_raw_integer_qty_base_or_min_stock_fields() -> None:
    """Auditoría de contrato sobre el OpenAPI COMPLETO (no sólo los esquemas
    que este módulo conoce por nombre): ningún esquema publicado, de ningún
    dominio montado, describe un campo llamado `qty_base` o `min_stock` como
    `type: integer` en JSON Schema -- tiene que ser `type: string` (o
    `anyOf` con `string`+`null`), la forma de `format_qty_base`. Cubre
    dominios que este archivo no importa por nombre (blindaje a futuro: un
    sexto esquema con el mismo error no necesita que alguien se acuerde de
    agregarlo a la lista de arriba)."""
    from app.main import app

    schema = app.openapi()
    offenders: list[str] = []
    for name, definition in schema.get("components", {}).get("schemas", {}).items():
        properties = definition.get("properties", {})
        for field in ("qty_base", "min_stock"):
            prop = properties.get(field)
            if prop is None:
                continue
            types_seen: set[str] = set()
            if "type" in prop:
                types_seen.add(prop["type"])
            for variant in prop.get("anyOf", []):
                if "type" in variant:
                    types_seen.add(variant["type"])
            if "integer" in types_seen:
                offenders.append(f"{name}.{field}")
    assert offenders == [], (
        "Estos campos publican milésimas crudas como entero en vez de texto "
        f"decimal (`format_qty_base`): {offenders}"
    )
