/**
 * Hooks compartidos por las pantallas de Turno (POS): un solo lugar que
 * define las claves de `react-query` y el sondeo de `GET /shifts/current`
 * cada 5 s (SPEC-NEGOCIO § 9.1) para que `ShiftStatusStrip` y `ShiftPage` no
 * dupliquen la lógica ni disparen dos configuraciones distintas sobre la
 * misma clave.
 */
import { useQuery } from "@tanstack/react-query";
import { useCallback } from "react";
import { useSearchParams } from "react-router-dom";

import { getCurrentShift, getShiftSummary, getShiftTips, listPendingDeliveryCash } from "@/api/shifts";

import type { ClaveAccion } from "./acciones";

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

/** `GET /delivery-settlements/pending` (`pos.delivery`, pedido 2c). */
export const DELIVERY_PENDING_QUERY_KEY = ["delivery-settlements", "pending"] as const;

export function usePendingDeliveryCash(enabled: boolean) {
  return useQuery({
    queryKey: DELIVERY_PENDING_QUERY_KEY,
    queryFn: listPendingDeliveryCash,
    enabled,
    refetchInterval: POLL_MS,
  });
}

export function shiftTipsQueryKey(shiftId: number | null | undefined) {
  return ["shifts", "tips", shiftId] as const;
}

/**
 * `GET /shifts/{id}/tips` (iteración 3, H-8): sólo se usa hoy para mostrar,
 * como REFERENCIA de sólo lectura junto al campo de propinas del cierre, el
 * `cash_out` que calcula el servidor — nunca se recalcula acá.
 */
export function useShiftTips(shiftId: number | null | undefined) {
  return useQuery({
    queryKey: shiftTipsQueryKey(shiftId),
    queryFn: () => getShiftTips(shiftId as number),
    enabled: shiftId !== null && shiftId !== undefined,
  });
}

/** `GET /shifts/carry-candidates` (2026-09-24): los días con plata por consignar que quien abre puede marcar. */
export const CARRY_CANDIDATES_QUERY_KEY = ["shifts", "carry-candidates"] as const;

/** `GET /deposits/drawer` (2026-09-24): los días anteriores que están en el cajón del turno abierto. */
export const DEPOSIT_DRAWER_QUERY_KEY = ["deposits", "drawer"] as const;

/** `GET /shifts/opening` (2026-09-26): la regla de apertura de la sede y los sobres elegibles, sin montos. */
export const OPENING_INFO_QUERY_KEY = ["shifts", "opening"] as const;

/** `GET /shifts/{id}/reserve` (2026-09-26): la base de respaldo vista desde el cajón. */
export function reserveQueryKey(shiftId: number | null | undefined) {
  return ["shifts", "reserve", shiftId] as const;
}

/**
 * La acción abierta vive en la URL (`?accion=`), no en un estado: así se
 * puede enlazar desde otra pantalla (`/pos/turno?accion=consignar`,
 * `/pos/mesas?accion=retiros`). Quien la usa resuelve la clave contra sus
 * acciones habilitadas: una desconocida o apagada por flag se ignora.
 */
export function useAccionEnUrl(): {
  claveAbierta: string | null;
  abrir: (clave: ClaveAccion) => void;
  cerrar: () => void;
} {
  const [searchParams, setSearchParams] = useSearchParams();
  const claveAbierta = searchParams.get("accion");
  const abrir = useCallback(
    (clave: ClaveAccion) =>
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set("accion", clave);
          return next;
        },
        { replace: true },
      ),
    [setSearchParams],
  );
  const cerrar = useCallback(
    () =>
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.delete("accion");
          return next;
        },
        { replace: true },
      ),
    [setSearchParams],
  );
  return { claveAbierta, abrir, cerrar };
}
