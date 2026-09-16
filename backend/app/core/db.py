"""Motor de base de datos y sesión.

SQLite en desarrollo y tests (con `busy_timeout`, `foreign_keys` y WAL para no
repetir las trampas de SQLite↔Postgres de `docs/SPEC-NEGOCIO.md §12`);
PostgreSQL en CI y producción. Ningún módulo de dominio crea su propio engine.
"""

from __future__ import annotations

from collections.abc import Iterator
from datetime import datetime, timezone

from sqlalchemy import DateTime, event
from sqlalchemy.engine import Engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker
from sqlalchemy import create_engine
from sqlalchemy.types import TypeDecorator

from app.core.config import settings
from app.core.errors import AppError


class Base(DeclarativeBase):
    pass


class UTCDateTime(TypeDecorator[datetime]):
    """`DateTime(timezone=True)` que **siempre** devuelve un datetime aware.

    Trampa de SQLite (SPEC-NEGOCIO §12): su dialecto guarda la hora como texto
    y, al leerla, descarta el offset — un datetime guardado aware vuelve
    *naive*, y comparar eso contra `clock.now_utc()` (aware) tira
    `TypeError`. Este tipo asume UTC en la lectura si vuelve sin tzinfo; en
    Postgres es un paso neutro (ya vuelve aware). Todo `Mapped[datetime]` de
    cualquier dominio debería usar este tipo, no `DateTime(timezone=True)` a
    secas.
    """

    impl = DateTime(timezone=True)
    cache_ok = True

    def process_bind_param(self, value: datetime | None, dialect: object) -> datetime | None:
        if value is not None and value.tzinfo is None:
            raise ValueError("Los datetimes que se guardan tienen que ser aware (usá clock.now_utc())")
        return value

    def process_result_value(self, value: datetime | None, dialect: object) -> datetime | None:
        if value is not None and value.tzinfo is None:
            return value.replace(tzinfo=timezone.utc)
        return value


def _is_sqlite(url: str) -> bool:
    return url.startswith("sqlite")


def normalize_database_url(url: str) -> str:
    """Fija el driver de Postgres en la URL: este proyecto usa **psycopg 3**
    (`psycopg[binary]` en `requirements.txt`), no psycopg2.

    Los hosts administrados (Render, Railway, Fly, Heroku) entregan la URL en
    su forma estándar, `postgresql://…` — y algunos todavía en la vieja
    `postgres://…`. SQLAlchemy mapea las dos al dialecto **psycopg2**, que no
    está instalado: la app no arranca, con un `ModuleNotFoundError` que no
    menciona la base por ningún lado. El CI nunca lo vio porque escribe
    `postgresql+psycopg://` a mano en `ci.yml`.

    Normalizar acá y no en la configuración del host es lo correcto: quién es
    el driver lo decide este repo, no la consola de un proveedor, y así
    `DATABASE_URL` se puede conectar tal como la entrega cualquiera de ellos.
    Una URL que ya trae driver explícito (`postgresql+psycopg://`,
    `postgresql+psycopg2://`) se respeta sin tocar.
    """
    for prefix in ("postgresql://", "postgres://"):
        if url.startswith(prefix):
            return "postgresql+psycopg://" + url[len(prefix) :]
    return url


def make_engine(database_url: str | None = None) -> Engine:
    url = normalize_database_url(database_url or settings.DATABASE_URL)
    connect_args: dict[str, object] = {}
    if _is_sqlite(url):
        connect_args["check_same_thread"] = False
    engine = create_engine(url, connect_args=connect_args, future=True)

    if _is_sqlite(url):

        @event.listens_for(engine, "connect")
        def _set_sqlite_pragmas(dbapi_connection: object, _record: object) -> None:
            cursor = dbapi_connection.cursor()  # type: ignore[attr-defined]
            cursor.execute("PRAGMA busy_timeout=5000")
            cursor.execute("PRAGMA foreign_keys=ON")
            cursor.execute("PRAGMA journal_mode=WAL")
            cursor.close()

    return engine


engine: Engine = make_engine()
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)


def get_db() -> Iterator[Session]:
    """Sesión por request.

    - Sin excepción: `commit()`.
    - `AppError` (400/401/403/404/409 de negocio): **también** `commit()`. Es
      un resultado que el código decidió a propósito, no un crash; lo que se
      alcanzó a escribir antes de levantarla (un contador de intentos de PIN,
      la fila de `idempotency_keys` ya resuelta con el error) tiene que
      sobrevivir — si no, cinco PIN fallidos nunca bloquean nada porque cada
      intento fallido se revierte a sí mismo. Por eso todo servicio tiene que
      **validar antes de escribir**: para cuando se hace un `db.add()`, la
      operación ya está decidida.
    - Cualquier otra excepción (bug real, se va a responder 500): `rollback()`.
    """
    db = SessionLocal()
    try:
        yield db
        db.commit()
    except AppError:
        db.commit()
        raise
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()
