"""Unidad de `app.orders.money`: la única matemática de la venta
(`CONTRATO-INTERNO-1b-1.md §2.3`). Sin base de datos: son funciones puras.
"""

from __future__ import annotations

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
