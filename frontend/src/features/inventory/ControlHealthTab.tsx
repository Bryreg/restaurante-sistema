import { useQuery } from "@tanstack/react-query"
import { useState } from "react"

import { getControlHealth, getFoodCost } from "@/api/inventory"
import { DateRangeFilter } from "@/components/DateRangeFilter"
import { EmptyState } from "@/components/EmptyState"
import { StatTile } from "@/components/StatTile"
import { formatCOP } from "@/lib/money"
import { errorMessage } from "@/lib/errors"

import { daysAgoLocal, formatBasisPoints, todayLocal } from "./lib"

/**
 * Admin → Inventario → Salud del control (SPEC-NEGOCIO §5.4/§10/§9.3): los
 * cuatro indicadores que dicen cuándo los números del restaurante ya no
 * valen, más el food cost real — que se apaga solo pasados 14 días sin
 * conteo completo. Cada `null` se dice con su motivo; nunca un `0` ni un
 * `—` mudo (AGENTS.md).
 */
export function ControlHealthTab({ storeId }: { storeId: number }): React.JSX.Element {
  const [from, setFrom] = useState(daysAgoLocal(90))
  const [to, setTo] = useState(todayLocal())

  const healthQuery = useQuery({
    queryKey: ["inventory", "control-health", storeId],
    queryFn: () => getControlHealth(storeId),
  })

  const foodCostQuery = useQuery({
    queryKey: ["inventory", "food-cost", storeId, from, to],
    queryFn: () => getFoodCost({ storeId, from, to }),
  })

  if (healthQuery.isLoading) {
    return <p className="text-sm text-muted-foreground">Cargando salud del control…</p>
  }
  if (healthQuery.isError) {
    return (
      <EmptyState
        role="alert"
        title="No se pudo cargar la salud del control"
        description={errorMessage(healthQuery.error)}
        action={{ label: "Reintentar", onClick: () => void healthQuery.refetch() }}
      />
    )
  }
  const health = healthQuery.data

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Salud del control</h2>
        <p className="text-sm text-muted-foreground">Que el sistema diga cuándo sus propios números ya no valen.</p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatTile
            label="Días desde el último conteo completo"
            value={health?.days_since_full_count !== null && health?.days_since_full_count !== undefined ? String(health.days_since_full_count) : "—"}
            hint={health?.days_since_full_count === null ? "Nunca hubo un conteo completo aplicado" : undefined}
            tone={health?.inventory_unreliable ? "critical" : "default"}
          />
          <StatTile
            label="Recepciones con factura"
            value={formatBasisPoints(health?.reception_invoice_ratio_bp ?? null)}
            hint={health?.reception_invoice_ratio_reason ?? undefined}
          />
          <StatTile
            label="Preparaciones por lote producidas esta semana"
            value={formatBasisPoints(health?.batch_preps_produced_ratio_bp ?? null)}
            hint={health?.batch_preps_produced_reason ?? undefined}
          />
          <StatTile label="Mermas registradas esta semana" value={health !== undefined ? String(health.waste_entries_this_week) : "—"} />
        </div>
        {health?.inventory_unreliable ? (
          <div role="alert" className="rounded-md border border-l-4 border-l-destructive bg-destructive/5 p-3 text-sm">
            <strong>Inventario no confiable</strong> — más de 14 días sin un conteo completo aplicado. El food cost
            real no se publica hasta que haya uno.
          </div>
        ) : null}
      </section>

      <section className="space-y-3 border-t pt-6">
        <h2 className="text-sm font-semibold">Food cost real</h2>
        <DateRangeFilter idPrefix="food-cost" from={from} to={to} onChange={(r) => { setFrom(r.from); setTo(r.to) }} />

        {foodCostQuery.isLoading ? (
          <p className="text-sm text-muted-foreground">Calculando…</p>
        ) : foodCostQuery.isError ? (
          <EmptyState
            role="alert"
            title="No se pudo calcular el food cost real"
            description={errorMessage(foodCostQuery.error)}
            action={{ label: "Reintentar", onClick: () => void foodCostQuery.refetch() }}
          />
        ) : !foodCostQuery.data?.available ? (
          <EmptyState
            title="Food cost real no disponible"
            description={foodCostQuery.data?.reason ?? "Hacen falta dos conteos completos aplicados y consecutivos en el período."}
          />
        ) : (
          <div className="rounded-lg border p-5">
            <p className="text-sm text-muted-foreground">
              (inventario inicial + compras − final) ÷ ventas netas, entre los conteos #{foodCostQuery.data.opening_count_id} y #
              {foodCostQuery.data.closing_count_id}
            </p>
            <p className="mt-1 text-4xl font-semibold tabular-nums">{formatBasisPoints(foodCostQuery.data.pct_bp)}</p>
            <div className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
              <div>
                <p className="text-muted-foreground">Inventario inicial</p>
                <p className="tabular-nums font-medium">{formatCOP(foodCostQuery.data.opening_value)}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Compras</p>
                <p className="tabular-nums font-medium">{formatCOP(foodCostQuery.data.purchases_value)}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Inventario final</p>
                <p className="tabular-nums font-medium">{formatCOP(foodCostQuery.data.closing_value)}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Ventas netas</p>
                <p className="tabular-nums font-medium">{formatCOP(foodCostQuery.data.net_sales)}</p>
              </div>
            </div>
          </div>
        )}
      </section>
    </div>
  )
}

export default ControlHealthTab
