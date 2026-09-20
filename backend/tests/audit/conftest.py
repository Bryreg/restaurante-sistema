"""Helpers propios del auditor de control interno.

No redefine ninguna fixture de `tests/conftest.py` (CONTRATO-INTERNO §3):
solo agrega lo que los invariantes de plata y de identidad necesitan para
escribirse como enunciados cortos de una regla.
"""

from __future__ import annotations

import uuid
from collections.abc import Callable
from pathlib import Path
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


# ---------------------------------------------------------------------------
# Documento fiscal de verdad (pedido 1b-2): sin un `fiscal_range` vigente no
# se puede cobrar. `app.fiscal.service.reserve_next_number` reserva el
# consecutivo DENTRO del rango y `pay_order` corta antes con
# `400 NO_FISCAL_RANGE` si no hay uno (SPEC-NEGOCIO §8.3).
#
# Por eso todos los invariantes de venta de 1b-1 —que cobraban sin cargar
# nada— necesitan ahora un rango: la fixture es **autouse** para no repetir
# el mismo parámetro en veinte firmas, y los tests que auditan justamente la
# ausencia de rango lo borran a mano (`delete(FiscalRange)`), que es más
# honesto que un marcador.
# ---------------------------------------------------------------------------

# Prefijo corto por tipo (`fiscal_ranges.prefix` es `String(10)`). Cada tipo
# DIAN-trazable lleva su PROPIO rango y por lo tanto su propio consecutivo:
# es la regla "consecutivo por tipo y por sede" de §8.3, y el invariante de
# las notas se apoya en que la nota no toma números de la serie de la venta.
RANGE_PREFIX: dict[str, str] = {
    "pos_equivalent": "POS",
    "invoice": "FE",
    "adjustment_note": "NA",
    "credit_note": "NC",
    "debit_note": "ND",
}


def seed_fiscal_ranges(
    db: Any,
    store: Any,
    *,
    to_number: int = 999_999_999,
    from_number: int = 1,
    types: tuple[str, ...] | None = None,
) -> dict[str, Any]:
    """Un rango vigente por tipo DIAN-trazable, con vigencia amplia.

    Vigencia 2020→2099 a propósito: los tests de fecha operativa mueven el
    reloj (00:30, turno pasado de la hora de corte) y un rango que venciera
    "hoy" convertiría un invariante de zona horaria en un falso rojo de
    numeración.
    """
    from datetime import date as _date

    from app.core import clock as clock_module
    from app.fiscal import service as fiscal_service
    from app.fiscal.models import FiscalDocumentType

    now = clock_module.now_utc()
    made: dict[str, Any] = {}
    for value, prefix in RANGE_PREFIX.items():
        if types is not None and value not in types:
            continue
        made[value] = fiscal_service.create_range(
            db,
            organization_id=store.organization_id,
            store_id=store.id,
            document_type=FiscalDocumentType(value),
            prefix=prefix,
            from_number=from_number,
            to_number=to_number,
            resolution_number="18760000001",
            resolution_date=_date(2020, 1, 1),
            valid_from=_date(2020, 1, 1),
            valid_until=_date(2099, 12, 31),
            technical_key="audit-technical-key",
            now=now,
        )
    db.commit()
    return made


@pytest.fixture(autouse=True)
def fiscal_ranges(request: Any) -> Any:
    """Rango vigente por tipo en la sede propia, para todo test que hable con
    la base. Se salta sola en los tests que no usan `db` (los de migraciones
    arman su propio SQLite bajo `tmp_path`) y en los de carrera, que corren
    sobre la base propia de `race_env`.
    """
    if "db" not in request.fixturenames or "store" not in request.fixturenames:
        return None
    db = request.getfixturevalue("db")
    store = request.getfixturevalue("store")
    return seed_fiscal_ranges(db, store)


def seed_race_fiscal_range(race_env: Any, *, document_type: str = "pos_equivalent") -> None:
    """Lo mismo, sobre la base **propia** de `race_env` (no es la de `db`)."""
    from datetime import date as _date

    from app.core import clock as clock_module
    from app.fiscal import service as fiscal_service
    from app.fiscal.models import FiscalDocumentType

    with race_env.session_factory() as db:
        fiscal_service.create_range(
            db,
            organization_id=race_env.organization_id,
            store_id=race_env.store_id,
            document_type=FiscalDocumentType(document_type),
            prefix=RANGE_PREFIX[document_type],
            from_number=1,
            to_number=999_999_999,
            resolution_number="18760000001",
            resolution_date=_date(2020, 1, 1),
            valid_from=_date(2020, 1, 1),
            valid_until=_date(2099, 12, 31),
            technical_key="audit-race-technical-key",
            now=clock_module.now_utc(),
        )
        db.commit()


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


