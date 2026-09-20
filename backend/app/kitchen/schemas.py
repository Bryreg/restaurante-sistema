"""Esquemas Pydantic del KDS (`kitchen.kds`, pedido 2c). Ninguno de acá trae
`cost`/`margin`/`unit_cost` ni nada equivalente (mismo pacto que
`app/orders/schemas.py`): esta pantalla es de DISPOSITIVO, nunca de admin
(`tests/audit/test_security_invariants.py`,
`tests/payments/test_documents.py::test_openapi_device_responses_never_expose_cost_fields`,
barrido por SUSTRING sobre el OpenAPI, no por nombre de ruta).

`GET /kitchen/rounds` (1b, `kitchen.view`) sigue devolviendo `list[dict]` sin
`response_model` — no se le toca la forma (checklist: "con `kitchen.kds`
apagada, todo lo de 1b sigue idéntico"). Estos esquemas son sólo para los
endpoints NUEVOS de 2c."""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel


class EmployeeRef(BaseModel):
    id: int
    name: str


class KitchenItemStateOut(BaseModel):
    """Lo que cambia en UN ítem tras `bump`/`unbump`. No es `OrderItemOut`
    (ese esquema es de `app.orders`, fuera de mi territorio): esto es sólo
    lo que el KDS necesita para reflejar el bump sin volver a pedir toda la
    comanda."""

    item_id: int
    order_id: int
    status: str
    ready_at: datetime | None
    changed: bool
    """`False` cuando el bump/unbump fue un no-op idempotente (el ítem ya
    estaba en el estado pedido): sigue siendo `200`, nunca un error."""
    bumped_by: EmployeeRef | None
    bumped_at: datetime | None


class KitchenExpediteItemOut(BaseModel):
    item_id: int
    name: str
    status: str
    station: str | None


class KitchenExpediteOut(BaseModel):
    order_id: int
    changed: bool
    """`False` cuando no quedaba nada por expedir (todo ya estaba `ready`
    o más allá): no es un error, es información."""
    changed_item_ids: list[int]
    items: list[KitchenExpediteItemOut]
    expedited_by: EmployeeRef
    expedited_at: datetime


class PrintJobIn(BaseModel):
    round_id: int
    station: str


class KitchenPrintJobItemOut(BaseModel):
    item_id: int
    name: str
    qty: int
    modifiers_text: str | None
    note: str | None


class KitchenPrintJobOut(BaseModel):
    """El "trabajo de impresión": lo que una impresora térmica real
    recibiría para esta ronda y esta estación (`app/kitchen/service.py`
    dice dónde termina esto). `printed`/`printed_at`/`printed_by`/
    `print_count` son el registro (§ misión, punto 3): `print_count == 0`
    es "nunca se confirmó como impreso", no un error."""

    order_id: int
    round_id: int
    round_no: int
    station: str
    channel: str
    tables: list[str]
    items: list[KitchenPrintJobItemOut]
    item_count: int
    printed: bool
    printed_at: datetime | None
    printed_by: EmployeeRef | None
    print_count: int
