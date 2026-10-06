"""`notify`: la única puerta para crear una notificación.

Respeta la regla de la sede (si existe y está apagada, no crea nada) y
deduplica por día (hora de Bogotá) cuando el llamador manda `dedupe_key` — un
`shift_stale` no tiene que repetirse cada vez que alguien refresca la
pantalla.

Si la notificación es **crítica** y la sede tiene `notifications.push`, sale
además al celular de los administradores (`app.notifications.push.enqueue`),
después del commit y sin frenar la request. `supervisor_body` suma a los
supervisores de la sede, con ese texto (sin montos); `push_url` dice a qué
pantalla lleva tocar el aviso.
"""

from __future__ import annotations

from typing import Any, Literal

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core import clock, tz
from app.notifications import push
from app.notifications.models import Notification, NotificationRule

NOTIFICATION_TYPES: list[str] = [
    "shift_stale",
    "cash_difference",
    "cash_difference_critical",
    "difference_streak",
    "cash_over_threshold",
    "pin_locked",
    "product_unavailable",
    # 1b-1 (CONTRATO-INTERNO-1b-1.md §2.3): "discount_rate_high" y
    # "courtesy_limit" ya emiten, desde `backend-comanda`; los otros tres
    # quedan declarados para que 1b-2 los use sin tocar este catálogo.
    "discount_rate_high",
    "courtesy_limit",
    "void_rate_high",
    "order_unsent_too_long",
    "order_unpaid_too_long",
    # 1b-2 (backend-clientes-dinero): documento fiscal (rechazo, contingencia
    # vencida, rango por agotarse — emitidos por `backend-fiscal`, territorio
    # ajeno; este catálogo sólo los declara) y devolución pendiente (emitido
    # por `app.refunds.hooks.settle_or_queue_refund`, este territorio).
    "fiscal_rejected",
    "fiscal_contingency_overdue",
    "fiscal_range_low",
    "pending_refund",
    # Pedido 2a (`features/fase-2-costo-inventario/spec.md`): alertas de costo
    # e inventario que ganan `GET /admin/today`. Las EMITEN los dominios
    # dueños del hecho que alertan (`backend-inventario` para las dos
    # primeras vía `record_movement`/un barrido propio; `backend-recetas`
    # para la tercera al detectar un lote sin producir; `backend-consumo`,
    # este territorio, para la cuarta desde `app.reports.service.today_report`
    # al leer `recipes.hooks.uncosted_products`); este catálogo sólo las
    # declara, igual que se hizo con los tipos fiscales en 1b-2.
    "ingredient_below_min",
    "ingredient_negative",
    "prep_no_production",
    "product_discounts_nothing",
    "waste_spike",
    # Avisos al celular (0031): los dos hechos graves que el dueño pidió y
    # que no se emitían. La plata de la base de respaldo sin devolver la
    # emite `app.shifts.reserve` (al intentar cerrar con préstamo abierto, o
    # pasada la hora de corte); el faltante grande del conteo por área,
    # `app.inventory.area_counts` al guardar un artículo fuera del umbral.
    "reserve_loan_open",
    "area_count_shortage",
]


#: El nivel con el que nace cada tipo cuando la sede no tiene regla propia.
#: Los críticos son los que salen al celular (`notifications.push`). La
#: pantalla de reglas los muestra con este nivel: antes mostraba «Alerta»
#: para todos, y guardar la pantalla bajaba un turno abandonado a alerta.
CRITICAL_BY_DEFAULT: frozenset[str] = frozenset(
    {
        "shift_stale",
        "cash_difference_critical",
        "void_rate_high",
        "reserve_loan_open",
        "area_count_shortage",
    }
)


def default_level(type: str) -> Literal["info", "warning", "critical"]:
    return "critical" if type in CRITICAL_BY_DEFAULT else "warning"


def _rule(db: Session, store_id: int, type: str) -> NotificationRule | None:
    stmt = select(NotificationRule).where(
        NotificationRule.store_id == store_id, NotificationRule.type == type
    )
    return db.execute(stmt).scalars().first()


#: Qué quiere decir `NotificationRule.threshold` en cada tipo que lo lee, y
#: su valor cuando la sede no guardó uno. La pantalla de reglas lo muestra
#: (`GET /admin/notification-rules` → `threshold_default`/`threshold_unit`)
#: y cada emisor lo lee con `rule_threshold` — antes el campo se podía
#: editar pero ningún emisor lo miraba.
THRESHOLD_DEFAULTS: dict[str, tuple[int, str]] = {
    # % de las ventas del turno de la persona que anuló (a precio de lista).
    "void_rate_high": (10, "% de las ventas del turno anulado"),
    # Minutos con ítems sin enviar a cocina / con la cuenta presentada.
    "order_unsent_too_long": (15, "minutos sin enviar a cocina"),
    "order_unpaid_too_long": (20, "minutos con la cuenta presentada sin cobrar"),
    # Merma de la semana contra la anterior, en por ciento (150 = 1,5 veces).
    "waste_spike": (150, "% de la merma de la semana anterior"),
    # % consumido de un rango de numeración DIAN.
    "fiscal_range_low": (80, "% del rango de numeración consumido"),
}


