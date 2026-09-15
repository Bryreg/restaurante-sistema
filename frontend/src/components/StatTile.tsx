import type { LucideIcon } from "lucide-react"

import { cn } from "@/lib/utils"

export type StatTileTone = "default" | "warning" | "critical"

export interface StatTileProps {
  label: string
  /** Ya formateado (`formatCOP`, un entero, un porcentaje) — este componente nunca calcula. */
  value: string
  hint?: string
  tone?: StatTileTone
  icon?: LucideIcon
}

const TONE_CONTAINER: Record<StatTileTone, string> = {
  default: "border-border",
  warning: "border-border bg-secondary/50",
  critical: "border-destructive/30 bg-destructive/5",
}

const TONE_VALUE: Record<StatTileTone, string> = {
  default: "text-foreground",
  warning: "text-foreground",
  critical: "text-destructive",
}

/**
 * "Un KPI que decide → stat tile con su contexto" (SPEC-NEGOCIO §9.3).
 * Máximo un nivel de énfasis por tarjeta: sólo `value` es grande. El color
 * de `tone` nunca es la única señal — el texto de `label`/`hint` ya dice lo
 * mismo que el tono, y `icon` es una segunda pista visual.
 */
export function StatTile({ label, value, hint, tone = "default", icon: Icon }: StatTileProps): React.JSX.Element {
  return (
    <div className={cn("rounded-lg border p-4", TONE_CONTAINER[tone])}>
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">{label}</p>
        {Icon ? <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" /> : null}
      </div>
      <p className={cn("mt-1 text-2xl font-semibold tabular-nums", TONE_VALUE[tone])}>{value}</p>
      {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  )
}

export default StatTile
