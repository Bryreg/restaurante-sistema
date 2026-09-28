import { Badge } from "@/components/ui/badge"
import { formatCOPDecimal } from "@/lib/money"

/** Mismos cinco orígenes en todo el backend (`app.inventory`/`app.recipes`
 * `CostSource`): `official > weighted_average > last_purchase > estimated >
 * none`, aunque 2a sólo produce `official`/`estimated`/`none` (el promedio
 * ponderado y la última compra llegan con las compras de 2b). */
export type CostSource = "official" | "weighted_average" | "last_purchase" | "estimated" | "none"

export const COST_SOURCE_LABEL: Record<CostSource, string> = {
  official: "oficial",
  weighted_average: "promedio ponderado",
  last_purchase: "última compra",
  estimated: "estimado",
  none: "sin costo",
}

/**
 * "Costo con origen, nunca un cero mudo" (AGENTS.md, `docs/SPEC-NEGOCIO.md
 * §4.1`): `cost === null` (u origen `"none"`) es un estado DISTINTO de `$0`
 * en toda pantalla admin que muestre plata de insumo/preparación/plato. Un
 * solo componente compartido para que ningún dominio nuevo lo repinte mal
 * (hallazgo O-4 de 1b-2: "cada dominio copia su propio filtro de fechas o
 * botón de CSV" — acá pasa lo mismo con el costo si no se comparte).
 *
 * `cost` viaja como texto decimal por unidad base (nunca `float`, nunca
 * redondeado al peso: la sal cuesta "0.003"/g, no "0"): este componente sólo
 * lo formatea con `formatCOPDecimal` (`@/lib/money`), nunca lo calcula ni
 * pasa por `Number()` para decidir su precisión (B-2, ronda 2).
 */
export function CostValue({
  cost,
  costSource,
  variant = "badge",
  className,
}: {
  cost: string | number | null
  costSource: CostSource
  /**
   * `"badge"` (de siempre) lleva el origen en una insignia. `"celda"` es la
   * forma de la tabla densa (handoff, pantalla 12): «Sin costo» **rayado**
   * (`.sin-dato`, el mismo rayado de todo «sin dato»: no saber no es ni
   * verde ni rojo) y el origen en texto chico al lado de la cifra, sin
   * insignia, para que la fila no pase de 34 px. El origen sigue a la vista:
   * un costo nunca viaja sin decir de dónde sale.
   */
  variant?: "badge" | "celda"
  className?: string
}): React.JSX.Element {
  if (variant === "celda") {
    if (cost === null || costSource === "none") {
      return (
        <span className={className} title="Origen: ninguno. No es $ 0: falta la factura o el costo estimado.">
          <span className="sin-dato px-2 py-0.5">Sin costo</span>
        </span>
      )
    }
    return (
      <span className={className}>
        <span className="tabular-nums">{formatCOPDecimal(cost)}</span>{" "}
        <span className="text-[0.7rem] text-muted-foreground">{COST_SOURCE_LABEL[costSource]}</span>
      </span>
    )
  }
  if (cost === null || costSource === "none") {
    return (
      <span className={className}>
        <span className="text-muted-foreground">Sin costo</span>{" "}
        <Badge variant="outline">origen: ninguno</Badge>
      </span>
    )
  }
  return (
    <span className={className}>
      <span className="tabular-nums">{formatCOPDecimal(cost)}</span>{" "}
      <Badge variant="secondary">{COST_SOURCE_LABEL[costSource]}</Badge>
    </span>
  )
}

export default CostValue
