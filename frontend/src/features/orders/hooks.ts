/**
 * Claves de `react-query` y sondeo del dominio comanda (CONTRATO-INTERNO-1b-1.md
 * §6.3 "Patrones obligatorios"): una sola clave por recurso, para que ninguna
 * pantalla dispare dos configuraciones de sondeo distintas sobre el mismo
 * dato. También el patrón de "versión optimista" (§6.3): ante `409
 * STALE_VERSION` se reemplaza la comanda local por `error.extra.order`, se
 * invalida la query y se avisa a la persona.
 */
import { useQuery, type QueryClient } from "@tanstack/react-query"
import { useCallback, useRef, useState } from "react"

import { getCatalog } from "@/api/catalog"
import { ApiError } from "@/api/client"
import { listFavorites, listTablesStatus, getOrder, type OrderOut } from "@/api/orders"
import { listKitchenRounds } from "@/api/kitchen"

export const TABLES_STATUS_QUERY_KEY = ["tables", "status"] as const
export const CATALOG_QUERY_KEY = ["catalog"] as const
export const FAVORITES_QUERY_KEY = ["orders", "favorites"] as const

export function orderQueryKey(orderId: number | null | undefined) {
  return ["orders", orderId] as const
}

export function kitchenRoundsQueryKey(station: string | undefined) {
  return ["kitchen", station ?? "__all__"] as const
}

const TABLES_POLL_MS = 5_000
const ORDER_POLL_MS = 5_000
const KITCHEN_POLL_MS = 4_000

export function useTablesStatus(enabled: boolean) {
  return useQuery({
    queryKey: TABLES_STATUS_QUERY_KEY,
    queryFn: listTablesStatus,
    enabled,
    refetchInterval: TABLES_POLL_MS,
  })
}

export function useCatalog() {
  return useQuery({ queryKey: CATALOG_QUERY_KEY, queryFn: () => getCatalog() })
}

export function useFavorites(enabled: boolean) {
  return useQuery({ queryKey: FAVORITES_QUERY_KEY, queryFn: listFavorites, enabled })
}

export function useOrder(orderId: number | null | undefined) {
  return useQuery({
    queryKey: orderQueryKey(orderId),
    queryFn: () => getOrder(orderId as number),
    enabled: orderId !== null && orderId !== undefined,
    refetchInterval: ORDER_POLL_MS,
  })
}

export function useKitchenRounds(station: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: kitchenRoundsQueryKey(station),
    queryFn: () => listKitchenRounds(station),
    enabled,
    refetchInterval: KITCHEN_POLL_MS,
  })
}

/** Los tres códigos que el backend usa para pedir PIN de supervisor/admin (§6.3). */
const AUTHORIZER_ERROR_CODES = new Set(["AUTHORIZATION_REQUIRED", "DISCOUNT_LIMIT_EXCEEDED", "BILL_PRESENTED_NEEDS_AUTH"])

export function isAuthorizerError(err: unknown): err is ApiError {
  return err instanceof ApiError && AUTHORIZER_ERROR_CODES.has(err.code)
}

export function isStaleVersionError(err: unknown): err is ApiError {
  return err instanceof ApiError && err.code === "STALE_VERSION"
}

/**
 * Ante `409 STALE_VERSION`, `error.extra.order` trae la comanda actual: se
 * escribe directo en la caché de `["orders", id]` (evita un round-trip) y se
 * invalida para que cualquier otra vista que la use también se refresque.
 */
export function applyStaleOrder(queryClient: QueryClient, orderId: number, err: ApiError): void {
  const fresh = err.extra.order as OrderOut | undefined
  if (fresh) {
    queryClient.setQueryData(orderQueryKey(orderId), fresh)
  }
  void queryClient.invalidateQueries({ queryKey: orderQueryKey(orderId) })
}

export const STALE_VERSION_MESSAGE = "La comanda cambió en otra tablet; revisá y repetí.";

/**
 * Encapsula el diálogo de PIN de autorizador (§6.3): cualquier mutación que
 * reciba `AUTHORIZATION_REQUIRED` / `DISCOUNT_LIMIT_EXCEEDED` /
 * `BILL_PRESENTED_NEEDS_AUTH` abre el diálogo y reintenta la MISMA acción con
 * `authorizer_pin` (y, si la acción usa `Idempotency-Key`, una clave nueva —
 * eso lo decide quien llama a `retry`, no este hook).
 */
export function useAuthorizerFlow() {
  const [open, setOpen] = useState(false);
  const [pinError, setPinError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const retryRef = useRef<((pin: string) => void) | null>(null);

  /** Devuelve `true` si el error era de autorización y ya quedó atendido (diálogo abierto). */
  const handleError = useCallback((err: unknown, retry: (pin: string) => void): boolean => {
    if (!isAuthorizerError(err)) return false;
    retryRef.current = retry;
    setPinError(null);
    setPending(false);
    setOpen(true);
    return true;
  }, []);

  const submitPin = useCallback((pin: string) => {
    setPinError(null);
    setPending(true);
    retryRef.current?.(pin);
  }, []);

  /** Llamar cuando el reintento con PIN también falló (PIN inválido, etc.). */
  const fail = useCallback((message: string) => {
    setPending(false);
    setPinError(message);
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    setPinError(null);
    setPending(false);
    retryRef.current = null;
  }, []);

  return { open, pinError, pending, handleError, submitPin, fail, close };
}
