"""Fixtures de reservas. Reusa las de `tests/orders` para no duplicar mesas."""

from __future__ import annotations

import sys
from pathlib import Path

# `tests/orders/conftest.py` trae `zone`, `tables`, `idem_headers` y el rango
# fiscal por defecto. Se importa su módulo en vez de copiarlo: las mesas de
# una reserva tienen que ser las MISMAS que las del plano, o los tests
# pasarían contra un salón que no existe.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from orders.conftest import *  # noqa: F401,F403,E402
