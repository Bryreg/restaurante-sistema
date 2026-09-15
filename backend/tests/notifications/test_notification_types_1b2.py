"""Catálogo `NOTIFICATION_TYPES` ampliado en 1b-2 (`backend-clientes-dinero`):
`fiscal_rejected`, `fiscal_contingency_overdue`, `fiscal_range_low` y
`pending_refund`. Los otros cinco (`void_rate_high`, `discount_rate_high`,
`courtesy_limit`, `order_unsent_too_long`, `order_unpaid_too_long`) ya
estaban declarados desde 1b-1: este archivo confirma que siguen ahí (no se
duplicaron ni se perdieron) y que los cuatro nuevos aparecen exactamente una
vez.
"""

from __future__ import annotations

from app.notifications.service import NOTIFICATION_TYPES

NEW_IN_1B2 = ["fiscal_rejected", "fiscal_contingency_overdue", "fiscal_range_low", "pending_refund"]
ALREADY_DECLARED_IN_1B1 = [
    "void_rate_high",
    "discount_rate_high",
    "courtesy_limit",
    "order_unsent_too_long",
    "order_unpaid_too_long",
]


def test_the_four_new_types_are_declared_exactly_once() -> None:
    for t in NEW_IN_1B2:
        assert NOTIFICATION_TYPES.count(t) == 1, f"{t} debería estar declarado exactamente una vez"


def test_the_1b1_types_were_not_duplicated() -> None:
    for t in ALREADY_DECLARED_IN_1B1:
        assert NOTIFICATION_TYPES.count(t) == 1, f"{t} no se debía duplicar"


def test_no_duplicates_at_all_in_the_catalog() -> None:
    assert len(NOTIFICATION_TYPES) == len(set(NOTIFICATION_TYPES))
