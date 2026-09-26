import { useQuery } from "@tanstack/react-query"

import { getAreaCountGate } from "@/api/areaCounts"
import { useSession } from "@/app/session"

import { AREA_COUNT_GATE_QUERY_KEY } from "./areaCountLib"

/**
 * La consulta de la puerta de la apertura (`GET /device/area-count/gate`):
 * por persona (la de la tablet cambia), con prefijo `["area-count", "gate"]`
 * para que guardar un artículo la refresque.
 */
export function useOpeningGate(enabled: boolean) {
  const { me } = useSession()
  const personaId = me?.employee?.id ?? null
  return useQuery({
    queryKey: [...AREA_COUNT_GATE_QUERY_KEY, personaId],
    queryFn: getAreaCountGate,
    enabled,
    retry: false,
  })
}

/** Si el conteo por área está encendido en esta tablet (sin libro no hay conteo por área). */
export function useConteoEncendido(): boolean {
  const { me, hasFeature } = useSession()
  return me?.kind === "device" && hasFeature("inventory.perpetual") && hasFeature("inventory.shift_counts")
}
