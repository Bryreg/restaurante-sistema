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


# ---------------------------------------------------------------------------
# Pedido 1b-1: `0004_orders` y `0005_payments_fiscal`
# ---------------------------------------------------------------------------


def test_the_chain_reaches_the_two_migrations_of_the_sale(migrated_url: str) -> None:
    """`CONTRATO-INTERNO-1b-1.md §2.6`: `0004_orders` (`0003 → 0004`) y
    `0005_payments_fiscal` (`0004 → 0005`).

    Los dos tests de arriba comparan modelos contra DDL, pero pasarían igual
    si `head` se hubiera quedado en `0003` y las tablas nuevas **tampoco**
    estuvieran en los modelos. Este fija el punto de llegada: la cadena
    termina en `0005` y las catorce tablas de la venta existen.
    """
    from sqlalchemy import text

    engine = create_engine(migrated_url)
    try:
        with engine.connect() as conn:
            version = conn.execute(text("select version_num from alembic_version")).scalar_one()
        tablas = set(inspect(engine).get_table_names())
    finally:
        engine.dispose()

    assert version == "0005", f"la cadena quedó en {version!r} y el pedido 1b-1 llega hasta 0005"

    de_la_comanda = {
        "orders",
        "order_tables",
        "order_rounds",
        "order_items",
        "order_discounts",
        "order_sub_accounts",
        "order_sub_account_items",
        "order_events",
        "waste_stubs",
    }
    del_cobro = {"fiscal_counters", "fiscal_documents", "document_reprints", "payments", "order_tips"}
    faltan = sorted((de_la_comanda | del_cobro) - tablas)
    assert not faltan, f"la migración de la venta no creó: {faltan}"


def test_one_open_order_per_table_is_defended_by_a_partial_unique_index(migrated_url: str) -> None:
    """§3.3 y §11.9: «Una mesa tiene **a lo sumo una comanda abierta**
    (constraint)»; contrato §2.2: índice único parcial
    `uq_order_tables_one_open_per_table` sobre `(table_id) WHERE released_at
    IS NULL`.

    El chequeo previo en el servicio no alcanza: entre el `SELECT` y el
    `INSERT` de dos tablets caben las dos. La única defensa real es la base, y
    tiene que ser **parcial** — sin el `WHERE`, la segunda comanda de la
    historia en esa mesa no se podría abrir nunca.
    """
    from sqlalchemy import text

    engine = create_engine(migrated_url)
    try:
        indices = {i["name"]: i for i in inspect(engine).get_indexes("order_tables")}
        with engine.connect() as conn:
            sql = conn.execute(
                text("select sql from sqlite_master where type='index' and name=:n"),
                {"n": "uq_order_tables_one_open_per_table"},
            ).scalar_one_or_none()
    finally:
        engine.dispose()

    assert "uq_order_tables_one_open_per_table" in indices, (
        f"falta el índice único parcial de «una comanda abierta por mesa»: {sorted(indices)}"
    )
    indice = indices["uq_order_tables_one_open_per_table"]
    assert indice["unique"], "el índice existe pero no es único: no defiende nada"
    assert indice["column_names"] == ["table_id"], (
        f"el índice tiene que ser sobre `table_id`: {indice['column_names']}"
    )
    assert sql is not None and "where" in sql.lower() and "released_at" in sql.lower(), (
        "el índice no es parcial: sin `WHERE released_at IS NULL` la mesa quedaría "
        f"bloqueada para siempre después de la primera comanda — {sql!r}"
    )


def test_the_consecutive_is_defended_by_unique_constraints_in_the_database(
    migrated_url: str,
) -> None:
    """§8.3: «Consecutivo estrictamente creciente, sin huecos ni
    reutilización»; contrato §2.2: `UNIQUE(store_id, document_type, prefix)`
    en `fiscal_counters`, y en `fiscal_documents` `UNIQUE(target_key)` («un
    documento por comanda o sub-cuenta») más `UNIQUE(store_id, document_type,
    prefix, number)` («consecutivo único»).

    Se inspecciona el esquema, no el servicio: el `SELECT ... FOR UPDATE` del
    contador es la defensa de primera línea, pero SQLite lo ignora y Postgres
    no protege de un bug de aplicación. Estas tres restricciones son las que
    convierten una carrera perdida en un `IntegrityError` —que el cobro
    traduce a `409`— en vez de en dos documentos con el mismo número.
    """
    engine = create_engine(migrated_url)
    try:
        inspector = inspect(engine)

        def _uniques(table: str) -> list[list[str]]:
            constraints = [
                list(c["column_names"]) for c in inspector.get_unique_constraints(table)
            ]
            indices = [
                list(i["column_names"]) for i in inspector.get_indexes(table) if i.get("unique")
            ]
            return constraints + indices

        contadores = _uniques("fiscal_counters")
        documentos = _uniques("fiscal_documents")
    finally:
        engine.dispose()

    assert ["store_id", "document_type", "prefix"] in contadores, (
        f"`fiscal_counters` no tiene UNIQUE(store_id, document_type, prefix): {contadores}"
    )
    assert ["target_key"] in documentos, (
        f"`fiscal_documents` no tiene UNIQUE(target_key): dos documentos podrían "
        f"nacer de una misma comanda — {documentos}"
    )
    assert ["store_id", "document_type", "prefix", "number"] in documentos, (
        f"`fiscal_documents` no tiene UNIQUE(store_id, document_type, prefix, number): "
        f"el consecutivo se podría reutilizar — {documentos}"
    )
