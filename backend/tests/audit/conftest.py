"""Helpers propios del auditor de control interno.

No redefine ninguna fixture de `tests/conftest.py` (CONTRATO-INTERNO §3):
solo agrega lo que los invariantes de plata y de identidad necesitan para
escribirse como enunciados cortos de una regla.
"""

from __future__ import annotations

import uuid
from collections.abc import Callable
from typing import Any

import pytest

from app.core.money import DENOMINATIONS

# Igual a `StoreCashSettings.opening_cash_fixed` por defecto: la base fija de
# la sede (`docs/SPEC-NEGOCIO.md §3.2`).
OPENING_FIXED = 200_000


def idem_headers() -> dict[str, str]:
    """`Idempotency-Key` nueva. Toda escritura de caja la exige."""
    return {"Idempotency-Key": str(uuid.uuid4())}


def denoms(total: int) -> dict[str, Any]:
    """Desglose por denominaciones reales que suma exactamente `total`.

    El backend valida el desglose contra el total (`DENOMINATIONS_MISMATCH`),
    así que los tests nunca declaran un total "a mano".
    """
    rest = total
    items: list[dict[str, int]] = []
    for value in sorted(DENOMINATIONS, reverse=True):
        count, rest = divmod(rest, value)
        if count:
            items.append({"value": value, "count": count})
    assert rest == 0, f"{total} no es representable con denominaciones colombianas"
    return {"denominations": items, "total": total}


def deep_keys(value: Any) -> set[str]:
    """Todas las claves de un JSON, a cualquier profundidad.

    Los campos sensibles (esperado, costo, hash de PIN) no se esconden en un
    nivel anidado: la inspección tiene que ser recursiva o no prueba nada.
    """
    found: set[str] = set()
    if isinstance(value, dict):
        for key, sub in value.items():
            found.add(str(key))
            found |= deep_keys(sub)
    elif isinstance(value, list):
        for sub in value:
            found |= deep_keys(sub)
    return found


def deep_contains_text(value: Any, needle: str) -> bool:
    """`needle` (minúsculas) aparece en alguna clave o texto del JSON."""
    if isinstance(value, dict):
        return any(
            needle in str(k).lower() or deep_contains_text(v, needle) for k, v in value.items()
        )
    if isinstance(value, list):
        return any(deep_contains_text(v, needle) for v in value)
    if isinstance(value, str):
        return needle in value.lower()
    return False


@pytest.fixture()
def open_shift(device_client: Any, identify: Any, employees: dict[str, Any]) -> Callable[..., dict]:
    """Abre un turno y devuelve el cuerpo de `POST /shifts/open`.

    Por defecto la base contada es la base fija (no hace falta causa) y el
    responsable de caja es `cashier`.
    """

    def _open(
        *,
        responsible: Any = None,
        total: int = OPENING_FIXED,
        cash_reserve: int = 0,
        opening_cause: str | None = None,
        opening_note: str | None = None,
    ) -> dict:
        person = responsible if responsible is not None else employees["cashier"]
        identify(device_client, person)
        payload: dict[str, Any] = {
            "opening_cash": denoms(total),
            "cash_reserve": cash_reserve,
            "cash_responsible_id": person.id,
        }
        if opening_cause is not None:
            payload["opening_cause"] = opening_cause
        if opening_note is not None:
            payload["opening_note"] = opening_note
        resp = device_client.post("/api/v1/shifts/open", json=payload, headers=idem_headers())
        assert resp.status_code in (200, 201), resp.text
        return resp.json()

    return _open


@pytest.fixture()
def other_org(db: Any, org_b: Any, store_b: Any) -> dict[str, Any]:
    """Una organización vecina con su sede, su empleado y su turno abierto.

    Es el "id ajeno" contra el que se prueba el aislamiento: `§1.1` manda que
    responda `404` en lectura y en escritura, nunca `403` (un `403` confirma
    que el id existe) ni `200`.
    """
    from app.auth.models import Employee
    from app.core import clock as clock_module
    from app.core import security
    from app.shifts.models import BusinessDay, Shift

    now = clock_module.now_utc()
    employee = Employee(
        organization_id=org_b.id,
        store_id=store_b.id,
        name="Vecino",
        role="operator",
        pin_hash=security.hash_secret("8888"),
        can_charge=True,
        active=True,
        failed_pin_attempts=0,
        created_at=now,
        updated_at=now,
    )
    db.add(employee)
    db.flush()

    day = BusinessDay(
        organization_id=org_b.id,
        store_id=store_b.id,
        business_date=now.date(),
        status="open",
        opened_at=now,
    )
    db.add(day)
    db.flush()

    shift = Shift(
        organization_id=org_b.id,
        store_id=store_b.id,
        business_day_id=day.id,
        status="open",
        opened_at=now,
        opened_by_employee_id=employee.id,
        opened_by_employee_name=employee.name,
        cash_responsible_id=employee.id,
        cash_responsible_name=employee.name,
        opening_cash_total=OPENING_FIXED,
        opening_denominations=denoms(OPENING_FIXED)["denominations"],
        cash_reserve=0,
        adjustments=[],
    )
    db.add(shift)
    db.commit()
    return {"org": org_b, "store": store_b, "employee": employee, "shift": shift}