# ---------------------------------------------------------------------------
# Costo e inventario (pedido 2a). Todo por HTTP, a propósito: los invariantes
# de esta fase defienden el CONTRATO (lo que el dueño de un restaurante puede
# hacer desde el admin y lo que el POS escribe), no la firma interna de un
# servicio. Armar los insumos con `db.add(Ingredient(...))` saltearía
# justamente las validaciones que el checklist manda probar (`min_stock > 0`,
# costo con origen, unidad base) — y un invariante que se salta la puerta de
# entrada no defiende la puerta de entrada.
#
# Excepción deliberada: `stock_of` lee con `app.inventory.hooks.current_stock`
# en vez de `GET /admin/inventory/stock`. Es una LECTURA del libro, la misma
# que usa el backend para decidir alertas; leerla por HTTP obligaría a parsear
# el string decimal de la respuesta y mezclaría dos cosas distintas (que el
# saldo esté bien y que el borde lo formatee bien) en una sola aserción.
# ---------------------------------------------------------------------------

API_V1 = "/api/v1"


def make_ingredient(
    admin_client: Any,
    store: Any,
    *,
    name: str = "Insumo",
    base_unit: str = "g",
    yield_pct: int = 100,
    official_cost: str | None = "10",
    min_stock: str = "1000",
    expect: int | None = 201,
    **extra: Any,
) -> dict[str, Any]:
    """`POST /admin/ingredients`. `official_cost=None` deja el insumo **sin
    costo** (`cost_source = none`), que es el caso que la regla "nunca un cero
    mudo" defiende."""
    payload: dict[str, Any] = {
        "name": name,
        "base_unit": base_unit,
        "purchase_unit": "kg" if base_unit == "g" else ("l" if base_unit == "ml" else "unit"),
        "purchase_factor": 1000 if base_unit in ("g", "ml") else 1,
        "yield_pct": yield_pct,
        "min_stock": min_stock,
        **extra,
    }
    if official_cost is not None:
        payload["official_cost"] = official_cost
    resp = admin_client.post(f"{API_V1}/admin/ingredients?store_id={store.id}", json=payload)
    if expect is not None:
        assert resp.status_code == expect, resp.text
    if resp.status_code != 201:
        return {"_resp": resp, "_status": resp.status_code, "_body": resp.json()}
    body: dict[str, Any] = resp.json()
    return body


def make_preparation(
    admin_client: Any,
    store: Any,
    *,
    name: str = "Preparación",
    mode: str = "exploded",
    standard_yield_qty: str = "1000",
    standard_yield_unit: str = "g",
    lines: list[dict[str, Any]] | None = None,
    expect: int | None = 201,
) -> Any:
    payload = {
        "name": name,
        "mode": mode,
        "standard_yield_qty": standard_yield_qty,
        "standard_yield_unit": standard_yield_unit,
        "lines": lines or [],
    }
    resp = admin_client.post(f"{API_V1}/admin/preparations?store_id={store.id}", json=payload)
    if expect is not None:
        assert resp.status_code == expect, resp.text
    return resp.json() if resp.status_code == 201 else resp


def put_recipe(
    admin_client: Any, product_id: int, lines: list[dict[str, Any]], *, version: int = 0, expect: int | None = 200
) -> Any:
    resp = admin_client.put(
        f"{API_V1}/admin/products/{product_id}/recipe", json={"version": version, "lines": lines}
    )
    if expect is not None:
        assert resp.status_code == expect, resp.text
    return resp.json() if resp.status_code == 200 else resp


def stock_of(db: Any, store: Any, *, ingredient_id: int | None = None, preparation_id: int | None = None) -> int:
    from app.inventory import hooks as inventory_hooks

    return inventory_hooks.current_stock(
        db, store_id=store.id, ingredient_id=ingredient_id, preparation_id=preparation_id
    )


