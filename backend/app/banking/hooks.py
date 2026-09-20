"""Contratos publicados de `banking` hacia otros dominios.

Ningún dominio de esta fase necesita leer `banking` (T2 arrastra las cuentas
por pagar al resultado del período leyendo `app.reports`/`app.purchases`,
nunca el banco; T3 y T4 tampoco lo tocan — ver
`features/fase-3-dinero-control/spec.md § 2`). Este archivo existe vacío a
propósito, para que la anatomía del dominio (`docs/CONTEXTO-AGENTES.md §3`:
`hooks.py` es el único import cruzado permitido) esté completa desde el
día uno: si un futuro pedido necesita leer algo de `banking` (por ejemplo,
si el punto de equilibrio de una fase posterior quisiera incorporar el neto
del datáfono), esto es lo único que otro dominio puede importar de acá —
nunca `app.banking.service` directo.
"""

from __future__ import annotations
