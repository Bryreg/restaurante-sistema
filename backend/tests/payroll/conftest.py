"""Fixtures propias de `tests/payroll/**`.

`"payroll"` ya está en `app.main.DOMAINS`/`app.core.models_registry
.MODEL_MODULES` (paso 0 del pedido, hecho por el orquestador humano): el
router se monta solo a través de `app.main.create_app()` — nunca se
remonta acá (`Duplicate Operation ID`).

El perfil `"full"` de la fixture compartida `org` (`tests/conftest.py`) ya
deja `payroll` y `pos.tips` ENCENDIDAS por default
(`app.core.features.FEATURE_CATALOG`): los tests que necesitan la función
APAGADA la apagan explícitamente con `set_feature`, y ningún test asume el
default encendido como su única precondición para el resto (se arma
explícitamente donde hace falta, `docs/CONTEXTO-AGENTES.md §11`).

**Excepción declarada al "todo entra por HTTP"** (`docs/CONTEXTO-AGENTES.md
§11`): estos tests siguen usando la puerta HTTP real para toda escritura
(`POST /shifts/{id}/roster` para la jornada, `POST /admin/payroll/...` para
la configuración de este dominio) — no hay ninguna excepción de escritura
directa a la base acá.
"""

from __future__ import annotations

import uuid
from collections.abc import Callable
from datetime import date, datetime, timedelta, timezone
from typing import Any

import pytest
from fastapi.testclient import TestClient

# Bogotá es UTC-5 todo el año (sin horario de verano): un instante "de pared"
# en Bogotá corresponde a `pared + 5h` en UTC.
BOGOTA_OFFSET = timedelta(hours=5)


def bogota_utc(year: int, month: int, day: int, hour: int, minute: int = 0) -> datetime:
    """Instante UTC (aware) que corresponde a esa hora de PARED en Bogotá."""
    return datetime(year, month, day, hour, minute, tzinfo=timezone.utc) + BOGOTA_OFFSET


def idem_headers() -> dict[str, str]:
    return {"Idempotency-Key": str(uuid.uuid4())}


@pytest.fixture()
def seed_surcharge_table() -> Callable[..., dict[str, Any]]:
    def _seed(
        admin_client: TestClient,
        *,
        store_id: int,
        valid_from: date,
        night_start_hour: int = 19,
        night_end_hour: int = 6,
        night_surcharge_bp: int = 3500,
        sunday_holiday_surcharge_bp: int = 8000,
        overtime_surcharge_bp: int = 2500,
        weekly_ordinary_hours: int = 46,
    ) -> dict[str, Any]:
        resp = admin_client.post(
            "/api/v1/admin/payroll/surcharge-tables",
            params={"store_id": store_id},
            json={
                "valid_from": valid_from.isoformat(),
                "night_start_hour": night_start_hour,
                "night_end_hour": night_end_hour,
                "night_surcharge_bp": night_surcharge_bp,
                "sunday_holiday_surcharge_bp": sunday_holiday_surcharge_bp,
                "overtime_surcharge_bp": overtime_surcharge_bp,
                "weekly_ordinary_hours": weekly_ordinary_hours,
            },
            headers=idem_headers(),
        )
        assert resp.status_code == 201, resp.text
        return resp.json()  # type: ignore[no-any-return]

    return _seed


@pytest.fixture()
def seed_wage() -> Callable[..., dict[str, Any]]:
    def _seed(
        admin_client: TestClient, *, store_id: int, employee_id: int, hourly_wage_pesos: int, valid_from: date
    ) -> dict[str, Any]:
        resp = admin_client.post(
            "/api/v1/admin/payroll/wages",
            params={"store_id": store_id},
            json={
                "employee_id": employee_id,
                "hourly_wage_pesos": hourly_wage_pesos,
                "valid_from": valid_from.isoformat(),
            },
            headers=idem_headers(),
        )
        assert resp.status_code == 201, resp.text
        return resp.json()  # type: ignore[no-any-return]

    return _seed


@pytest.fixture()
def roster_action() -> Callable[..., Any]:
    def _act(device_client: TestClient, *, shift_id: int, employee_id: int, action: str, pin: str) -> Any:
        resp = device_client.post(
            f"/api/v1/shifts/{shift_id}/roster",
            json={"employee_id": employee_id, "action": action, "pin": pin},
        )
        assert resp.status_code == 200, resp.text
        return resp

    return _act
