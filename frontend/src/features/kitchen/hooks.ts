/**
 * Claves de `react-query` y sondeo del KDS (`kitchen.kds`). Namespace propio
 * (`["kds", ...]`), distinto del de la vista mínima de 1b
 * (`features/orders/hooks.ts::kitchenRoundsQueryKey`, `["kitchen", ...]`):
 * las dos pantallas piden el MISMO endpoint (`GET /kitchen/rounds`) pero
 * son cachés independientes — no hay ningún estado compartido entre
 * `features/orders/**` (ajeno) y este territorio.
 */
import { useQuery } from "@tanstack/react-query"

import { listKitchenRounds, listKitchenStations, listPrintJobs } from "@/api/kitchen"

/** Las estaciones configuradas de la sede (la barra del KDS): cambian poco, no se sondean. */
export function useKdsStations(enabled: boolean) {
  return useQuery({
    queryKey: ["kds", "stations"] as const,
    queryFn: listKitchenStations,
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
  })
}

const ROUNDS_POLL_MS = 5_000
const PRINT_JOBS_POLL_MS = 5_000

export function kdsRoundsQueryKey(station: string | undefined) {
  return ["kds", "rounds", station ?? "__all__"] as const
}

export function useKdsRounds(station: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: kdsRoundsQueryKey(station),
    queryFn: () => listKitchenRounds(station),
    enabled,
    refetchInterval: ROUNDS_POLL_MS,
  })
}

export function kdsPrintJobsQueryKey(station: string | undefined) {
  return ["kds", "print-jobs", station ?? "__all__"] as const
}

export function useKdsPrintJobs(station: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: kdsPrintJobsQueryKey(station),
    queryFn: () => listPrintJobs(station),
    enabled,
    refetchInterval: PRINT_JOBS_POLL_MS,
  })
}
