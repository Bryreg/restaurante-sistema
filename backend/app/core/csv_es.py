"""CSV para abrir en Excel en español: separador `;`, BOM UTF-8 y encabezados
en español, con el orden de columnas que decide quien llama.

`app.core.csv.csv_response` sigue siendo el aplanado genérico de toda lista
(`,`, encabezados = llaves del JSON). Esto es para las descargas que el dueño
abre en una hoja de cálculo con configuración regional de Colombia, donde la
coma es el separador decimal: con `,` todo cae en una sola columna, y sin BOM
las tildes salen rotas.
"""

from __future__ import annotations

import csv
import io
from collections.abc import Sequence
from typing import Any

from fastapi import Response

BOM = "﻿"


def csv_es_response(
    rows: Sequence[dict[str, Any]], *, columns: Sequence[tuple[str, str]], filename: str
) -> Response:
    """`columns` = `[(llave, encabezado en español), …]`: el orden de la
    hoja. Un `None` se escribe como celda vacía (nunca «0»: `null` no es 0).
    Sin filas, igual sale la fila de encabezados."""
    buffer = io.StringIO()
    writer = csv.writer(buffer, delimiter=";", lineterminator="\r\n")
    writer.writerow([header for _key, header in columns])
    for row in rows:
        writer.writerow(["" if row.get(key) is None else row.get(key) for key, _header in columns])
    return Response(
        content=BOM + buffer.getvalue(),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
