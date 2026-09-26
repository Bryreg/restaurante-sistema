"""Esquemas del panel de control (`GET /admin/panel`) y de las fichas
relacionales (`GET /admin/records/...`).

Van en un archivo aparte de `schemas.py` a propósito: el panel y las fichas
son lecturas NUEVAS que se apoyan en las de siempre, y separarlas deja que
los cambios de `Hoy`/`Informes` y los de acá no se pisen.

Mismas reglas que el resto de `reports`: plata en enteros de pesos, `None`
no es `0` (lo que no se sabe viaja como `None` con su motivo), y nada de
costos para el operador (todas estas rutas son de administrador).
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel

from app.reports.schemas import PanelLevelLiteral as PanelLevel
from app.reports.schemas import PanelLightLiteral as PanelLight
from app.reports.schemas import SalesBucketOut


class PersonRefOut(BaseModel):
    """Una persona como la congeló el registro (`name`), más si HOY sigue
    activa. Un responsable desactivado se muestra con su marca: el nombre
    congelado es la verdad de lo que pasó, `active` dice si todavía hay a
    quién preguntarle."""

    id: int
    name: str
    active: bool


class PanelCashOut(BaseModel):
    """El turno de caja abierto de la sede, **sea del día que sea**. Es la
    misma lectura que `Hoy` (`shifts_service.get_current_shift`), y la que
    `Dinero › Operacional` pone arriba aunque el turno sea de un día
    anterior: un turno abandonado no se esconde por su fecha."""

    shift_id: int
    business_date: date
    opened_at: datetime
    responsible: PersonRefOut
    is_stale: bool
    # La hora de corte del día siguiente al del turno: desde ahí es abandonado.
    stale_since: datetime | None
    cash_over_threshold: bool
    # El esperado del cajón, con `compute_breakdown` (la única fórmula). Es
    # la misma cifra que la tarjeta «Efectivo esperado» de Hoy: el panel es
    # de administrador y no le muestra nada que Hoy no le mostrara ya.
    expected_cash: int


class PanelStaffPersonOut(BaseModel):
    employee_id: int
    name: str
    since: datetime
    on_pause: bool
    active: bool
    puesto: str | None = None


class PanelPendingExitOut(BaseModel):
    """Una salida olvidada: la entrada quedó abierta en un día que ya pasó."""

    entry_id: int
    employee_id: int
    name: str
    business_date: date
    in_at: datetime


class PanelStaffOut(BaseModel):
    """Quién trabaja, leído de la **asistencia** del día (`attendance_entries`,
    vía `app.shifts.hooks.present_today`): con o sin caja abierta. El
    administrador no tiene asistencia. `pending_review` son las salidas
    olvidadas de días anteriores, que nómina no cuenta hasta corregirlas.
    `reason` explica una lista vacía que no es un error."""

    present: list[PanelStaffPersonOut]
    pending_review: list[PanelPendingExitOut]
    reason: str | None


class PanelAreaCountsOut(BaseModel):
    """Resumen del conteo corto por área de hoy, leído de la MISMA bandeja
    que la tarjeta de Hoy (`service._area_counts_tray`)."""

    enabled: bool
    areas_total: int
    opening_done: int
    # Áreas cuya apertura es obligatoria y no está (`opening_missing` del conteo compartido).
    opening_missing: int
    closing_done: int
    flagged: int
    pending_recounts: int


class PanelSalonOut(BaseModel):
    tables_occupied: int
    tables_total: int
    open_orders: int
    unsent: int
    unpaid: int


class PanelKitchenOut(BaseModel):
    """`enabled=False` con «Cocina» apagada. `late` son platos pasados de su
    tiempo objetivo (ámbar o rojo en el KDS), `very_late` los rojos."""

    enabled: bool
    in_kitchen: int
    late: int
    very_late: int
    oldest_late_minutes: int | None


class PanelPendingOut(BaseModel):
    """Los recuentos de lo que espera al dueño. Salen de los mismos hooks
    que la bandeja de Hoy; `0` con la función apagada."""

    deposits_to_confirm: int
    requests_pending: int
    novelties_open: int
    novelties_urgent: int
    unreviewed_closes: int
    # Base de respaldo: préstamos al cajón sin devolver (`reserve_loans_tray`,
    # lo mismo que Hoy). `None` en el total = la sede no usa base.
    reserve_loans_open: int = 0
    reserve_loans_total: int | None = None
    attendance_review: int = 0


class PanelReasonOut(BaseModel):
    """Por qué el semáforo tiene su color. `key` es estable (el frontend
    decide a dónde lleva); `text` es la frase para el dueño."""

    key: str
    level: PanelLevel
    text: str


class StorePanelOut(BaseModel):
    store_id: int
    store_name: str
    business_date: date
    light: PanelLight
    reasons: list[PanelReasonOut]
    # Sin turno y sin actividad: la sede está cerrada (semáforo gris).
    closed: bool
    cash: PanelCashOut | None
    staff: PanelStaffOut
    area_counts: PanelAreaCountsOut
    salon: PanelSalonOut
    kitchen: PanelKitchenOut
    pending: PanelPendingOut


class PanelOut(BaseModel):
    scope: Literal["all", "store"]
    generated_at: datetime
    stores: list[StorePanelOut]


# ---------------------------------------------------------------------------
# Fichas relacionales
# ---------------------------------------------------------------------------


class RecordNoveltyOut(BaseModel):
    id: int
    title: str
    level: str
    category: str
    employee_name: str
    created_at: datetime
    resolved_at: datetime | None


class RecordVoidOut(BaseModel):
    """Un ítem anulado. `amount` es `unit_price × qty`, la misma cifra que
    cuenta la actividad de la persona (`app.shifts.activity_metrics`)."""

    order_id: int
    item_name: str
    qty: int
    amount: int
    reason: str | None
    voided_at: datetime | None
    voided_by: str | None
    authorized_by: str | None
    after_bill: bool


class RecordDiscountOut(BaseModel):
    order_id: int
    kind: Literal["discount", "courtesy"]
    amount: int | None
    reason: str | None
    employee_name: str | None
    authorized_by: str | None
    at: datetime | None


class RecordAreaCountOut(BaseModel):
    count_id: int
    area_name: str
    moment: str
    counted_at: datetime
    employee_name: str


class RecordAttendanceOut(BaseModel):
    """En la ficha del turno, las filas del roster (la asistencia proyectada
    sobre la ventana del turno: `status` `open`/`closed`). En la de la
    persona, su asistencia real del día (`open`/`closed`/`review`)."""

    shift_id: int | None
    business_date: date | None
    employee_id: int
    employee_name: str
    in_at: datetime
    out_at: datetime | None
    status: str


class RecordEnvelopeOut(BaseModel):
    source_shift_id: int | None
    business_date: date | None
    expected: int | None
    counted: int | None
    difference: int | None


class RecordOpeningCountOut(BaseModel):
    """La apertura por sobres: qué sobres, lo esperado y lo contado de cada
    uno, y quién contó. Cifras tal como las selló el servidor al abrir."""

    envelopes: list[RecordEnvelopeOut]
    expected_total: int
    counted_total: int
    counted_by: str
    counted_at: datetime


class RecordReserveMovementOut(BaseModel):
    kind: str
    amount: int
    employee_name: str
    authorized_by: str | None
    at: datetime
    reversed: bool


class RecordDepositOut(BaseModel):
    """Plata de este turno que ya salió al banco (asignaciones vivas de
    consignaciones a este turno), con el total que publica `banking`."""

    deposited_total: int
    to_deposit: int | None
    outstanding: int | None


class ShiftRecordOut(BaseModel):
    shift_id: int
    store_id: int
    store_name: str
    business_date: date
    status: str
    opened_at: datetime
    closed_at: datetime | None
    is_stale: bool
    responsible: PersonRefOut
    opened_by: PersonRefOut
    closed_by: str | None
    reviewed: bool
    # Las ventas del turno con `aggregate_sales` agrupado por turno: la misma
    # suma que Ventas › Por turno. `None` si el turno no cobró nada.
    sales: SalesBucketOut | None
    deposit: RecordDepositOut | None
    opening_mode: str
    opening_count: RecordOpeningCountOut | None
    reserve_movements: list[RecordReserveMovementOut]
    # Lo que el cajón le debe a la base; `None` si la sede no usa base.
    reserve_loan_outstanding: int | None
    voids: list[RecordVoidOut]
    discounts: list[RecordDiscountOut]
    novelties: list[RecordNoveltyOut]
    area_counts: list[RecordAreaCountOut]
    attendance: list[RecordAttendanceOut]


class RecordShiftRowOut(BaseModel):
    shift_id: int
    business_date: date
    status: str
    is_stale: bool
    difference: int | None
    closed_without_count: bool


class EmployeeRecordOut(BaseModel):
    employee: PersonRefOut
    role: str
    store_id: int | None
    date_from: date
    date_to: date
    # Lo que COBRÓ en el período, con `aggregate_sales(group_by="employee")`:
    # la misma fila que Informes › Por persona. `None` si no cobró nada.
    charged: SalesBucketOut | None
    shifts_as_responsible: list[RecordShiftRowOut]
    attendance: list[RecordAttendanceOut]
    voids: list[RecordVoidOut]
    discounts: list[RecordDiscountOut]


class IngredientCauseTotalOut(BaseModel):
    cause: str
    movements: int
    # Cantidad neta en la unidad base, texto decimal (`format_qty_base`).
    qty: str


class IngredientCountLineOut(BaseModel):
    count_id: int
    area_name: str
    moment: str
    counted_at: datetime
    employee_name: str
    qty: str


class IngredientRecordOut(BaseModel):
    ingredient_id: int
    name: str
    base_unit: str
    active: bool
    store_id: int
    date_from: date
    date_to: date
    # `None` con el inventario perpetuo apagado: no hay libro que leer.
    stock: str | None
    by_cause: list[IngredientCauseTotalOut]
    area_counts: list[IngredientCountLineOut]
