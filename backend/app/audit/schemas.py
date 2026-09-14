from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel


class AuditRowOut(BaseModel):
    id: int
    entity: str
    entity_id: str
    action: str
    before: dict[str, Any] | None
    after: dict[str, Any] | None
    reason: str | None
    actor_employee_id: int | None
    actor_employee_name: str | None
    actor_kind: str | None
    at: datetime
