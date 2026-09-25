"""Consumo interno y traslado a otra sede: salidas explicadas por la pantalla
de merma, que NO son pérdida (rutina del turno, 2026-09-25).

- `internal_use` pide quién (empleado o texto «dueño»).
- `transfer_out` pide la sede destino, de la misma organización; sale como
  `transfer_out` del libro y la sede destino lo recibe como `transfer_in` al
  mismo costo.
- Ninguna de las dos entra en «mermas ÷ compras», en la alerta de merma alta,
  en la salud del control ni en la varianza.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Callable
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth.deps import Actor
from app.auth.models import Employee
from app.core import clock as clock_module
from app.core import security, tz
from app.inventory import hooks
from app.inventory.models import CostSource, MovementCause, StockMovement, Waste, WasteType
from app.notifications.models import Notification
from app.stores.models import Organization, Store

API = "/api/v1"
OPERATOR_PIN = "2222"
ADMIN_PIN = "9999"


def _idem() -> dict[str, str]:
    return {"Idempotency-Key": str(uuid4())}


def _actor(store: Store, employee: Employee) -> Actor:
    return Actor(
        kind="admin", organization_id=store.organization_id, store_id=store.id,
        employee_id=employee.id, employee_name=employee.name, role=employee.role,
    )


def _add_store(db: Session, org: Organization, name: str) -> Store:
    now = clock_module.now_utc()
    row = Store(
        organization_id=org.id, name=name, opening_hours=[], cutoff_hour=6,
        active_channels=["counter"], store_pin_hash=security.hash_secret("654321"),
        active=True, created_at=now, updated_at=now,
    )
    db.add(row)
    db.commit()
    return row


@pytest.fixture()
def ready(
    enable_inventory: Callable[[], None], device_client: TestClient, identify: Callable[..., Any],
    employees: dict[str, Employee],
) -> None:
    enable_inventory()
    identify(device_client, employees["operator"])


def _post_waste(device_client: TestClient, **body: Any) -> Any:
    payload = {"qty": "1", "employee_pin": OPERATOR_PIN, **body}
    return device_client.post(f"{API}/waste", json=payload, headers=_idem())


# ---------------------------------------------------------------------------
# Consumo interno.
# ---------------------------------------------------------------------------


def test_internal_use_requires_who_and_writes_nothing_without_it(
    ready: None, device_client: TestClient, create_ingredient: Callable[..., dict[str, Any]], db: Session,
    store: Store,
) -> None:
    ingredient = create_ingredient()
    resp = _post_waste(device_client, ingredient_id=ingredient["id"], type="internal_use")
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "CONSUMER_REQUIRED"
    assert db.execute(select(Waste)).scalars().first() is None
    assert hooks.current_stock(db, store_id=store.id, ingredient_id=ingredient["id"]) == 0

    blank = _post_waste(device_client, ingredient_id=ingredient["id"], type="internal_use", consumer_name="   ")
    assert blank.status_code == 400


def test_internal_use_with_a_free_text_consumer(
    ready: None, device_client: TestClient, create_ingredient: Callable[..., dict[str, Any]], db: Session,
    store: Store,
) -> None:
    ingredient = create_ingredient()
    resp = _post_waste(
        device_client, ingredient_id=ingredient["id"], type="internal_use", consumer_name=" Dueño ", qty="2"
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["type"] == "internal_use"
    assert body["consumer_name"] == "Dueño"
    assert body["consumer_employee_id"] is None
    assert "cost" not in body
    assert hooks.current_stock(db, store_id=store.id, ingredient_id=ingredient["id"]) == -2000


def test_internal_use_with_an_employee_freezes_the_name(
    ready: None, device_client: TestClient, create_ingredient: Callable[..., dict[str, Any]],
    employees: dict[str, Employee],
) -> None:
    ingredient = create_ingredient()
    resp = _post_waste(
        device_client, ingredient_id=ingredient["id"], type="internal_use",
        consumer_employee_id=employees["supervisor"].id,
    )
    assert resp.status_code == 201, resp.text
    assert resp.json()["consumer_employee_id"] == employees["supervisor"].id
    assert resp.json()["consumer_name"] == "Supervisor"


def test_internal_use_with_an_employee_of_another_organization_is_404(
    ready: None, device_client: TestClient, create_ingredient: Callable[..., dict[str, Any]], db: Session,
    org_b: Organization,
) -> None:
    now = clock_module.now_utc()
    stranger = Employee(
        organization_id=org_b.id, store_id=None, name="Ajeno", role="operator",
        pin_hash=security.hash_secret("8888"), email=None, password_hash=None, can_charge=False,
        discount_limit_pct=None, document=None, active=True, failed_pin_attempts=0, pin_locked_until=None,
        created_at=now, updated_at=now,
    )
    db.add(stranger)
    db.commit()
    ingredient = create_ingredient()
    resp = _post_waste(
        device_client, ingredient_id=ingredient["id"], type="internal_use", consumer_employee_id=stranger.id
    )
    assert resp.status_code == 404
    assert db.execute(select(Waste)).scalars().first() is None


# ---------------------------------------------------------------------------
# Traslado a otra sede.
# ---------------------------------------------------------------------------


def test_transfer_stores_lists_only_the_other_active_stores_of_the_organization(
    ready: None, device_client: TestClient, db: Session, org: Organization, store_b: Store,
) -> None:
    # Una sola sede: la lista viene vacía y la pantalla no ofrece traslado.
    assert device_client.get(f"{API}/device/waste/transfer-stores").json() == []

    norte = _add_store(db, org, "Sede Norte")
    inactive = _add_store(db, org, "Sede Cerrada")
    inactive.active = False
    db.commit()
    rows = device_client.get(f"{API}/device/waste/transfer-stores").json()
    assert rows == [{"id": norte.id, "name": "Sede Norte"}]  # ni la propia, ni la inactiva, ni la de otra org


def test_transfer_requires_a_destination_of_the_same_organization(
    ready: None, device_client: TestClient, create_ingredient: Callable[..., dict[str, Any]], db: Session,
    store: Store, store_b: Store,
) -> None:
    ingredient = create_ingredient()
    missing = _post_waste(device_client, ingredient_id=ingredient["id"], type="transfer_out")
    assert missing.status_code == 400
    assert missing.json()["error"]["code"] == "DESTINATION_REQUIRED"

    same = _post_waste(device_client, ingredient_id=ingredient["id"], type="transfer_out", destination_store_id=store.id)
    assert same.status_code == 400

    foreign = _post_waste(
        device_client, ingredient_id=ingredient["id"], type="transfer_out", destination_store_id=store_b.id
    )
    assert foreign.status_code == 404

    assert db.execute(select(Waste)).scalars().first() is None
    assert hooks.current_stock(db, store_id=store.id, ingredient_id=ingredient["id"]) == 0


def test_a_preparation_cannot_be_transferred(
    ready: None, device_client: TestClient, db: Session, org: Organization,
) -> None:
    norte = _add_store(db, org, "Sede Norte")
    resp = _post_waste(device_client, preparation_id=1, type="transfer_out", destination_store_id=norte.id)
    assert resp.status_code == 400
    assert db.execute(select(Waste)).scalars().first() is None


def test_transfer_leaves_as_transfer_out_and_is_received_at_the_same_cost(
    ready: None, device_client: TestClient, admin_client: TestClient,
    create_ingredient: Callable[..., dict[str, Any]], db: Session, org: Organization, store: Store,
) -> None:
    norte = _add_store(db, org, "Sede Norte")
    ingredient = create_ingredient(name="Queso campesino", official_cost="12")
    resp = _post_waste(
        device_client, ingredient_id=ingredient["id"], type="transfer_out", destination_store_id=norte.id,
        qty="3", note="para el fin de semana",
    )
    assert resp.status_code == 201, resp.text
    waste_id = resp.json()["id"]
    assert resp.json()["destination_store_id"] == norte.id

    out_moves = db.execute(select(StockMovement).where(StockMovement.store_id == store.id)).scalars().all()
    assert [(m.cause, m.qty_base) for m in out_moves] == [(MovementCause.TRANSFER_OUT, -3000)]

    # La sede destino tiene su propio insumo equivalente (los insumos son por sede).
    dest = admin_client.post(
        f"{API}/admin/ingredients?store_id={norte.id}",
        json={
            "name": "queso campesino", "category": None, "base_unit": "g", "purchase_unit": "kg",
            "purchase_factor": 1000, "yield_pct": 100, "official_cost": "15", "estimated_cost": None,
            "min_stock": "10", "key_item": False,
        },
    ).json()
    other_unit = admin_client.post(
        f"{API}/admin/ingredients?store_id={norte.id}",
        json={
            "name": "Queso en unidades", "category": None, "base_unit": "unit", "purchase_unit": "und",
            "purchase_factor": 1, "yield_pct": 100, "official_cost": None, "estimated_cost": None,
            "min_stock": "1", "key_item": False,
        },
    ).json()

    incoming = admin_client.get(f"{API}/admin/transfers/incoming", params={"store_id": norte.id}).json()
    assert len(incoming) == 1
    row = incoming[0]
    assert row["id"] == waste_id
    assert row["source_store_name"] == "Sede Centro"
    assert row["qty"] == "3"
    assert row["cost"] == "12"
    assert row["suggested_ingredient_id"] == dest["id"]
    assert row["received_at"] is None
    # La sede origen no lo ve como entrante.
    assert admin_client.get(f"{API}/admin/transfers/incoming", params={"store_id": store.id}).json() == []

    mismatch = admin_client.post(
        f"{API}/admin/transfers/{waste_id}/receive", params={"store_id": norte.id},
        json={"ingredient_id": other_unit["id"]}, headers=_idem(),
    )
    assert mismatch.status_code == 400
    assert mismatch.json()["error"]["code"] == "TRANSFER_UNIT_MISMATCH"
    wrong_store = admin_client.post(
        f"{API}/admin/transfers/{waste_id}/receive", params={"store_id": store.id},
        json={"ingredient_id": ingredient["id"]}, headers=_idem(),
    )
    assert wrong_store.status_code == 404
    assert db.get(Waste, waste_id).received_at is None  # type: ignore[union-attr]

    received = admin_client.post(
        f"{API}/admin/transfers/{waste_id}/receive", params={"store_id": norte.id},
        json={"ingredient_id": dest["id"]}, headers=_idem(),
    )
    assert received.status_code == 200, received.text
    assert received.json()["received_by_employee_name"] == "Admin"
    assert received.json()["received_ingredient_id"] == dest["id"]

    in_moves = db.execute(select(StockMovement).where(StockMovement.store_id == norte.id)).scalars().all()
    assert len(in_moves) == 1
    move = in_moves[0]
    assert move.cause is MovementCause.TRANSFER_IN
    assert move.qty_base == 3000
    # Mismo costo con que salió ($12/g), no el oficial de la sede destino ($15).
    assert move.cost_micros == 12_000_000
    assert move.cost_source is CostSource.OFFICIAL
    assert hooks.current_stock(db, store_id=norte.id, ingredient_id=dest["id"]) == 3000

    again = admin_client.post(
        f"{API}/admin/transfers/{waste_id}/receive", params={"store_id": norte.id},
        json={"ingredient_id": dest["id"]}, headers=_idem(),
    )
    assert again.status_code == 409
    assert again.json()["error"]["code"] == "TRANSFER_ALREADY_RECEIVED"

    assert admin_client.get(f"{API}/admin/transfers/incoming", params={"store_id": norte.id}).json() == []
    history = admin_client.get(
        f"{API}/admin/transfers/incoming", params={"store_id": norte.id, "status": "all"}
    ).json()
    assert [h["id"] for h in history] == [waste_id]
    assert hooks.pending_incoming_transfers(db, store_id=norte.id) == 0

    admin_row = admin_client.get(f"{API}/admin/waste", params={"store_id": store.id}).json()["items"][0]
    assert admin_row["type"] == "transfer_out"
    assert admin_row["received_by_employee_name"] == "Admin"


def test_transfer_routes_respect_the_waste_flag(
    ready: None, set_feature: Callable[..., None], device_client: TestClient,
    admin_client: TestClient, store: Store,
) -> None:
    set_feature("inventory.waste", False)
    assert device_client.get(f"{API}/device/waste/transfer-stores").json()["error"]["code"] == "FEATURE_DISABLED"
    resp = admin_client.get(f"{API}/admin/transfers/incoming", params={"store_id": store.id})
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "FEATURE_DISABLED"


# ---------------------------------------------------------------------------
# No son pérdida.
# ---------------------------------------------------------------------------


def test_explained_outflows_do_not_count_in_the_weekly_kpi_nor_in_control_health(
    ready: None, device_client: TestClient, admin_client: TestClient, set_feature: Callable[..., None],
    create_ingredient: Callable[..., dict[str, Any]], db: Session, org: Organization, store: Store,
    employees: dict[str, Employee], clock: Any, identify: Callable[..., Any],
) -> None:
    set_feature("inventory.counts", True)
    set_feature("inventory.variance", True)
    clock.set(datetime(2026, 5, 5, 12, tzinfo=timezone.utc))
    identify(device_client, employees["operator"])
    norte = _add_store(db, org, "Sede Norte")
    ingredient_id = create_ingredient(name="Leche", official_cost="4", min_stock="10")["id"]
    business_date = tz.today_business_date(store.cutoff_hour)
    hooks.record_movement(
        db, organization_id=store.organization_id, store_id=store.id, ingredient_id=ingredient_id,
        qty_base=100_000, cause=MovementCause.PURCHASE, cost_micros=10_000_000, cost_source=CostSource.OFFICIAL,
        actor=_actor(store, employees["admin"]), business_date=business_date, at=clock.now(),
    )
    db.commit()

    assert _post_waste(device_client, ingredient_id=ingredient_id, type="internal_use", consumer_name="dueño", qty="50").status_code == 201
    assert _post_waste(device_client, ingredient_id=ingredient_id, type="transfer_out", destination_store_id=norte.id, qty="40").status_code == 201

    kpi = admin_client.get(f"{API}/admin/waste", params={"store_id": store.id}).json()["weekly_kpi"]
    assert kpi["ratio"] == 0  # hubo compras y ninguna pérdida: 0 % de verdad, no «sin datos»
    health = admin_client.get(f"{API}/admin/control-health", params={"store_id": store.id}).json()
    assert health["waste_entries_this_week"] == 0

    # Una rotura sí cuenta: $40 de $1.000.
    assert _post_waste(device_client, ingredient_id=ingredient_id, type="breakage", qty="10").status_code == 201
    kpi = admin_client.get(f"{API}/admin/waste", params={"store_id": store.id}).json()["weekly_kpi"]
    assert kpi["ratio"] == 400
    health = admin_client.get(f"{API}/admin/control-health", params={"store_id": store.id}).json()
    assert health["waste_entries_this_week"] == 1


def test_explained_outflows_never_trigger_the_waste_spike_alert(
    ready: None, device_client: TestClient, create_ingredient: Callable[..., dict[str, Any]], db: Session,
    clock: Any, identify: Callable[..., Any], employees: dict[str, Employee],
) -> None:
    ingredient_id = create_ingredient(name="Pan")["id"]
    clock.set(datetime(2026, 5, 1, 12, tzinfo=timezone.utc))
    identify(device_client, employees["operator"])
    assert _post_waste(device_client, ingredient_id=ingredient_id, type="breakage", qty="1").status_code == 201
    clock.set(datetime(2026, 5, 9, 12, tzinfo=timezone.utc))
    identify(device_client, employees["operator"])
    assert _post_waste(
        device_client, ingredient_id=ingredient_id, type="internal_use", consumer_name="reunión", qty="100"
    ).status_code == 201
    spikes = db.execute(select(Notification).where(Notification.type == "waste_spike")).scalars().all()
    assert spikes == []


def test_explained_outflows_are_not_variance(
    ready: None, device_client: TestClient, admin_client: TestClient, set_feature: Callable[..., None],
    create_ingredient: Callable[..., dict[str, Any]], db: Session, org: Organization, store: Store,
    employees: dict[str, Employee], clock: Any, identify: Callable[..., Any],
) -> None:
    set_feature("inventory.counts", True)
    set_feature("inventory.variance", True)
    norte = _add_store(db, org, "Sede Norte")
    ingredient_id = create_ingredient(name="Arroz", official_cost="4", min_stock="10")["id"]
    day = datetime(2026, 5, 1, 12, tzinfo=timezone.utc)

    def _count(qty: str) -> dict[str, Any]:
        opened = admin_client.post(f"{API}/admin/counts?store_id={store.id}", json={"scope": "full"}).json()
        admin_client.put(
            f"{API}/admin/counts/{opened['id']}/lines?store_id={store.id}",
            json={"lines": [{"ingredient_id": ingredient_id, "qty_counted": qty, "was_counted": True}]},
        )
        applied = admin_client.post(
            f"{API}/admin/counts/{opened['id']}/apply?store_id={store.id}",
            json={"authorizer_pin": ADMIN_PIN}, headers=_idem(),
        )
        assert applied.status_code == 200, applied.text
        return opened

    clock.set(day)
    _count("100")
    clock.set(day + timedelta(hours=1))
    identify(device_client, employees["operator"])
    # 10 al dueño, 20 a la otra sede, 5 rotos.
    assert _post_waste(device_client, ingredient_id=ingredient_id, type="internal_use", consumer_name="dueño", qty="10").status_code == 201
    assert _post_waste(device_client, ingredient_id=ingredient_id, type="transfer_out", destination_store_id=norte.id, qty="20").status_code == 201
    assert _post_waste(device_client, ingredient_id=ingredient_id, type="breakage", qty="5").status_code == 201
    clock.set(day + timedelta(hours=2))
    count2 = _count("65")

    body = admin_client.get(f"{API}/admin/variance?store_id={store.id}&count_id={count2['id']}").json()
    row = next(r for r in body["rows"] if r["ingredient_id"] == ingredient_id)
    # 100 − 65 = 35 salieron; 30 explicados: el uso real (y la varianza) son los 5 rotos.
    assert row["real_usage_qty"] == "5"
    assert row["variance_qty"] == "5"


def test_the_new_waste_types_are_in_the_enum_and_staff_meal_still_is_not() -> None:
    values = {t.value for t in WasteType}
    assert {"internal_use", "transfer_out"} <= values
    assert "staff_meal" not in values
