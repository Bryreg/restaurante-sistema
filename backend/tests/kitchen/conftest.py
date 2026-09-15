"""`tests/kitchen` reusa las fixtures de `tests/orders/conftest.py` (mismo
territorio, `backend-comanda`): pytest descubre fixtures por nombre en el
namespace del `conftest.py` de cada carpeta, así que re-exportarlas acá basta
— no se redefine nada, sólo se hacen visibles para este directorio."""

from __future__ import annotations

from tests.orders.conftest import (  # noqa: F401
    add_items,
    drink_product,
    idem_headers,
    main_product,
    new_order,
    send_order,
    tables,
    zone,
)
