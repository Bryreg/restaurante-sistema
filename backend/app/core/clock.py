"""Reloj único del sistema.

Prohibido `datetime.now()` / `datetime.utcnow()` en cualquier otro módulo: todo
el código usa `clock.now_utc()`. Los tests fijan el reloj con `set_clock` para
simular el paso del tiempo (bloqueo de PIN, expiración de persona activa, etc.).
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import datetime, timezone

_override: Callable[[], datetime] | None = None


def now_utc() -> datetime:
    """Instante actual, aware, en UTC."""
    if _override is not None:
        return _override()
    return datetime.now(timezone.utc)


def set_clock(fn: Callable[[], datetime] | None) -> None:
    """Reemplaza (o restaura, con `None`) la fuente de tiempo. Solo para tests."""
    global _override
    _override = fn
