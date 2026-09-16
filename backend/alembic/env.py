"""Entorno de Alembic: lee `DATABASE_URL`, registra todos los modelos de todos
los dominios que ya existan (`import_all_models`), y usa modo *batch* en
SQLite (necesario para `ALTER TABLE` ahí)."""

from __future__ import annotations

import os
import sys
from logging.config import fileConfig
from pathlib import Path

from alembic import context
from sqlalchemy import engine_from_config, pool

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.core.db import Base, normalize_database_url  # noqa: E402
from app.core.models_registry import import_all_models  # noqa: E402

config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# `normalize_database_url` fija el driver psycopg 3, igual que `make_engine`.
# Alembic arma su PROPIO engine (`engine_from_config`, más abajo) y no pasa por
# `app.core.db`, así que sin esto la API arrancaría bien y la migración moriría
# con `ModuleNotFoundError: No module named 'psycopg2'` — que es exactamente lo
# que pasó en el primer despliegue a Render.
database_url = normalize_database_url(os.environ.get("DATABASE_URL", "sqlite:///./dev.db"))

# La URL NO se escribe en el `.ini`: `config.set_main_option` la guarda en un
# ConfigParser con interpolación, y los hosts administrados entregan la
# contraseña percent-encoded (`p%40ss`). Ese `%4` lo lee ConfigParser como una
# interpolación rota y revienta al leerla. Se pasa directo donde se usa.

import_all_models()
target_metadata = Base.metadata


def run_migrations_offline() -> None:
    url = database_url
    is_sqlite = url.startswith("sqlite")
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        render_as_batch=is_sqlite,
        compare_type=True,
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    section = dict(config.get_section(config.config_ini_section, {}))
    section["sqlalchemy.url"] = database_url
    connectable = engine_from_config(section, prefix="sqlalchemy.", poolclass=pool.NullPool)
    is_sqlite = connectable.url.get_backend_name() == "sqlite"

    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            render_as_batch=is_sqlite,
            compare_type=True,
        )
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