def rule_threshold(db: Session, store_id: int, type: str) -> int:
    """El umbral de la regla de la sede para `type`; sin regla o sin umbral
    guardado, el de `THRESHOLD_DEFAULTS`. Un umbral `<= 0` guardado no se
    usa (dispararía siempre): vale el default."""
    default = THRESHOLD_DEFAULTS[type][0]
    rule = _rule(db, store_id, type)
    if rule is None or rule.threshold is None or rule.threshold <= 0:
        return default
    return int(rule.threshold)


def notify(
    db: Session,
    *,
    organization_id: int,
    store_id: int,
    type: str,
    level: Literal["info", "warning", "critical"],
    title: str,
    body: str,
    payload: dict[str, Any] | None = None,
    dedupe_key: str | None = None,
    supervisor_body: str | None = None,
    push_url: str | None = None,
    dedupe_while_open: bool = False,
) -> Notification | None:
    """`dedupe_while_open=True` cambia la ventana del `dedupe_key`: en vez de
    «uno por día», **uno mientras siga sin resolver**. Es para los hechos que
    son un estado y no un evento («este insumo está bajo el mínimo»): el
    aviso no se repite cada día ni con cada venta mientras la condición
    siga, y vuelve a salir sólo después de que se resolvió (a mano o porque
    la condición se apagó, `resolve_open`)."""
    rule = _rule(db, store_id, type)
    if rule is not None and not rule.enabled:
        return None

    now = clock.now_utc()
    if dedupe_key is not None and dedupe_while_open:
        if open_notification(db, store_id=store_id, type=type, dedupe_key=dedupe_key) is not None:
            return None
    elif dedupe_key is not None:
        today = tz.to_bogota(now).date()
        stmt = (
            select(Notification)
            .where(
                Notification.organization_id == organization_id,
                Notification.store_id == store_id,
                Notification.type == type,
                Notification.dedupe_key == dedupe_key,
            )
            .order_by(Notification.created_at.desc())
            .limit(1)
        )
        existing = db.execute(stmt).scalars().first()
        if existing is not None and tz.to_bogota(existing.created_at).date() == today:
            return None

    row = Notification(
        organization_id=organization_id,
        store_id=store_id,
        type=type,
        level=rule.level if rule is not None else level,
        title=title,
        body=body,
        payload=payload,
        dedupe_key=dedupe_key,
        read_at=None,
        created_at=now,
    )
    db.add(row)
    db.flush()
    push.enqueue(db, row, supervisor_body=supervisor_body, url=push_url)
    return row


# ---------------------------------------------------------------------------
# Leído ≠ resuelto (0042). `read_at` lo pone la campana; `resolved_at` saca
# el aviso de «Requiere tu atención» (`app.reports.service._recent_alerts`).
# ---------------------------------------------------------------------------

#: El nombre con que firma el sistema cuando la condición se apagó sola.
SYSTEM_RESOLVER_NAME = "Sistema"


def open_notification(db: Session, *, store_id: int, type: str, dedupe_key: str) -> Notification | None:
    """El aviso sin resolver de ese tipo y esa clave, si hay uno."""
    stmt = (
        select(Notification)
        .where(
            Notification.store_id == store_id,
            Notification.type == type,
            Notification.dedupe_key == dedupe_key,
            Notification.resolved_at.is_(None),
        )
        .order_by(Notification.created_at.desc())
        .limit(1)
    )
    return db.execute(stmt).scalars().first()


def resolve(
    db: Session,
    row: Notification,
    *,
    employee_id: int | None = None,
    employee_name: str | None = None,
) -> bool:
    """Marca resuelto un aviso. Resolver también es haberlo visto: si no
    estaba leído, queda leído a la misma hora. Idempotente: uno ya resuelto
    no cambia (ni de hora ni de quién) y devuelve `False`."""
    if row.resolved_at is not None:
        return False
    now = clock.now_utc()
    row.resolved_at = now
    row.resolved_by_employee_id = employee_id
    row.resolved_by_name = employee_name if employee_name else SYSTEM_RESOLVER_NAME
    if row.read_at is None:
        row.read_at = now
    db.flush()
    return True


def resolve_open(
    db: Session,
    *,
    store_id: int,
    type: str,
    dedupe_key: str | None = None,
    keep_keys: set[str] | None = None,
) -> int:
    """Resuelve, a nombre del sistema, los avisos abiertos de `type` en la
    sede cuya condición ya se apagó. Con `dedupe_key`, sólo ése; con
    `keep_keys`, todos menos los que siguen vigentes (lo que un barrido
    acaba de volver a ver). Devuelve cuántos resolvió."""
    stmt = select(Notification).where(
        Notification.store_id == store_id,
        Notification.type == type,
        Notification.resolved_at.is_(None),
    )
    if dedupe_key is not None:
        stmt = stmt.where(Notification.dedupe_key == dedupe_key)
    resolved = 0
    for row in db.execute(stmt).scalars().all():
        if keep_keys is not None and row.dedupe_key in keep_keys:
            continue
        if resolve(db, row):
            resolved += 1
    return resolved
