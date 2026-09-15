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
def expected_of(admin_client: Any) -> Callable[[int], int]:
    """Esperado que el backend reporta hoy para un turno abierto.

    Se lee de `GET /shifts/{id}` **como administrador**: el frontend nunca lo
    deriva y el test tampoco (§11.13, una sola matemática).

    Por qué el admin y no el responsable (cambio de 1b-1, decisión O-1,
    `CONTRATO-INTERNO-1b-1.md §2.4 «Caja»` y §5.8): con `cash.blind_close`
    encendida —el default del perfil `full`, que es el de estos tests— el
    responsable de caja **no** ve `expected_cash` fuera del paso 2 del cierre.
    El administrador lo ve siempre, así que es el único observador desde el
    que se puede medir la ecuación del esperado sin depender de una flag. Los
    invariantes sobre **quién** ve el esperado viven en
    `test_cash_invariants.py`, no acá.
    """

    def _expected(shift_id: int) -> int:
        resp = admin_client.get(f"/api/v1/shifts/{shift_id}")
        assert resp.status_code == 200, resp.text
        value = resp.json()["expected_cash"]
        assert value is not None, "el administrador siempre puede ver el esperado"
        return int(value)

    return _expected



# ---------------------------------------------------------------------------
# Venta (pedido 1b-1): productos con tasas distintas, mesas, y helpers HTTP
# delgados para armar una comanda por API. No redefinen nada de
# `tests/conftest.py`; viven acá porque los invariantes de plata de la venta
# necesitan controlar exactamente qué tasa lleva cada línea.
# ---------------------------------------------------------------------------


@pytest.fixture()
def sales_products(db: Any, store: Any) -> dict[str, Any]:
    """Tres productos con las tres tarifas del país (`inc_8`, `iva_19`,
    `excluded`), uno con estación y dos sin ella.

    Con una sola tarifa no se puede auditar `tax_lines` (una lista de un
    elemento siempre suma bien); con dos tarifas y una excluida, el
    agrupamiento por tasa y el prorrateo del descuento de comanda quedan
    realmente expuestos.
    """
    from app.catalog.models import Category, Product
    from app.core import clock as clock_module

    now = clock_module.now_utc()
    category = Category(
        organization_id=store.organization_id,
        store_id=store.id,
        name="Auditoría",
        sort_order=0,
        default_course="main",
        default_station=None,
        active=True,
    )
    db.add(category)
    db.flush()

    specs = [
        ("inc8", "Bandeja", 25_000, "hot_kitchen", "inc_8"),
        ("iva19", "Cerveza", 12_000, None, "iva_19"),
        ("excluded", "Agua", 4_000, None, "excluded"),
    ]
    made: dict[str, Any] = {}
    for key, name, price, station, tax_code in specs:
        row = Product(
            organization_id=store.organization_id,
            store_id=store.id,
            category_id=category.id,
            name=name,
            description=None,
            station=station,
            default_course="main",
            price_dine_in=price,
            price_takeout=price,
            price_delivery=None,
            price_platform=None,
            tax_code=tax_code,
            active=True,
            available=True,
            daily_count=None,
            daily_remaining=None,
            unavailable_by_employee_id=None,
            unavailable_by_employee_name=None,
            unavailable_at=None,
            created_at=now,
            updated_at=now,
        )
        db.add(row)
        db.flush()
        made[key] = row
    db.commit()
    for row in made.values():
        db.refresh(row)
    return made


@pytest.fixture()
def audit_tables(db: Any, store: Any) -> list[Any]:
    """Una zona con dos mesas de la sede propia (para `dine_in`)."""
    from app.stores.models import Table, Zone

    zone = Zone(store_id=store.id, name="Auditoría", sort_order=9, active=True)
    db.add(zone)
    db.flush()
    rows = []
    for number in ("A1", "A2"):
        table = Table(zone_id=zone.id, store_id=store.id, number=number, seats=4, active=True)
        db.add(table)
        rows.append(table)
    db.commit()
    for table in rows:
        db.refresh(table)
    return rows


def create_order(client: Any, *, channel: str = "counter", **body: Any) -> Any:
    return client.post(
        "/api/v1/orders", json={"channel": channel, **body}, headers=idem_headers()
    )


def add_items(client: Any, order: dict[str, Any], items: list[dict[str, Any]], **extra: Any) -> Any:
    payload: dict[str, Any] = {"expected_version": order["version"], "items": items, **extra}
    return client.post(
        f"/api/v1/orders/{order['id']}/items", json=payload, headers=idem_headers()
    )


def get_order(client: Any, order_id: int) -> dict[str, Any]:
    resp = client.get(f"/api/v1/orders/{order_id}")
    assert resp.status_code == 200, resp.text
    body: dict[str, Any] = resp.json()
    return body


def pay(
    client: Any,
    order_id: int,
    *,
    splits: list[dict[str, Any]],
    tip: dict[str, Any] | None = None,
    pin: str = "1111",
    sub_account_id: int | None = None,
    headers: dict[str, str] | None = None,
    **extra: Any,
) -> Any:
    payload: dict[str, Any] = {"pin": pin, "splits": splits, **extra}
    if tip is not None:
        payload["tip"] = tip
    if sub_account_id is not None:
        payload["sub_account_id"] = sub_account_id
    return client.post(
        f"/api/v1/orders/{order_id}/payments", json=payload, headers=headers or idem_headers()
    )


NO_TIP: dict[str, Any] = {"asked": True, "accepted": False, "modified": False, "amount": 0}
