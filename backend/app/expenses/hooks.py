"""Lo único que otros dominios pueden importar de `expenses`.

Ningún otro territorio de esta fase declaró consumir algo de acá (T1
`banking` arma la mano del dueño sólo con `CashPickup`; T4 `analytics` no
menciona `expenses` en su contrato). El archivo existe igual, por la
anatomía de dominio del proyecto (`docs/CONTEXTO-AGENTES.md §3`), y queda
vacío a propósito: **si otro dominio necesita algo de acá, se publica una
función nueva en este archivo, nunca se importa `service.py` ni `models.py`
directo desde afuera.**
"""

from __future__ import annotations
