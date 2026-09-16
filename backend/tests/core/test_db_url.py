"""`app.core.db.normalize_database_url`: el driver de Postgres lo decide este
repo, no la consola del proveedor.

Nació de un defecto encontrado al preparar el despliegue: la app sólo se había
corrido contra Postgres con `postgresql+psycopg://` escrito a mano en
`ci.yml`. Cualquier host administrado entrega la URL estándar `postgresql://`,
que SQLAlchemy mapea a psycopg2 — un paquete que este proyecto no instala —, y
la API no arranca con un `ModuleNotFoundError` que no nombra la base.
"""

from __future__ import annotations

import pytest

from app.core.db import normalize_database_url


@pytest.mark.parametrize(
    "entrada",
    [
        "postgresql://app:secreto@host:5432/db",
        "postgres://app:secreto@host:5432/db",  # forma vieja, todavía usada por algunos hosts
    ],
)
def test_a_managed_host_url_gets_the_psycopg3_driver(entrada: str) -> None:
    assert normalize_database_url(entrada) == "postgresql+psycopg://app:secreto@host:5432/db"


@pytest.mark.parametrize(
    "entrada",
    [
        "postgresql+psycopg://app:secreto@host:5432/db",  # ya explícita: no se toca
        "postgresql+psycopg2://app:secreto@host:5432/db",  # alguien eligió psycopg2 a propósito
        "sqlite:///./dev.db",
        "sqlite+pysqlite:///:memory:",
    ],
)
def test_an_url_that_already_declares_its_driver_is_left_alone(entrada: str) -> None:
    assert normalize_database_url(entrada) == entrada


def test_the_query_string_and_credentials_survive() -> None:
    """Render entrega la URL con `?sslmode=require`; perderlo deja la conexión
    sin TLS o directamente rechazada."""
    entrada = "postgresql://u:p%40ss@dpg-abc.oregon-postgres.render.com/db?sslmode=require"
    assert normalize_database_url(entrada) == (
        "postgresql+psycopg://u:p%40ss@dpg-abc.oregon-postgres.render.com/db?sslmode=require"
    )