def movements_of(db: Any, store: Any, *, ingredient_id: int | None = None, preparation_id: int | None = None) -> list[Any]:
    from sqlalchemy import select

    from app.inventory.models import StockMovement

    stmt = select(StockMovement).where(StockMovement.store_id == store.id)
    if ingredient_id is not None:
        stmt = stmt.where(StockMovement.ingredient_id == ingredient_id)
    if preparation_id is not None:
        stmt = stmt.where(StockMovement.preparation_id == preparation_id)
    return list(db.execute(stmt.order_by(StockMovement.id)).scalars())


def send(client: Any, order: dict[str, Any]) -> Any:
    return client.post(
        f"{API_V1}/orders/{order['id']}/send",
        json={"expected_version": order["version"]},
        headers=idem_headers(),
    )


def produce(
    client: Any, preparation_id: int, *, qty_expected: str, qty_real: str, pin: str = "2222", headers: Any = None
) -> Any:
    return client.post(
        f"{API_V1}/preparations/{preparation_id}/produce",
        json={"qty_expected": qty_expected, "qty_real": qty_real, "employee_pin": pin},
        headers=headers or idem_headers(),
    )


# ---------------------------------------------------------------------------
# Pedido 2b — helpers de compras, lotes y conteos.
#
# Mismo criterio que los helpers de 2a de arriba: todo entra por HTTP, por la
# puerta real, para que un invariante no se saltee la validación que existe
# para defender. Las dos excepciones declaradas son lecturas del libro y de
# los lotes (`stock_of`, `lots_of`): leerlas por HTTP obligaría a parsear el
# texto decimal de la respuesta y mezclaría "el saldo está bien" con "el
# borde lo formatea bien" en una sola aserción.
# ---------------------------------------------------------------------------


def make_supplier(
    admin_client: Any,
    store: Any,
    *,
    name: str = "Distribuidora del Centro",
    nit: str | None = "900111222",
    payment_term_days: int = 30,
    invoices_required: bool = True,
    expect: int | None = 201,
    **extra: Any,
) -> Any:
    resp = admin_client.post(
        f"{API_V1}/admin/suppliers?store_id={store.id}",
        json={
            "name": name,
            "nit": nit,
            "payment_term_days": payment_term_days,
            "invoices_required": invoices_required,
            **extra,
        },
    )
    if expect is not None:
        assert resp.status_code == expect, resp.text
    return resp.json() if resp.status_code == 201 else resp


def reception_line(
    ingredient_id: int,
    *,
    qty_received: str = "10000",
    qty_invoiced: str | None = None,
    purchase_unit_price: str = "12000",
    tax_base: int = 120_000,
    tax_rate: int = 19,
    tax_amount: int = 22_800,
    lot_code: str | None = None,
    expires_at: str | None = None,
) -> dict[str, Any]:
    return {
        "ingredient_id": ingredient_id,
        "qty_received": qty_received,
        "qty_invoiced": qty_invoiced if qty_invoiced is not None else qty_received,
        "purchase_unit_price": purchase_unit_price,
        "tax_base": tax_base,
        "tax_rate": tax_rate,
        "tax_amount": tax_amount,
        "lot_code": lot_code,
        "expires_at": expires_at,
    }


def post_reception(
    admin_client: Any,
    store: Any,
    lines: list[dict[str, Any]],
    *,
    supplier_id: int,
    invoice_number: str | None = "F-001",
    invoice_date: str = "2026-01-15",
    no_invoice: bool = False,
    received_by_pin: str = "1111",
    confirm_price: bool = False,
    headers: Any = None,
    expect: int | None = 201,
) -> Any:
    resp = admin_client.post(
        f"{API_V1}/receptions?store_id={store.id}",
        headers=headers or idem_headers(),
        json={
            "supplier_id": supplier_id,
            "invoice_number": invoice_number,
            "invoice_date": invoice_date,
            "no_invoice": no_invoice,
            "received_by_pin": received_by_pin,
            "confirm_price": confirm_price,
            "lines": lines,
        },
    )
    if expect is not None:
        assert resp.status_code == expect, resp.text
    return resp.json() if resp.status_code == 201 else resp


def lots_of(db: Any, store: Any, *, ingredient_id: int) -> list[Any]:
    from sqlalchemy import select

    from app.inventory.models import StockBatch

    return list(
        db.execute(
            select(StockBatch)
            .where(StockBatch.store_id == store.id, StockBatch.ingredient_id == ingredient_id)
            .order_by(StockBatch.id)
        ).scalars()
    )


