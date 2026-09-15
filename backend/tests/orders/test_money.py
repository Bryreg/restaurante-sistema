"""Unidad de `app.orders.money`: la única matemática de la venta
(`CONTRATO-INTERNO-1b-1.md §2.3`). Sin base de datos: son funciones puras.
"""

from __future__ import annotations

import random

from app.orders.money import LineInput, TaxLine, compute_totals, prorate, round_half_up


class TestRoundHalfUp:
    def test_half_rounds_up(self) -> None:
        assert round_half_up(5, 2) == 3  # 2.5 -> 3
        assert round_half_up(15, 10) == 2  # 1.5 -> 2
        assert round_half_up(25, 10) == 3  # 2.5 -> 3 (no banker's rounding)

    def test_truncates_below_half(self) -> None:
        assert round_half_up(1, 3) == 0  # 0.333.. -> 0
        assert round_half_up(4, 2) == 2  # exacto

    def test_rounds_up_above_half(self) -> None:
        assert round_half_up(2, 3) == 1  # 0.666.. -> 1

    def test_exact_division_no_float_error(self) -> None:
        assert round_half_up(190000, 100) == 1900


class TestProrate:
    def test_sum_equals_amount(self) -> None:
        shares = prorate(100, [1, 1, 1])
        assert sum(shares) == 100

    def test_residual_goes_to_first_maximum(self) -> None:
        # 100 entre 3 pesos iguales: 33/33/33 con 1 de residuo -> el primero.
        assert prorate(100, [1, 1, 1]) == [34, 33, 33]

    def test_residual_goes_to_largest_weight(self) -> None:
        assert prorate(101, [10, 90]) == [10, 91]

    def test_zero_weight_receives_zero(self) -> None:
        assert prorate(100, [0, 5, 5]) == [0, 50, 50]

    def test_all_zero_weights_returns_zeros(self) -> None:
        assert prorate(0, [0, 0]) == [0, 0]

    def test_empty_weights(self) -> None:
        assert prorate(100, []) == []

    def test_proportional_no_residual(self) -> None:
        assert prorate(10000, [30, 70]) == [3000, 7000]

    # -- A-12 (`features/fase-1b-venta/outputs-1b-1/auditor-venta.md § 3`) --
    # `prorate` no puede asignar a una línea más de lo que esa línea pesa
    # cuando `amount` cabe dentro de la capacidad total (Σ weights): el
    # residuo tiene que repartirse hacia la línea siguiente con saldo, nunca
    # empujar una línea por encima de su propio peso.

    def test_a12_regression_small_weights_never_exceed_their_own_weight(self) -> None:
        # El caso exacto del hallazgo: antes del tope, `prorate(9, [5, 1, 1,
        # 1, 1, 1])` daba `[9, 0, 0, 0, 0, 0]` — la primera línea (peso 5)
        # recibía 9, más de lo que pesa. `net = gross - discount` hubiera
        # quedado negativo y `round_half_up` revienta con un numerador
        # negativo: un 500, no un 400.
        weights = [5, 1, 1, 1, 1, 1]
        shares = prorate(9, weights)
        assert sum(shares) == 9
        for share, weight in zip(shares, weights):
            assert share <= weight, f"{share} > {weight}"

    def test_a12_ties_can_overflow_the_single_largest_line(self) -> None:
        # Con pesos empatados, ni siquiera hace falta un caso extremo: un
        # descuento de $8 sobre tres líneas de $3 cada una (Σ = 9) ya
        # empujaba la primera línea (peso 3) a 4 con el algoritmo viejo.
        weights = [3, 3, 3]
        shares = prorate(8, weights)
        assert sum(shares) == 8
        for share, weight in zip(shares, weights):
            assert share <= weight

    def test_a12_property_amount_within_capacity_never_exceeds_any_weight(self) -> None:
        """Test de propiedad (A-12): sobre 2.000 combinaciones aleatorias de
        `amount`/`weights` donde `amount <= Σ weights` (la situación real de
        un descuento de comanda, donde cada peso es el bruto restante de su
        línea, en la MISMA unidad que `amount`) — el tope `min(share,
        weight)` se respeta línea por línea y, pese al tope, el reparto
        sigue sumando exacto y un peso en `0` sigue recibiendo `0`."""
        rng = random.Random(20260915)
        for _ in range(2000):
            n = rng.randint(1, 8)
            weights = [rng.randint(0, 50) for _ in range(n)]
            total_weight = sum(weights)
            if total_weight == 0:
                amount = 0
            else:
                # Deliberadamente en o por debajo de la capacidad total: es
                # el caso que A-12 tenía que arreglar (`saldo total menor
                # que la cantidad de líneas` cae naturalmente acá con pesos
                # chicos).
                amount = rng.randint(0, total_weight)
            shares = prorate(amount, weights)

            assert sum(shares) == amount, f"perdió pesos: {amount} entre {weights} -> {shares}"
            for weight, share in zip(weights, shares):
                assert share <= weight, f"{share} > peso {weight} (amount={amount}, weights={weights})"
                assert share >= 0
                if weight == 0:
                    assert share == 0

    def test_a12_property_amount_over_capacity_keeps_the_legacy_shape(self) -> None:
        """Cuando `amount` excede la capacidad total (el otro uso de
        `prorate`: repartir plata entre *porciones* de un ítem compartido,
        donde `weights` son cantidades chicas de porciones que NO están en
        la misma unidad que `amount`) el tope no aplica — sigue sin perder
        un peso, que es el único invariante que ese llamador necesita."""
        rng = random.Random(20260915 + 1)
        for _ in range(500):
            n = rng.randint(1, 6)
            weights = [rng.randint(0, 5) for _ in range(n)]
            total_weight = sum(weights)
            if total_weight == 0:
                continue
            amount = rng.randint(total_weight + 1, total_weight * 10_000)
            shares = prorate(amount, weights)
            assert sum(shares) == amount
            for weight, share in zip(weights, shares):
                if weight == 0:
                    assert share == 0


