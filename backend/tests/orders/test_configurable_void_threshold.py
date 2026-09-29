"""`void_rate_high` lee el umbral de la regla de la sede: con la regla en
20 %, anular el 15 % de las ventas del turno ya no avisa (con el default de
10 % sí avisaría, `test_limits.test_void_rate_high_notifies_with_dedupe`)."""

from __future__ import annotations

from typing import Any

from sqlalchemy import select

from app.notifications.models import Notification, NotificationRule


def test_void_rate_rule_threshold_changes_the_alert(
    device_client: Any, identify: Any, employees: Any, open_shift: Any, new_order: Any, add_items: Any,
    main_product: Any, drink_product: Any, db: Any, store: Any, org: Any,
) -> None:
    db.add(NotificationRule(organization_id=org.id, store_id=store.id, type="void_rate_high", enabled=True, threshold=20, level="critical"))
    db.commit()
    open_shift()
    identify(device_client, employees["operator"])
    operator = employees["operator"]

    from app.orders.models import Order

    paid = add_items(new_order().json(), [{"product_id": main_product.id, "qty": 4}]).json()  # 100.000
    row = db.get(Order, paid["id"])
    row.status = "paid"
    row.paid_by_employee_id = operator.id
    row.paid_by_employee_name = operator.name
    db.commit()

    order = add_items(new_order().json(), [{"product_id": drink_product.id, "qty": 3}]).json()  # 15.000
    void = device_client.post(
        f"/api/v1/orders/{order['id']}/items/{order['items'][0]['id']}/void",
        json={"expected_version": order["version"], "reason": "duplicate"},
    )
    assert void.status_code == 200, void.text
    rows = db.execute(select(Notification).where(Notification.type == "void_rate_high")).scalars().all()
    assert rows == []  # 15 % < 20 % de la regla
