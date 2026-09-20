/**
 * Utilidades puras y compartidas de "Banco": etiquetas y fechas de filtro por
 * defecto — nunca plata derivada (AGENTS.md § "una sola matemática, en el
 * backend"). `todayLocal`/`daysAgoLocal` reexportan `todayInBogota`/
 * `daysAgoInBogota` de `features/reports/lib.ts` en vez de duplicarlas
 * (mismo patrón que `features/inventory/lib.ts`, hallazgo O-4 de 1b-2).
 */
import type { BankLedgerEntryKind } from "@/api/banking"
import { daysAgoInBogota, todayInBogota } from "@/features/reports/lib"

export const todayLocal = todayInBogota
export const daysAgoLocal = daysAgoInBogota

export const LEDGER_KIND_LABEL: Record<BankLedgerEntryKind, string> = {
  deposit: "Consignación",
  card_settlement: "Liquidación de datáfono",
  transfer: "Transferencia",
}

export function ledgerKindLabel(kind: string | undefined): string {
  if (!kind) return "—"
  return LEDGER_KIND_LABEL[kind as BankLedgerEntryKind] ?? kind
}
