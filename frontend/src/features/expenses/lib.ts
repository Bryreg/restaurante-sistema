/**
 * Utilidades puras y compartidas de "Obligaciones y gastos": etiquetas y
 * fechas de filtro por defecto — nunca plata derivada (AGENTS.md § "una sola
 * matemática, en el backend"). `todayLocal`/`daysAgoLocal` reexportan
 * `todayInBogota`/`daysAgoInBogota` de `features/reports/lib.ts` en vez de
 * duplicarlas (mismo patrón que `features/inventory/lib.ts`).
 */
import type { ExpenseCategory, ExpenseSource, ObligationCategory, ObligationStatus } from "@/api/expenses"
import { daysAgoInBogota, todayInBogota } from "@/features/reports/lib"

export const todayLocal = todayInBogota
export const daysAgoLocal = daysAgoInBogota

/** Espejo de `app/expenses/schemas.py::ExpenseCategoryLiteral` — enum
 * cerrado, nunca texto libre (mismo criterio que `MovementCause` en
 * `features/inventory/lib.ts`). */
export const EXPENSE_CATEGORY_LABEL: Record<ExpenseCategory, string> = {
  supplies: "Insumos",
  maintenance: "Mantenimiento",
  utilities: "Servicios públicos",
  marketing: "Mercadeo",
  transport: "Transporte",
  other: "Otro",
}

export function expenseCategoryLabel(category: string): string {
  return EXPENSE_CATEGORY_LABEL[category as ExpenseCategory] ?? category
}

/** Espejo de `app/expenses/schemas.py::ExpenseSourceLiteral`: de dónde salió
 * la plata de un gasto o de una obligación saldada. */
export const EXPENSE_SOURCE_LABEL: Record<ExpenseSource, string> = {
  bank: "Banco (transferencia o débito)",
  cash_drawer: "Cajón (egreso ya registrado en el turno)",
  other: "Otro (fuera del banco y del cajón)",
}

export function expenseSourceLabel(source: string): string {
  return EXPENSE_SOURCE_LABEL[source as ExpenseSource] ?? source
}

/** Las causas de egreso del cajón que respaldan un gasto (espejo de
 * `app/expenses/service.py::_EXPENSE_CASH_MOVEMENT_CAUSES`). */
export const DRAWER_EXPENSE_CAUSE_LABEL: Record<string, string> = {
  petty_expense: "Gasto menor",
  emergency_purchase: "Compra de emergencia",
  other_expense: "Otro egreso",
}

/** Espejo de `app/expenses/schemas.py::ObligationCategoryLiteral`. */
export const OBLIGATION_CATEGORY_LABEL: Record<ObligationCategory, string> = {
  rent: "Arriendo",
  utilities: "Servicios públicos",
  taxes: "Impuestos",
  other: "Otro",
}

export function obligationCategoryLabel(category: string): string {
  return OBLIGATION_CATEGORY_LABEL[category as ObligationCategory] ?? category
}

/** Espejo de `app/expenses/schemas.py::ObligationStatusLiteral`
 * (`"pending" | "paid"`) — no existe `"cancelled"` como estado: una
 * obligación cancelada sigue `pending` y lleva `cancelled_at` propio. */
export const OBLIGATION_STATUS_LABEL: Record<ObligationStatus, string> = {
  pending: "Pendiente",
  paid: "Pagada",
}

export function obligationStatusLabel(status: string): string {
  return OBLIGATION_STATUS_LABEL[status as ObligationStatus] ?? status
}

export const PAYABLE_STATUS_LABEL: Record<string, string> = {
  pending_review: "Pendiente de revisión",
  approved: "Aprobada",
  cancelled: "Cancelada",
}

export function payableStatusLabel(status: string): string {
  return PAYABLE_STATUS_LABEL[status] ?? status
}

/**
 * Puntos básicos REALES (100 = 1 %): reexporta `formatBasisPoints` de
 * `features/inventory/lib.ts`, la ÚNICA función del repo que sabe que
 * 100 = 1 % — mismo patrón ya usado por `features/settings/ChannelsSection.tsx`
 * e `InventorySection.tsx` (cross-domain, territorio ajeno), en vez de
 * reimplementarla acá.
 */
export { formatBasisPoints } from "@/features/inventory/lib"
