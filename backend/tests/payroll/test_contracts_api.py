"""Contrato, novedades y parámetros legales por HTTP, y su efecto en la
liquidación y en el costo de nómina de la utilidad."""

from __future__ import annotations

from datetime import date
from typing import Any
from uuid import uuid4

from fastapi.testclient import TestClient

API = "/api/v1"


def _post(c: TestClient, path: str, store_id: int | None, body: dict[str, Any]) -> Any:
    params = {"store_id": store_id} if store_id is not None else {}
    return c.post(f"{API}{path}", params=params, json=body, headers={"Idempotency-Key": str(uuid4())})


def test_a_monthly_contract_is_paid_without_clocking_in(
    admin_client: TestClient, store: Any, employees: dict[str, Any], seed_surcharge_table: Any, clock: Any,
) -> None:
    seed_surcharge_table(admin_client, store_id=store.id, valid_from=date(2024, 1, 1), weekly_ordinary_hours=42)
    cook = employees["operator"]
    r = _post(admin_client, "/admin/payroll/contracts", store.id, {
        "employee_id": cook.id, "kind": "indefinite", "salary_type": "monthly",
        "monthly_salary_pesos": 1_750_905, "start_date": "2026-01-01"})
    assert r.status_code == 201, r.text
    assert r.json()["kind"] == "indefinite"

    sick = _post(admin_client, "/admin/payroll/absences", store.id, {
        "employee_id": cook.id, "kind": "sick_leave", "date_from": "2026-06-10", "date_to": "2026-06-13"})
    assert sick.status_code == 201, sick.text
    assert sick.json()["days"] == 4
    overlap = _post(admin_client, "/admin/payroll/absences", store.id, {
        "employee_id": cook.id, "kind": "vacation", "date_from": "2026-06-12", "date_to": "2026-06-20"})
    assert overlap.status_code == 409

    run = admin_client.post(f"{API}/admin/payroll/runs", params={"store_id": store.id},
                            json={"date_from": "2026-06-01", "date_to": "2026-06-30"},
                            headers={"Idempotency-Key": str(uuid4())})
    assert run.status_code == 201, run.text
    line = next(l for l in run.json()["lines"] if l["employee_id"] == cook.id)
    assert line["absence_days"] == 4
    assert line["recoverable"] == 2 * 58_364
    assert line["transport_allowance"] > 0
    assert line["employer_total"] > line["total"]
    assert run.json()["employer_total_amount"] is not None

    # Anular la novedad: nada se borra y deja de contar.
    void = admin_client.post(f"{API}/admin/payroll/absences/{sick.json()['id']}/void",
                             params={"store_id": store.id}, json={"reason": "Se cargó a la persona equivocada"},
                             headers={"Idempotency-Key": str(uuid4())})
    assert void.status_code == 200, void.text
    assert void.json()["voided_by_employee_name"]
    listed = admin_client.get(f"{API}/admin/payroll/absences", params={"store_id": store.id}).json()
    assert listed[0]["voided_at"] is not None


def test_legal_params_list_and_override(admin_client: TestClient) -> None:
    rows = admin_client.get(f"{API}/admin/payroll/legal-params").json()
    assert rows[0]["valid_from"] == "2026-01-01" and rows[0]["source"] == "ley"
    assert rows[0]["smmlv_pesos"] == 1_750_905
    r = _post(admin_client, "/admin/payroll/legal-params", None, {
        "valid_from": "2026-01-01", "smmlv_pesos": 1_750_905, "transport_allowance_pesos": 249_095})
    assert r.status_code == 201, r.text
    rows = admin_client.get(f"{API}/admin/payroll/legal-params").json()
    assert rows[0]["source"] == "organizacion" and rows[0]["confirmed_by_name"]


def test_monthly_contract_needs_a_salary(admin_client: TestClient, store: Any, employees: dict[str, Any]) -> None:
    r = _post(admin_client, "/admin/payroll/contracts", store.id, {
        "employee_id": employees["operator"].id, "kind": "indefinite", "salary_type": "monthly",
        "start_date": "2026-01-01"})
    assert r.status_code == 400


def test_organization_payroll_sums_every_store(
    admin_client: TestClient, store: Any, employees: dict[str, Any], seed_surcharge_table: Any,
) -> None:
    seed_surcharge_table(admin_client, store_id=store.id, valid_from=date(2024, 1, 1))
    _post(admin_client, "/admin/payroll/contracts", store.id, {
        "employee_id": employees["operator"].id, "kind": "indefinite", "salary_type": "monthly",
        "monthly_salary_pesos": 2_000_000, "start_date": "2026-01-01"})
    body = admin_client.get(f"{API}/admin/payroll/organization", params={"from": "2026-06-01", "to": "2026-06-30"}).json()
    row = next(s for s in body["stores"] if s["store_id"] == store.id)
    assert row["people"] >= 1 and row["employer_total"] is not None
    person = next(p for p in body["people"] if p["employee_id"] == employees["operator"].id)
    assert person["stores"] == [store.name]
    assert person["total"] >= 2_000_000