@pytest.fixture()
def catalog_seeded(db: Any, store: Any) -> None:
    """Carta mínima cargada, para que `GET /catalog` tenga algo que devolver.

    Si el dominio de carta todavía no expone su seed, el test que la usa queda
    sin datos que inspeccionar y se reporta como pendiente, no como hallazgo.
    """
    from app.catalog.seed import seed_catalog

    seed_catalog(db, store)
    db.commit()


@pytest.fixture()
def expected_of(device_client: Any) -> Callable[[int], int]:
    """Esperado que el backend reporta hoy para un turno abierto.

    Se lee de `GET /shifts/{id}` con la persona responsable identificada: el
    frontend nunca lo deriva y el test tampoco (§11.13, una sola matemática).
    """

    def _expected(shift_id: int) -> int:
        resp = device_client.get(f"/api/v1/shifts/{shift_id}")
        assert resp.status_code == 200, resp.text
        value = resp.json()["expected_cash"]
        assert value is not None, "el responsable de caja tiene que poder ver el esperado"
        return int(value)

    return _expected


@pytest.fixture()
def race_app(tmp_path: Any) -> Any:
    """App con **una sesión por request** (como en producción) para los tests
    de concurrencia real con hilos.

    La fixture compartida `db` (CONTRATO-INTERNO §3) entrega una sola `Session`
    a todos los requests del test. Eso es cómodo para leer lo que dejó una
    escritura, pero una `Session` de SQLAlchemy no es thread-safe: dos hilos
    sobre ella se matan con `ResourceClosedError`/`InvalidRequestError` antes
    de tocar el índice único parcial, y el invariante «dos aperturas
    simultáneas: una 200, otra 409» quedaría sin poder verificarse.

    Acá se arma una base propia bajo `TMPDIR` y un `get_db` que abre y cierra
    una sesión por request, con la misma política de commit de
    `app.core.db.get_db` (un `AppError` también hace commit).

    Devuelve `(TestClient con dispositivo activado e identificado, employee_id)`.
    """
    from collections.abc import Iterator
    from datetime import date
    from uuid import uuid4

    from fastapi.testclient import TestClient
    from sqlalchemy import create_engine, event
    from sqlalchemy.orm import Session, sessionmaker

    from app.auth.models import Employee
    from app.core import clock as clock_module
    from app.core import security
    from app.core.db import Base, get_db
    from app.core.errors import AppError
    from app.core.models_registry import import_all_models
    from app.main import app
    from app.stores.models import (
        Organization,
        Store,
        StoreCashSettings,
        StoreFiscalConfig,
    )

    import_all_models()

    db_path = tmp_path / f"race-{uuid4().hex}.db"
    engine = create_engine(f"sqlite:///{db_path}", connect_args={"check_same_thread": False}, future=True)

    @event.listens_for(engine, "connect")
    def _pragmas(dbapi_connection: Any, _record: Any) -> None:
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA busy_timeout=5000")
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.close()

    Base.metadata.create_all(engine)
    session_factory = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)

    store_pin = "123456"
    employee_pin = "1111"
    now = clock_module.now_utc()
    with session_factory() as setup:
        org = Organization(name="Carrera", profile="full", created_at=now, updated_at=now)
        setup.add(org)
        setup.flush()
        store = Store(
            organization_id=org.id,
            name="Sede Carrera",
            nit="900000000",
            dv="1",
            legal_name="Carrera SAS",
            address="Calle 1",
            municipality_dane="11001",
            opening_hours=[],
            cutoff_hour=6,
            active_channels=["counter"],
            store_pin_hash=security.hash_secret(store_pin),
            active=True,
            created_at=now,
            updated_at=now,
        )
        setup.add(store)
        setup.flush()
        setup.add(StoreCashSettings(store_id=store.id, updated_at=now))
        setup.add(
            StoreFiscalConfig(
                store_id=store.id,
                valid_from=date(2020, 1, 1),
                person_type="natural",
                regime="ordinary",
                franchise=False,
                inc_responsible=True,
                iva_responsible=False,
                rut_codes=[],
                price_includes_tax=True,
                default_tax="inc_8",
                created_at=now,
            )
        )
        employee = Employee(
            organization_id=org.id,
            store_id=store.id,
            name="Cajero Carrera",
            role="operator",
            pin_hash=security.hash_secret(employee_pin),
            can_charge=True,
            active=True,
            failed_pin_attempts=0,
            created_at=now,
            updated_at=now,
        )
        setup.add(employee)
        setup.commit()
        store_id, employee_id = store.id, employee.id

    def _per_request_db() -> Iterator[Session]:
        session = session_factory()
        try:
            yield session
            session.commit()
        except AppError:
            session.commit()
            raise
        except Exception:
            session.rollback()
            raise
        finally:
            session.close()

    previous = app.dependency_overrides.get(get_db)
    app.dependency_overrides[get_db] = _per_request_db
    client = TestClient(app)
    try:
        activated = client.post(
            "/api/v1/auth/device/activate", json={"store_id": store_id, "store_pin": store_pin}
        )
        assert activated.status_code == 200, activated.text
        identified = client.post(
            "/api/v1/auth/device/identify", json={"employee_id": employee_id, "pin": employee_pin}
        )
        assert identified.status_code == 200, identified.text
        yield client, employee_id
    finally:
        if previous is None:
            app.dependency_overrides.pop(get_db, None)
        else:
            app.dependency_overrides[get_db] = previous
        engine.dispose()