def open_count(admin_client: Any, store: Any, *, scope: str = "full", expect: int | None = 201) -> Any:
    resp = admin_client.post(f"{API_V1}/admin/counts?store_id={store.id}", json={"scope": scope})
    if expect is not None:
        assert resp.status_code == expect, resp.text
    return resp.json() if resp.status_code == 201 else resp


def save_count_lines(admin_client: Any, store: Any, count_id: int, lines: list[dict[str, Any]], *, expect: int | None = 200) -> Any:
    resp = admin_client.put(
        f"{API_V1}/admin/counts/{count_id}/lines?store_id={store.id}", json={"lines": lines}
    )
    if expect is not None:
        assert resp.status_code == expect, resp.text
    return resp.json() if resp.status_code == 200 else resp


def apply_count(
    admin_client: Any, store: Any, count_id: int, *, pin: str = "9999", headers: Any = None, expect: int | None = 200
) -> Any:
    resp = admin_client.post(
        f"{API_V1}/admin/counts/{count_id}/apply?store_id={store.id}",
        json={"authorizer_pin": pin},
        headers=headers or idem_headers(),
    )
    if expect is not None:
        assert resp.status_code == expect, resp.text
    return resp.json() if resp.status_code == 200 else resp


def set_iva_regime(db: Any, store: Any) -> None:
    """Pasa la sede a responsable de IVA (no de INC): el impuesto de una
    compra deja de ser mayor valor del costo (SPEC-NEGOCIO §4.1)."""
    from sqlalchemy import select

    from app.stores.models import StoreFiscalConfig

    row = db.execute(
        select(StoreFiscalConfig).where(StoreFiscalConfig.store_id == store.id).order_by(StoreFiscalConfig.valid_from.desc())
    ).scalars().first()
    assert row is not None, "la sede de test no tiene configuración fiscal"
    row.inc_responsible = False
    row.iva_responsible = True
    db.commit()


# ---------------------------------------------------------------------------
# Clasificación de rutas por SESIÓN (el recorte de los barridos heredados,
# pedido 2b). Ver el docstring de
# `tests/payments/test_documents.py::test_openapi_device_responses_never_expose_cost_fields`
# para el porqué del recorte; acá vive la mecánica, compartida por los tres
# barridos para que no vuelvan a divergir entre sí.
# ---------------------------------------------------------------------------


def _dependency_calls(dependant: Any, acc: set[Any]) -> set[Any]:
    for sub in dependant.dependencies:
        if sub.call is not None:
            acc.add(sub.call)
        _dependency_calls(sub, acc)
    return acc


def iter_api_routes(routes: Any = None, prefix: str = "") -> Any:
    """Todas las `APIRoute` de la app con su path COMPLETO.

    FastAPI 0.141 no clona las rutas al `include_router`: deja un
    `_IncludedRouter` que apunta al router original y aplica el prefijo al
    resolver. Recorrer `app.routes` a secas devuelve UNA sola ruta (el
    fallback de la SPA) — por eso se baja por `original_router.routes`
    acumulando el prefijo del `include_context`."""
    from fastapi.routing import APIRoute

    from app.main import app

    if routes is None:
        routes = app.routes
    for route in routes:
        if isinstance(route, APIRoute):
            yield prefix + route.path, route
        original = getattr(route, "original_router", None)
        if original is not None:
            context = getattr(route, "include_context", None)
            sub_prefix = getattr(context, "prefix", "") if context is not None else ""
            yield from iter_api_routes(original.routes, prefix + (sub_prefix or ""))


def admin_only_paths() -> set[str]:
    """Las rutas que exigen `current_admin`: un dispositivo NO puede
    alcanzarlas (sin cookie de admin, `current_admin` levanta 401 antes de
    entrar al endpoint)."""
    from app.auth.deps import current_admin

    return {
        path
        for path, route in iter_api_routes()
        if current_admin in _dependency_calls(route.dependant, set())
    }


def device_reachable_paths() -> set[str]:
    """Todo lo demás de `/api/v1`: lo que una sesión de dispositivo puede
    alcanzar, sea con `current_device`, `current_operator`,
    `current_device_session`, `current_actor` o sin sesión (login). Es la
    definición ESTRICTA de "el operador no ve costos" — más estricta que
    mirar el prefijo `/admin/` del path, porque caza una ruta bajo `/admin/`
    a la que se le olvidó `current_admin`, y no acusa en falso a una ruta
    de admin que no lleva `/admin/` en el path (`POST /receptions`)."""
    admin = admin_only_paths()
    return {path for path, _ in iter_api_routes() if path.startswith("/api/v1") and path not in admin}


