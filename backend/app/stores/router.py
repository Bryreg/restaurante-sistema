"""Organización, funciones, sedes y su configuración; zonas y mesas."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Request
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.audit.service import record_audit
from app.auth.deps import Actor, admin_store, current_admin, current_device
from app.core import clock
from app.core.csv import csv_response, wants_csv
from app.core.db import get_db
from app.core.errors import AppError, NotFoundError
from app.core.features import FEATURE_BY_KEY, FEATURE_CATALOG, enabled_map, profile_defaults
from app.core.security import hash_secret
from app.stores.models import (
    FeatureState,
    Organization,
    Store,
    StoreCashSettings,
    StoreFiscalConfig,
    StoreSalesSettings,
    Table,
    UvtValue,
    Zone,
)
from app.stores.schemas import (
    CashSettingsIn,
    CashSettingsOut,
    DeviceTableOut,
    FeatureOut,
    FeatureSetIn,
    FiscalIn,
    FiscalOut,
    OrganizationOut,
    OrganizationUpdateIn,
    ProfileSetIn,
    RotatePinIn,
    SalesSettingsIn,
    SalesSettingsOut,
    StoreCreateIn,
    StoreOut,
    StoreUpdateIn,
    TableCreateIn,
    TableOut,
    TableUpdateIn,
    UvtEntry,
    ZoneCreateIn,
    ZoneOut,
    ZoneUpdateIn,
)
from app.stores.service import current_fiscal, get_cash_settings, get_sales_settings

router = APIRouter()

# Capacidades que no son un flag (ley o integridad): existen para que
# `PUT /admin/features/{key}` distinga "no existe" de "esto no se apaga".
CORE_CAPABILITY_KEYS = {
    "audit",
    "idempotency",
    "snapshot_pricing",
    "business_date",
    "sequential_numbering",
    "typed_cause",
    "fiscal_document",
}


# ---------------------------------------------------------------------------
# Helpers de salida (nunca devuelven `pin_hash`/`store_pin_hash`).
# ---------------------------------------------------------------------------


def _organization_out(org: Organization) -> OrganizationOut:
    declared = None
    if org.declared_not_obliged_at is not None:
        declared = {"at": org.declared_not_obliged_at.isoformat(), "by": org.declared_not_obliged_by}
    return OrganizationOut(id=org.id, name=org.name, profile=org.profile, declared_not_obliged_to_invoice=declared)


def _store_out(store: Store) -> StoreOut:
    return StoreOut(
        id=store.id,
        name=store.name,
        nit=store.nit,
        dv=store.dv,
        legal_name=store.legal_name,
        address=store.address,
        municipality_dane=store.municipality_dane,
        opening_hours=list(store.opening_hours),
        cutoff_hour=store.cutoff_hour,
        active_channels=list(store.active_channels),
        active=store.active,
    )


def _fiscal_out(row: StoreFiscalConfig) -> FiscalOut:
    return FiscalOut(
        id=row.id,
        valid_from=row.valid_from,
        person_type=row.person_type,  # type: ignore[arg-type]
        regime=row.regime,  # type: ignore[arg-type]
        franchise=row.franchise,
        inc_responsible=row.inc_responsible,
        iva_responsible=row.iva_responsible,
        rut_codes=list(row.rut_codes),
        price_includes_tax=row.price_includes_tax,
        default_tax=row.default_tax,  # type: ignore[arg-type]
    )


def _cash_settings_out(row: StoreCashSettings) -> CashSettingsOut:
    return CashSettingsOut(
        opening_cash_fixed=row.opening_cash_fixed,
        cash_reserve_default=row.cash_reserve_default,
        tolerance_unknown_cause=row.tolerance_unknown_cause,
        tolerance_identified_cause=row.tolerance_identified_cause,
        critical_difference=row.critical_difference,
        cash_pickup_threshold=row.cash_pickup_threshold,
        petty_cash_limit=row.petty_cash_limit,
        photo_required_on_close=row.photo_required_on_close,
        photo_required_on_pickup=row.photo_required_on_pickup,
        streak_alert_shifts=row.streak_alert_shifts,
    )


def _sales_settings_out(row: StoreSalesSettings) -> SalesSettingsOut:
    return SalesSettingsOut(
        tip_suggested_pct=float(row.tip_suggested_pct),
        discount_limit_pct=float(row.discount_limit_pct),
        discount_daily_limit_pct=float(row.discount_daily_limit_pct),
        courtesy_shift_limit=row.courtesy_shift_limit,
        payment_methods=list(row.payment_methods),  # type: ignore[arg-type]
        void_reasons=list(row.void_reasons),
        discount_reasons=list(row.discount_reasons),
        courtesy_reasons=list(row.courtesy_reasons),
        courses=list(row.courses),
        stations=list(row.stations),
        course_target_minutes=dict(row.course_target_minutes),
        invoice_threshold_uvt=row.invoice_threshold_uvt,
    )


def _zone_out(zone: Zone) -> ZoneOut:
    return ZoneOut(id=zone.id, store_id=zone.store_id, name=zone.name, sort_order=zone.sort_order, active=zone.active)


def _table_out(table: Table) -> TableOut:
    return TableOut(
        id=table.id, zone_id=table.zone_id, store_id=table.store_id, number=table.number, seats=table.seats, active=table.active
    )


def _zone_or_404(db: Session, actor: Actor, zone_id: int) -> Zone:
    zone = db.get(Zone, zone_id)
    if zone is None:
        raise NotFoundError("La zona no existe")
    store = db.get(Store, zone.store_id)
    if store is None or store.organization_id != actor.organization_id:
        raise NotFoundError("La zona no existe")
    return zone


def _table_or_404(db: Session, actor: Actor, table_id: int) -> Table:
    table = db.get(Table, table_id)
    if table is None:
        raise NotFoundError("La mesa no existe")
    store = db.get(Store, table.store_id)
    if store is None or store.organization_id != actor.organization_id:
        raise NotFoundError("La mesa no existe")
    return table


# ---------------------------------------------------------------------------
# Organización y funciones.
# ---------------------------------------------------------------------------


@router.get("/admin/organization")
def get_organization(db: Session = Depends(get_db), actor: Actor = Depends(current_admin)) -> OrganizationOut:
    org = db.get(Organization, actor.organization_id)
    if org is None:
        raise NotFoundError("La organización no existe")
    return _organization_out(org)


@router.patch("/admin/organization")
def update_organization(
    body: OrganizationUpdateIn, db: Session = Depends(get_db), actor: Actor = Depends(current_admin)
) -> OrganizationOut:
    org = db.get(Organization, actor.organization_id)
    if org is None:
        raise NotFoundError("La organización no existe")
    before = _organization_out(org).model_dump()
    org.name = body.name
    org.updated_at = clock.now_utc()
    db.flush()
    record_audit(
        db,
        actor=actor,
        organization_id=org.id,
        store_id=None,
        entity="organization",
        entity_id=org.id,
        action="update",
        before=before,
        after=_organization_out(org).model_dump(),
    )
    return _organization_out(org)


@router.get("/admin/features")
def list_features(
    store_id: int | None = None, db: Session = Depends(get_db), actor: Actor = Depends(current_admin)
) -> list[FeatureOut]:
    if store_id is not None:
        admin_store(db, actor, store_id)

    org = db.get(Organization, actor.organization_id)
    if org is None:
        raise NotFoundError("La organización no existe")
    defaults = profile_defaults(org.profile)

    org_states = {
        s.key: s
        for s in db.execute(
            select(FeatureState).where(
                FeatureState.organization_id == actor.organization_id, FeatureState.store_id.is_(None)
            )
        )
        .scalars()
        .all()
    }
    store_states: dict[str, FeatureState] = {}
    if store_id is not None:
        store_states = {
            s.key: s
            for s in db.execute(
                select(FeatureState).where(
                    FeatureState.organization_id == actor.organization_id, FeatureState.store_id == store_id
                )
            )
            .scalars()
            .all()
        }

    out: list[FeatureOut] = []
    for f in FEATURE_CATALOG:
        if store_id is not None and f.key in store_states:
            enabled = store_states[f.key].enabled
            source: str = "store_override"
        elif f.key in org_states:
            enabled = org_states[f.key].enabled
            source = "org"
        else:
            enabled = defaults[f.key]
            source = "profile_default"
        out.append(
            FeatureOut(
                key=f.key,
                description=f.description,
                enabled=enabled,
                source=source,  # type: ignore[arg-type]
                requires=list(f.requires),
                available_from_phase=f.available_from_phase,
            )
        )
    return out


@router.put("/admin/features/{key}")
def set_feature(
    key: str, body: FeatureSetIn, db: Session = Depends(get_db), actor: Actor = Depends(current_admin)
) -> FeatureOut:
    feature_def = FEATURE_BY_KEY.get(key)
    if feature_def is None:
        if key in CORE_CAPABILITY_KEYS:
            raise AppError(
                code="FEATURE_IS_CORE",
                message=f'"{key}" es ley o integridad del sistema; no se apaga',
                extra={"feature": key},
            )
        raise NotFoundError(f'No existe la función "{key}"')

    store_id = body.store_id
    if store_id is not None:
        admin_store(db, actor, store_id)

    current_flags = enabled_map(db, actor.organization_id, store_id)
    if body.enabled:
        for dep in feature_def.requires:
            if not current_flags.get(dep, False):
                raise AppError(
                    code="FEATURE_DEPENDENCY",
                    message=f'"{key}" necesita que "{dep}" esté habilitada primero',
                    extra={"feature": key, "requires": dep},
                )
    else:
        dependents = [
            f.key for f in FEATURE_CATALOG if key in f.requires and current_flags.get(f.key, False)
        ]
        if dependents:
            raise AppError(
                code="FEATURE_DEPENDENCY",
                message=f'Apagá primero "{dependents[0]}", que depende de "{key}"',
                extra={"feature": key, "requires": dependents[0]},
            )

    stmt = select(FeatureState).where(
        FeatureState.organization_id == actor.organization_id,
        FeatureState.store_id == store_id,
        FeatureState.key == key,
    )
    state = db.execute(stmt).scalars().first()
    before = {"enabled": state.enabled} if state is not None else None
    now = clock.now_utc()
    if state is None:
        state = FeatureState(
            organization_id=actor.organization_id,
            store_id=store_id,
            key=key,
            enabled=body.enabled,
            updated_at=now,
            updated_by=actor.employee_name,
        )
        db.add(state)
    else:
        state.enabled = body.enabled
        state.updated_at = now
        state.updated_by = actor.employee_name
    db.flush()

    record_audit(
        db,
        actor=actor,
        organization_id=actor.organization_id,
        store_id=store_id,
        entity="feature",
        entity_id=key,
        action="set",
        before=before,
        after={"enabled": body.enabled},
    )

    refreshed = enabled_map(db, actor.organization_id, store_id)
    source = "store_override" if store_id is not None else "org"
    return FeatureOut(
        key=key,
        description=feature_def.description,
        enabled=refreshed[key],
        source=source,  # type: ignore[arg-type]
        requires=list(feature_def.requires),
        available_from_phase=feature_def.available_from_phase,
    )


@router.post("/admin/organization/profile")
def set_profile(
    body: ProfileSetIn, db: Session = Depends(get_db), actor: Actor = Depends(current_admin)
) -> OrganizationOut:
    org = db.get(Organization, actor.organization_id)
    if org is None:
        raise NotFoundError("La organización no existe")
    before = {"profile": org.profile}
    org.profile = body.profile
    org.updated_at = clock.now_utc()
    db.execute(
        delete(FeatureState).where(
            FeatureState.organization_id == org.id, FeatureState.store_id.is_(None)
        )
    )
    db.flush()
    record_audit(
        db,
        actor=actor,
        organization_id=org.id,
        store_id=None,
        entity="organization",
        entity_id=org.id,
        action="set_profile",
        before=before,
        after={"profile": body.profile},
    )
    return _organization_out(org)


# ---------------------------------------------------------------------------
# Sedes y su configuración.
# ---------------------------------------------------------------------------


@router.get("/admin/stores")
def list_stores(request: Request, db: Session = Depends(get_db), actor: Actor = Depends(current_admin)) -> Any:
    stmt = select(Store).where(Store.organization_id == actor.organization_id).order_by(Store.name)
    stores = [_store_out(s) for s in db.execute(stmt).scalars().all()]
    if wants_csv(request):
        return csv_response([s.model_dump() for s in stores], "stores.csv")
    return stores


@router.post("/admin/stores")
def create_store(
    body: StoreCreateIn, db: Session = Depends(get_db), actor: Actor = Depends(current_admin)
) -> StoreOut:
    now = clock.now_utc()
    store = Store(
        organization_id=actor.organization_id,
        name=body.name,
        nit=body.nit,
        dv=body.dv,
        legal_name=body.legal_name,
        address=body.address,
        municipality_dane=body.municipality_dane,
        opening_hours=[h.model_dump() for h in body.opening_hours],
        cutoff_hour=body.cutoff_hour,
        active_channels=list(body.active_channels),
        store_pin_hash=hash_secret(body.store_pin),
        active=True,
        created_at=now,
        updated_at=now,
    )
    db.add(store)
    db.flush()
    record_audit(
        db,
        actor=actor,
        organization_id=actor.organization_id,
        store_id=store.id,
        entity="store",
        entity_id=store.id,
        action="create",
        before=None,
        after=_store_out(store).model_dump(),
    )
    return _store_out(store)


@router.patch("/admin/stores/{store_id}")
def update_store(
    store_id: int, body: StoreUpdateIn, db: Session = Depends(get_db), actor: Actor = Depends(current_admin)
) -> StoreOut:
    store = admin_store(db, actor, store_id)
    before = _store_out(store).model_dump()
    data = body.model_dump(exclude_unset=True)
    for field in (
        "name",
        "nit",
        "dv",
        "legal_name",
        "address",
        "municipality_dane",
        "cutoff_hour",
        "active_channels",
        "opening_hours",
    ):
        if field in data and data[field] is not None:
            setattr(store, field, data[field])
    store.updated_at = clock.now_utc()
    db.flush()
    record_audit(
        db,
        actor=actor,
        organization_id=actor.organization_id,
        store_id=store.id,
        entity="store",
        entity_id=store.id,
        action="update",
        before=before,
        after=_store_out(store).model_dump(),
    )
    return _store_out(store)


@router.post("/admin/stores/{store_id}/rotate-pin")
def rotate_pin(
    store_id: int, body: RotatePinIn, db: Session = Depends(get_db), actor: Actor = Depends(current_admin)
) -> dict[str, bool]:
    store = admin_store(db, actor, store_id)
    store.store_pin_hash = hash_secret(body.new_pin)
    store.updated_at = clock.now_utc()
    db.flush()
    record_audit(
        db,
        actor=actor,
        organization_id=actor.organization_id,
        store_id=store.id,
        entity="store",
        entity_id=store.id,
        action="rotate_pin",
        before=None,
        after=None,
    )
    return {"ok": True}


@router.get("/admin/stores/{store_id}/fiscal")
def get_fiscal(
    store_id: int, db: Session = Depends(get_db), actor: Actor = Depends(current_admin)
) -> FiscalOut:
    admin_store(db, actor, store_id)
    fiscal = current_fiscal(db, store_id)
    if fiscal is None:
        raise NotFoundError("La sede todavía no tiene configuración fiscal vigente")
    return _fiscal_out(fiscal)


@router.put("/admin/stores/{store_id}/fiscal")
def set_fiscal(
    store_id: int, body: FiscalIn, db: Session = Depends(get_db), actor: Actor = Depends(current_admin)
) -> FiscalOut:
    admin_store(db, actor, store_id)
    if body.valid_from is None:
        raise AppError(
            code="FISCAL_VALID_FROM_REQUIRED",
            message="valid_from: decí desde cuándo aplica este cambio fiscal",
        )
    before_row = current_fiscal(db, store_id)
    before = _fiscal_out(before_row).model_dump() if before_row is not None else None

    row = StoreFiscalConfig(
        store_id=store_id,
        valid_from=body.valid_from,
        person_type=body.person_type,
        regime=body.regime,
        franchise=body.franchise,
        inc_responsible=body.inc_responsible,
        iva_responsible=body.iva_responsible,
        rut_codes=list(body.rut_codes),
        price_includes_tax=body.price_includes_tax,
        default_tax=body.default_tax,
        created_at=clock.now_utc(),
    )
    db.add(row)
    db.flush()
    record_audit(
        db,
        actor=actor,
        organization_id=actor.organization_id,
        store_id=store_id,
        entity="store_fiscal_config",
        entity_id=row.id,
        action="create_version",
        before=before,
        after=_fiscal_out(row).model_dump(),
    )
    return _fiscal_out(row)


@router.get("/admin/stores/{store_id}/fiscal/history")
def fiscal_history(
    store_id: int, db: Session = Depends(get_db), actor: Actor = Depends(current_admin)
) -> list[FiscalOut]:
    admin_store(db, actor, store_id)
    stmt = (
        select(StoreFiscalConfig)
        .where(StoreFiscalConfig.store_id == store_id)
        .order_by(StoreFiscalConfig.valid_from.desc())
    )
    return [_fiscal_out(r) for r in db.execute(stmt).scalars().all()]


@router.get("/admin/stores/{store_id}/cash-settings")
def get_cash_settings_route(
    store_id: int, db: Session = Depends(get_db), actor: Actor = Depends(current_admin)
) -> CashSettingsOut:
    admin_store(db, actor, store_id)
    return _cash_settings_out(get_cash_settings(db, store_id))


@router.put("/admin/stores/{store_id}/cash-settings")
def put_cash_settings_route(
    store_id: int, body: CashSettingsIn, db: Session = Depends(get_db), actor: Actor = Depends(current_admin)
) -> CashSettingsOut:
    admin_store(db, actor, store_id)
    row = get_cash_settings(db, store_id)
    before = _cash_settings_out(row).model_dump()
    for field, value in body.model_dump().items():
        setattr(row, field, value)
    row.updated_at = clock.now_utc()
    db.flush()
    record_audit(
        db,
        actor=actor,
        organization_id=actor.organization_id,
        store_id=store_id,
        entity="store_cash_settings",
        entity_id=store_id,
        action="update",
        before=before,
        after=_cash_settings_out(row).model_dump(),
    )
    return _cash_settings_out(row)


@router.get("/admin/stores/{store_id}/sales-settings")
def get_sales_settings_route(
    store_id: int, db: Session = Depends(get_db), actor: Actor = Depends(current_admin)
) -> SalesSettingsOut:
    admin_store(db, actor, store_id)
    return _sales_settings_out(get_sales_settings(db, store_id))


@router.put("/admin/stores/{store_id}/sales-settings")
def put_sales_settings_route(
    store_id: int, body: SalesSettingsIn, db: Session = Depends(get_db), actor: Actor = Depends(current_admin)
) -> SalesSettingsOut:
    admin_store(db, actor, store_id)
    if body.tip_suggested_pct > 10:
        raise AppError(
            code="TIP_PCT_OVER_LIMIT",
            message="La propina sugerida no puede superar el 10% (Ley 1935 de 2018)",
        )
    row = get_sales_settings(db, store_id)
    before = _sales_settings_out(row).model_dump()
    data = body.model_dump()
    data["payment_methods"] = [dict(m) for m in data["payment_methods"]]
    for field, value in data.items():
        setattr(row, field, value)
    row.updated_at = clock.now_utc()
    db.flush()
    record_audit(
        db,
        actor=actor,
        organization_id=actor.organization_id,
        store_id=store_id,
        entity="store_sales_settings",
        entity_id=store_id,
        action="update",
        before=before,
        after=_sales_settings_out(row).model_dump(),
    )
    return _sales_settings_out(row)


@router.get("/admin/uvt")
def list_uvt(db: Session = Depends(get_db), actor: Actor = Depends(current_admin)) -> list[UvtEntry]:
    stmt = (
        select(UvtValue)
        .where(UvtValue.organization_id == actor.organization_id)
        .order_by(UvtValue.year)
    )
    return [UvtEntry(year=r.year, value=r.value) for r in db.execute(stmt).scalars().all()]


@router.put("/admin/uvt")
def put_uvt(
    body: list[UvtEntry], db: Session = Depends(get_db), actor: Actor = Depends(current_admin)
) -> list[UvtEntry]:
    existing = db.execute(
        select(UvtValue).where(UvtValue.organization_id == actor.organization_id)
    ).scalars().all()
    before: dict[str, Any] = {str(r.year): r.value for r in existing}
    by_year = {r.year: r for r in existing}
    for entry in body:
        row = by_year.get(entry.year)
        if row is None:
            db.add(UvtValue(organization_id=actor.organization_id, year=entry.year, value=entry.value))
        else:
            row.value = entry.value
    db.flush()
    after: dict[str, Any] = {str(e.year): e.value for e in body}
    record_audit(
        db,
        actor=actor,
        organization_id=actor.organization_id,
        store_id=None,
        entity="uvt",
        entity_id="table",
        action="update",
        before=before,
        after=after,
    )
    return list_uvt(db, actor)


# ---------------------------------------------------------------------------
# Zonas y mesas.
# ---------------------------------------------------------------------------


@router.get("/admin/zones")
def list_zones(
    store_id: int, db: Session = Depends(get_db), actor: Actor = Depends(current_admin)
) -> list[ZoneOut]:
    admin_store(db, actor, store_id)
    stmt = select(Zone).where(Zone.store_id == store_id).order_by(Zone.sort_order, Zone.name)
    return [_zone_out(z) for z in db.execute(stmt).scalars().all()]


@router.post("/admin/zones")
def create_zone(
    store_id: int, body: ZoneCreateIn, db: Session = Depends(get_db), actor: Actor = Depends(current_admin)
) -> ZoneOut:
    admin_store(db, actor, store_id)
    zone = Zone(store_id=store_id, name=body.name, sort_order=body.sort_order, active=True)
    db.add(zone)
    db.flush()
    record_audit(
        db,
        actor=actor,
        organization_id=actor.organization_id,
        store_id=store_id,
        entity="zone",
        entity_id=zone.id,
        action="create",
        before=None,
        after=_zone_out(zone).model_dump(),
    )
    return _zone_out(zone)


@router.patch("/admin/zones/{zone_id}")
def update_zone(
    zone_id: int, body: ZoneUpdateIn, db: Session = Depends(get_db), actor: Actor = Depends(current_admin)
) -> ZoneOut:
    zone = _zone_or_404(db, actor, zone_id)
    before = _zone_out(zone).model_dump()
    data = body.model_dump(exclude_unset=True)
    for field in ("name", "sort_order", "active"):
        if field in data and data[field] is not None:
            setattr(zone, field, data[field])
    db.flush()
    record_audit(
        db,
        actor=actor,
        organization_id=actor.organization_id,
        store_id=zone.store_id,
        entity="zone",
        entity_id=zone.id,
        action="update",
        before=before,
        after=_zone_out(zone).model_dump(),
    )
    return _zone_out(zone)


@router.get("/admin/tables")
def list_tables_admin(
    store_id: int, db: Session = Depends(get_db), actor: Actor = Depends(current_admin)
) -> list[TableOut]:
    admin_store(db, actor, store_id)
    stmt = select(Table).where(Table.store_id == store_id).order_by(Table.number)
    return [_table_out(t) for t in db.execute(stmt).scalars().all()]


@router.post("/admin/tables")
def create_table(
    body: TableCreateIn, db: Session = Depends(get_db), actor: Actor = Depends(current_admin)
) -> TableOut:
    zone = _zone_or_404(db, actor, body.zone_id)
    table = Table(zone_id=zone.id, store_id=zone.store_id, number=body.number, seats=body.seats, active=True)
    db.add(table)
    db.flush()
    record_audit(
        db,
        actor=actor,
        organization_id=actor.organization_id,
        store_id=zone.store_id,
        entity="table",
        entity_id=table.id,
        action="create",
        before=None,
        after=_table_out(table).model_dump(),
    )
    return _table_out(table)


@router.patch("/admin/tables/{table_id}")
def update_table(
    table_id: int, body: TableUpdateIn, db: Session = Depends(get_db), actor: Actor = Depends(current_admin)
) -> TableOut:
    table = _table_or_404(db, actor, table_id)
    before = _table_out(table).model_dump()
    data = body.model_dump(exclude_unset=True)
    if data.get("zone_id") is not None:
        new_zone = _zone_or_404(db, actor, data["zone_id"])
        table.zone_id = new_zone.id
        table.store_id = new_zone.store_id
    for field in ("number", "seats", "active"):
        if field in data and data[field] is not None:
            setattr(table, field, data[field])
    db.flush()
    record_audit(
        db,
        actor=actor,
        organization_id=actor.organization_id,
        store_id=table.store_id,
        entity="table",
        entity_id=table.id,
        action="update",
        before=before,
        after=_table_out(table).model_dump(),
    )
    return _table_out(table)


@router.get("/tables")
def device_tables(db: Session = Depends(get_db), actor: Actor = Depends(current_device)) -> list[DeviceTableOut]:
    store_id = actor.store_id
    stmt = (
        select(Table, Zone)
        .join(Zone, Table.zone_id == Zone.id)
        .where(Table.store_id == store_id, Table.active.is_(True))
        .order_by(Zone.sort_order, Table.number)
    )
    rows = db.execute(stmt).all()
    return [
        DeviceTableOut(id=t.id, zone_id=z.id, zone_name=z.name, number=t.number, seats=t.seats, status="free")
        for t, z in rows
    ]
