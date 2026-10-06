"""Seguridad de la cuenta de administrador (auditoría 2026-10-06, e5).

- **Límite de intentos**: 5 fallidos seguidos contra un correo (desde el
  último ingreso bueno) lo frenan 15 minutos; 30 fallidos desde una misma IP
  en 15 minutos, también. Se mide con `auth_login_attempts`.
- **Verificación en dos pasos** con una app de autenticación (TOTP, RFC
  6238: HMAC-SHA1, 30 s, 6 dígitos, ±1 ventana de tolerancia).
- **Códigos de recuperación**: 10 de un solo uso, con hash. Reemplazan el
  código del teléfono y sirven para poner una contraseña nueva (el sistema
  no manda correos). Otro administrador también puede cambiarle la
  contraseña desde Equipo.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
import struct
from datetime import datetime, timedelta
from urllib.parse import quote

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.auth.models import Employee, LoginAttempt, RecoveryCode
from app.core import clock
from app.core.errors import AppError
from app.core.security import hash_secret, verify_secret

EMAIL_MAX_FAILURES = 5
IP_MAX_FAILURES = 30
LOCK_WINDOW = timedelta(minutes=15)
RECOVERY_CODES = 10
ISSUER = "Restaurante"


# ---------------------------------------------------------------------------
# Límite de intentos
# ---------------------------------------------------------------------------


def _norm(email: str) -> str:
    return email.strip().lower()


def check_not_locked(db: Session, *, email: str, ip: str | None) -> None:
    now = clock.now_utc()
    since = now - LOCK_WINDOW
    email = _norm(email)
    last_ok = db.execute(
        select(func.max(LoginAttempt.at)).where(LoginAttempt.email == email, LoginAttempt.success.is_(True))
    ).scalar_one_or_none()
    floor = max(since, last_ok) if last_ok is not None else since
    failures = list(
        db.execute(
            select(LoginAttempt.at)
            .where(LoginAttempt.email == email, LoginAttempt.success.is_(False), LoginAttempt.at > floor)
            .order_by(LoginAttempt.at.desc())
        ).scalars()
    )
    if len(failures) >= EMAIL_MAX_FAILURES:
        unlock = failures[EMAIL_MAX_FAILURES - 1] + LOCK_WINDOW
        minutes = max(1, int((unlock - now).total_seconds() // 60) + 1)
        raise AppError(
            "LOGIN_LOCKED",
            f"Demasiados intentos fallidos con este correo. Probá de nuevo en {minutes} min "
            "o pedile a otro administrador que te cambie la contraseña.",
            status=429,
        )
    if ip:
        ip_failures = db.execute(
            select(func.count(LoginAttempt.id)).where(
                LoginAttempt.ip == ip, LoginAttempt.success.is_(False), LoginAttempt.at > since
            )
        ).scalar_one()
        if ip_failures >= IP_MAX_FAILURES:
            raise AppError(
                "LOGIN_LOCKED", "Demasiados intentos fallidos desde esta red. Probá en 15 minutos.", status=429
            )


def record_attempt(db: Session, *, email: str, ip: str | None, success: bool) -> None:
    db.add(LoginAttempt(email=_norm(email), ip=ip, success=success, at=clock.now_utc()))
    db.flush()


# ---------------------------------------------------------------------------
# TOTP (RFC 6238)
# ---------------------------------------------------------------------------


def new_totp_secret() -> str:
    return base64.b32encode(secrets.token_bytes(20)).decode("ascii").rstrip("=")


def _hotp(secret_b32: str, counter: int) -> str:
    padded = secret_b32 + "=" * (-len(secret_b32) % 8)
    key = base64.b32decode(padded, casefold=True)
    digest = hmac.new(key, struct.pack(">Q", counter), hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    code = (struct.unpack(">I", digest[offset : offset + 4])[0] & 0x7FFFFFFF) % 1_000_000
    return f"{code:06d}"


def totp_now(secret_b32: str, at: datetime | None = None) -> str:
    t = int((at or clock.now_utc()).timestamp()) // 30
    return _hotp(secret_b32, t)


def verify_totp(secret_b32: str, code: str, at: datetime | None = None) -> bool:
    code = "".join(ch for ch in code if ch.isdigit())
    if len(code) != 6:
        return False
    t = int((at or clock.now_utc()).timestamp()) // 30
    return any(hmac.compare_digest(_hotp(secret_b32, t + d), code) for d in (-1, 0, 1))


def otpauth_uri(secret_b32: str, account: str, organization: str) -> str:
    label = quote(f"{ISSUER} {organization}:{account}")
    return f"otpauth://totp/{label}?secret={secret_b32}&issuer={quote(ISSUER)}&digits=6&period=30"


# ---------------------------------------------------------------------------
# Códigos de recuperación
# ---------------------------------------------------------------------------


def _new_code() -> str:
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # sin 0/O ni 1/I
    raw = "".join(secrets.choice(alphabet) for _ in range(10))
    return f"{raw[:5]}-{raw[5:]}"


def regenerate_recovery_codes(db: Session, *, employee: Employee) -> list[str]:
    """Invalida los anteriores y devuelve 10 nuevos EN CLARO (única vez que
    se ven)."""
    now = clock.now_utc()
    for old in db.execute(
        select(RecoveryCode).where(RecoveryCode.employee_id == employee.id, RecoveryCode.used_at.is_(None))
    ).scalars():
        old.used_at = now
    codes = [_new_code() for _ in range(RECOVERY_CODES)]
    for c in codes:
        db.add(RecoveryCode(employee_id=employee.id, code_hash=hash_secret(c), created_at=now))
    db.flush()
    return codes


def consume_recovery_code(db: Session, *, employee: Employee, code: str) -> bool:
    normalized = code.strip().upper().replace(" ", "")
    if len(normalized) == 10:
        normalized = f"{normalized[:5]}-{normalized[5:]}"
    for row in db.execute(
        select(RecoveryCode).where(RecoveryCode.employee_id == employee.id, RecoveryCode.used_at.is_(None))
    ).scalars():
        if verify_secret(normalized, row.code_hash):
            row.used_at = clock.now_utc()
            db.flush()
            return True
    return False


def remaining_recovery_codes(db: Session, *, employee_id: int) -> int:
    return int(
        db.execute(
            select(func.count(RecoveryCode.id)).where(
                RecoveryCode.employee_id == employee_id, RecoveryCode.used_at.is_(None)
            )
        ).scalar_one()
    )