MONEY_LEAK_SUBSTRINGS = ("cost", "margin")


def openapi_properties_reachable_from(spec: dict[str, Any], paths: set[str]) -> list[tuple[str, str]]:
    """`[(dónde, propiedad)]` de todo esquema alcanzable desde `paths`,
    siguiendo `$ref` anidados (un campo de costo escondido tres niveles
    abajo también cuenta)."""
    components: dict[str, Any] = spec.get("components", {}).get("schemas", {})
    found: list[tuple[str, str]] = []

    def walk(node: Any, seen: set[str], where: str) -> None:
        if isinstance(node, dict):
            ref = node.get("$ref")
            if ref:
                name = ref.split("/")[-1]
                if name in seen or name not in components:
                    return
                seen.add(name)
                walk(components[name], seen, f"{where} -> {name}")
                return
            for key, value in node.items():
                if key == "properties" and isinstance(value, dict):
                    for prop in value:
                        found.append((where, prop))
                walk(value, seen, where)
        elif isinstance(node, list):
            for item in node:
                walk(item, seen, where)

    for path in sorted(paths):
        if path in spec.get("paths", {}):
            walk(spec["paths"][path], set(), path)
    return found


# ---------------------------------------------------------------------------
# Barridos de AST sobre `app/` (ronda 2).
#
# Tres invariantes distintos recorren el árbol de `app/**` buscando una
# construcción prohibida (una causa retirada que vuelve, una constante de
# negocio escrita dos veces, un `float` filtrado). Compartir el recorrido
# evita que se separen — que es exactamente el modo de falla que destapó H-4:
# la misma pregunta respondida dos veces, con dos fórmulas.
# ---------------------------------------------------------------------------

APP_ROOT = Path(__file__).resolve().parents[2] / "app"


def app_source_files() -> list[tuple[str, Any]]:
    """`[(ruta relativa a `backend/`, árbol de AST)]` de todo `app/**/*.py`.

    Excluye `__pycache__` y los `.pyc`. La ruta se devuelve relativa para
    que el mensaje de un rojo sea copiable tal cual en un `sed -n`.
    """
    import ast

    out: list[tuple[str, Any]] = []
    for archivo in sorted(APP_ROOT.rglob("*.py")):
        if "__pycache__" in archivo.parts:
            continue
        relativa = str(archivo.relative_to(APP_ROOT.parent))
        out.append((relativa, ast.parse(archivo.read_text(encoding="utf-8"), filename=str(archivo))))
    return out


# ---------------------------------------------------------------------------
# Pedido 2c — canales y cocina.
#
# Mismo criterio que los helpers de 2a/2b: todo entra por HTTP, por la puerta
# real, para que un invariante no se saltee la validación que existe para
# defender. Las excepciones declaradas siguen siendo lecturas del libro
# (`stock_of`, `movements_of`) y las lecturas de tablas nuevas de `channels`
# (`receivables_of`, `commissions_of`): leerlas por HTTP obligaría a pasar por
# una ruta de admin y mezclaría "el asiento está bien" con "el borde lo
# serializa bien" en una sola aserción.
# ---------------------------------------------------------------------------

CHANNEL_FEATURES_2C = ("pos.delivery", "pos.platforms", "pos.courses", "kitchen.kds")


@pytest.fixture()
def enable_2c(set_feature: Any) -> Callable[..., None]:
    """Enciende las cuatro funciones de 2c **y sus dependencias declaradas**
    (`app/core/features.py`): `pos.delivery -> pos.takeout`,
    `pos.courses -> kitchen.view`, `kitchen.kds -> kitchen.view`."""

    def _enable(*keys: str) -> None:
        wanted = list(keys) if keys else list(CHANNEL_FEATURES_2C)
        deps = {
            "pos.delivery": ["pos.takeout"],
            "pos.courses": ["kitchen.view"],
            "kitchen.kds": ["kitchen.view"],
        }
        for key in wanted:
            for dep in deps.get(key, []):
                set_feature(dep, True)
            set_feature(key, True)

    return _enable


