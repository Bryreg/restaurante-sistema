"""`format=csv` en toda lista: mismo aplanado simple para todos los dominios."""

from __future__ import annotations

import csv
import io
from typing import Any

from fastapi import Request, Response


def wants_csv(request: Request) -> bool:
    return request.query_params.get("format") == "csv"


def csv_response(rows: list[dict[str, Any]], filename: str) -> Response:
    buffer = io.StringIO()
    if rows:
        fieldnames = list(rows[0].keys())
        writer = csv.DictWriter(buffer, fieldnames=fieldnames, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)
    return Response(
        content=buffer.getvalue(),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
