/**
 * Admin → Analítica → Salud sostenida (D-1, spec.md § 1, `GET
 * /admin/control-health/sustained`): la brecha de food cost real está
 * sostenida en rojo cuando supera el umbral en al menos 2 de las últimas 3
 * ventanas. `sustained_red` es `null` (nunca `false` mudo, nunca "verde" por
 * default) con menos de 2 ventanas computables — ésa es la letra exacta de
 * D-1 y el error nº7 del proyecto si se pinta distinto.
 */
import { useQuery } from "@tanstack/react-query"

import { getControlHealthSustained } from "@/api/analytics"
import { EmptyState } from "@/components/EmptyState"
import { StatTile } from "@/components/StatTile"
import { errorMessage } from "@/lib/errors"

export function SustainedHealthTab({ storeId }: { storeId: number }): React.JSX.Element {
  const query = useQuery({
    queryKey: ["analytics", "control-health-sustained", storeId],
    queryFn: () => getControlHealthSustained(storeId),
  })

  if (query.isLoading) {
    return <p className="text-sm text-muted-foreground">Evaluando la salud del control…</p>
  }
  if (query.isError) {
    return (
      <EmptyState role="alert" title="No se pudo evaluar la salud sostenida" description={errorMessage(query.error)} action={{ label: "Reintentar", onClick: () => void query.refetch() }} />
    )
  }

  const data = query.data

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        «Sostenido» (D-1): la brecha de food cost real supera el umbral rojo en al menos 2 de las últimas 3 ventanas
        de conteo — nunca por un solo conteo malo.
      </p>
      {data?.sustained_red === null || data === undefined ? (
        <EmptyState
          title="Sin historial suficiente"
          description={data?.reason ?? "Hacen falta al menos dos conteos completos aplicados para evaluar si está sostenido."}
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <StatTile
            label="Brecha sostenida en rojo"
            value={data.sustained_red ? "Sí" : "No"}
            tone={data.sustained_red ? "critical" : "default"}
          />
          <StatTile label="Ventanas evaluadas" value={String(data.windows_evaluated)} />
        </div>
      )}
    </div>
  )
}

export default SustainedHealthTab
