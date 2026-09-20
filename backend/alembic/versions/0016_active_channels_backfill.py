"""Marca `delivery` y `platform` como canales activos en las sedes que ya existen.

`create_order` ahora gatea los cinco canales de venta contra
`stores.active_channels`, no sólo los tres de 1b. Sin este respaldo, toda sede
creada antes de 2c quedaría sin poder vender por domicilio ni por plataforma el
día del despliegue: su `active_channels` es `["counter", "dine_in", "takeout"]`
—el default del alta— y nunca tuvo motivo de incluir los otros dos.

**Por qué se activan en TODAS y no sólo donde la función está encendida.** Antes
de esta migración «activo» no significaba nada para esos dos canales: el único
interruptor era la función. Marcarlos activos en todas es la única posición que
preserva exactamente el comportamiento de hoy — una sede sin la función sigue sin
poder vender por ese canal, porque la función se sigue exigiendo antes. Lo que
cambia es que ahora el administrador PUEDE apagar el canal sin apagar la función.

Resolver aquí qué sedes tienen la función encendida exigiría leer el catálogo de
perfiles, que vive en código y no en la base: una migración que importa
`app.core.features` queda atada al catálogo de hoy y se rompe el día que el
catálogo cambie.

Revision ID: 0016
Revises: 0015
Create Date: 2026-09-20
"""

from __future__ import annotations

import json
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0016"
down_revision: str | None = "0015"
branch_labels: Sequence[str] | None = None
depends_on: Sequence[str] | None = None

NUEVOS = ("delivery", "platform")


def _migrar(agregar: bool) -> None:
    bind = op.get_bind()
    filas = bind.execute(sa.text("SELECT id, active_channels FROM stores")).fetchall()
    for store_id, crudo in filas:
        if crudo is None:
            canales: list[str] = []
        elif isinstance(crudo, str):
            canales = json.loads(crudo)
        else:
            canales = list(crudo)

        if agregar:
            nuevos = canales + [c for c in NUEVOS if c not in canales]
        else:
            nuevos = [c for c in canales if c not in NUEVOS]

        if nuevos != canales:
            bind.execute(
                sa.text("UPDATE stores SET active_channels = :v WHERE id = :id"),
                {"v": json.dumps(nuevos), "id": store_id},
            )


def upgrade() -> None:
    _migrar(agregar=True)


def downgrade() -> None:
    # Simétrico: los saca. Una sede que los tenía apagados a propósito pierde
    # esa decisión, pero sin la guarda de `create_order` el dato no significa
    # nada de todos modos.
    _migrar(agregar=False)
