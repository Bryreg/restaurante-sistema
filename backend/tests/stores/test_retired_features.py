"""Funciones retiradas del catálogo (`RETIRED_FEATURE_KEYS`): `multi_store` y
`cash.photo_required`. Sus filas viejas quedan en la base sin efecto, y la foto
vieja se pliega en las casillas de la sede sin cambiar lo que se exigía."""

from __future__ import annotations

from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core import clock
from app.core.features import FEATURE_BY_KEY, RETIRED_FEATURE_KEYS, enabled_map
from app.stores import service as stores_service
from app.stores.models import FeatureState, Organization, Store, StoreCashSettings


def _state(db: Session, org: Organization, key: str, enabled: bool, store_id: int | None = None) -> None:
    db.add(
        FeatureState(
            organization_id=org.id,
            store_id=store_id,
            key=key,
            enabled=enabled,
            updated_at=clock.now_utc(),
            updated_by="antes",
        )
    )
    db.flush()


def test_retired_keys_are_out_of_the_catalog_and_ignored(db: Session, org: Organization, store: Store) -> None:
    for key in RETIRED_FEATURE_KEYS:
        assert key not in FEATURE_BY_KEY
    _state(db, org, "multi_store", True)
    flags = enabled_map(db, org.id, store.id)
    assert "multi_store" not in flags
    assert "cash.photo_required" not in flags


def test_put_retired_feature_is_404(admin_client: TestClient) -> None:
    assert admin_client.put("/api/v1/admin/features/multi_store", json={"enabled": True}).status_code == 404
    assert admin_client.put("/api/v1/admin/features/cash.photo_required", json={"enabled": True}).status_code == 404


def test_photo_flag_off_folds_into_store_settings(db: Session, org: Organization, store: Store) -> None:
    # Antes: la función apagada en la sede ganaba sobre las casillas encendidas.
    _state(db, org, "cash.photo_required", False, store_id=store.id)
    row = db.get(StoreCashSettings, store.id)
    assert row is not None and row.photo_required_on_close and row.photo_required_on_pickup

    settings = stores_service.get_cash_settings(db, store.id)
    assert settings.photo_required_on_close is False
    assert settings.photo_required_on_pickup is False

    # Plegado una vez: si el dueño la vuelve a encender en Ajustes › Caja, rige.
    settings.photo_required_on_close = True
    db.flush()
    assert stores_service.get_cash_settings(db, store.id).photo_required_on_close is True


def test_photo_flag_default_by_profile_is_respected(db: Session, org: Organization, store: Store) -> None:
    # Perfil «basic»: la función venía apagada por defecto → la foto no se pedía.
    org.profile = "basic"
    db.flush()
    settings = stores_service.get_cash_settings(db, store.id)
    assert settings.photo_required_on_close is False
    assert settings.photo_required_on_pickup is False
    marker = db.execute(
        select(FeatureState).where(FeatureState.store_id == store.id, FeatureState.key == "cash.photo_required")
    ).scalar_one()
    assert marker.enabled is True


def test_profile_change_does_not_move_the_photo(admin_client: TestClient, db: Session, store: Store) -> None:
    # El perfil «full» tenía la foto encendida; pasar a «basic» (que la tenía
    # apagada por defecto) ya no la apaga: se plegó antes del cambio.
    assert admin_client.post("/api/v1/admin/organization/profile", json={"profile": "basic"}).status_code == 200
    db.expire_all()
    settings = stores_service.get_cash_settings(db, store.id)
    assert settings.photo_required_on_close is True


def test_photo_flag_on_keeps_store_settings(db: Session, org: Organization, store: Store) -> None:
    # Perfil «full» (la función encendida): las casillas no se tocan.
    settings = stores_service.get_cash_settings(db, store.id)
    assert settings.photo_required_on_close is True
    assert settings.photo_required_on_pickup is True

