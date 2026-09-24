/**
 * Admin → Obligaciones y gastos → Punto de equilibrio (T2,
 * `GET /admin/break-even`). `available`/`reason` mandan sobre todo lo demás:
 * sin costos fijos registrados o con poca venta costeada,
 * `break_even_amount` llega `null` con motivo — nunca `$0` (checklist de la
 * fase, error nº7 del proyecto).
 *
 * Informe de visualización #2: los costos fijos ya no se escriben a mano;
 * el backend los suma de obligaciones + nómina + gastos, los mismos que usa
 * Utilidad, así que las dos pestañas cuentan la misma historia. Lo de acá
 * es la conclusión («te faltan $W; a este ritmo lo pasás en N días»), el
 * medidor de avance y de dónde sale cada costo fijo. Todas las cifras
 * —avance, faltante, días— llegan del servidor.
 */
import { useQuery } from "@tanstack/react-query"
import { useState } from "react"

import { getBreakEven, type BreakEvenOut } from "@/api/expenses"
import { FilterLink, GroupLabel } from "@/components/admin"
import { Medidor } from "@/components/charts"
import { DateRangeFilter } from "@/components/DateRangeFilter"
import { EmptyState } from "@/components/EmptyState"
import { StatTile, cifraOSinDato } from "@/components/StatTile"
import { errorMessage } from "@/lib/errors"
import { formatPct } from "@/lib/format"
import { formatCOP } from "@/lib/money"

import { Explicacion } from "./Explicacion"
import { FixedCostsCard } from "./FixedCostsCard"
import { daysAgoLocal, todayLocal } from "./lib"
import { breakEvenHeadline } from "./titulares"

/** «Llevás $X de $Y (Z %)», con el avance que manda el backend. */
function avanceTexto(d: BreakEvenOut): string {
  const avance = d.progress_bp ?? null
  return `Llevás ${formatCOP(d.net_sales ?? null)} de ${formatCOP(d.break_even_amount)}${avance === null ? "" : ` (${formatPct(avance)})`}`
}

/** El aviso de cobertura: con poca venta costeada, margen y equilibrio no son confiables. */
function CoberturaAviso({ d }: { d: BreakEvenOut }): React.JSX.Element | null {
  const pct = d.costed_pct ?? null
  const minimo = d.costed_pct_min ?? null
  if (pct === null || minimo === null || pct >= minimo) return null
  return (
    <div
      role="status"
      className="rounded-md border border-l-[3px] border-warning/45 border-l-warning bg-warning/10 px-3 py-2 text-sm"
    >
      <p>
        <strong>Sólo el {formatPct(pct * 100, 0)} de la venta tiene ficha técnica con costo</strong>, y para confiar
        en el margen hace falta al menos el {formatPct(minimo * 100, 0)}. La venta sin ficha entra con costo cero e
        infla el margen: por eso el punto de equilibrio no se muestra hasta completarlas.
      </p>
      <FilterLink className="mt-1.5" to="/admin/carta" screen="Carta" tab="Recetas" />
    </div>
  )
}

export function BreakEvenTab({ storeId }: { storeId: number }): React.JSX.Element {
  const [from, setFrom] = useState(daysAgoLocal(30))
  const [to, setTo] = useState(todayLocal())

  const query = useQuery({
    queryKey: ["expenses", "break-even", storeId, from, to],
    queryFn: () => getBreakEven({ storeId, from, to }),
  })
  const d = query.data

  return (
    <div className="space-y-4">
      <DateRangeFilter
        idPrefix="break-even"
        from={from}
        to={to}
        onChange={(r) => {
          setFrom(r.from)
          setTo(r.to)
        }}
      />

      {query.isLoading ? (
        <p className="text-sm text-muted-foreground">Calculando el punto de equilibrio…</p>
      ) : query.isError ? (
        <EmptyState
          role="alert"
          title="No se pudo calcular el punto de equilibrio"
          description={errorMessage(query.error)}
          action={{ label: "Reintentar", onClick: () => void query.refetch() }}
        />
      ) : !d ? null : (
        <>
          <GroupLabel label="El resultado" says="calculado por el servidor con los costos fijos y la venta del período">
            {!d.available || d.break_even_amount === null ? (
              <div className="space-y-3">
                <CoberturaAviso d={d} />
                <EmptyState
                  title="Punto de equilibrio no disponible"
                  description={d.reason ?? "Faltan datos del período para calcularlo."}
                />
              </div>
            ) : (
              <div className="space-y-4">
                <section className="space-y-3 rounded-lg border bg-card p-4" aria-label="Avance hacia el punto de equilibrio">
                  <div className="space-y-1">
                    <h3 className="text-lg leading-snug font-semibold" data-testid="break-even-headline">
                      {breakEvenHeadline(d)}
                    </h3>
                    <p className="text-sm text-muted-foreground">{avanceTexto(d)}.</p>
                  </div>
                  {typeof d.net_sales === "number" ? (
                  <Medidor
                    valor={d.net_sales}
                    meta={d.break_even_amount}
                    formato={formatCOP}
                    etiquetaValor="Vendido en el período"
                    etiquetaMeta="Punto de equilibrio"
                    avance={d.progress_bp === null || d.progress_bp === undefined ? undefined : formatPct(d.progress_bp)}
                    resumen={`${avanceTexto(d)}.`}
                  />
                  ) : null}
                  <FilterLink to="/admin/gastos?tab=utilidad" screen="Obligaciones y gastos" tab="Utilidad" />
                </section>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <StatTile
                    label="Costos fijos del período"
                    {...cifraOSinDato(d.fixed_costs, d.reason ?? "no se pudieron sumar los costos fijos")}
                  />
                  <StatTile label="Margen de contribución" value={formatPct(d.contribution_margin_pct_bp)} />
                  {/* Sin `tone`: el punto de equilibrio es un umbral, no un
                      estado. Lo que dice (si se llegó o no) ya lo dice el
                      titular de arriba. */}
                  <StatTile label="Punto de equilibrio" value={formatCOP(d.break_even_amount)} />
                </div>
                {/* Regla 2 · El párrafo de método y las pistas de las tres
                    tarjetas, plegados: se leen una vez, no cada vez. */}
                <Explicacion resumen="Cómo leer esto">
                  <p>
                    La venta es neta, sin impuesto ni propina.
                    {d.costed_pct !== null && d.costed_pct !== undefined
                      ? ` El ${formatPct(d.costed_pct * 100, 0)} de esa venta tiene costo de ficha técnica.`
                      : ""}{" "}
                    Por debajo del equilibrio, la utilidad del período es pérdida.
                  </p>
                  <p>
                    <b>Costos fijos del período</b>: obligaciones + nómina + gastos del período, sumados por el
                    sistema. <b>Margen de contribución</b>: de cada $100 vendidos, lo que queda después del costo de
                    lo vendido. <b>Punto de equilibrio</b>: hay que vender esto para no perder plata; por debajo, el
                    período cierra en rojo.
                  </p>
                </Explicacion>
              </div>
            )}
          </GroupLabel>

          <GroupLabel label="Los costos fijos" says="automáticos: no se escriben, salen de lo registrado en el período">
            <FixedCostsCard
              total={d.fixed_costs}
              breakdown={d.fixed_costs_breakdown ?? []}
              reason={
                d.fixed_costs === null
                  ? "sin la nómina del período no se pueden sumar; el motivo está arriba, en «El resultado»"
                  : null
              }
            />
          </GroupLabel>
        </>
      )}
    </div>
  )
}

export default BreakEvenTab
