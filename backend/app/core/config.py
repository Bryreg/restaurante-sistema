"""Configuración de la aplicación, leída de variables de entorno.

Una sola instancia (`settings`) importada en todos lados. Nada de leer
`os.environ` directamente fuera de este módulo.
"""

from __future__ import annotations

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    DATABASE_URL: str = "sqlite:///./dev.db"
    JWT_SECRET: str = "dev-secret-change-me"
    ENV: str = "dev"  # "dev" | "test" | "production"

    # Identidad de la persona (PIN de 4 dígitos) sobre el dispositivo compartido.
    EMPLOYEE_SESSION_MINUTES: int = 3
    PIN_LOCK_ATTEMPTS: int = 5
    PIN_LOCK_MINUTES: int = 15

    # Sesiones largas.
    DEVICE_SESSION_DAYS: int = 180
    ADMIN_SESSION_HOURS: int = 12
    # Sesión de administrador abierta DESDE una tablet del salón (el
    # navegador ya tiene la cookie del dispositivo): corta y fija. Al vencer
    # o al salir, la tablet vuelve sola a «Quién opera».
    ADMIN_ON_DEVICE_SESSION_MINUTES: int = 15

    # Avisos al celular (Web Push, `app.notifications.push`). Si las dos
    # claves vienen, mandan para todas las organizaciones; si no, cada
    # organización genera su par una vez y lo guarda en la base. La pública
    # y la privada van en base64url (el formato de `web-push
    # generate-vapid-keys`); la privada también se acepta en PEM.
    # `VAPID_SUBJECT` es el contacto que exigen los servicios de push
    # (`mailto:...` o `https://...`); sin él se usa el correo del
    # administrador.
    VAPID_PUBLIC_KEY: str = ""
    VAPID_PRIVATE_KEY: str = ""
    VAPID_SUBJECT: str = ""


settings = Settings()
