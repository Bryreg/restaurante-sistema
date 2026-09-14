/**
 * Hooks compartidos por las pantallas de Turno (POS): un solo lugar que
 * define las claves de `react-query` y el sondeo de `GET /shifts/current`
 * cada 5 s (SPEC-NEGOCIO § 9.1) para que `ShiftStatusStrip` y `ShiftPage` no
 * dupliquen la lógica ni disparen dos configuraciones distintas sobre la
 * misma clave.
 */
import { useQuery } from "@tanstack/react-query";

import { getCurrentShift, getShiftSummary } from "@/api/shifts";

export const CURRENT_SHIFT_QUERY_KEY = ["shifts", "current"] as const;

const POLL_MS = 5_000;

export function useCurrentShift() {
  return useQuery({
    queryKey: CURRENT_SHIFT_QUERY_KEY,
    queryFn: getCurrentShift,
    refetchInterval: POLL_MS,
  });
}

export function shiftSummaryQueryKey(shiftId: number | null | undefined) {
  return ["shifts", "summary", shiftId] as const;
}

/**
 * Resumen completo (`GET /shifts/{id}`): movimientos, cambios, retiros,
 * relevos y roster. Cada panel que escribe algo invalida esta clave para
 * que las listas se refresquen sin volver a pedir todo el árbol.
 */
export function useShiftSummary(shiftId: number | null | undefined) {
  return useQuery({
    queryKey: shiftSummaryQueryKey(shiftId),
    queryFn: () => getShiftSummary(shiftId as number),
    enabled: shiftId !== null && shiftId !== undefined,
  });
}
