"""Esquemas Pydantic del maestro de clientes y habeas data."""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

ConsentPurposeLiteral = Literal["invoice", "marketing"]
DataRequestKindLiteral = Literal["access", "rectify", "revoke", "erase"]


class OutModel(BaseModel):
    model_config = ConfigDict(from_attributes=True)


class CustomerOut(OutModel):
    id: int
    doc_type: str
    doc_number: str
    dv: str | None = None
    name: str
    email: str | None = None
    address: str | None = None
    municipality_dane: str | None = None
    created_at: datetime
    updated_at: datetime
    erased_at: datetime | None = None


class CustomerPatchIn(BaseModel):
    """Todos los campos opcionales: `PATCH` corrige lo que venga (ejercicio
    del derecho de rectificación, §8.4). No se puede tocar `doc_type`/
    `doc_number` acá — cambiar el documento de una persona es, en los hechos,
    otra persona; si se tecleó mal, se corrige desde `erase` + una compra
    nueva con el número correcto."""

    name: str | None = None
    email: str | None = None
    address: str | None = None
    municipality_dane: str | None = None
    dv: str | None = None


class ConsentIn(BaseModel):
    purpose: ConsentPurposeLiteral
    granted: bool
    channel: str
    text_version: str


class ConsentOut(OutModel):
    id: int
    purpose: ConsentPurposeLiteral
    granted: bool
    channel: str
    text_version: str
    registered_by_employee_id: int | None = None
    registered_by_employee_name: str | None = None
    at: datetime


class DataRequestOut(OutModel):
    id: int
    kind: DataRequestKindLiteral
    note: str | None = None
    response: str | None = None
    requested_at: datetime
    responded_at: datetime | None = None
    employee_id: int | None = None
    employee_name: str | None = None


class EraseIn(BaseModel):
    reason: str = Field(min_length=1)
