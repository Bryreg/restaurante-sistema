"""La única matemática de la venta (`CONTRATO-INTERNO-1b-1.md §2.3`).

Sin float, sin librerías externas: todo en enteros de pesos con redondeo
half-up. `backend-cobro` y el auditor llaman `compute_totals` (vía
`app.orders.service.compute_order_totals` / `compute_sub_account_totals`) en
vez de reimplementar nada de esto — es la regla "una sola matemática, en el
backend" (`AGENTS.md`, `docs/SPEC-NEGOCIO.md §11.13`).

Invariantes que el auditor prueba sobre 1.000 comandas aleatorias (semilla
fija, `tests/audit/`):
    Σ lines.net == total
    Σ prorrateo de descuento de comanda == descuento de comanda aplicado
    Σ tax_lines.tax == tax_total
"""

from __future__ import annotations

from dataclasses import dataclass, field


def round_half_up(numerator: int, denominator: int) -> int:
    """Entero, redondeo half-up, sin float. `numerator` y `denominator`
    no negativos (plata siempre >= 0); `denominator` > 0."""
    if denominator <= 0:
        raise ValueError("denominator debe ser positivo")
    if numerator < 0:
        raise ValueError("numerator no puede ser negativo")
    quotient, remainder = divmod(numerator, denominator)
    if remainder * 2 >= denominator:
        quotient += 1
    return quotient


def prorate(amount: int, weights: list[int]) -> list[int]:
    """Reparte `amount` (pesos) entre `weights` en proporción a cada peso.

    Σ del resultado == `amount`; el residuo del redondeo (por truncar hacia
    abajo cada parte) va entero al peso más grande (el primero, si hay
    empate); los pesos en `0` siempre reciben `0`.
    """
    if not weights:
        return []
    total_weight = sum(weights)
    if total_weight <= 0:
        return [0] * len(weights)

    shares = [amount * w // total_weight for w in weights]
    residual = amount - sum(shares)
    if residual:
        # `max(..., key=...)` conserva el primer índice en caso de empate:
        # es "el peso mayor (primer máximo)" del contrato.
        max_index = max(range(len(weights)), key=lambda i: weights[i])
        shares[max_index] += residual
    return shares


@dataclass(frozen=True)
class LineInput:
    item_id: int
    gross: int
    tax_rate: int
    item_discount: int
    is_combo: bool
    price_includes_tax: bool


@dataclass(frozen=True)
class LineTotals:
    item_id: int
    gross: int
    discount: int
    net: int
    base: int
    tax: int
    tax_rate: int


@dataclass(frozen=True)
class TaxLine:
    rate: int
    base: int
    tax: int


@dataclass(frozen=True)
class OrderTotals:
    subtotal: int
    discount_total: int
    total: int
    tax_total: int
    tip_base: int
    tax_lines: list[TaxLine] = field(default_factory=list)
    lines: list[LineTotals] = field(default_factory=list)


def compute_totals(
    lines: list[LineInput], order_discounts: list[tuple[str, int]]
) -> OrderTotals:
    """Algoritmo literal de `CONTRATO-INTERNO-1b-1.md §2.3`.

    `lines` ya trae el `gross` resuelto por el llamador (`unit_price * qty`;
    una cortesía o un ítem con `unit_price=0` llega con `gross=0` y por lo
    tanto no aporta nada — un ítem anulado simplemente no se incluye en la
    lista). `item_discount` nunca supera `gross` (lo valida el router antes
    de llegar acá: `DISCOUNT_EXCEEDS_LINE`).
    """
    subtotal = sum(line.gross for line in lines)
    sum_item_discount = sum(line.item_discount for line in lines)

    # Cada descuento de comanda se calcula sobre lo que queda después de los
    # descuentos de línea y de los descuentos de comanda anteriores.
    remaining_base = subtotal - sum_item_discount
    order_discount_total = 0
    for kind, value in order_discounts:
        if kind == "percent":
            amt = round_half_up(remaining_base * value, 100)
        else:  # "amount"
            amt = value
        amt = min(amt, remaining_base)
        order_discount_total += amt
        remaining_base -= amt

    # El total de descuentos de comanda se prorratea por (gross - item_discount).
    weights = [max(line.gross - line.item_discount, 0) for line in lines]
    order_shares = prorate(order_discount_total, weights)

    line_totals: list[LineTotals] = []
    tax_buckets: dict[int, list[int]] = {}
    total_net = 0
    total_tax = 0

    for line, order_share in zip(lines, order_shares):
        discount = line.item_discount + order_share
        net = line.gross - discount

        if line.price_includes_tax:
            base = round_half_up(net * 100, 100 + line.tax_rate)
            tax = net - base
        else:
            base = net
            tax = round_half_up(base * line.tax_rate, 100)
            net = base + tax  # el total de la línea pasa a ser base + tax

        line_totals.append(
            LineTotals(
                item_id=line.item_id,
                gross=line.gross,
                discount=discount,
                net=net,
                base=base,
                tax=tax,
                tax_rate=line.tax_rate,
            )
        )
        total_net += net
        total_tax += tax
        bucket = tax_buckets.setdefault(line.tax_rate, [0, 0])
        bucket[0] += base
        bucket[1] += tax

    tax_lines = [TaxLine(rate=rate, base=b, tax=t) for rate, (b, t) in sorted(tax_buckets.items())]
    discount_total = sum(lt.discount for lt in line_totals)
    total = total_net
    tax_total = total_tax
    tip_base = total - tax_total

    return OrderTotals(
        subtotal=subtotal,
        discount_total=discount_total,
        total=total,
        tax_total=tax_total,
        tip_base=tip_base,
        tax_lines=tax_lines,
        lines=line_totals,
    )
