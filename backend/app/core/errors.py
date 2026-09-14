"""Una sola forma de error en toda la API: `{"error": {"code", "message", ...}}`.

Ninguna regla de negocio responde `500`. `AppError` (y sus subclases) son la
única manera de cortar un endpoint con un error de negocio; el mensaje siempre
nombra la acción correctiva (AGENTS.md, SPEC-NEGOCIO §11.18).
"""

from __future__ import annotations

import logging
from collections.abc import Sequence
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

logger = logging.getLogger("app.errors")


class AppError(Exception):
    """Error de negocio. `status` es el código HTTP; `code` es estable y lo
    consume el frontend para decidir qué hacer (no el `message`, que es para
    mostrarlo)."""

    def __init__(
        self,
        code: str,
        message: str,
        status: int = 400,
        extra: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status
        self.extra = extra or {}

    def body(self) -> dict[str, Any]:
        payload: dict[str, Any] = {"code": self.code, "message": self.message}
        payload.update(self.extra)
        return {"error": payload}


class NotFoundError(AppError):
    def __init__(
        self,
        message: str = "No encontrado",
        *,
        code: str = "NOT_FOUND",
        extra: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(code=code, message=message, status=404, extra=extra)


class ConflictError(AppError):
    def __init__(
        self,
        message: str,
        *,
        code: str = "CONFLICT",
        extra: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(code=code, message=message, status=409, extra=extra)


class UnauthorizedError(AppError):
    def __init__(
        self,
        message: str,
        *,
        code: str = "NOT_AUTHENTICATED",
        extra: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(code=code, message=message, status=401, extra=extra)


class ForbiddenError(AppError):
    def __init__(
        self,
        message: str = "No autorizado",
        *,
        code: str = "FORBIDDEN",
        extra: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(code=code, message=message, status=403, extra=extra)


def _format_validation_message(errors: Sequence[Any]) -> str:
    if not errors:
        return "Datos inválidos"
    first = errors[0]
    loc = [str(p) for p in first.get("loc", []) if p not in ("body", "query", "path")]
    field = ".".join(loc) if loc else "campo"
    problem = str(first.get("msg", "dato inválido"))
    return f"{field}: {problem}"


def register_error_handlers(app: FastAPI) -> None:
    """Registra los handlers de error. Se llama una sola vez, desde `create_app()`."""

    @app.exception_handler(AppError)
    async def _app_error_handler(request: Request, exc: AppError) -> JSONResponse:
        return JSONResponse(status_code=exc.status, content=exc.body())

    @app.exception_handler(RequestValidationError)
    async def _validation_error_handler(
        request: Request, exc: RequestValidationError
    ) -> JSONResponse:
        message = _format_validation_message(exc.errors())
        return JSONResponse(
            status_code=400,
            content={"error": {"code": "VALIDATION_ERROR", "message": message}},
        )

    @app.exception_handler(StarletteHTTPException)
    async def _http_exception_handler(
        request: Request, exc: StarletteHTTPException
    ) -> JSONResponse:
        detail = exc.detail if isinstance(exc.detail, str) else "Error"
        code = "NOT_FOUND" if exc.status_code == 404 else "HTTP_ERROR"
        return JSONResponse(
            status_code=exc.status_code,
            content={"error": {"code": code, "message": detail}},
        )

    @app.exception_handler(Exception)
    async def _unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
        logger.exception("Error interno no controlado en %s", request.url.path)
        return JSONResponse(
            status_code=500,
            content={"error": {"code": "INTERNAL_ERROR", "message": "Error interno"}},
        )
