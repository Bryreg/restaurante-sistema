"""Lo que otros dominios leen de `requests`.

- `pending_count(db, store_id)` — cuántas solicitudes esperan al
  administrador. Para la bandeja de Hoy (`app.reports`).
- `approved_supply_lines(db, store_id)` — los insumos aprobados y todavía por
  comprar, renglón por renglón. Para Compras (`app.purchases`), que los
  muestra como la lista de lo que hay que traer. **Sin costos**: el costo lo
  pone la recepción, no la solicitud.
- `mark_supply_request_bought(...)` — para que Compras, al recibir, cierre
  el pedido que originó la compra. Valida antes de escribir y levanta
  `AppError` si el pedido no está aprobado y por comprar.

Este dominio no importa `app.purchases` ni `app.reports`: la dependencia va
en un solo sentido (ellos leen acá).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth.deps import Actor
from app.core.errors import NotFoundError
from app.requests import service
from app.requests.models import StaffRequest, StaffRequestKind, StaffRequestLine, StaffRequestStatus


def pending_count(db: Session, store_id: int) -> int:
    return service.pending_count(db, store_id=store_id)


@dataclass(frozen=True)
class ApprovedSupplyLine:
    request_id: int
    line_id: int
    ingredient_id: int
    ingredient_name: str
    base_unit: str
    # Milésimas de la unidad base (`app.core.quantity.QTY_SCALE`); quien la
    # publique usa `format_qty_base`.
    qty_approved: int
    requested_by_employee_name: str
    requested_at: datetime
    approved_at: datetime | None
    note: str | None


def approved_supply_lines(db: Session, store_id: int) -> list[ApprovedSupplyLine]:
    """Renglones con cantidad aprobada > 0 de los pedidos de insumos
    aprobados y todavía no comprados, del más viejo al más nuevo."""
    rows = db.execute(
        select(StaffRequest, StaffRequestLine)
        .join(StaffRequestLine, StaffRequestLine.request_id == StaffRequest.id)
        .where(
            StaffRequest.store_id == store_id,
            StaffRequest.kind == StaffRequestKind.SUPPLY.value,
            StaffRequest.status == StaffRequestStatus.APPROVED,
            StaffRequestLine.qty_approved > 0,
        )
        .order_by(StaffRequest.resolved_at, StaffRequest.id, StaffRequestLine.id)
    ).all()
    return [
        ApprovedSupplyLine(
            request_id=request.id,
            line_id=line.id,
            ingredient_id=line.ingredient_id,
            ingredient_name=line.ingredient_name,
            base_unit=line.base_unit,
            qty_approved=int(line.qty_approved or 0),
            requested_by_employee_name=request.requested_by_employee_name,
            requested_at=request.requested_at,
            approved_at=request.resolved_at,
            note=request.note,
        )
        for request, line in rows
    ]


def mark_supply_request_bought(
    db: Session, *, store_id: int, request_id: int, actor: Actor | None, note: str | None = None
) -> None:
    request = db.get(StaffRequest, request_id)
    if request is None or request.store_id != store_id:
        raise NotFoundError("La solicitud de insumos no existe")
    service.mark_bought(db, actor=actor, request=request, note=note)
