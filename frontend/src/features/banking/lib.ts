/**
 * Utilidades puras y compartidas de "Banco": etiquetas y fechas de filtro por
 * defecto — nunca plata derivada (AGENTS.md § "una sola matemática, en el
 * backend"). `todayLocal`/`daysAgoLocal` reexportan `todayInBogota`/
 * `daysAgoInBogota` de `features/reports/lib.ts` en vez de duplicarlas
 * (mismo patrón que `features/inventory/lib.ts`, hallazgo O-4 de 1b-2).
 */
import type { BankLedgerEntryKind, BankMovementCause } from "@/api/banking"
import { daysAgoInBogota, todayInBogota } from "@/features/reports/lib"

export const todayLocal = todayInBogota
export const daysAgoLocal = daysAgoInBogota

export const LEDGER_KIND_LABEL: Record<BankLedgerEntryKind, string> = {
  deposit: "Consignación",
  card_settlement: "Liquidación de datáfono",
  transfer: "Transferencia de clientes",
  platform_settlement: "Liquidación de plataforma",
  expense: "Gasto pagado del banco",
  obligation: "Obligación pagada del banco",
  supplier_payment: "Pago a proveedor",
  movement: "Movimiento tecleado",
}

/** La causa de un movimiento tecleado, en la palabra del negocio. */
export const MOVEMENT_CAUSE_LABEL: Record<BankMovementCause, string> = {
  payroll: "Nómina",
  bank_fee: "Cuota de manejo o comisión",
  tax: "Impuesto",
  owner_withdrawal: "Retiro del dueño",
  owner_contribution: "Aporte del dueño",
  account_transfer: "Traslado entre cuentas",
  interest: "Intereses",
  adjustment: "Ajuste",
  other: "Otro",
}

/** Qué causas valen para cada sentido (el servidor lo vuelve a validar). */
export const CAUSES_BY_DIRECTION: Record<"in" | "out", BankMovementCause[]> = {
  in: ["owner_contribution", "interest", "adjustment", "other"],
  out: ["payroll", "bank_fee", "tax", "owner_withdrawal", "account_transfer", "adjustment", "other"],
}

export function ledgerKindLabel(kind: string | undefined): string {
  if (!kind) return "—"
  return LEDGER_KIND_LABEL[kind as BankLedgerEntryKind] ?? kind
}


/** La etiqueta de un renglón: un movimiento tecleado dice su causa. */
export function ledgerEntryLabel(kind: string | undefined, cause: BankMovementCause | null | undefined): string {
  if (kind === "movement" && cause) return MOVEMENT_CAUSE_LABEL[cause] ?? ledgerKindLabel(kind)
  return ledgerKindLabel(kind)
}

/** Las pestañas de Plata (`/admin/plata`), que antes eran de `/admin/banco` (c10). */
export const PLATA_TABS = ["libro", "mano", "datafono", "plataformas"] as const
