/**
 * Listas cerradas y helpers compartidos por las pantallas de Compras
 * (`features/fase-2-costo-inventario/spec.md § Alcance de 2b`). Causa y
 * estado son listas cerradas que vienen del backend — estos diccionarios
 * sólo les ponen la etiqueta en español; nunca aceptan un valor que el
 * backend no declaró (AGENTS.md § "causa tipada").
 *
 * `defaultDateRange` reexporta/reusa `todayInBogota`/`daysAgoInBogota` de
 * `features/reports/lib.ts` (mismo criterio que ya adoptó
 * `features/inventory/lib.ts`: `todayLocal`/`daysAgoLocal`) en vez de armar
 * una cuarta fórmula de fecha con `new Date().toISOString().slice(0, 10)`,
 * que deriva la fecha de la zona del NAVEGADOR, no de la sede. En Bogotá
 * (UTC−5), a partir de las 19:00 locales `toISOString()` ya está en el día
 * siguiente: un rango "últimos N días" calculado así se corre un día todas
 * las noches, justo cuando un admin suele revisar (hallazgo H-6, ronda 2).
 */

import type {
  PayablesAgingBucket,
  PayableStatus,
  ReceptionStatus,
  SupplierOut,
  SupplierPaymentMethod,
} from "@/api/purchases"
import { daysAgoInBogota, todayInBogota } from "@/features/reports/lib"

export const SUPPLIER_PAYMENT_METHOD_LABEL: Record<SupplierPaymentMethod, string> = {
  cash: "Efectivo",
  card: "Tarjeta",
  transfer: "Transferencia",
  other: "Otro",
}

export const RECEPTION_STATUS_LABEL: Record<ReceptionStatus, string> = {
  confirmed: "Confirmada",
  reversed: "Revertida",
}

export const PAYABLE_STATUS_LABEL: Record<PayableStatus, string> = {
  pending_review: "Pendiente de revisión",
  approved: "Aprobada",
  cancelled: "Cancelada",
}

/** Un porcentaje que el backend ya calculó (entero, puntos porcentuales) o
 * `null` cuando no hay datos para calcularlo — nunca se dibuja como "0 %"
 * (AGENTS.md § "null no es 0"). */
export function formatPct(value: number | null): string {
  return value === null ? "sin datos" : `${value} %`
}

// `downloadSuppliersCsv` (el CSV de proveedores armado en el cliente) se fue:
// `GET /admin/suppliers` ya acepta `format=csv` y el servidor arma el archivo
// para Excel en español, igual que toda otra lista (`CsvExportButton`).

export function supplierName(suppliers: SupplierOut[], supplierId: number): string {
  return suppliers.find((s) => s.id === supplierId)?.name ?? `Proveedor #${supplierId}`
}

/**
 * Rango por defecto de un filtro de fecha en Compras: `to` es HOY en la zona
 * de la sede (America/Bogota) y `from` es exactamente `days` días antes de
 * ESA fecha — nunca de la fecha UTC del navegador. Único punto de esta
 * fórmula en `features/purchases/**`; las tres pantallas con un rango por
 * defecto (Recepciones, Cuentas por pagar, Confiabilidad de proveedor) lo
 * importan de acá en vez de calcular cada una la suya.
 */
export function defaultDateRange(days: number): { from: string; to: string } {
  return { from: daysAgoInBogota(days), to: todayInBogota() }
}

// ---------------------------------------------------------------------------
// Resumen de cuentas por pagar (informe de visualización #8): rótulos de los
// tramos y el titular. Las cifras vienen de `GET /admin/payables/summary`.
// ---------------------------------------------------------------------------

export const AGING_LABEL: Record<PayablesAgingBucket, string> = {
  current: "Al día",
  "1_30": "1 a 30 días vencida",
  "31_60": "31 a 60 días vencida",
  over_60: "Más de 60 días vencida",
}

/** Etiqueta corta para el eje (a 390 px no caben las largas). */
export const AGING_EJE: Record<PayablesAgingBucket, string> = {
  current: "Al día",
  "1_30": "1–30 d",
  "31_60": "31–60 d",
  over_60: "+60 d",
}

export function cuentas(n: number): string {
  return `${n} ${n === 1 ? "cuenta" : "cuentas"}`
}

