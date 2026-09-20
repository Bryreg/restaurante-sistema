/**
 * Admin → Obligaciones y gastos → Utilidad del período (T2,
 * `GET /admin/profit`): ventas netas, costo, gastos, obligaciones y nómina,
 * hasta `profit`. Todos los números YA vienen sumados por el servidor —
 * ninguna resta acá (AGENTS.md § "una sola matemática, en el backend").
 * `available`/`reason` mandan igual que en punto de equilibrio.
 */
import { useQuery } from "@tanstack/react-query"
import { useState } from "react"

import { getProfit } from "@/api/expenses"
import { DateRangeFilter } from "@/components/DateRangeFilter"
import { EmptyState } from "@/components/EmptyState"
import { StatTile } from "@/components/StatTile"
import { errorMessage } from "@/lib/errors"
import { formatCOP } from "@/lib/money"

import { daysAgoLocal, todayLocal } from "./lib"

export function ProfitTab({ storeId }: { storeId: number }): React.JSX.Element {
  const [from, setFrom] = useState(daysAgoLocal(30))
  const [to, setTo] = useState(todayLocal())

  const query = useQuery({
    queryKey: ["expenses", "profit", storeId, from, to],
    queryFn: () => getProfit({ storeId, from, to }),
  })

  return (
    <div className="space-y-4">
      <DateRangeFilter idPrefix="profit" from={from} to={to} onChange={(r) => { setFrom(r.from); setTo(r.to) }} />

      {query.isLoading ? (
        <p className="text-sm text-muted-foreground">Calculando la utilidad del período…</p>
      ) : query.isError ? (
        <EmptyState role="alert" title="No se pudo calcular la utilidad" description={errorMessage(query.error)} action={{ label: "Reintentar", onClick: () => void query.refetch() }} />
      ) : !query.data?.available ? (
        <EmptyState title="Utilidad no disponible" description={query.data?.reason ?? "Faltan datos del período para calcularla."} />
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <StatTile label="Ventas netas" value={formatCOP(query.data.net_sales)} />
          <StatTile label="Costo" value={formatCOP(query.data.cost)} />
          <StatTile label="Gastos" value={formatCOP(query.data.expenses)} />
          <StatTile label="Obligaciones" value={formatCOP(query.data.obligations)} />
          <StatTile label="Nómina" value={formatCOP(query.data.payroll)} />
          <StatTile label="Utilidad" value={formatCOP(query.data.profit)} tone={query.data.profit !== null && query.data.profit < 0 ? "critical" : "default"} />
        </div>
      )}
    </div>
  )
}

export default ProfitTab
