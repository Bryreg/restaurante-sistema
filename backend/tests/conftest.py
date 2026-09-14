"""Fixtures compartidas de todo el backend (CONTRATO-INTERNO.md §3).

Ningún dominio redefine estas fixtures; si necesita algo propio, agrega un
`tests/<dominio>/conftest.py` con fixtures adicionales.
"""

from __future__ import annotations

from collections.abc import Callable, Iterator
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event, select
from sqlalchemy.orm import Session, sessionmaker

from app.auth.models import Employee
from app.core import clock as clock_module
from app.core import security
from app.core.db import Base, get_db
from app.core.errors import AppError
from app.core.models_registry import import_all_models
from app.main import app
from app.stores.models import (
    FeatureState,
    Organization,
    Store,
    StoreCashSettings,
    StoreFiscalConfig,
    StoreSalesSettings,
)
from app.stores.service import (
    DEFAULT_COURSE_TARGET_MINUTES,
    DEFAULT_COURSES,
    DEFAULT_COURTESY_REASONS,
    DEFAULT_DISCOUNT_REASONS,
    DEFAULT_PAYMENT_METHODS,
    DEFAULT_STATIONS,
    DEFAULT_VOID_REASONS,
)

# Todos los dominios que ya existan quedan registrados en Base.metadata, aunque
# su router todavía no exista (find_spec busca `models.py`, no `router.py`).
import_all_models()

KNOWN_PINS: dict[str, str] = {
    "Admin": "9999",
    "Supervisor": "5555",
    "Cashier": "1111",
    "Operator": "2222",
    "Operator2": "3333",
    "Operator3": "4444",
}
ADMIN_EMAIL = "admin@test.local"
ADMIN_PASSWORD = "admin1234"
STORE_PIN = "123456"


# ---------------------------------------------------------------------------
# Base de datos y cliente HTTP.
# ---------------------------------------------------------------------------


@pytest.fixture()
def db(tmp_path: Path) -> Iterator[Session]:
    db_path = tmp_path / f"test-{uuid4().hex}.db"
    engine = create_engine(f"sqlite:///{db_path}", connect_args={"check_same_thread": False})

    @event.listens_for(engine, "connect")
    def _set_sqlite_pragmas(dbapi_connection: object, _record: object) -> None:
        cursor = dbapi_connection.cursor()  # type: ignore[attr-defined]
        cursor.execute("PRAGMA busy_timeout=5000")
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.close()

    Base.metadata.create_all(engine)
    testing_session_local = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)
    session = testing_session_local()

    def _override_get_db() -> Iterator[Session]:
        # SAVEPOINT por request, no commit/rollback de la transacción entera:
        # así un 400/404 esperado en un request no borra lo que dejaron los
        # fixtures (org/store/employees) u otro request anterior del mismo
        # test que solo hicieron `flush()`, nunca `commit()` real en disco.
        # Espeja la política de `app.core.db.get_db`: un `AppError` también
        # libera el savepoint (un contador de PIN fallido tiene que sobrevivir
        # a su propia respuesta 400); solo un error inesperado lo revierte.
        savepoint = session.begin_nested()
        try:
            yield session
        except AppError:
            savepoint.commit()
            raise
        except Exception:
            savepoint.rollback()
            raise
        else:
            savepoint.commit()

    app.dependency_overrides[get_db] = _override_get_db
    try:
        yield session
    finally:
        app.dependency_overrides.pop(get_db, None)
        session.close()
        engine.dispose()


@pytest.fixture()
def client(db: Session) -> TestClient:
    return TestClient(app)


# ---------------------------------------------------------------------------
# Organización / sede de referencia (todo encendido: perfil "full").
# ---------------------------------------------------------------------------


@pytest.fixture()
def org(db: Session) -> Organization:
    now = clock_module.now_utc()
    row = Organization(name="Organización Demo", profile="full", created_at=now, updated_at=now)
    db.add(row)
    db.commit()
    return row


