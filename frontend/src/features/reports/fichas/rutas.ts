/**
 * Las direcciones de las fichas relacionales. Cuelgan de la pantalla de su
 * sección —Caja › Dinero, Equipo › Turnos, Inventario— para que el rail
 * encienda la sección correcta sin sumar entradas (`app/AdminLayout.tsx`
 * reconoce una ruta hija de una pestaña como parte de ella).
 *
 * Cualquier pantalla que muestre un turno, una persona o un insumo enlaza
 * acá con estas funciones: si la dirección cambia, cambia en un solo lugar.
 */
export function fichaTurnoHref(shiftId: number): string {
  return `/admin/dinero/turno/${shiftId}`
}

export function fichaPersonaHref(employeeId: number): string {
  return `/admin/personal/persona/${employeeId}`
}

export function fichaInsumoHref(ingredientId: number): string {
  return `/admin/inventario/insumo/${ingredientId}`
}
