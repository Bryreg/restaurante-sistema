"""Dinero en enteros de pesos colombianos. Nada de `float` en ninguna capa.

Denominaciones reales de Colombia (monedas de 50 a 1.000, billetes de 2.000 a
100.000). Toda apertura, cierre, relevo y retiro de caja guarda su desglose y
lo valida acá: una sola función, para que "el conteo no cuadra" sea siempre el
mismo error.
"""

from __future__ import annotations

from dataclasses import dataclass

from app.core.errors import AppError

DENOMINATIONS: list[int] = [50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000, 100000]


@dataclass(frozen=True)
class Denomination:
    value: int
    count: int


def sum_denominations(denominations: list[Denomination]) -> int:
    return sum(d.value * d.count for d in denominations)


def validate_denominations(denominations: list[Denomination], total: int) -> int:
    """Valida un desglose por denominaciones contra el total declarado.

    Levanta `AppError` (`DENOMINATION_INVALID` si una denominación no existe o
    trae una cantidad negativa; `DENOMINATIONS_MISMATCH` si la suma no cuadra
    con `total`) o devuelve `total` si todo es válido.
    """
    for item in denominations:
        if item.value not in DENOMINATIONS:
            raise AppError(
                code="DENOMINATION_INVALID",
                message=f"${item.value} no es una denominación válida; usá monedas o billetes reales",
            )
        if item.count < 0:
            raise AppError(
                code="DENOMINATION_INVALID",
                message="La cantidad de billetes o monedas no puede ser negativa",
            )
    computed = sum_denominations(denominations)
    if computed != total:
        raise AppError(
            code="DENOMINATIONS_MISMATCH",
            message=(
                f"El desglose suma ${computed} pero el total declarado es ${total}; "
                "revisá el conteo por denominación"
            ),
        )
    return total


def format_cop(value: int) -> str:
    """Un entero de pesos, escrito como lo escribe la app: ``$ 134.500``.

    Espeja `formatCOP` de `frontend/src/lib/money.ts`. Existe porque los
    cuerpos de las notificaciones se arman acá y se muestran tal cual —el
    riel «Requiere tu atención» de Hoy los dibuja sin tocarlos—, así que un
    ``f"${n}"`` suelto llega al dueño como ``$134500`` mientras la tarjeta de
    al lado dice ``$ 134.500``. El negativo conserva el signo adelante
    (``-$ 3.000``), igual que el formateador del navegador.
    """
    signo = "-" if value < 0 else ""
    return f"{signo}$ {abs(value):,}".replace(",", ".")