def _seed_store_settings(db: Session, store: Store) -> None:
    now = clock_module.now_utc()
    db.add(StoreCashSettings(store_id=store.id, updated_at=now))
    db.add(
        StoreSalesSettings(
            store_id=store.id,
            payment_methods=list(DEFAULT_PAYMENT_METHODS),
            void_reasons=list(DEFAULT_VOID_REASONS),
            discount_reasons=list(DEFAULT_DISCOUNT_REASONS),
            courtesy_reasons=list(DEFAULT_COURTESY_REASONS),
            courses=list(DEFAULT_COURSES),
            stations=list(DEFAULT_STATIONS),
            course_target_minutes=dict(DEFAULT_COURSE_TARGET_MINUTES),
            updated_at=now,
        )
    )
    db.add(
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
    db.flush()


@pytest.fixture()
def store(db: Session, org: Organization) -> Store:
    now = clock_module.now_utc()
    row = Store(
        organization_id=org.id,
        name="Sede Centro",
        nit="900123456",
        dv="7",
        legal_name="Organización Demo SAS",
        address="Calle Falsa 123",
        municipality_dane="11001",
        opening_hours=[],
        cutoff_hour=6,
        active_channels=["counter", "dine_in", "takeout"],
        store_pin_hash=security.hash_secret(STORE_PIN),
        active=True,
        created_at=now,
        updated_at=now,
    )
    db.add(row)
    db.flush()
    _seed_store_settings(db, row)
    db.commit()
    return row


@pytest.fixture()
def org_b(db: Session) -> Organization:
    now = clock_module.now_utc()
    row = Organization(name="Otra Organización", profile="full", created_at=now, updated_at=now)
    db.add(row)
    db.commit()
    return row


@pytest.fixture()
def store_b(db: Session, org_b: Organization) -> Store:
    now = clock_module.now_utc()
    row = Store(
        organization_id=org_b.id,
        name="Sede B",
        nit=None,
        dv=None,
        legal_name=None,
        address=None,
        municipality_dane=None,
        opening_hours=[],
        cutoff_hour=6,
        active_channels=["counter"],
        store_pin_hash=security.hash_secret("654321"),
        active=True,
        created_at=now,
        updated_at=now,
    )
    db.add(row)
    db.flush()
    _seed_store_settings(db, row)
    db.commit()
    return row


@pytest.fixture()
def employees(db: Session, org: Organization, store: Store) -> dict[str, Employee]:
    now = clock_module.now_utc()
    result: dict[str, Employee] = {}
    specs: list[tuple[str, str, str, int | None, bool, str | None, str | None]] = [
        ("admin", "admin", KNOWN_PINS["Admin"], None, False, ADMIN_EMAIL, ADMIN_PASSWORD),
        ("supervisor", "supervisor", KNOWN_PINS["Supervisor"], store.id, False, None, None),
        ("cashier", "operator", KNOWN_PINS["Cashier"], store.id, True, None, None),
        ("operator", "operator", KNOWN_PINS["Operator"], store.id, False, None, None),
        ("operator2", "operator", KNOWN_PINS["Operator2"], store.id, False, None, None),
        ("operator3", "operator", KNOWN_PINS["Operator3"], store.id, False, None, None),
    ]
    for key, role, pin, store_id, can_charge, email, password in specs:
        row = Employee(
            organization_id=org.id,
            store_id=store_id,
            name=key.capitalize(),
            role=role,
            pin_hash=security.hash_secret(pin),
            email=email,
            password_hash=security.hash_secret(password) if password else None,
            can_charge=can_charge,
            discount_limit_pct=None,
            document=None,
            active=True,
            failed_pin_attempts=0,
            pin_locked_until=None,
            created_at=now,
            updated_at=now,
        )
        db.add(row)
        result[key] = row
    db.commit()
    return result


@pytest.fixture()
def admin_client(db: Session, employees: dict[str, Employee]) -> TestClient:
    c = TestClient(app)
    resp = c.post("/api/v1/auth/admin/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD})
    assert resp.status_code == 200, resp.text
    return c


@pytest.fixture()
def device_client(db: Session, store: Store) -> TestClient:
    c = TestClient(app)
    resp = c.post("/api/v1/auth/device/activate", json={"store_id": store.id, "store_pin": STORE_PIN})
    assert resp.status_code == 200, resp.text
    return c


@pytest.fixture()
def identify() -> Callable[[TestClient, Employee], object]:
    def _identify(client: TestClient, employee: Employee, pin: str | None = None) -> object:
        used_pin = pin if pin is not None else KNOWN_PINS[employee.name]
        return client.post(
            "/api/v1/auth/device/identify", json={"employee_id": employee.id, "pin": used_pin}
        )

    return _identify


@pytest.fixture()
def set_feature(db: Session, org: Organization) -> Callable[..., None]:
    def _set(key: str, enabled: bool, store_id: int | None = None) -> None:
        stmt = select(FeatureState).where(
            FeatureState.organization_id == org.id,
            FeatureState.store_id == store_id,
            FeatureState.key == key,
        )
        row = db.execute(stmt).scalars().first()
        now = clock_module.now_utc()
        if row is None:
            row = FeatureState(
                organization_id=org.id, store_id=store_id, key=key, enabled=enabled, updated_at=now, updated_by="test"
            )
            db.add(row)
        else:
            row.enabled = enabled
            row.updated_at = now
        db.commit()

    return _set


class _TestClock:
    def __init__(self) -> None:
        self._now = datetime(2026, 1, 15, 12, 0, tzinfo=timezone.utc)
        clock_module.set_clock(lambda: self._now)

    def now(self) -> datetime:
        return self._now

    def set(self, value: datetime) -> None:
        self._now = value

    def advance(
        self, *, minutes: float = 0, hours: float = 0, days: float = 0, seconds: float = 0
    ) -> None:
        self._now = self._now + timedelta(days=days, hours=hours, minutes=minutes, seconds=seconds)


@pytest.fixture()
def clock() -> Iterator[_TestClock]:
    tc = _TestClock()
    try:
        yield tc
    finally:
        clock_module.set_clock(None)


@pytest.fixture()
def idem() -> Callable[[], dict[str, str]]:
    def _make() -> dict[str, str]:
        return {"Idempotency-Key": str(uuid4())}

    return _make


# ---------------------------------------------------------------------------
# Carreras reales (una sesión por request). Promovida desde tests/audit para
# que cualquier dominio pruebe concurrencia con hilos (D-2 de la entrega 1a).
# ---------------------------------------------------------------------------


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
