/**
 * "Costo con origen, nunca un cero mudo" (AGENTS.md, checklist de 2a).
 * `cost === null` (u origen `"none"`) es un estado distinto de `$0` en TODA
 * pantalla de este módulo. `CostValue`/`COST_SOURCE_LABEL` viven en el
 * componente compartido `@/components/CostValue` (frontend-inventario es
 * dueño de ese archivo; lo arregla en la ronda 2 del contrato para no
 * redondear costos sub-peso como $0,003/g) — acá sólo se re-exportan para
 * no duplicar la implementación entre las pantallas de inventario y las de
 * este módulo (mismo hallazgo O-4 de 1b-2 que ya evitamos con
 * `DateRangeFilter`/`CsvExportButton`). Este archivo no formatea ni
 * convierte ningún costo por su cuenta.
 */

import type { LucideIcon } from "lucide-react"
import { AlertTriangle } from "lucide-react"

import { Badge } from "@/components/ui/badge"

export { CostValue, COST_SOURCE_LABEL } from "@/components/CostValue"

/** Franja de referencia del sector, SPEC-NEGOCIO §4.3: 28–35 %. Sólo decide
 * un tono visual sobre un número que YA calculó el servidor — no deriva
 * ningún costo ni porcentaje nuevo. */
const FOOD_COST_BAND = { min: 28, max: 35 }

export function foodCostInBand(pct: string | null): boolean | null {
  if (pct === null) return null
  const value = Number(pct)
  if (Number.isNaN(value)) return null
  return value >= FOOD_COST_BAND.min && value <= FOOD_COST_BAND.max
}

export function FoodCostBadge({ pct }: { pct: string | null }): React.JSX.Element {
  if (pct === null) {
    return <Badge variant="outline">Food cost: sin datos</Badge>
  }
  const inBand = foodCostInBand(pct)
  return (
    <span className="inline-flex items-center gap-1.5">
      <Badge variant={inBand ? "secondary" : "destructive"}>Food cost {pct}%</Badge>
      <span className="text-xs text-muted-foreground">
        {inBand
          ? `dentro del rango del sector (${FOOD_COST_BAND.min}–${FOOD_COST_BAND.max} %)`
          : `fuera del rango del sector (${FOOD_COST_BAND.min}–${FOOD_COST_BAND.max} %)`}
      </span>
      {!inBand && <AlertTriangle className="size-3.5 text-destructive" aria-hidden="true" />}
    </span>
  )
}

export function VarianceBadge({
  pct,
  alert,
  icon: Icon = AlertTriangle,
}: {
  pct: string
  alert: boolean
  icon?: LucideIcon
}): React.JSX.Element {
  return (
    <span className="inline-flex items-center gap-1.5">
      <Badge variant={alert ? "destructive" : "outline"}>{pct}%</Badge>
      {alert ? (
        <span className="inline-flex items-center gap-1 text-xs font-medium text-destructive">
          <Icon className="size-3.5" aria-hidden="true" />
          se aparta más de 15 % de lo esperado
        </span>
      ) : null}
    </span>
  )
}
