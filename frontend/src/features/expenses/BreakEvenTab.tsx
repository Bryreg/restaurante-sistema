/**
 * Admin → Obligaciones y gastos → Punto de equilibrio (T2,
 * `GET /admin/break-even`). `available`/`reason` mandan sobre todo lo demás:
 * sin costos fijos cargados, `break_even_amount` llega `null` con motivo —
 * nunca `$0` (checklist de la fase, error nº7 del proyecto).
 */
import { useQuery } from "@tanstack/react-query"
import { useState } from "react"

import { getBreakEven } from "@/api/expenses"
import { DateRangeFilter } from "@/components/DateRangeFilter"
import { EmptyState } from "@/components/EmptyState"
import { StatTile } from "@/components/StatTile"
import { errorMessage } from "@/lib/errors"
import { formatCOP } from "@/lib/money"

import { daysAgoLocal, formatBasisPoints, todayLocal } from "./lib"

export function BreakEvenTab({ storeId }: { storeId: number }): React.JSX.Element {
  const [from, setFrom] = useState(daysAgoLocal(30))
  const [to, setTo] = useState(todayLocal())

  const query = useQuery({
    queryKey: ["expenses", "break-even", storeId, from, to],
    queryFn: () => getBreakEven({ storeId, from, to }),
  })

  return (
    <div className="space-y-4">
      <DateRangeFilter idPrefix="break-even" from={from} to={to} onChange={(r) => { setFrom(r.from); setTo(r.to) }} />

      {query.isLoading ? (
        <p className="text-sm text-muted-foreground">Calculando el punto de equilibrio…</p>
      ) : query.isError ? (
        <EmptyState role="alert" title="No se pudo calcular el punto de equilibrio" description={errorMessage(query.error)} action={{ label: "Reintentar", onClick: () => void query.refetch() }} />
      ) : !query.data?.available ? (
        <EmptyState
          title="Punto de equilibrio no disponible"
          description={query.data?.reason ?? "Cargá los costos fijos del período para poder calcularlo."}
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <StatTile label="Costos fijos del período" value={formatCOP(query.data.fixed_costs)} />
          <StatTile label="Margen de contribución" value={formatBasisPoints(query.data.contribution_margin_pct_bp)} />
          <StatTile label="Punto de equilibrio" value={formatCOP(query.data.break_even_amount)} tone="warning" />
        </div>
      )}
    </div>
  )
}

export default BreakEvenTab
