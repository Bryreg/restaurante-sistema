"""`app.core.features`: catálogo, defaults por perfil y el gate de flags."""

from __future__ import annotations

from typing import Any

import pytest
from sqlalchemy.orm import Session

from app.core.errors import AppError
from app.core.features import FEATURE_CATALOG, assert_feature, enabled_map, is_enabled
from app.stores.models import Organization, Store


def test_every_catalog_key_has_the_three_profiles() -> None:
    for f in FEATURE_CATALOG:
        assert set(f.defaults.keys()) == {"basic", "standard", "full"}


def test_profile_basic_matches_spec_1_2(db: Session, org: Organization, store: Store) -> None:
    org.profile = "basic"
    db.flush()
    flags = enabled_map(db, org.id, None)
    for f in FEATURE_CATALOG:
        assert flags[f.key] == f.defaults["basic"], f.key


def test_profile_full_enables_everything(db: Session, org: Organization, store: Store) -> None:
    org.profile = "full"
    db.flush()
    flags = enabled_map(db, org.id, None)
    for f in FEATURE_CATALOG:
        assert flags[f.key] == f.defaults["full"], f.key


def test_assert_feature_raises_feature_disabled(db: Session, org: Organization, store: Store) -> None:
    org.profile = "basic"
    db.flush()
    with pytest.raises(AppError) as exc_info:
        assert_feature(db, org.id, None, "pos.tables")
    assert exc_info.value.code == "FEATURE_DISABLED"
    assert exc_info.value.extra["feature"] == "pos.tables"


def test_store_override_wins_over_org_level(
    db: Session, org: Organization, store: Store, set_feature: Any
) -> None:
    org.profile = "basic"
    db.flush()
    assert is_enabled(db, org.id, store.id, "pos.tables") is False

    set_feature("pos.tables", True, store_id=store.id)
    assert is_enabled(db, org.id, store.id, "pos.tables") is True
    # A nivel de organización (sin sede) sigue apagado.
    assert is_enabled(db, org.id, None, "pos.tables") is False


def test_unknown_organization_is_not_found(db: Session) -> None:
    with pytest.raises(Exception):
        enabled_map(db, 999999, None)
