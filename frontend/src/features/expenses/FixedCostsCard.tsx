/**
 * De dónde salen los costos fijos del período — ya NO se escriben a mano.
 *
 * Antes esto era un formulario (`PATCH /admin/expenses/settings`) con un
 * número suelto que alguien tipeaba ($14,5 M). El sistema ya conocía los
 * costos fijos de verdad —obligaciones + nómina + gastos: $19,6 M— y por
 * eso el punto de equilibrio decía «ya lo pasaste» mientras Utilidad
 * mostraba una pérdida (informe de visualización #2). Ahora el backend los
 * suma solo (`fixed_costs` + `fixed_costs_breakdown`, los MISMOS en
 * `GET /admin/break-even` y en `GET /admin/profit`), y esta tarjeta explica
 * de qué registro sale cada renglón y dónde se corrige. La ruta de
 * `settings` quedó obsoleta en el backend: nada la suma.
 */
import type { FixedCostLine } from "@/api/expenses"
import { FilterLink, type FilterLinkProps } from "@/components/admin"
import { BarList, ChartFrame } from "@/components/charts"
import { SinDato } from "@/components/SinDato"

import { Explicacion } from "./Explicacion"
import { formatCOP } from "@/lib/money"

/** Dónde se carga (y se corrige) cada origen. */
const FIXED_COST_ORIGIN: Record<FixedCostLine["source"], { nombre: string; link: FilterLinkProps }> = {
  obligations: {
    nombre: "Obligaciones",
    link: { to: "/admin/gastos?tab=obligaciones", screen: "Obligaciones y gastos", tab: "Obligaciones" },
  },
  payroll: {
    nombre: "Nómina",
    link: { to: "/admin/nomina?tab=liquidaciones", screen: "Nómina", tab: "Liquidaciones" },
  },
  expenses: {
    nombre: "Gastos",
    link: { to: "/admin/gastos?tab=gastos", screen: "Obligaciones y gastos", tab: "Gastos" },
  },
}

const ORDEN_ORIGEN: FixedCostLine["source"][] = ["obligations", "payroll", "expenses"]

/**
 * El desglose de los costos fijos automáticos: barras por renglón (nominal,
 * ordenado por plata), tabla gemela con el origen de cada uno y los enlaces
 * a donde se cargan. `total` es el `fixed_costs` del servidor; acá no se
 * suma nada.
 */
export function FixedCostsCard({
  total,
  breakdown,
  reason,
}: {
  total: number | null
  breakdown: FixedCostLine[]
  /** Por qué `total` es `null` (la nómina no se pudo calcular). */
  reason?: string | null
}): React.JSX.Element {
  // Elegir el renglón más grande es seleccionar, no calcular.
  const mayor = breakdown.reduce<FixedCostLine | null>((m, l) => (m === null || l.amount > m.amount ? l : m), null)

  const titular =
    total === null
      ? "Los costos fijos del período no se pueden sumar todavía"
      : mayor === null
        ? "No hay costos fijos registrados en el período"
        : `${formatCOP(total)} de costos fijos; lo que más pesa es ${mayor.label.toLowerCase()} (${formatCOP(mayor.amount)})`

  return (
    <div className="space-y-3 rounded-lg border bg-card p-4">
      <ChartFrame
        titular={titular}
        detalle={
          /* Regla 2 · Cómo se calculan, plegado: el rótulo de grupo ya dice
             «automáticos»; el cómo lo lee quien lo pide. */
          <Explicacion>
            <p>
              Se calculan solos con lo que ya está registrado en el período: obligaciones que vencen, la nómina de
              las horas trabajadas y los gastos no anulados. <b>No se escriben a mano</b>: si un renglón está mal, se
              corrige donde se cargó.
            </p>
          </Explicacion>
        }
        tabla={{
          columnas: [
            { key: "label", header: "Renglón" },
            { key: "origen", header: "De dónde sale" },
            { key: "amount", header: "Monto", align: "right" },
          ],
          filas: breakdown.map((l) => ({
            label: l.label,
            origen: FIXED_COST_ORIGIN[l.source].nombre,
            amount: formatCOP(l.amount),
          })),
        }}
      >
        {total === null ? (
          <SinDato forma="bloque" motivo={reason} />
        ) : breakdown.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Ni obligaciones, ni nómina, ni gastos en el período. Cargalos y el cálculo sale solo.
          </p>
        ) : (
          <BarList
            datos={breakdown.map((l, i) => ({
              key: `${l.source}-${i}`,
              etiqueta: l.label,
              valor: l.amount,
              // El origen sólo se escribe si el rótulo no lo dice ya («Nómina · Nómina»).
              detalle: l.label === FIXED_COST_ORIGIN[l.source].nombre ? undefined : FIXED_COST_ORIGIN[l.source].nombre,
            }))}
            formato={formatCOP}
          />
        )}
      </ChartFrame>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t pt-3 text-xs text-muted-foreground">
        <span>Se cargan en:</span>
        {ORDEN_ORIGEN.map((s) => (
          <FilterLink key={s} {...FIXED_COST_ORIGIN[s].link} />
        ))}
      </div>
    </div>
  )
}

export default FixedCostsCard
