"""Esquemas Pydantic de identidad, empleados y autorizaciones.

Ningún esquema de salida incluye `pin_hash` ni `password_hash`: el PIN y la
contraseña no aparecen jamás en una respuesta (SPEC-NEGOCIO §11.10 por
extensión, y checklist del pedido 1a).
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

# Dónde trabaja la persona en el POS (ver `app.auth.models.PUESTO_VALUES`).
# `None` = ve todo, el comportamiento de siempre.
Puesto = Literal["caja", "salon", "cocina", "bar"]


class AdminLoginIn(BaseModel):
    email: str
    password: str


class UserOut(BaseModel):
    id: int
    name: str
    role: str


class OrganizationOut(BaseModel):
    id: int
    name: str


class AdminLoginOut(BaseModel):
    user: UserOut
    organization: OrganizationOut


class DeviceActivateIn(BaseModel):
    store_id: int
    store_pin: str


class StoreBriefOut(BaseModel):
    id: int
    name: str
    cutoff_hour: int
    active_channels: list[str]


class DeviceActivateOut(BaseModel):
    store: StoreBriefOut


class DeviceIdentifyIn(BaseModel):
    employee_id: int
    pin: str = Field(min_length=4, max_length=4, pattern=r"^\d{4}$")


class EmployeeBriefOut(BaseModel):
    id: int
    name: str
    role: str
    can_charge: bool
    discount_limit_pct: float | None = None
    puesto: Puesto | None = None


class DeviceIdentifyOut(BaseModel):
    employee: EmployeeBriefOut


class MeOut(BaseModel):
    kind: Literal["admin", "device"]
    user: UserOut | None = None
    store: StoreBriefOut | None = None
    employee: EmployeeBriefOut | None = None
    employee_expires_at: datetime | None = None
    # Sólo en el dispositivo: quién se identificó por última vez en esta
    # tablet (sobrevive a soltar la persona), para ofrecerla primero.
    last_employee_id: int | None = None
    organization: OrganizationOut | None = None
    features: dict[str, bool] | None = None


class AuthorizeIn(BaseModel):
    pin: str | None = None
    action: str


class AuthorizerOut(BaseModel):
    id: int
    name: str
    role: str


class AuthorizeOut(BaseModel):
    authorizer: AuthorizerOut


class EmployeeCreateIn(BaseModel):
    name: str
    role: Literal["operator", "supervisor", "admin"]
    pin: str = Field(min_length=4, max_length=4, pattern=r"^\d{4}$")
    store_id: int | None = None
    can_charge: bool = False
    puesto: Puesto | None = None
    discount_limit_pct: float | None = None
    document: str | None = None
    email: str | None = None
    password: str | None = None


class EmployeeUpdateIn(BaseModel):
    name: str | None = None
    role: Literal["operator", "supervisor", "admin"] | None = None
    pin: str | None = Field(default=None, min_length=4, max_length=4, pattern=r"^\d{4}$")
    store_id: int | None = None
    can_charge: bool | None = None
    # Enviado como `null` explícito = «ve todo»; omitido = no cambia.
    puesto: Puesto | None = None
    discount_limit_pct: float | None = None
    document: str | None = None
    email: str | None = None
    password: str | None = None
    active: bool | None = None


class EmployeeOut(BaseModel):
    id: int
    name: str
    role: str
    store_id: int | None
    can_charge: bool
    puesto: Puesto | None = None
    discount_limit_pct: float | None
    document: str | None = None
    email: str | None = None
    active: bool


class DeviceEmployeeOut(BaseModel):
    """`GET /device/employees` (SPEC-NEGOCIO §9.1, «Quién opera»): SOLO estos
    tres campos. Nunca `document`, `email`, `discount_limit_pct`, `can_charge`
    ni ningún hash (CONTRATO-INTERNO-1b-1.md §2.4)."""

    id: int
    name: str
    role: str


class AuthorizationOut(BaseModel):
    id: int
    authorizer_id: int
    authorizer_name: str
    action: str
    requested_by_employee_id: int | None
    at: datetime
    reference_type: str | None
    reference_id: str | None
