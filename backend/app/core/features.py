"""Catálogo de funciones habilitables (`docs/SPEC-NEGOCIO.md §1.2`).

Todas las claves viven acá desde el día uno, aunque el módulo que las usa
llegue en una fase futura (catalog.recipes, inventory.*, money.*, payroll...):
así `GET /admin/features` siempre puede describir "qué hace" cada una y con
qué depende, y ningún agente futuro necesita tocar este archivo para agregar
un flag que ya estaba previsto.

`require_feature` es la única puerta que un router debe usar para un endpoint
opcional: si la función está apagada, corta con `400 FEATURE_DISABLED` antes
de llegar al service.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field

from fastapi import Depends, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth.deps import Actor, current_actor
from app.core.db import get_db
from app.core.errors import AppError, NotFoundError
from app.stores.models import FeatureState, Organization


@dataclass(frozen=True)
class FeatureDef:
    key: str
    description: str
    requires: list[str] = field(default_factory=list)
    defaults: dict[str, bool] = field(default_factory=dict)  # {"basic","standard","full"} -> bool
    available_from_phase: str = "1a"


FEATURE_CATALOG: list[FeatureDef] = [
    FeatureDef(
        "pos.tables",
        "Mapa de mesas: unir y mover mesas, comensales por mesa",
        [],
        {"basic": False, "standard": True, "full": True},
        "1b",
    ),
    FeatureDef(
        "pos.counter",
        "Venta de mostrador: comanda que se cobra en el acto, sin mesa",
        [],
        {"basic": True, "standard": True, "full": True},
        "1b",
    ),
    FeatureDef(
        "pos.takeout",
        "Para llevar: nombre, teléfono y hora prometida",
        [],
        {"basic": True, "standard": True, "full": True},
        "1b",
    ),
    FeatureDef(
        "pos.delivery",
        "Domicilio propio",
        ["pos.takeout"],
        {"basic": False, "standard": False, "full": True},
        "2",
    ),
    FeatureDef(
        "pos.platforms",
        "Pedidos de plataformas (Rappi, Didi, iFood)",
        [],
        {"basic": False, "standard": False, "full": True},
        "2",
    ),
    FeatureDef(
        "pos.seats",
        "Asiento por ítem y división de cuenta por asiento",
        ["pos.tables"],
        {"basic": False, "standard": False, "full": True},
        "2",
    ),
    FeatureDef(
        "pos.courses",
        "Curso por ítem (bebida, entrada, fuerte, postre); «marchar» en fase 2",
        ["kitchen.view"],
        {"basic": False, "standard": True, "full": True},
        "1b",
    ),
    FeatureDef(
        "pos.modifiers",
        "Grupos de modificadores en los productos de la carta",
        [],
        {"basic": True, "standard": True, "full": True},
        "1a",
    ),
    FeatureDef(
        "pos.combos",
        "Combos de precio fijo con grupos de opción",
        [],
        {"basic": True, "standard": True, "full": True},
        "1a",
    ),
    FeatureDef(
        "pos.daily_menu",
        "Menú del día con opciones activas por día y franja horaria",
        ["pos.combos"],
        {"basic": False, "standard": True, "full": True},
        "1a",
    ),
    FeatureDef(
        "pos.pre_bill",
        "Precuenta (cuenta presentada) antes de cobrar",
        [],
        {"basic": False, "standard": True, "full": True},
        "1b",
    ),
    FeatureDef(
        "pos.split_bill",
        "División de cuenta (por ítems, por asiento o partes iguales)",
        [],
        {"basic": False, "standard": True, "full": True},
        "1b",
    ),
    FeatureDef(
        "pos.tips",
        "Pregunta de propina voluntaria al presentar la cuenta y su reporte",
        [],
        {"basic": True, "standard": True, "full": True},
        "1b",
    ),
    FeatureDef(
        "pos.discounts",
        "Descuentos por ítem o por comanda con motivo tipado",
        [],
        {"basic": True, "standard": True, "full": True},
        "1b",
    ),
    FeatureDef(
        "pos.courtesies",
        "Cortesías (ítem a precio 0 con motivo)",
        [],
        {"basic": False, "standard": True, "full": True},
        "1b",
    ),
    FeatureDef(
        "pos.staff_meal",
        "Comanda de consumo de personal",
        [],
        {"basic": False, "standard": True, "full": True},
        "1b",
    ),
    FeatureDef(
        "pos.daily_count",
        "Contador de porciones del día por producto",
        [],
        {"basic": False, "standard": True, "full": True},
        "1a",
    ),
    FeatureDef(
        "kitchen.view",
        "Vista de cocina mínima por estación",
        [],
        {"basic": False, "standard": True, "full": True},
        "1b",
    ),
    FeatureDef(
        "kitchen.kds",
        "KDS completo: bump, expedición e impresión por estación",
        ["kitchen.view"],
        {"basic": False, "standard": False, "full": True},
        "2",
    ),
    FeatureDef(
        "cash.blind_close",
        "Cierre de turno a ciegas en tres pasos (si está apagado: cierre en un paso, igual con causa)",
        [],
        {"basic": False, "standard": True, "full": True},
        "1a",
    ),
    FeatureDef(
        "cash.reserve",
        "Reserva de caja declarada aparte de la base",
        [],
        {"basic": True, "standard": True, "full": True},
        "1a",
    ),
    FeatureDef(
        "cash.pickups",
        "Retiros de efectivo con snapshot del esperado",
        [],
        {"basic": True, "standard": True, "full": True},
        "1a",
    ),
    FeatureDef(
        "cash.handovers",
        "Relevo del responsable de caja y arqueo sorpresa",
        [],
        {"basic": False, "standard": True, "full": True},
        "1a",
    ),
    FeatureDef(
        "cash.photo_required",
        "Foto obligatoria en cierre y retiro de caja",
        [],
        {"basic": False, "standard": True, "full": True},
        "1a",
    ),
    FeatureDef(
        "cash.swaps",
        "Cambio de denominaciones (sencilla) con neto cero",
        [],
        {"basic": True, "standard": True, "full": True},
        "1a",
    ),
    FeatureDef(
        "roles.supervisor",
        "Rol supervisor con PIN propio para autorizar",
        [],
        {"basic": False, "standard": True, "full": True},
        "1a",
    ),
    FeatureDef(
        "fiscal.dee_pos",
        "Documento equivalente electrónico POS vía proveedor tecnológico",
        [],
        {"basic": True, "standard": True, "full": True},
        "1b",
    ),
    FeatureDef(
        "fiscal.invoice",
        "Factura electrónica a cliente identificado",
        ["fiscal.dee_pos"],
        {"basic": True, "standard": True, "full": True},
        "1b",
    ),
    FeatureDef(
        "customers",
        "Maestro de clientes y consentimientos",
        [],
        {"basic": True, "standard": True, "full": True},
        "1b",
    ),
    FeatureDef(
        "catalog.recipes",
        "Fichas técnicas y costo teórico de los platos",
        [],
        {"basic": False, "standard": True, "full": True},
        "2",
    ),
    FeatureDef(
        "catalog.preps",
        "Preparaciones en dos modos (por lote o explotada)",
        ["catalog.recipes"],
        {"basic": False, "standard": False, "full": True},
        "2",
    ),
    FeatureDef(
        "inventory.perpetual",
        "Movimientos de inventario y stock teórico",
        ["catalog.recipes"],
        {"basic": False, "standard": True, "full": True},
        "2",
    ),
    FeatureDef(
        "inventory.counts",
        "Conteos de insumos críticos y completos",
        ["inventory.perpetual"],
        {"basic": False, "standard": True, "full": True},
        "2",
    ),
    FeatureDef(
        "inventory.variance",
        "Varianza de inventario, food cost real y salud del control",
        ["inventory.counts"],
        {"basic": False, "standard": False, "full": True},
        "2",
    ),
    FeatureDef(
        "inventory.waste",
        "Registro de mermas",
        ["inventory.perpetual"],
        {"basic": False, "standard": True, "full": True},
        "2",
    ),
    FeatureDef(
        "inventory.lots",
        "Lotes y vencimientos",
        ["inventory.perpetual"],
        {"basic": False, "standard": False, "full": True},
        "2",
    ),
    FeatureDef(
        "purchases",
        "Proveedores, recepciones de compra y cuentas por pagar",
        ["inventory.perpetual"],
        {"basic": False, "standard": True, "full": True},
        "2",
    ),
    FeatureDef(
        "money.deposits",
        "Consignaciones y plata por consignar",
        [],
        {"basic": False, "standard": True, "full": True},
        "3",
    ),
    FeatureDef(
        "money.bank",
        "Libro del banco y mano del dueño",
        ["money.deposits"],
        {"basic": False, "standard": False, "full": True},
        "3",
    ),
    FeatureDef(
        "money.obligations",
        "Gastos, obligaciones y punto de equilibrio",
        [],
        {"basic": False, "standard": False, "full": True},
        "3",
    ),
    FeatureDef(
        "payroll",
        "Horas, recargos y nómina",
        [],
        {"basic": False, "standard": False, "full": True},
        "3",
    ),
    FeatureDef(
        "multi_store",
        "Selector de sede y comparativo entre sedes",
        [],
        {"basic": False, "standard": False, "full": True},
        "1a",
    ),
    FeatureDef(
        "notifications.push",
        "Notificaciones push al administrador",
        [],
        {"basic": False, "standard": True, "full": True},
        "2",
    ),
]

FEATURE_BY_KEY: dict[str, FeatureDef] = {f.key: f for f in FEATURE_CATALOG}


def profile_defaults(profile: str) -> dict[str, bool]:
    """Los flags que deja un perfil recién elegido (`POST /admin/organization/profile`)."""
    return {f.key: f.defaults.get(profile, False) for f in FEATURE_CATALOG}


def enabled_map(db: Session, organization_id: int, store_id: int | None) -> dict[str, bool]:
    """Flags vigentes: default del perfil de la organización, sobreescrito por
    el estado guardado a nivel de organización y, si se pide una sede, por el
    override de esa sede."""
    org = db.get(Organization, organization_id)
    if org is None:
        raise NotFoundError("La organización no existe")

    result = profile_defaults(org.profile)

    org_states = db.execute(
        select(FeatureState).where(
            FeatureState.organization_id == organization_id,
            FeatureState.store_id.is_(None),
        )
    ).scalars().all()
    for state in org_states:
        result[state.key] = state.enabled

    if store_id is not None:
        store_states = db.execute(
            select(FeatureState).where(
                FeatureState.organization_id == organization_id,
                FeatureState.store_id == store_id,
            )
        ).scalars().all()
        for state in store_states:
            result[state.key] = state.enabled

    return result


def is_enabled(db: Session, organization_id: int, store_id: int | None, key: str) -> bool:
    return enabled_map(db, organization_id, store_id).get(key, False)


def assert_feature(db: Session, organization_id: int, store_id: int | None, key: str) -> None:
    if not is_enabled(db, organization_id, store_id, key):
        raise AppError(
            code="FEATURE_DISABLED",
            message=f'La función "{key}" está apagada; habilitala en Admin → Funciones',
            extra={"feature": key},
        )


def _admin_store_id_from_request(request: Request) -> int | None:
    raw = request.path_params.get("store_id") or request.query_params.get("store_id")
    if raw is None:
        return None
    try:
        return int(raw)
    except (TypeError, ValueError):
        return None


def require_feature(key: str) -> Callable[..., None]:
    """Dependencia FastAPI para un endpoint opcional. Resuelve la sede desde la
    sesión: la del dispositivo si es un dispositivo, la de `store_id` en el
    path o la query si es un admin (si no viene, evalúa a nivel de
    organización)."""

    def _dependency(
        request: Request,
        db: Session = Depends(get_db),
        actor: Actor = Depends(current_actor),
    ) -> None:
        if actor.kind == "device":
            store_id = actor.store_id
        else:
            store_id = _admin_store_id_from_request(request)
        assert_feature(db, actor.organization_id, store_id, key)

    return _dependency
