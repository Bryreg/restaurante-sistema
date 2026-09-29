"""Hash de secretos (PIN y contraseña), tokens de sesión y cookies.

Nada de sesión ni token vive en `localStorage`: siempre cookie `httpOnly`.
`read_token` puede levantar `jwt.PyJWTError` (expirado o inválido); lo
traducen a `401` los `deps` de auth, no este módulo.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any

import bcrypt
import jwt
from fastapi import Response

from app.core.clock import now_utc
from app.core.config import settings

#: Costo de bcrypt. 12 es el de fábrica de la librería y el de producción.
#: Sólo la suite de tests lo baja (`tests/conftest.py`), porque cada test crea
#: sus empleados con PIN y a 12 rondas eso solo son ~2 s por test.
BCRYPT_ROUNDS = 12

COOKIE_ADMIN = "admin_session"
COOKIE_DEVICE = "device_session"


def hash_secret(plain: str) -> str:
    return bcrypt.hashpw(plain.encode("utf-8"), bcrypt.gensalt(rounds=BCRYPT_ROUNDS)).decode("utf-8")


def verify_secret(plain: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(plain.encode("utf-8"), hashed.encode("utf-8"))
    except ValueError:
        return False


def make_token(payload: dict[str, Any], ttl: timedelta) -> str:
    to_encode: dict[str, Any] = dict(payload)
    now = now_utc()
    to_encode["iat"] = int(now.timestamp())
    to_encode["exp"] = int((now + ttl).timestamp())
    encoded = jwt.encode(to_encode, settings.JWT_SECRET, algorithm="HS256")
    return encoded


def read_token(token: str) -> dict[str, Any]:
    payload: dict[str, Any] = jwt.decode(token, settings.JWT_SECRET, algorithms=["HS256"])
    return payload


def set_session_cookie(response: Response, name: str, token: str, max_age: int) -> None:
    response.set_cookie(
        key=name,
        value=token,
        max_age=max_age,
        httponly=True,
        samesite="lax",
        secure=(settings.ENV == "production"),
        path="/",
    )


def clear_session_cookie(response: Response, name: str) -> None:
    response.delete_cookie(key=name, path="/")
