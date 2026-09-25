import type { Denomination } from "@/api/shifts";
import type { StaffRequest, StaffRequestKind, StaffRequestStatus } from "@/api/requests";
import { DENOMINATIONS } from "@/lib/money";

export const KIND_LABEL: Record<StaffRequestKind, string> = {
  supply: "Insumos",
  change: "Sencilla",
};

/**
 * El estado en palabras. «Aprobado» no es el final: dice qué falta — comprar
 * los insumos o traer la sencilla —, que es lo que el salón necesita saber.
 */
export function statusLabel(request: Pick<StaffRequest, "kind" | "status">): string {
  const labels: Record<StaffRequestStatus, string> = {
    pending: "Pendiente",
    approved: request.kind === "supply" ? "Aprobado · por comprar" : "Aprobado · por entregar",
    rejected: "Rechazado",
    bought: "Comprado",
    received: "Recibida",
  };
  return labels[request.status];
}

export function statusVariant(status: StaffRequestStatus): "default" | "secondary" | "destructive" | "outline" {
  if (status === "rejected") return "destructive";
  if (status === "approved") return "default";
  if (status === "pending") return "secondary";
  return "outline";
}

/** Todas las denominaciones, con la cantidad que traiga `rows` (o cero). */
export function fullDenominations(rows: Denomination[] | null | undefined): Denomination[] {
  const byValue = new Map((rows ?? []).map((d) => [d.value, d.count]));
  return DENOMINATIONS.map((value) => ({ value, count: byValue.get(value) ?? 0 }));
}

/**
 * La suma de lo tecleado, que viaja como `total` del desglose — igual que
 * en `CashSwapPanel`. No es un esperado ni una diferencia: el servidor
 * vuelve a sumar y rechaza si no cuadra (`DENOMINATIONS_MISMATCH`).
 */
export function typedTotal(rows: Denomination[]): number {
  return rows.reduce((acc, d) => acc + d.value * d.count, 0);
}

export const REQUESTS_QUERY_KEYS = {
  mine: ["requests", "mine"] as const,
  suggestions: ["requests", "supply-suggestions"] as const,
  adminPending: (storeId: number) => ["requests", "admin", storeId, "pending"] as const,
  adminApprovedSupplies: (storeId: number) => ["requests", "admin", storeId, "approved-supplies"] as const,
};
