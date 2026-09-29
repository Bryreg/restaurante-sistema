"""Etiquetas de cocina con QR (`app.labels`, detrás de `inventory.labels`).

Todo entra por HTTP salvo los lotes, que se siembran con el mismo hook que usa
la recepción. Lo que se prueba:
- el «usar antes de» lo calcula el servidor: abierto = hoy + días de abierto
  sin pasarse del lote; recibido = el lote; producido = la vida útil;
- una fecha manual sólo puede ser más corta, y sin regla es obligatoria;
- cada copia es un recipiente con su código; el código se lee con o sin el
  prefijo del QR, en minúsculas o con guiones;
- se acabó / se botó una sola vez, y botar es una merma con PIN que descuenta
  el inventario;
- Hoy avisa lo vencido que sigue en la cocina;
- la función apagada, persona sin identificar y sede ajena.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import Any, Callable
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth.models import Employee
from app.core import clock as clock_module
from app.core import tz
from app.inventory import hooks as inventory_hooks
from app.inventory.models import CostSource, Waste, WasteType
from app.labels.models import FoodLabel
from app.purchases.models import ReceptionDraft, ReceptionDraftLine, ReceptionDraftStatus, Supplier
from app.recipes.models import Preparation, PrepBatch, PrepMode
from app.stores.models import Store

API = "/api/v1"


def _idem() -> dict[str, str]:
    return {"Idempotency-Key": str(uuid4())}


@pytest.fixture()
def labels_on(set_feature: Callable[..., None]) -> None:
    for key in (
        "catalog.recipes",
        "inventory.perpetual",
        "inventory.waste",
        "inventory.lots",
        "inventory.labels",
    ):
        set_feature(key, True)


@pytest.fixture()
def cook(
    labels_on: None, device_client: TestClient, identify: Callable[..., Any], employees: dict[str, Employee]
) -> TestClient:
    resp = identify(device_client, employees["operator"])
    assert resp.status_code == 200, resp.text  # type: ignore[attr-defined]
    return device_client


def _today(store: Store) -> date:
    return tz.today_business_date(store.cutoff_hour)


def _ingredient(admin_client: TestClient, store: Store, *, name: str, opened_days: int | None = None) -> int:
    body: dict[str, Any] = {
        "name": name,
        "category": "Lácteos",
        "base_unit": "g",
        "purchase_unit": "kg",
        "purchase_factor": 1000,
        "official_cost": "10",
        "min_stock": "500",
        "perishable": True,
    }
    if opened_days is not None:
        body["opened_shelf_life_days"] = opened_days
    resp = admin_client.post(f"{API}/admin/ingredients?store_id={store.id}", json=body)
    assert resp.status_code == 201, resp.text
    return int(resp.json()["id"])


def _batch(
    db: Session, store: Store, ingredient_id: int, *, expires_at: date | None, lot: str = "L-001", qty: int = 5_000_000
) -> int:
    now = clock_module.now_utc()
    batch = inventory_hooks.create_stock_batch(
        db,
        organization_id=store.organization_id,
        store_id=store.id,
        ingredient_id=ingredient_id,
        qty_base=qty,
        unit_cost_micros=10_000_000,
        cost_source=CostSource.OFFICIAL,
        lot_code=lot,
        expires_at=expires_at,
        received_at=now,
        business_date=tz.business_date_for(now, store.cutoff_hour),
        source_type="reception",
        source_id=1,
    )
    db.commit()
    return batch.id


def _prep_batch(db: Session, store: Store, employee: Employee, *, shelf_days: int | None) -> int:
    now = clock_module.now_utc()
    today = tz.business_date_for(now, store.cutoff_hour)
    prep = Preparation(
        organization_id=store.organization_id,
        store_id=store.id,
        name="Salsa de la casa",
        mode=PrepMode.BATCH,
        standard_yield_qty=2_000_000,
        standard_yield_unit="ml",
        process_loss_pct=0,
        shelf_life_days=shelf_days,
        active=True,
        created_at=now,
        updated_at=now,
    )
    db.add(prep)
    db.flush()
    batch = PrepBatch(
        organization_id=store.organization_id,
        store_id=store.id,
        preparation_id=prep.id,
        qty_expected=2_000_000,
        qty_real=2_000_000,
        unit="ml",
        variance_pct_x100=0,
        variance_alert=False,
        cost_source="none",
        expiry_date=today + timedelta(days=shelf_days) if shelf_days is not None else None,
        produced_by_employee_id=employee.id,
        produced_by_employee_name=employee.name,
        produced_at=now,
        business_date=today,
    )
    db.add(batch)
    db.commit()
    return batch.id


def _draft_line(
    db: Session, store: Store, employee: Employee, ingredient_id: int, *, expires_at: date | None, lot: str | None
) -> tuple[int, int]:
    """Lo que la tablet registra al recibir: un borrador pendiente con su
    renglón (lote y vencimiento incluidos). El lote de inventario todavía no
    existe: nace cuando el administrador lo completa."""
    now = clock_module.now_utc()
    supplier = Supplier(
        organization_id=store.organization_id, store_id=store.id, name="Lácteos San Fernando",
        payment_term_days=0, invoices_required=False, active=True, created_at=now, updated_at=now,
    )
    db.add(supplier)
    db.flush()
    draft = ReceptionDraft(
        organization_id=store.organization_id, store_id=store.id, supplier_id=supplier.id, invoice_number=None,
        no_invoice=True, photo="photo:1", status=ReceptionDraftStatus.PENDING, created_by_employee_id=employee.id,
        created_by_employee_name=employee.name, created_at=now,
        business_date=tz.business_date_for(now, store.cutoff_hour),
    )
    db.add(draft)
    db.flush()
    line = ReceptionDraftLine(
        draft_id=draft.id, ingredient_id=ingredient_id, qty_purchase_milli=2000, purchase_unit="kg",
        purchase_factor=1000, qty_base=2_000_000, lot_code=lot, expires_at=expires_at,
    )
    db.add(line)
    db.commit()
    return draft.id, line.id


def _print(client: TestClient, **body: Any) -> Any:
    return client.post(f"{API}/labels", json=body, headers=_idem())


# ---------------------------------------------------------------------------
# El «usar antes de».
# ---------------------------------------------------------------------------


def test_abierto_vence_con_los_dias_de_abierto_sin_pasarse_del_lote(
    cook: TestClient, admin_client: TestClient, store: Store, db: Session
) -> None:
    today = _today(store)
    queso = _ingredient(admin_client, store, name="Queso mozzarella", opened_days=5)
    _batch(db, store, queso, expires_at=today + timedelta(days=30), lot="QZ-77")

    resp = _print(cook, kind="opened", ingredient_id=queso, qty_text="1 kg")
    assert resp.status_code == 201, resp.text
    [label] = resp.json()["labels"]
    assert label["use_by"] == (today + timedelta(days=5)).isoformat()
    assert label["use_by_source"] == "opened_shelf_life"
    assert label["lot_code"] == "QZ-77"
    assert label["item_name"] == "Queso mozzarella"
    assert label["employee_name"] == "Operator"
    assert label["days_left"] == 5 and label["state"] == "ok"
    assert label["waste_unit"] == "kg"

    # Un lote que vence ANTES que los días de abierto manda: lo que llegue primero.
    crema = _ingredient(admin_client, store, name="Crema de leche", opened_days=5)
    _batch(db, store, crema, expires_at=today + timedelta(days=2), lot="CR-1")
    [label2] = _print(cook, kind="opened", ingredient_id=crema).json()["labels"]
    assert label2["use_by"] == (today + timedelta(days=2)).isoformat()
    assert label2["use_by_source"] == "supplier"

    # Abrir no mueve inventario: el consumo lo descuenta la receta.
    assert inventory_hooks.current_stock(db, store_id=store.id, ingredient_id=queso) == 0


def test_sin_regla_la_fecha_es_obligatoria_y_nunca_puede_ser_mas_larga(
    cook: TestClient, admin_client: TestClient, store: Store, db: Session
) -> None:
    today = _today(store)
    salsa = _ingredient(admin_client, store, name="Salsa negra")

    missing = _print(cook, kind="opened", ingredient_id=salsa)
    assert missing.status_code == 400
    assert missing.json()["error"]["code"] == "LABEL_USE_BY_REQUIRED"
    assert db.execute(select(FoodLabel)).first() is None

    manual = _print(cook, kind="opened", ingredient_id=salsa, use_by=(today + timedelta(days=10)).isoformat())
    assert manual.status_code == 201, manual.text
    assert manual.json()["labels"][0]["use_by_source"] == "manual"

    past = _print(cook, kind="opened", ingredient_id=salsa, use_by=(today - timedelta(days=1)).isoformat())
    assert past.status_code == 400

    leche = _ingredient(admin_client, store, name="Leche", opened_days=3)
    too_late = _print(cook, kind="opened", ingredient_id=leche, use_by=(today + timedelta(days=4)).isoformat())
    assert too_late.status_code == 400
    assert too_late.json()["error"]["code"] == "LABEL_USE_BY_TOO_LATE"

    shorter = _print(cook, kind="opened", ingredient_id=leche, use_by=(today + timedelta(days=1)).isoformat())
    assert shorter.status_code == 201
    assert shorter.json()["labels"][0]["use_by"] == (today + timedelta(days=1)).isoformat()
    assert shorter.json()["labels"][0]["use_by_source"] == "manual"


def test_recibido_lleva_el_vencimiento_del_lote_o_sin_vencimiento(
    cook: TestClient, admin_client: TestClient, store: Store, db: Session
) -> None:
    today = _today(store)
    pollo = _ingredient(admin_client, store, name="Pechuga")
    arroz = _ingredient(admin_client, store, name="Arroz")
    b_pollo = _batch(db, store, pollo, expires_at=today + timedelta(days=4), lot="PO-9")
    b_arroz = _batch(db, store, arroz, expires_at=None, lot=None)  # type: ignore[arg-type]

    resp = _print(cook, kind="received", stock_batch_id=b_pollo, copies=3)
    assert resp.status_code == 201, resp.text
    labels = resp.json()["labels"]
    assert len(labels) == 3
    assert len({lab["code"] for lab in labels}) == 3
    assert all(lab["use_by"] == (today + timedelta(days=4)).isoformat() for lab in labels)
    assert all(lab["use_by_source"] == "supplier" for lab in labels)

    [sin] = _print(cook, kind="received", stock_batch_id=b_arroz).json()["labels"]
    assert sin["use_by"] is None and sin["state"] == "no_date"

    sources = cook.get(f"{API}/device/labels/sources")
    assert sources.status_code == 200, sources.text
    received = {r["stock_batch_id"]: r for r in sources.json()["received"]}
    assert received[b_pollo]["labels_printed"] == 3
    assert received[b_arroz]["labels_printed"] == 1
    assert received[b_pollo]["qty_received"] == "5000" and received[b_pollo]["unit"] == "g"


def test_lo_recibido_en_la_tablet_se_etiqueta_en_la_puerta_antes_de_completarlo(
    cook: TestClient, admin_client: TestClient, store: Store, db: Session, employees: dict[str, Employee]
) -> None:
    today = _today(store)
    queso = _ingredient(admin_client, store, name="Queso campesino")
    draft_id, line_id = _draft_line(
        db, store, employees["operator"], queso, expires_at=today + timedelta(days=6), lot="SF-12"
    )

    sources = cook.get(f"{API}/device/labels/sources").json()["received"]
    [row] = [r for r in sources if r["reception_draft_line_id"] == line_id]
    assert row["pending"] is True and row["stock_batch_id"] is None
    assert row["qty_received"] == "2" and row["unit"] == "kg" and row["lot_code"] == "SF-12"

    resp = _print(cook, kind="received", reception_draft_line_id=line_id, copies=2)
    assert resp.status_code == 201, resp.text
    labels = resp.json()["labels"]
    assert {lab["use_by"] for lab in labels} == {(today + timedelta(days=6)).isoformat()}
    assert {lab["lot_code"] for lab in labels} == {"SF-12"}
    assert {lab["reception_draft_line_id"] for lab in labels} == {line_id}

    sources = cook.get(f"{API}/device/labels/sources").json()["received"]
    assert [r["labels_printed"] for r in sources if r["reception_draft_line_id"] == line_id] == [2]

    # Uno de los dos, nunca los dos ni ninguno.
    assert _print(cook, kind="received").status_code == 400

    # Una recepción rechazada no se etiqueta.
    draft = db.get(ReceptionDraft, draft_id)
    assert draft is not None
    draft.status = ReceptionDraftStatus.REJECTED
    db.commit()
    rejected = _print(cook, kind="received", reception_draft_line_id=line_id)
    assert rejected.status_code == 409
    assert all(r["reception_draft_line_id"] != line_id for r in cook.get(f"{API}/device/labels/sources").json()["received"])


def test_producido_lleva_la_vida_util_de_la_preparacion(
    cook: TestClient, store: Store, db: Session, employees: dict[str, Employee]
) -> None:
    today = _today(store)
    with_life = _prep_batch(db, store, employees["operator"], shelf_days=3)
    [label] = _print(cook, kind="produced", prep_batch_id=with_life, qty_text="500 ml", copies=1).json()["labels"]
    assert label["use_by"] == (today + timedelta(days=3)).isoformat()
    assert label["use_by_source"] == "prep_shelf_life"
    assert label["lot_code"] == f"P{with_life}"
    assert label["waste_unit"] == "ml"

    without = _prep_batch(db, store, employees["operator"], shelf_days=None)
    resp = _print(cook, kind="produced", prep_batch_id=without)
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "LABEL_USE_BY_REQUIRED"

    produced = {p["prep_batch_id"]: p for p in cook.get(f"{API}/device/labels/sources").json()["produced"]}
    assert produced[with_life]["labels_printed"] == 1
    assert produced[without]["labels_printed"] == 0


# ---------------------------------------------------------------------------
# Leer, acabar, botar.
# ---------------------------------------------------------------------------


def test_el_codigo_se_lee_con_prefijo_minusculas_o_guiones(
    cook: TestClient, admin_client: TestClient, store: Store, db: Session
) -> None:
    queso = _ingredient(admin_client, store, name="Queso", opened_days=5)
    [label] = _print(cook, kind="opened", ingredient_id=queso).json()["labels"]
    code = label["code"]
    assert len(code) == 8

    for raw in (code, code.lower(), f"ET-{code}", f"et{code.lower()}", f"{code[:4]}-{code[4:]}"):
        resp = cook.get(f"{API}/device/labels/{raw}")
        assert resp.status_code == 200, (raw, resp.text)
        assert resp.json()["id"] == label["id"]

    assert cook.get(f"{API}/device/labels/ZZZZZZZZ").status_code == 404


def test_se_acabo_cierra_una_sola_vez_y_sale_del_tablero(
    cook: TestClient, admin_client: TestClient, store: Store
) -> None:
    queso = _ingredient(admin_client, store, name="Queso", opened_days=5)
    [label] = _print(cook, kind="opened", ingredient_id=queso).json()["labels"]

    board = cook.get(f"{API}/device/labels").json()
    assert [lab["code"] for lab in board["labels"]] == [label["code"]]

    done = cook.post(f"{API}/labels/{label['code']}/finish", json={"outcome": "used_up"}, headers=_idem())
    assert done.status_code == 200, done.text
    assert done.json()["status"] == "used_up"
    assert done.json()["closed_by_employee_name"] == "Operator"

    again = cook.post(f"{API}/labels/{label['code']}/finish", json={"outcome": "used_up"}, headers=_idem())
    assert again.status_code == 409
    assert again.json()["error"]["code"] == "LABEL_ALREADY_CLOSED"
    assert cook.get(f"{API}/device/labels").json()["labels"] == []

    reprint = cook.post(f"{API}/labels/{label['code']}/reprint", headers=_idem())
    assert reprint.status_code == 409


def test_botar_es_una_merma_con_pin_que_descuenta_el_inventario(
    cook: TestClient, admin_client: TestClient, store: Store, db: Session
) -> None:
    queso = _ingredient(admin_client, store, name="Queso", opened_days=5)
    [label] = _print(cook, kind="opened", ingredient_id=queso).json()["labels"]
    url = f"{API}/labels/{label['code']}/finish"

    no_pin = cook.post(url, json={"outcome": "discarded", "qty": "0.5"}, headers=_idem())
    assert no_pin.status_code == 400

    wrong = cook.post(url, json={"outcome": "discarded", "qty": "0.5", "employee_pin": "0000"}, headers=_idem())
    assert wrong.status_code == 400
    assert wrong.json()["error"]["code"] == "AUTHORIZATION_INVALID"
    db.expire_all()
    assert db.execute(select(FoodLabel).where(FoodLabel.code == label["code"])).scalar_one().status.value == "active"
    assert db.execute(select(Waste)).first() is None

    ok = cook.post(
        url,
        json={"outcome": "discarded", "qty": "0.5", "employee_pin": "5555", "note": "olía raro"},
        headers=_idem(),
    )
    assert ok.status_code == 200, ok.text
    body = ok.json()
    assert body["status"] == "discarded"
    assert body["closed_by_employee_name"] == "Supervisor"  # quien puso el PIN
    waste = db.execute(select(Waste)).scalar_one()
    assert body["waste_id"] == waste.id
    assert waste.type is WasteType.EXPIRED
    assert waste.qty_base == 500_000  # 0,5 kg en milésimas de gramo
    assert label["code"] in (waste.note or "")
    assert inventory_hooks.current_stock(db, store_id=store.id, ingredient_id=queso) == -500_000


def test_botar_con_la_merma_apagada_solo_cierra_la_etiqueta(
    cook: TestClient, admin_client: TestClient, store: Store, db: Session, set_feature: Callable[..., None]
) -> None:
    queso = _ingredient(admin_client, store, name="Queso", opened_days=5)
    [label] = _print(cook, kind="opened", ingredient_id=queso).json()["labels"]
    set_feature("inventory.waste", False)
    resp = cook.post(f"{API}/labels/{label['code']}/finish", json={"outcome": "discarded"}, headers=_idem())
    assert resp.status_code == 200, resp.text
    assert resp.json()["waste_id"] is None
    assert db.execute(select(Waste)).first() is None


# ---------------------------------------------------------------------------
# Tablero, Hoy, admin.
# ---------------------------------------------------------------------------


def test_el_tablero_ordena_por_vencimiento_y_hoy_avisa_lo_vencido(
    cook: TestClient, admin_client: TestClient, store: Store, db: Session
) -> None:
    today = _today(store)
    leche = _ingredient(admin_client, store, name="Leche", opened_days=1)
    queso = _ingredient(admin_client, store, name="Queso", opened_days=4)
    _print(cook, kind="opened", ingredient_id=queso)
    [leche_label] = _print(cook, kind="opened", ingredient_id=leche).json()["labels"]

    board = cook.get(f"{API}/device/labels").json()
    assert [lab["item_name"] for lab in board["labels"]] == ["Leche", "Queso"]
    assert board["tomorrow"] == 1 and board["expired"] == 0

    hoy = admin_client.get(f"{API}/admin/today?store_id={store.id}")
    assert hoy.status_code == 200, hoy.text
    assert hoy.json()["labels_expired"] == {"expired": 0, "due_today": 0, "expired_names": []}

    # Pasan los días: la leche quedó en la nevera con la fecha vencida. Se
    # simula moviendo la fecha congelada, no el reloj (la sesión del
    # dispositivo vive en el reloj real).
    row = db.execute(select(FoodLabel).where(FoodLabel.code == leche_label["code"])).scalar_one()
    row.use_by = today - timedelta(days=1)
    db.commit()

    board = cook.get(f"{API}/device/labels").json()
    assert board["labels"][0]["item_name"] == "Leche"
    assert board["labels"][0]["state"] == "expired" and board["labels"][0]["days_left"] == -1
    assert board["expired"] == 1

    hoy = admin_client.get(f"{API}/admin/today?store_id={store.id}").json()
    assert hoy["labels_expired"] == {"expired": 1, "due_today": 0, "expired_names": ["Leche"]}


def test_admin_lista_descarga_y_configura_el_tamano(
    cook: TestClient, admin_client: TestClient, store: Store
) -> None:
    queso = _ingredient(admin_client, store, name="Queso", opened_days=5)
    _print(cook, kind="opened", ingredient_id=queso, copies=2)

    rows = admin_client.get(f"{API}/admin/labels?store_id={store.id}&status=all")
    assert rows.status_code == 200, rows.text
    assert len(rows.json()) == 2
    csv = admin_client.get(f"{API}/admin/labels?store_id={store.id}&status=all&format=csv")
    assert csv.status_code == 200
    assert csv.headers["content-type"].startswith("text/csv")

    assert admin_client.get(f"{API}/admin/stores/{store.id}/label-settings").json() == {
        "store_id": store.id,
        "width_mm": 50,
        "height_mm": 30,
    }
    bad = admin_client.put(f"{API}/admin/stores/{store.id}/label-settings", json={"width_mm": 10, "height_mm": 30})
    assert bad.status_code in (400, 422)
    put = admin_client.put(f"{API}/admin/stores/{store.id}/label-settings", json={"width_mm": 62, "height_mm": 29})
    assert put.status_code == 200, put.text
    assert cook.get(f"{API}/device/labels/settings").json()["width_mm"] == 62


def test_dias_de_abierto_se_guardan_y_se_borran_en_el_insumo(admin_client: TestClient, store: Store, labels_on: None) -> None:
    queso = _ingredient(admin_client, store, name="Queso", opened_days=5)
    url = f"{API}/admin/ingredients/{queso}?store_id={store.id}"
    listed = {i["id"]: i for i in admin_client.get(f"{API}/admin/ingredients?store_id={store.id}").json()}
    assert listed[queso]["opened_shelf_life_days"] == 5
    assert admin_client.patch(url, json={"opened_shelf_life_days": 7}).json()["opened_shelf_life_days"] == 7
    assert admin_client.patch(url, json={"clear_opened_shelf_life": True}).json()["opened_shelf_life_days"] is None


# ---------------------------------------------------------------------------
# Permisos y función apagada.
# ---------------------------------------------------------------------------


def test_apagada_sin_persona_y_sede_ajena(
    labels_on: None,
    device_client: TestClient,
    admin_client: TestClient,
    identify: Callable[..., Any],
    employees: dict[str, Employee],
    store: Store,
    store_b: Store,
    set_feature: Callable[..., None],
) -> None:
    queso = _ingredient(admin_client, store, name="Queso", opened_days=5)

    anon = _print(device_client, kind="opened", ingredient_id=queso)
    assert anon.status_code == 401
    assert anon.json()["error"]["code"] == "IDENTIFY_REQUIRED"

    identify(device_client, employees["operator"])
    assert admin_client.get(f"{API}/admin/labels?store_id={store_b.id}").status_code == 404

    set_feature("inventory.labels", False)
    off = _print(device_client, kind="opened", ingredient_id=queso)
    assert off.status_code == 400
    assert off.json()["error"]["code"] == "FEATURE_DISABLED"
    assert device_client.get(f"{API}/device/labels").status_code == 400
    hoy = admin_client.get(f"{API}/admin/today?store_id={store.id}").json()
    assert hoy["labels_expired"] is None
