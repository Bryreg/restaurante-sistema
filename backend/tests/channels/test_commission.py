"""La comisión se REGISTRA, no se resta — y se calcula con enteros.

Renglón del checklist de 2c: «La comisión de la plataforma se registra por
pedido y por plataforma, y **no se resta de la venta**: la venta es la
venta, la comisión es un costo». Y «Sin `float` en comisiones ni en precios
por canal».
"""

from __future__ import annotations

import ast
import inspect

from app.channels import models as channels_models
from app.channels import service as channels_service
from app.channels.service import compute_commission


def test_the_contract_example_one_hundred_thousand_at_eighteen_percent() -> None:
    """El ejemplo textual del pedido: venta de $100.000 con 18 % →
    comisión $18.000, y la venta **sigue siendo** $100.000."""
    sale = 100_000
    commission = compute_commission(sale, 1_800)
    assert commission == 18_000
    # La venta no se toca: `compute_commission` no devuelve un neto ni
    # modifica nada. Es una función pura sobre un entero.
    assert sale == 100_000


def test_basis_points_are_integers_and_the_math_is_integer_all_the_way() -> None:
    assert compute_commission(0, 1_800) == 0
    assert compute_commission(100_000, 0) == 0
    assert compute_commission(1, 10_000) == 1  # 100 %
    assert compute_commission(33_333, 1_250) == 4_167  # 4166,625 → half-up
    for base in (1, 7, 999, 123_456, 9_999_999):
        for bp in (0, 1, 250, 1_800, 10_000):
            value = compute_commission(base, bp)
            assert isinstance(value, int)
            assert not isinstance(value, float)


def test_rounding_is_half_up_and_declared() -> None:
    """El redondeo está **declarado** (half-up, como toda la plata del repo)
    y probado en el borde exacto, que es donde un `//` mudo se separaría de
    lo que dice el docstring."""
    # 10.000 × 5 bp = 50.000 / 10.000 = 5 exacto.
    assert compute_commission(10_000, 5) == 5
    # 1 × 5.000 bp = 5.000 / 10.000 = 0,5 → half-up → 1 (un `//` daría 0).
    assert compute_commission(1, 5_000) == 1
    # 1 × 4.999 bp = 0,4999 → 0.
    assert compute_commission(1, 4_999) == 0
    # 3 × 5.000 bp = 1,5 → 2.
    assert compute_commission(3, 5_000) == 2


def test_no_float_appears_in_the_money_columns_of_the_domain() -> None:
    """Regla dura: dinero y comisiones en enteros, prohibido `float`.

    Se lee el MODELO, no una lista a mano: la columna número nueve que
    agregue fase 3 cae sola si alguien la declara `Float`/`Numeric`.
    """
    offenders: list[str] = []
    for name, obj in vars(channels_models).items():
        table = getattr(obj, "__table__", None)
        if table is None or not name[0].isupper():
            continue
        for column in table.columns:
            type_name = type(column.type).__name__
            if type_name in ("Float", "Numeric", "REAL", "DOUBLE_PRECISION"):
                offenders.append(f"{table.name}.{column.name}: {type_name}")
    assert not offenders, f"columnas de plata en coma flotante: {offenders}"


def test_the_only_commission_math_lives_in_one_function() -> None:
    """Una sola matemática: nadie más multiplica por `commission_bp`.

    Si aparece un segundo lugar que haga la cuenta, este test lo nombra —
    es el mismo patrón barato que 2b usó para los espejos que se rompían.
    """
    # Se lee el AST, no el texto: un comentario que NOMBRA la fórmula no es
    # una segunda implementación, y un test que confunde prosa con código
    # enseña a ignorarlo (la lección del `400` esperado que ensucia la
    # consola, `docs/ESTADO.md` punto 21).
    tree = ast.parse(inspect.getsource(channels_service))
    multiplications: list[str] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.BinOp) or not isinstance(node.op, ast.Mult):
            continue
        names = {
            n.id if isinstance(n, ast.Name) else n.attr
            for n in ast.walk(node)
            if isinstance(n, (ast.Name, ast.Attribute))
        }
        if "commission_bp" in names:
            multiplications.append(ast.unparse(node))

    assert len(multiplications) == 1, (
        f"más de un lugar del backend multiplica por `commission_bp`: {multiplications}. "
        "La comisión tiene una sola matemática (`compute_commission`)"
    )
    assert multiplications[0] == "base_amount * commission_bp"
