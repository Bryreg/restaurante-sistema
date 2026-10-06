"""Matriz de permisos (auditoría e11): quién puede qué, por rol.

No es una configuración aparte que pueda desincronizarse: las filas de
autorización salen de `auth.service.SUPERVISOR_ACTIONS` (lo que un
supervisor puede autorizar con su PIN; el resto, sólo un administrador) y
las de rol de las reglas de `deps.current_admin` (el contador es de sólo
lectura) y del POS. Un test verifica que cada acción autorizable tenga su
fila.
"""

from __future__ import annotations

from typing import Literal, TypedDict

from app.auth.service import SUPERVISOR_ACTIONS

Nivel = Literal["si", "no", "autoriza", "con_autorizacion", "solo_ver", "si_puede_cobrar"]
ROLES = ("operator", "supervisor", "admin", "accountant")


class Fila(TypedDict):
    area: str
    capacidad: str
    operator: Nivel
    supervisor: Nivel
    admin: Nivel
    accountant: Nivel


# Acciones que se autorizan con el PIN de otra persona (`verify_authorizer`).
AUTHORIZABLE_ACTIONS: dict[str, tuple[str, str]] = {
    "void_sent_item": ("Salón", "Anular un plato ya enviado a cocina"),
    "courtesy": ("Salón", "Dar una cortesía"),
    "discount_over_limit": ("Salón", "Descuento por encima del límite de la persona"),
    "void_order": ("Salón", "Anular una comanda"),
    "after_bill_change": ("Salón", "Cambiar una cuenta ya impresa"),
    "reserve_take": ("Caja", "Tomar plata de la base de respaldo"),
    "reserve_reverse": ("Caja", "Reversar un movimiento de la base de respaldo"),
    "handover": ("Caja", "Entregar el cajón en un relevo"),
    "petty_over_limit": ("Caja", "Gasto de caja menor por encima del tope"),
    "pickup": ("Caja", "Retiro de efectivo del cajón"),
    "pickup_reverse": ("Caja", "Reversar un retiro"),
    "spot_check": ("Inventario", "Recuento sorpresa"),
    "preparation_mode_change": ("Cocina", "Cambiar el modo de una preparación"),
    "purchases.payable_approve": ("Compras", "Aprobar una cuenta por pagar"),
    "purchases.payment_create": ("Compras", "Registrar un pago a proveedor"),
    "purchases.payment_void": ("Compras", "Anular un pago a proveedor"),
    "purchases.reception_reverse": ("Compras", "Reversar una recepción"),
}

_BASE: list[Fila] = [
    Fila(area="Salón", capacidad="Tomar pedidos y mandarlos a cocina",
         operator="si", supervisor="si", admin="si", accountant="no"),
    Fila(area="Salón", capacidad="Cobrar",
         operator="si_puede_cobrar", supervisor="si", admin="si", accountant="no"),
    Fila(area="Salón", capacidad="Descuento hasta su propio límite",
         operator="si", supervisor="si", admin="si", accountant="no"),
    Fila(area="Caja", capacidad="Abrir y cerrar el turno de caja",
         operator="si_puede_cobrar", supervisor="si", admin="si", accountant="no"),
    Fila(area="Escritorio", capacidad="Entrar al escritorio con correo y contraseña",
         operator="no", supervisor="no", admin="si", accountant="si"),
    Fila(area="Escritorio", capacidad="Ver informes, plata, inventario, nómina y documentos fiscales",
         operator="no", supervisor="no", admin="si", accountant="solo_ver"),
    Fila(area="Escritorio", capacidad="Exportar a CSV",
         operator="no", supervisor="no", admin="si", accountant="si"),
    Fila(area="Escritorio", capacidad="Cambiar catálogo, precios, ajustes, personal y nómina",
         operator="no", supervisor="no", admin="si", accountant="no"),
]


def matrix() -> list[Fila]:
    rows = list(_BASE)
    for action, (area, label) in AUTHORIZABLE_ACTIONS.items():
        rows.append(
            Fila(
                area=area,
                capacidad=label,
                operator="con_autorizacion",
                supervisor="autoriza" if action in SUPERVISOR_ACTIONS else "con_autorizacion",
                admin="autoriza",
                accountant="no",
            )
        )
    return rows
