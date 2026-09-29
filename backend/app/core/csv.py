"""`format=csv` en toda lista: mismo aplanado simple para todos los dominios.

**Pensado para Excel en español de Colombia** (pedido del dueño: «toda la
información debe poder ser descargable», y se descarga para abrirla en Excel):

- separador `;` — con la configuración regional es-CO la coma es el separador
  decimal y Excel parte en columnas por `;`;
- `BOM` UTF-8 al inicio — sin él Excel lee «Ã±» donde dice «ñ»;
- encabezados en español (`app.core.csv_headers`): el mapeo propio del
  endpoint primero, el glosario común después;
- los decimales con coma («12,5», no «12.5», que Excel es-CO lee como texto
  o como fecha), `Sí`/`No` en vez de `True`/`False`, y `null` como celda
  **vacía**, nunca `0` (`null` ≠ 0).

Un objeto anidado se aplana en columnas «Padre · Hijo»; una lista de valores
simples va en una celda separada por « | »; una lista de objetos, como JSON en
una sola celda (quien necesita esa lista como tabla tiene su propio CSV).
"""

from __future__ import annotations

import csv
import io
import json
import re
from collections.abc import Iterable, Mapping
from datetime import date, datetime, time
from decimal import Decimal
from enum import Enum
from typing import Annotated, Any, Literal

from fastapi import Query, Request, Response
from pydantic import BaseModel

from app.core.csv_headers import spanish_header

SEPARATOR = ";"
BOM = "﻿"

_DECIMAL_TEXT = re.compile(r"^-?\d+\.\d+$")

#: El parámetro `format` que declara todo endpoint que exporta: así el
#: OpenAPI lo publica (`tests/reports/test_csv_format_contract.py`).
CsvFormat = Annotated[
    Literal["json", "csv"] | None,
    Query(description='"csv" descarga lo mismo como CSV para Excel (`;`, UTF-8 con BOM, encabezados en español)'),
]


def wants_csv(request: Request) -> bool:
    return request.query_params.get("format") == "csv"


def _flatten(value: Any, prefix: str, out: dict[str, Any]) -> None:
    if isinstance(value, BaseModel):
        value = value.model_dump()
    if isinstance(value, Mapping):
        for k, v in value.items():
            _flatten(v, f"{prefix}__{k}" if prefix else str(k), out)
        return
    out[prefix] = value


def flatten_row(row: Mapping[str, Any] | BaseModel) -> dict[str, Any]:
    """Una fila con objetos anidados → una fila plana (`padre__hijo`)."""
    out: dict[str, Any] = {}
    _flatten(row, "", out)
    return out


SECTION_KEY = "Sección"
SUMMARY_SECTION = "Resumen"


def _is_table(value: Any) -> bool:
    return isinstance(value, (list, tuple)) and any(isinstance(i, (Mapping, BaseModel)) for i in value)


def sectioned_rows(report: BaseModel | Mapping[str, Any]) -> list[dict[str, Any]]:
    """Un informe compuesto (cifras sueltas + varias tablas) en UNA tabla
    larga que Excel filtra: la primera columna dice de qué parte sale cada
    fila. Las cifras sueltas van en la fila «Resumen»; cada lista de objetos,
    fila por fila bajo su propio nombre. Nada se calcula acá: es el mismo
    contenido de la respuesta JSON, reordenado."""
    data = report.model_dump() if isinstance(report, BaseModel) else dict(report)
    summary: dict[str, Any] = {SECTION_KEY: SUMMARY_SECTION}
    tables: list[tuple[str, list[Any]]] = []

    def walk(value: Any, prefix: str) -> None:
        if isinstance(value, Mapping):
            for k, v in value.items():
                walk(v, f"{prefix}__{k}" if prefix else str(k))
        elif _is_table(value):
            tables.append((prefix, list(value)))
        else:
            summary[prefix] = value

    walk(data, "")
    rows: list[dict[str, Any]] = [summary] if len(summary) > 1 else []
    for name, items in tables:
        label = spanish_header(name)
        for item in items:
            if isinstance(item, BaseModel):
                item = item.model_dump()
            if isinstance(item, Mapping):
                rows.append({SECTION_KEY: label, **flatten_row(item)})
            else:
                rows.append({SECTION_KEY: label, "value": item})
    return rows


def cell(value: Any) -> str:
    """El texto de una celda, como lo lee Excel en español."""
    if value is None:
        return ""  # null ≠ 0: sin dato es celda vacía, nunca un cero
    if isinstance(value, bool):
        return "Sí" if value else "No"
    if isinstance(value, Enum):
        return cell(value.value)
    if isinstance(value, int):
        return str(value)
    if isinstance(value, (float, Decimal)):
        text = format(value, "f") if isinstance(value, Decimal) else repr(value)
        return text.replace(".", ",")
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, (date, time)):
        return value.isoformat()
    if isinstance(value, str):
        return value.replace(".", ",") if _DECIMAL_TEXT.match(value) else value
    if isinstance(value, BaseModel):
        value = value.model_dump(mode="json")
    if isinstance(value, (list, tuple, set)):
        items = list(value)
        if all(not isinstance(i, (Mapping, BaseModel, list, tuple)) for i in items):
            return " | ".join(cell(i) for i in items)
        return json.dumps(
            [i.model_dump(mode="json") if isinstance(i, BaseModel) else i for i in items],
            ensure_ascii=False,
            default=str,
        )
    if isinstance(value, Mapping):
        return json.dumps(value, ensure_ascii=False, default=str)
    return str(value)


def csv_text(
    rows: Iterable[Mapping[str, Any] | BaseModel],
    headers: Mapping[str, str] | None = None,
) -> str:
    """El cuerpo del CSV (con BOM). `headers` es el mapeo propio del
    endpoint: nombra en español lo que ahí se llama distinto y, si no llega
    ninguna fila, alcanza para escribir el encabezado."""
    flat = [flatten_row(r) for r in rows]
    keys: list[str] = []
    seen: set[str] = set()
    for row in flat:
        for k in row:
            if k not in seen:
                seen.add(k)
                keys.append(k)
    if not keys and headers:
        keys = list(headers.keys())
    own = dict(headers or {})
    buffer = io.StringIO()
    writer = csv.writer(buffer, delimiter=SEPARATOR, lineterminator="\r\n")
    if keys:
        writer.writerow([own.get(k) or spanish_header(k) for k in keys])
        for row in flat:
            writer.writerow([cell(row.get(k)) for k in keys])
    return BOM + buffer.getvalue()


def csv_response(
    rows: Iterable[Mapping[str, Any] | BaseModel],
    filename: str,
    headers: Mapping[str, str] | None = None,
) -> Response:
    return Response(
        content=csv_text(rows, headers).encode("utf-8"),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
