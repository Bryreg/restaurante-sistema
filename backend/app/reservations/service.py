"""Reservas de mesa: crear, listar, sentar y cerrar.

Las reglas duras, todas acá y ninguna en la pantalla:

- Una mesa **no acepta dos reservas encimadas**. «Encimadas» es dentro de la
  misma ventana de servicio (`VENTANA_MINUTOS`): apartar la mesa 5 a las 8:00
  y otra vez a las 8:20 es el mismo error de siempre, dos mesas prometidas y
  una sola mesa.
- Una reserva **no se borra**. Cancelar es `status="cancelled"` con su hora y
  su motivo; quién no llegó es lo que alguien quiere mirar a fin de mes.
- El día operativo lo decide el corte de la sede, no el calendario: una
  reserva de la 1 a. m. pertenece a la noche anterior.
"""

from __future__ import annotations

from datetime import datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core import clock, tz
from app.core.errors import AppError, NotFoundError
from app.reservations.models import Reservation, ReservationStatus
from app.reservations.schemas import (
    ReservationCloseIn,
    ReservationIn,
    ReservationOut,
    ReservationTableRefOut,
    TableReservationOut,
)
from app.stores.models import Store, Table

#: Dos reservas de la misma mesa a menos de esto son la misma franja de
#: servicio. Hora y media es lo que dura una mesa promedio en un restaurante
#: de menú, que es el producto que este sistema atiende.
VENTANA_MINUTOS = 90

#: Cuánto antes de la hora la mesa ya se pinta «reservada» en el plano. Antes
#: de eso la mesa sigue libre y se puede vender: apartarla tres horas antes
#: sería regalar el almuerzo.
ANTICIPACION_MINUTOS = 90

#: Cuánto después de la hora la reserva sigue marcando la mesa. Pasado eso,
#: la mesa vuelve a verse libre y alguien tendrá que marcar «no llegaron» —
#: lo marca una persona, no un reloj: el sistema no sabe si el cliente está
#: estacionando.
TOLERANCIA_MINUTOS = 30


def _table_or_404(db: Session, *, store_id: int, table_id: int) -> Table:
    table = db.get(Table, table_id)
    if table is None or table.store_id != store_id or not table.active:
        raise NotFoundError("La mesa no existe en esta sede")
    return table


def _out(table: Table, row: Reservation) -> ReservationOut:
    return ReservationOut(
        id=row.id,
        table=ReservationTableRefOut(id=table.id, number=table.number, seats=table.seats),
        business_date=row.business_date,
        at=row.at,
        party_name=row.party_name,
        party_size=row.party_size,
        phone=row.phone,
        note=row.note,
        status=row.status.value,  # type: ignore[arg-type]
        created_at=row.created_at,
        created_by_name=row.created_by_name,
        seated_at=row.seated_at,
        seated_order_id=row.seated_order_id,
        closed_at=row.closed_at,
        closed_reason=row.closed_reason,
        closed_by_name=row.closed_by_name,
    )


def _tables_by_id(db: Session, rows: list[Reservation]) -> dict[int, Table]:
    if not rows:
        return {}
    ids = {r.table_id for r in rows}
    return {t.id: t for t in db.execute(select(Table).where(Table.id.in_(ids))).scalars()}


def create(
    db: Session, *, store: Store, payload: ReservationIn, by_name: str | None
) -> ReservationOut:
    table = _table_or_404(db, store_id=store.id, table_id=payload.table_id)

    if payload.party_size > table.seats:
        raise AppError(
            "PARTY_EXCEEDS_SEATS",
            f"La mesa {table.number} tiene {table.seats} puestos y la reserva es para "
            f"{payload.party_size}: elegí otra mesa o bajá el número de personas",
            status=400,
        )

    business_date = tz.business_date_for(payload.at, store.cutoff_hour)

    # Choque con otra reserva viva de la misma mesa. Sólo cuentan las que
    # siguen en pie: una cancelada no aparta nada.
    ventana = timedelta(minutes=VENTANA_MINUTOS)
    choque = db.execute(
        select(Reservation).where(
            Reservation.table_id == table.id,
            Reservation.status == ReservationStatus.BOOKED,
            Reservation.at > payload.at - ventana,
            Reservation.at < payload.at + ventana,
        )
    ).scalars().first()
    if choque is not None:
        raise AppError(
            "TABLE_ALREADY_RESERVED",
            f"La mesa {table.number} ya está apartada a nombre de {choque.party_name} "
            f"a esa hora: elegí otra mesa u otra franja",
            status=409,
            extra={"reservation_id": choque.id},
        )

    row = Reservation(
        organization_id=store.organization_id,
        store_id=store.id,
        table_id=table.id,
        business_date=business_date,
        at=payload.at,
        party_name=payload.party_name.strip(),
        party_size=payload.party_size,
        phone=payload.phone,
        note=payload.note,
        status=ReservationStatus.BOOKED,
        created_at=clock.now_utc(),
        created_by_name=by_name,
    )
    db.add(row)
    db.flush()
    return _out(table, row)