@pytest.fixture()
def activate_channels(db: Any, store: Any) -> Callable[..., None]:
    """Agrega canales a `stores.active_channels` de la sede de prueba.

    Existe aparte de `enable_2c` a propósito: son los DOS interruptores que
    §9.3 describe como distintos —la función dice si el plan incluye la
    capacidad, «canales activos» dice si ESTA sede la usa— y hay un invariante
    (`test_the_active_channels_of_the_store_gate_every_channel_and_not_only_three`)
    que necesita justamente la combinación de función encendida y canal
    apagado. Si `enable_2c` activara los canales, ese invariante no se podría
    escribir.

    En producción el equivalente es la migración `0016`, que marca
    `delivery`/`platform` activos en toda sede que ya existía."""

    def _activate(*canales: str) -> None:
        actuales = list(store.active_channels or [])
        store.active_channels = actuales + [c for c in canales if c not in actuales]
        db.flush()

    return _activate


@pytest.fixture()
def courier(db: Any, org: Any, store: Any) -> Any:
    """Un domiciliario de la sede propia."""
    from app.auth.models import Employee
    from app.core import clock as clock_module
    from app.core import security

    now = clock_module.now_utc()
    row = Employee(
        organization_id=org.id,
        store_id=store.id,
        name="Domiciliario Uno",
        role="operator",
        pin_hash=security.hash_secret("4141"),
        active=True,
        created_at=now,
        updated_at=now,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


@pytest.fixture()
def delivery_fee_product(db: Any, store: Any) -> Any:
    """El producto marcado `is_delivery_fee` de la sede: el cargo de
    domicilio ES una línea de la carta (§3.3), no un campo aparte."""
    from app.catalog.models import Category, Product
    from app.core import clock as clock_module

    now = clock_module.now_utc()
    category = Category(
        organization_id=store.organization_id,
        store_id=store.id,
        name="Servicio (auditoría)",
        sort_order=90,
        default_course="main",
        default_station=None,
        active=True,
    )
    db.add(category)
    db.flush()
    row = Product(
        organization_id=store.organization_id,
        store_id=store.id,
        category_id=category.id,
        name="Cargo de domicilio",
        description=None,
        station=None,
        default_course="main",
        price_dine_in=5_000,
        price_takeout=None,
        price_delivery=None,
        price_platform=None,
        tax_code="inc_8",
        active=True,
        available=True,
        daily_count=None,
        daily_remaining=None,
        unavailable_by_employee_id=None,
        unavailable_by_employee_name=None,
        unavailable_at=None,
        is_delivery_fee=True,
        created_at=now,
        updated_at=now,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


@pytest.fixture()
def platform(db: Any, store: Any) -> Any:
    """Una plataforma activa con 18 % de comisión, y el medio de pago
    `platform` disponible en la configuración de ventas de la sede.

    Se arma con el código REAL de `app.channels.service`
    (`ensure_platform_payment_method`), no con un doble: un invariante que
    siembra el medio a mano no prueba que el camino real lo siembre.
    """
    from app.channels import service as channels_service
    from app.channels.models import DeliveryPlatform
    from app.core import clock as clock_module

    now = clock_module.now_utc()
    row = DeliveryPlatform(
        organization_id=store.organization_id,
        store_id=store.id,
        name="Rappi (auditoría)",
        code="rappi_audit",
        commission_bp=1_800,
        active=True,
        created_at=now,
        updated_at=now,
    )
    db.add(row)
    db.flush()
    channels_service.ensure_platform_payment_method(db, store=store)
    db.commit()
    db.refresh(row)
    return row


def receivables_of(db: Any, store: Any) -> list[Any]:
    from sqlalchemy import select

    from app.channels.models import PlatformReceivable

    return list(
        db.execute(
            select(PlatformReceivable)
            .where(PlatformReceivable.store_id == store.id)
            .order_by(PlatformReceivable.id)
        ).scalars()
    )


def commissions_of(db: Any, store: Any) -> list[Any]:
    from sqlalchemy import select

    from app.channels.models import PlatformCommission

    return list(
        db.execute(
            select(PlatformCommission)
            .where(PlatformCommission.store_id == store.id)
            .order_by(PlatformCommission.id)
        ).scalars()
    )


def wastes_of(db: Any, store: Any) -> list[Any]:
    from sqlalchemy import select

    from app.inventory.models import Waste

    return list(db.execute(select(Waste).where(Waste.store_id == store.id).order_by(Waste.id)).scalars())


def cash_movements_of(db: Any, shift_id: int) -> list[Any]:
    from sqlalchemy import select

    from app.shifts.models import CashMovement

    return list(
        db.execute(
            select(CashMovement).where(CashMovement.shift_id == shift_id).order_by(CashMovement.id)
        ).scalars()
    )
