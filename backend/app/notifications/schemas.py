from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel


class NotificationOut(BaseModel):
    id: int
    type: str
    level: str
    title: str
    body: str
    payload: dict[str, Any] | None = None
    read_at: datetime | None = None
    created_at: datetime


class NotificationRuleOut(BaseModel):
    type: str
    enabled: bool
    threshold: int | None = None
    level: str


class NotificationRuleIn(BaseModel):
    type: str
    enabled: bool
    threshold: int | None = None
    level: str