def list_for_date(db: Session, *, store: Store, business_date: object | None = None) -> list[ReservationOut]:
    """Las reservas de un día operativo, en orden de hora. Sin fecha, las de
    hoy — que es lo que el salón pregunta todo el tiempo."""
    dia = business_date or tz.today_business_date(store.cutoff_hour)
    rows = list(
        db.execute(
            select(Reservation)
            .where(Reservation.store_id == store.id, Reservation.business_date == dia)
            .order_by(Reservation.at, Reservation.id)
        ).scalars()
    )
    tables = _tables_by_id(db, rows)
    return [_out(tables[r.table_id], r) for r in rows if r.table_id in tables]


def close(
    db: Session, *, store: Store, reservation_id: int, payload: ReservationCloseIn, by_name: str | None
) -> ReservationOut:
    row = db.get(Reservation, reservation_id)
    if row is None or row.store_id != store.id:
        raise NotFoundError("La reserva no existe en esta sede")
    if row.status != ReservationStatus.BOOKED:
        raise AppError(
            "RESERVATION_NOT_OPEN",
            f"Esa reserva ya no está en pie: quedó como «{row.status.value}». "
            "Abrí la lista del día para ver su estado",
            status=409,
        )
    if payload.status == "cancelled" and not (payload.reason or "").strip():
        raise AppError(
            "REASON_REQUIRED",
            "Escribí por qué se cancela: sin motivo, la lista del mes no dice nada",
            status=400,
        )

    row.status = ReservationStatus.CANCELLED if payload.status == "cancelled" else ReservationStatus.NO_SHOW
    row.closed_at = clock.now_utc()
    row.closed_reason = (payload.reason or "").strip() or None
    row.closed_by_name = by_name
    db.flush()
    return _out(_table_or_404(db, store_id=store.id, table_id=row.table_id), row)


def mark_seated(db: Session, *, store_id: int, table_ids: list[int], order_id: int, now: datetime) -> None:
    """Cuando una mesa se abre, la reserva que la esperaba queda sentada.

    Lo llama `app.orders.service` al crear una comanda de mesa. No falla ni
    avisa si no había reserva: abrir una mesa sin reserva es el caso normal.
    """
    if not table_ids:
        return
    desde = now - timedelta(minutes=VENTANA_MINUTOS)
    hasta = now + timedelta(minutes=VENTANA_MINUTOS)
    rows = db.execute(
        select(Reservation).where(
            Reservation.store_id == store_id,
            Reservation.table_id.in_(table_ids),
            Reservation.status == ReservationStatus.BOOKED,
            Reservation.at > desde,
            Reservation.at < hasta,
        )
    ).scalars()
    for row in rows:
        row.status = ReservationStatus.SEATED
        row.seated_at = now
        row.seated_order_id = order_id


def upcoming_by_table(db: Session, *, store: Store, now: datetime) -> dict[int, TableReservationOut]:
    """Qué mesa está apartada AHORA, para el plano del salón.

    «Ahora» es una ventana alrededor del reloj, no el día entero: una reserva
    de las 9 p. m. no puede tener la mesa apartada desde el almuerzo. Si hay
    dos en la ventana, gana la más próxima.
    """
    desde = now - timedelta(minutes=TOLERANCIA_MINUTOS)
    hasta = now + timedelta(minutes=ANTICIPACION_MINUTOS)
    rows = db.execute(
        select(Reservation)
        .where(
            Reservation.store_id == store.id,
            Reservation.status == ReservationStatus.BOOKED,
            Reservation.at >= desde,
            Reservation.at <= hasta,
        )
        .order_by(Reservation.at)
    ).scalars()
    por_mesa: dict[int, TableReservationOut] = {}
    for row in rows:
        if row.table_id in por_mesa:
            continue  # ya ganó la más próxima
        por_mesa[row.table_id] = TableReservationOut(
            id=row.id, at=row.at, party_name=row.party_name, party_size=row.party_size
        )
    return por_mesa
