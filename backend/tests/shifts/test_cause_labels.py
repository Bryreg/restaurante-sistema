"""Toda causa de movimiento de caja tiene etiqueta legible.

**Defecto encontrado recorriendo la app, no por un test.** La cronología del
turno mostraba «Egreso (supplier_payment) por $150.000» — el nombre crudo del
enum en la pantalla de Dinero — porque 2b agregó la causa y
`_MOVEMENT_CAUSE_LABEL` se quedó con las seis de 1a. Es exactamente el mismo
defecto que 1a ya había arreglado para las otras seis, y volvió porque el
`.get(..., valor_crudo)` degrada EN SILENCIO: nada falla, sólo se ve feo.

Es la sexta vez en este proyecto que un enum crece de un lado y su espejo del
otro no se entera. Este test es la forma barata de cobrarlo: lee el enum real
en vez de repetir una lista a mano.
"""

from __future__ import annotations

from app.shifts.models import CashMovementCause
from app.shifts.service import _MOVEMENT_CAUSE_LABEL, _movement_cause_label


def test_every_cash_movement_cause_has_a_readable_label() -> None:
    sin_etiqueta = [c.value for c in CashMovementCause if c.value not in _MOVEMENT_CAUSE_LABEL]
    assert not sin_etiqueta, (
        "estas causas se van a pintar con el nombre crudo del enum en la cronología del turno: "
        f"{sin_etiqueta}. `_movement_cause_label` cae al valor crudo sin fallar, así que el defecto "
        "no rompe nada: sólo se ve mal, y por eso nadie lo nota"
    )


def test_no_label_is_left_over_for_a_cause_that_no_longer_exists() -> None:
    """El espejo también se rompe al revés: una etiqueta huérfana es una
    causa que alguien sacó del enum y nadie limpió acá."""
    vivas = {c.value for c in CashMovementCause}
    sobrantes = [k for k in _MOVEMENT_CAUSE_LABEL if k not in vivas]
    assert not sobrantes, f"etiquetas de causas que ya no existen en `CashMovementCause`: {sobrantes}"


def test_the_supplier_payment_label_is_in_spanish_not_the_enum_name() -> None:
    assert _movement_cause_label(CashMovementCause.SUPPLIER_PAYMENT) == "Pago a proveedor"
