"""Porcentajes escritos como los lee el dueño: español de Colombia.

Los porcentajes del sistema viajan en PUNTOS BÁSICOS enteros (`*_bp`: 1.234
bp = 12,34 %) y nunca en `float`. Cuando el backend arma un texto que va a
mostrarse tal cual —el cuerpo de un aviso de «Requiere tu atención», un motivo
de `null`— el número tiene que salir con coma decimal y el espacio fino antes
del signo (U+202F, el mismo `ESPACIO_FINO` de
`frontend/src/lib/format.ts`), igual que `formatPct` del frontend: «12,3 %», nunca «12.34 %»
(formato inglés, el defecto que encontró la revisión de datos de septiembre
en un texto de inventario).

Hermana de `app.core.money.format_cop`: sólo para MOSTRAR. Ningún cálculo lee
de vuelta este texto.
"""

from __future__ import annotations

from decimal import ROUND_HALF_UP, Decimal


def format_pct_bp(bp: int, *, decimals: int = 1) -> str:
    """Puntos básicos -> «12,3 %». `decimals` es cuántos decimales se
    muestran (0 a 2; los bp no tienen más precisión que eso). El negativo
    conserva el signo adelante («-4,5 %»), y el redondeo es half-up, el
    mismo criterio que `app.orders.money.round_half_up`."""
    if not 0 <= decimals <= 2:
        raise ValueError("decimals: entre 0 y 2")
    quant = Decimal(1).scaleb(-decimals)
    value = (Decimal(bp) / Decimal(100)).quantize(quant, rounding=ROUND_HALF_UP)
    signo = "-" if value < 0 else ""
    entero, _, fraccion = f"{abs(value):f}".partition(".")
    entero = f"{int(entero):,}".replace(",", ".")
    texto = f"{entero},{fraccion}" if fraccion else entero
    return f"{signo}{texto}\u202f%"
