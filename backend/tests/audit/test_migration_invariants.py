"""El DDL escrito a mano tiene que decir lo mismo que los modelos.

`docs/SPEC-NEGOCIO.md §12` y las convenciones de ingeniería de 1a: Alembic
**desde el primer commit**, y el esquema de producción se construye con
`alembic upgrade head`, no con `create_all`. El resto de la suite usa
`create_all` (CONTRATO-INTERNO §4), que crea las tablas **desde los modelos**:
por construcción nunca ve el desfase entre una columna agregada al modelo y la
migración que nadie escribió. Ese desfase es "el bug más caro del go-live" de
§12, y sólo lo caza correr la cadena de verdad y comparar.

Este archivo es el único de `tests/audit` que no habla HTTP: arma una base
SQLite **propia** bajo `TMPDIR`, corre `alembic upgrade head` contra ella y
compara tabla por tabla y columna por columna contra `Base.metadata`.

Cierra el punto "SIN VERIFICAR 2" de la ronda 1 del entregable
`outputs/auditor-control.md`.
"""

from __future__ import annotations

import os
from collections.abc import Iterator
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, inspect

from app.core.db import Base
from app.core.models_registry import import_all_models

# `Base.metadata` sólo conoce las tablas de los `models.py` importados. La suite
# lo hace en `tests/conftest.py`; repetirlo acá deja el archivo honesto si
# alguna vez se corre solo.
import_all_models()

BACKEND_DIR = Path(__file__).resolve().parents[2]

# Alembic lleva su propia tabla de control: no es del dominio y no está en los
# modelos, así que nunca entra en la comparación.
ALEMBIC_BOOKKEEPING = {"alembic_version"}


def _alembic_config(database_url: str) -> Config:
    config = Config(str(BACKEND_DIR / "alembic.ini"))
    # `script_location` es relativo al `alembic.ini`; el test puede correr desde
    # cualquier cwd, así que se resuelve a absoluto.
    config.set_main_option("script_location", str(BACKEND_DIR / "alembic"))
    config.set_main_option("sqlalchemy.url", database_url)
    return config


@pytest.fixture()
def migrated_url(tmp_path: Path) -> Iterator[str]:
    """Un archivo SQLite **nuevo** con la cadena `0001 → 0002 → 0003` aplicada.

    Archivo propio bajo el `tmp_path` del test (que respeta `TMPDIR`): ningún
    otro agente corriendo en paralelo lo ve, y el teardown de nadie lo borra.
    """
    db_path = tmp_path / "migration-chain.db"
    url = f"sqlite:///{db_path}"
    # `alembic/env.py` lee `DATABASE_URL` y pisa lo que diga el `.ini`.
    previo = os.environ.get("DATABASE_URL")
    os.environ["DATABASE_URL"] = url
    try:
        command.upgrade(_alembic_config(url), "head")
        yield url
    finally:
        if previo is None:
            os.environ.pop("DATABASE_URL", None)
        else:
            os.environ["DATABASE_URL"] = previo


def test_the_migration_chain_builds_exactly_the_tables_of_the_models(migrated_url: str) -> None:
    """`alembic upgrade head` sobre una base vacía tiene que dejar **el mismo
    conjunto de tablas** que `Base.metadata`.

    Una tabla en los modelos y no en el DDL revienta en el primer deploy; una
    tabla en el DDL y no en los modelos es basura que nadie mantiene y que el
    próximo `--autogenerate` propone borrar.
    """
    engine = create_engine(migrated_url)
    try:
        en_el_ddl = set(inspect(engine).get_table_names()) - ALEMBIC_BOOKKEEPING
    finally:
        engine.dispose()
    en_los_modelos = set(Base.metadata.tables)

    faltan = sorted(en_los_modelos - en_el_ddl)
    sobran = sorted(en_el_ddl - en_los_modelos)
    assert not faltan and not sobran, (
        "la cadena de Alembic y los modelos no dicen lo mismo — "
        f"tablas en los modelos sin migración: {faltan}; "
        f"tablas en el DDL sin modelo: {sobran}"
    )


def test_every_migrated_table_has_exactly_the_columns_of_its_model(migrated_url: str) -> None:
    """Y tabla por tabla, **el mismo conjunto de columnas**.

    Es el desfase caro de §12: la columna existe en el modelo, los tests pasan
    con `create_all`, y en producción la consulta se cae con "no such column".
    """
    engine = create_engine(migrated_url)
    try:
        inspector = inspect(engine)
        tablas = set(inspector.get_table_names()) - ALEMBIC_BOOKKEEPING
        columnas_ddl = {t: {c["name"] for c in inspector.get_columns(t)} for t in tablas}
    finally:
        engine.dispose()

    diferencias: list[str] = []
    for nombre, tabla in sorted(Base.metadata.tables.items()):
        if nombre not in columnas_ddl:
            continue  # lo reporta el test de tablas; acá no se duplica el ruido
        en_el_modelo = {c.name for c in tabla.columns}
        faltan = sorted(en_el_modelo - columnas_ddl[nombre])
        sobran = sorted(columnas_ddl[nombre] - en_el_modelo)
        if faltan or sobran:
            diferencias.append(f"{nombre}: faltan en el DDL {faltan}; sobran en el DDL {sobran}")

    assert not diferencias, "el DDL a mano se desfasó de los modelos:\n" + "\n".join(diferencias)


def test_downgrading_to_base_leaves_no_table_of_the_application(migrated_url: str) -> None:
    """`alembic downgrade base` tiene que dejar la base **limpia**.

    Un `downgrade` que no deshace lo que hizo el `upgrade` es un rollback que
    no existe: el día que una migración salga mal en producción, la salida es
    restaurar un backup. Además es lo único que prueba que cada `down_revision`
    de la cadena está bien encadenada de verdad.
    """
    command.downgrade(_alembic_config(migrated_url), "base")

    engine = create_engine(migrated_url)
    try:
        quedaron = set(inspect(engine).get_table_names()) - ALEMBIC_BOOKKEEPING
    finally:
        engine.dispose()

    assert not quedaron, f"el downgrade dejó tablas de la aplicación en pie: {sorted(quedaron)}"
