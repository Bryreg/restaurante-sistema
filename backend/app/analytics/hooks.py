"""Contrato publicado de `analytics` para otros dominios.

Ningún dominio de esta fase (ni de las anteriores) necesita leer nada de
`app.analytics` todavía — este territorio es una hoja: **lee** de `orders`,
`inventory` (vía `app.inventory.hooks`) y modelos de sólo lectura de otros
dominios, y no publica nada que otro dominio consuma. Este archivo existe
igual, vacío salvo este docstring, por dos motivos: (1) `docs/CONTEXTO-
AGENTES.md §3` fija que TODO dominio tiene su `hooks.py` como el único punto
de import cruzado, así que si algún pedido futuro necesita leer algo de acá
(por ejemplo, la clasificación de ingeniería de menú para alimentar otro
reporte) ya tiene dónde publicarlo sin reorganizar nada; (2) mantiene la
anatomía de dominio uniforme para que el Conciliador no tenga que hacer una
excepción al cruzar este territorio contra el patrón del resto del repo.
"""

from __future__ import annotations
