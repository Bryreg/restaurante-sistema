"""Tabla de tarifas de impuesto colombianas, centralizada (`docs/SPEC-NEGOCIO.md
§8.2`).

Hasta 1b-1 vivía duplicada como `TAX_RATE_BY_CODE` declarada localmente en
`app.orders.service` (gap declarado en
`features/fase-1b-venta/outputs-1b-1/backend-comanda.md § 8`: "si el pedido
1b-2 agrega más tasas o un método más flexible, convendría centralizarlo").
1b-2 la centraliza acá porque notas y facturas (`app.fiscal`) necesitan la
MISMA tabla que la comanda para no revalorar nada con un número distinto:
dos copias de la tasa por código es exactamente el bug que este módulo
previene. `app.orders.service` importa `TAX_RATE_BY_CODE`/`rate_for_code` de
acá; no vuelve a declarar la tabla.

El código de impuesto (`tax_code`) es el que ya declara `app.catalog.models`
(`TAX_CODE_VALUES = ("inc_8", "iva_19", "excluded")`, territorio ajeno, sólo
lectura): este módulo no depende de `app.catalog` para no crear un ciclo
entre dominios, sólo documenta el mismo vocabulario.
"""

from __future__ import annotations

# Tasa entera (por ciento, sin decimales: la matemática de la venta en
# `app.orders.money` trabaja siempre en enteros) por código de impuesto de
# la carta. INC 8% sobre el consumo de un restaurante no franquiciado; IVA
# 19% si es franquicia (art. 426 ET); "excluded" (p. ej. un cargo que no
# causa impuesto) siempre 0.
TAX_RATE_BY_CODE: dict[str, int] = {
    "inc_8": 8,
    "iva_19": 19,
    "excluded": 0,
}


def rate_for_code(code: str) -> int:
    """Tasa entera (%) para un `tax_code` de la carta. Un código que no está
    en la tabla se trata como excluido (`0`), igual que el `.get(code, 0)`
    que ya usaba `app.orders.service` antes de centralizarse acá — ningún
    código nuevo de impuesto puede tumbar el cálculo de la venta con un
    `KeyError`."""
    return TAX_RATE_BY_CODE.get(code, 0)
