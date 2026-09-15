"""Esquemas Pydantic de devoluciones pendientes."""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

SettleFromLiteral = Literal["shift", "owner"]
PendingRefundStatusLiteral = Literal["pending", "settled"]


class OutModel(BaseModel):
    model_config = ConfigDict(from_attributes=True)


class PendingRefundOut(OutModel):
    id: int
    store_id: int
    document_id: int
    customer_id: int | None = None
    customer_name: str
    customer_doc_number: str
    amount: int
    method: str
    authorized_by_employee_id: int
    authorized_by_employee_name: str
    requested_at: datetime
    status: PendingRefundStatusLiteral
    settled_at: datetime | None = None
    settled_from: SettleFromLiteral | None = None
    settled_shift_id: int | None = None
    settled_cash_movement_id: int | None = None
    settled_by_employee_id: int | None = None
    settled_by_employee_name: str | None = None


class SettlePendingRefundIn(BaseModel):
    """`{from: "shift"|"owner", shift_id?}`. `from` es palabra reservada de
    Python: se mapea a `from_` con alias, igual que `CashSwapIn.in_`/`out` en
    `app.shifts.schemas`."""

    from_: SettleFromLiteral = Field(alias="from")
    shift_id: int | None = None

    model_config = ConfigDict(populate_by_name=True)
