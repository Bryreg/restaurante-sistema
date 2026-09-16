"""Reimplementación fiel de `app.core.quantity` (contrato dado por la
misión), usada SOLO cuando ese módulo todavía no existe en el árbol —
`conftest.py` la inyecta en `sys.modules` antes de importar `app.recipes.*`.
En cuanto `backend-inventario`/el dueño de `app/core` publique el módulo
real, este archivo deja de activarse solo (ver `conftest.py`): nunca hay que
tocar `app/recipes/**` para converger.
"""

from __future__ import annotations

QTY_SCALE = 1000
COST_SCALE = 1_000_000


def apply_yield(qty_base: int, yield_pct: int) -> int:
    if not 1 <= yield_pct <= 100:
        raise ValueError("yield_pct debe estar entre 1 y 100")
    return -(-qty_base * 100 // yield_pct)


def micros_to_pesos(micros: int) -> int:
    sign = 1 if micros >= 0 else -1
    magnitude = abs(micros)
    quotient, remainder = divmod(magnitude, COST_SCALE)
    if remainder * 2 >= COST_SCALE:
        quotient += 1
    return sign * quotient


def format_cost_micros(micros: int) -> str:
    sign = "-" if micros < 0 else ""
    whole, frac = divmod(abs(micros), COST_SCALE)
    frac_str = f"{frac:06d}".rstrip("0")
    return f"{sign}{whole}.{frac_str}" if frac_str else f"{sign}{whole}"