class TestComputeTotals:
    def test_tax_inclusive_8pct(self) -> None:
        # INC 8% incluido en el precio (régimen general, SPEC-NEGOCIO §8.1).
        line = LineInput(item_id=1, gross=10000, tax_rate=8, item_discount=0, is_combo=False, price_includes_tax=True)
        totals = compute_totals([line], [])
        assert totals.lines[0].base == 9259
        assert totals.lines[0].tax == 741
        assert totals.lines[0].net == 10000
        assert totals.subtotal == 10000
        assert totals.total == 10000
        assert totals.tax_total == 741
        assert totals.discount_total == 0
        assert totals.tip_base == 10000 - 741
        assert totals.tax_lines == [TaxLine(rate=8, base=9259, tax=741)]

    def test_tax_exclusive_19pct(self) -> None:
        # IVA 19% (franquicia), precio NO incluye impuesto: se suma encima.
        line = LineInput(item_id=1, gross=10000, tax_rate=19, item_discount=0, is_combo=False, price_includes_tax=False)
        totals = compute_totals([line], [])
        assert totals.lines[0].base == 10000
        assert totals.lines[0].tax == 1900
        assert totals.lines[0].net == 11900  # net pasa a ser base + tax
        assert totals.subtotal == 10000
        assert totals.total == 11900
        assert totals.tax_total == 1900
        assert totals.tip_base == 10000

    def test_courtesy_line_is_zero(self) -> None:
        line = LineInput(item_id=1, gross=0, tax_rate=8, item_discount=0, is_combo=False, price_includes_tax=True)
        totals = compute_totals([line], [])
        assert totals.lines[0].gross == 0
        assert totals.lines[0].discount == 0
        assert totals.lines[0].net == 0
        assert totals.lines[0].base == 0
        assert totals.lines[0].tax == 0
        assert totals.total == 0

    def test_order_discount_prorated_by_gross(self) -> None:
        lines = [
            LineInput(item_id=1, gross=10000, tax_rate=8, item_discount=0, is_combo=False, price_includes_tax=True),
            LineInput(item_id=2, gross=30000, tax_rate=8, item_discount=0, is_combo=False, price_includes_tax=True),
        ]
        totals = compute_totals(lines, [("percent", 10)])

        line1 = next(lt for lt in totals.lines if lt.item_id == 1)
        line2 = next(lt for lt in totals.lines if lt.item_id == 2)
        assert line1.discount == 1000
        assert line2.discount == 3000
        assert totals.discount_total == 4000
        # Σ lines.net == total
        assert line1.net + line2.net == totals.total == 36000
        # Σ tax_lines.tax == tax_total
        assert sum(t.tax for t in totals.tax_lines) == totals.tax_total
        assert totals.tax_total == 2667
        assert totals.subtotal == 40000

    def test_item_discount_never_exceeds_gross_plus_order_discount_capped(self) -> None:
        # Un ítem ya con descuento de línea que agota el bruto: el descuento
        # de comanda que le toque en el prorrateo es 0 (peso 0).
        lines = [
            LineInput(item_id=1, gross=5000, tax_rate=0, item_discount=5000, is_combo=False, price_includes_tax=True),
            LineInput(item_id=2, gross=5000, tax_rate=0, item_discount=0, is_combo=False, price_includes_tax=True),
        ]
        totals = compute_totals(lines, [("amount", 1000)])
        line1 = next(lt for lt in totals.lines if lt.item_id == 1)
        line2 = next(lt for lt in totals.lines if lt.item_id == 2)
        assert line1.discount == 5000  # sin cambios: su peso era 0
        assert line1.net == 0
        assert line2.discount == 1000
        assert line2.net == 4000

    def test_order_discount_amount_kind(self) -> None:
        lines = [LineInput(item_id=1, gross=10000, tax_rate=0, item_discount=0, is_combo=False, price_includes_tax=True)]
        totals = compute_totals(lines, [("amount", 2500)])
        assert totals.discount_total == 2500
        assert totals.total == 7500

    def test_order_discount_capped_at_remaining_base(self) -> None:
        lines = [LineInput(item_id=1, gross=1000, tax_rate=0, item_discount=0, is_combo=False, price_includes_tax=True)]
        totals = compute_totals(lines, [("amount", 5000)])
        assert totals.discount_total == 1000  # nunca negativo
        assert totals.total == 0

    def test_multiple_tax_rates_grouped(self) -> None:
        lines = [
            LineInput(item_id=1, gross=10000, tax_rate=8, item_discount=0, is_combo=False, price_includes_tax=True),
            LineInput(item_id=2, gross=20000, tax_rate=19, item_discount=0, is_combo=False, price_includes_tax=False),
        ]
        totals = compute_totals(lines, [])
        rates = {t.rate for t in totals.tax_lines}
        assert rates == {8, 19}
        assert sum(t.tax for t in totals.tax_lines) == totals.tax_total
