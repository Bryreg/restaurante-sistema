import type { ReliabilityKey } from "@/api/reports"

/**
 * A dónde lleva cada aviso de «¿le puedo creer a estos números?»: la
 * pantalla que lo arregla. El servidor dice QUÉ falta (`key`); acá sólo se
 * elige el camino, igual que `alertRoute` con los avisos de Hoy.
 */
export const RELIABILITY_ROUTE: Record<ReliabilityKey, { to: string; label: string }> = {
  inventory_never_counted: { to: "/admin/inventario?tab=salud", label: "Hacer un conteo completo" },
  inventory_stale: { to: "/admin/inventario?tab=salud", label: "Hacer un conteo completo" },
  uncosted_sales: { to: "/admin/carta", label: "Cargar fichas técnicas" },
  uncosted_products: { to: "/admin/carta", label: "Cargar recetas" },
  shifts_open: { to: "/admin/dinero", label: "Cerrar los turnos" },
  shifts_unreviewed: { to: "/admin/dinero?tab=historial", label: "Revisar los cierres" },
  attendance_review: { to: "/admin/nomina?tab=horas", label: "Corregir las salidas" },
  payroll_no_tables: { to: "/admin/nomina?tab=recargos", label: "Cargar la tabla de recargos" },
  payroll_tables_unconfirmed: { to: "/admin/nomina?tab=recargos", label: "Confirmar la tabla" },
  payroll_legal_unconfirmed: { to: "/admin/nomina?tab=contratos", label: "Confirmar los parámetros" },
  payroll_without_wage: { to: "/admin/nomina?tab=tarifas", label: "Cargar las tarifas" },
  payroll_without_contract: { to: "/admin/nomina?tab=contratos", label: "Cargar los contratos" },
  no_opening_hours: { to: "/admin/settings", label: "Cargar el horario" },
  no_table_seats: { to: "/admin/settings", label: "Cargar las sillas" },
}

/**
 * «0,50 vueltas»: una razón que llega en puntos básicos (10.000 = 1), escrita
 * con dos decimales. Cambiar de unidad para escribirla no es una cuenta.
 */
export function formatVueltas(bp: number | null | undefined): string {
  if (bp === null || bp === undefined || Number.isNaN(bp)) return "—"
  return (bp / 10_000).toLocaleString("es-CO", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/** «88,00 h»: las horas que el servidor manda como texto decimal («88.00»). */
export function formatHorasTexto(texto: string | null | undefined): string {
  if (!texto) return "—"
  return `${texto.replace(".", ",")} h`
}
