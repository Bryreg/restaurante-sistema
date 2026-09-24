import { useQuery } from "@tanstack/react-query"
import { useState } from "react"

import {
  getVariance,
  listCounts,
  varianceCsvUrl,
  type VarianceLevel,
  type VarianceOut,
  type VarianceParetoRowOut,
  type VarianceRowOut,
} from "@/api/inventory"
import {
  DenseTable,
  DenseTableBar,
  type DenseColumn,
  type LegendEntry,
  type RowStatus,
} from "@/components/admin"
import { ChartFrame, Pareto, type ParetoDatum } from "@/components/charts"
import { COST_SOURCE_LABEL } from "@/components/CostValue"
import { CsvExportButton } from "@/components/CsvExportButton"
import { EmptyState } from "@/components/EmptyState"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Diferencia } from "@/components/Diferencia"
import { errorMessage } from "@/lib/errors"
import { formatFechaCorta, formatPct } from "@/lib/format"
import { formatCOP } from "@/lib/money"
import { cn } from "@/lib/utils"

import { cantidad, textoVentana } from "./lib"
import { varianceDetalle, varianceTitular } from "./titulares"

const LEVEL_LABEL: Record<VarianceLevel, string> = {
  green: "Verde",
  yellow: "Revisar",
  red: "Rojo",
}
const LEVEL_DOT: Record<VarianceLevel, string> = {
  green: "bg-success",
  yellow: "bg-warning",
  red: "bg-destructive",
}
const LEVEL_STATUS: Record<VarianceLevel, RowStatus> = {
  green: "none",
  yellow: "warning",
  red: "critical",
}

const LEGEND: readonly LegendEntry[] = [
  {
    term: "Uso real",
    meaning: "lo que faltó entre dos conteos: inicial + entradas − final. Es lo que de verdad salió.",
  },
  {
    term: "Uso teórico",
    meaning: "lo que las recetas dicen que debió salir por lo que se vendió. La diferencia es la varianza.",
  },
  {
    term: "Sin costo",
    meaning: (
      <>
        no es <b>$ 0</b> — el insumo no tiene costo conocido, así que su varianza no se puede valorar en
        pesos. La varianza en cantidad sigue siendo cierta.
      </>
    ),
  },
]

/** ▼ faltante / ▲ sobrante: la misma lectura que `Diferencia`, para que la dirección no sea sólo color. */
function flecha(p: VarianceParetoRowOut): string {
  return p.direction === "shortage" ? "▼" : "▲"
}

/**
 * La concentración de la varianza (científico #9, analista #12): Pareto
 * por insumo con el acumulado que manda el servidor, el titular con el
 * total y cuántos insumos explican el 80 %, y la tabla gemela con la
 * dirección en rojo (faltante) o ámbar (sobrante; nunca rojo).
 */
function VarianceConcentration({ data }: { data: VarianceOut }): React.JSX.Element {
  const datos: ParetoDatum[] = data.pareto.map((p) => ({
    key: String(p.ingredient_id),
    etiqueta: `${flecha(p)} ${p.ingredient_name}`,
    valor: p.abs_value,
    acumulado_bp: p.cumulative_bp,
  }))
  const titular = varianceTitular(data)
  const detalle = varianceDetalle(data)
  const ventana = textoVentana(null, null, data.window_from, data.window_to)
  return (
    <div className="rounded-lg border bg-card p-4">
      <ChartFrame
        titular={titular}
        detalle={
          <>
            {detalle ? <span className="block">{detalle}</span> : null}
            <span className="block">
              Conteo #{data.opening_count_id ?? "—"} contra #{data.count_id ?? "—"}
              {ventana ? `, ${ventana}` : ""}.
            </span>
            {/* Cómo se lee el gráfico, plegado (mapa de pantallas, regla 2):
                se lee una vez, no cada vez que se abre la pestaña. */}
            <details className="text-xs">
              <summary className="cursor-pointer select-none hover:text-foreground">Cómo leer esto</summary>
              Varianza en pesos por insumo, de mayor a menor (sin signo: ▼ faltante, ▲ sobrante), con el acumulado
              en gris.
            </details>
          </>
        }
        tabla={{
          columnas: [
            { key: "insumo", header: "Insumo" },
            { key: "valor", header: "Varianza", align: "right" },
            { key: "part", header: "Parte del total", align: "right" },
            { key: "acum", header: "Acumulado", align: "right" },
          ],
          filas: data.pareto.map((p) => ({
            insumo: p.ingredient_name,
            valor: <Diferencia valor={p.variance_value} faltaCuando="positivo" />,
            part: formatPct(p.share_bp),
            acum: formatPct(p.cumulative_bp),
          })),
        }}
      >
        {datos.length > 0 ? (
          <Pareto datos={datos} formato={formatCOP} etiquetaValor="Varianza en pesos (sin signo)" resumen={`${titular}.`} />
        ) : (
          <p className="text-sm text-muted-foreground">Ningún insumo con varianza valorizada distinta de cero.</p>
        )}
      </ChartFrame>
    </div>
  )
}

/**
 * Admin → Inventario → Varianza (SPEC-NEGOCIO §5.4 / §9.3): uso real contra
 * uso teórico, en cantidad y en pesos con el origen del costo. El semáforo
 * (`row.level`) es SIEMPRE el que manda el servidor contra los umbrales de
 * la sede — este archivo nunca compara `variance_pct_bp` contra un número
 * propio; cambiar el umbral en Configuración cambia el color acá sin tocar
 * una línea de este componente.
 */
export function VarianceTab({ storeId }: { storeId: number }): React.JSX.Element {
  const [countId, setCountId] = useState<number | null>(null)

  const countsQuery = useQuery({
    queryKey: ["inventory", "variance", "applied-counts", storeId],
    queryFn: () => listCounts({ storeId }),
  })
  const appliedCounts = (countsQuery.data ?? []).filter((c) => c.status === "applied")

  // Sin elegir nada, el servidor usa el último conteo aplicado (analista
  // #12: la pestaña ya no abre vacía).
  const varianceQuery = useQuery({
    queryKey: ["inventory", "variance", storeId, countId],
    queryFn: () => getVariance({ storeId, countId }),
  })
  const shownCountId = countId ?? varianceQuery.data?.count_id ?? null

  const picker = (
    <>
      <div className="flex items-center gap-2">
        <Label htmlFor="variance-count">Conteo aplicado</Label>
        <Select
          value={shownCountId === null ? undefined : String(shownCountId)}
          onValueChange={(v) => setCountId(Number(v))}
        >
          <SelectTrigger id="variance-count" className="h-8 w-full min-w-0 sm:w-80">
            <SelectValue placeholder="Elegí un conteo aplicado" />
          </SelectTrigger>
          <SelectContent>
            {appliedCounts.map((count) => (
              <SelectItem key={count.id} value={String(count.id)}>
                #{count.id} — {count.scope === "full" ? "Completo" : "Críticos"} — {formatFechaCorta(count.business_date)}
                {count.id === varianceQuery.data?.latest_applied_count_id ? " (el último)" : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {shownCountId !== null ? <CsvExportButton href={varianceCsvUrl({ storeId, countId: shownCountId })} /> : null}
    </>
  )

  // Los vacíos escalonados: cada uno dice un motivo DISTINTO, y el motivo
  // decide la acción (`docs/PATRONES-ADMIN.md` § 13). Aplanarlos en un solo
  // «sin datos» es exactamente lo que el patrón viene a impedir.
  const rows: readonly VarianceRowOut[] = varianceQuery.data?.available ? varianceQuery.data.rows : []

  let empty: React.ReactNode = null
  if (countsQuery.isSuccess && appliedCounts.length === 0) {
    empty = (
      <EmptyState
        title="Todavía no hay ningún conteo aplicado en esta sede"
        description="La varianza compara un conteo aplicado contra el aplicado anterior. Hacen falta dos."
        action={{ label: "Ir a Conteos", to: "/admin/inventario?tab=conteos" }}
      />
    )
  } else if (varianceQuery.isError) {
    empty = (
      <EmptyState
        role="alert"
        title="No se pudo calcular la varianza"
        description={errorMessage(varianceQuery.error)}
        action={{
          label: "Reintentar",
          onClick: () => void varianceQuery.refetch(),
        }}
      />
    )
  } else if (varianceQuery.isSuccess && !varianceQuery.data.available) {
    empty = (
      <EmptyState
        title="Sin varianza para este conteo"
        description={
          varianceQuery.data.reason ?? "Hace falta un conteo aplicado anterior contra el cual comparar."
        }
      />
    )
  } else if (varianceQuery.isSuccess && rows.length === 0) {
    empty = (
      <EmptyState
        title="Sin insumos en común entre los dos conteos"
        description="Ningún insumo se contó en ambos conteos, así que no hay nada que comparar. Un conteo completo contra uno de críticos deja pocos en común."
      />
    )
  }

  const columns: readonly DenseColumn<VarianceRowOut>[] = [
    {
      key: "name",
      header: "Insumo",
      kind: "name",
      cell: (r) => r.ingredient_name,
    },
    {
      key: "opening",
      header: "Inicial",
      kind: "number",
      // Las cinco cantidades de las que sale la varianza, detrás de «Más
      // columnas» (regla 3): la primera lectura es cuánto se fue, en pesos,
      // y de qué color lo pinta el servidor. El detalle sigue a un toque.
      secondary: true,
      cell: (r) => cantidad(r.opening_qty, r.base_unit),
    },
    {
      key: "inflow",
      header: "Entradas",
      kind: "number",
      secondary: true,
      cell: (r) => cantidad(r.inflow_qty, r.base_unit),
    },
    {
      key: "closing",
      header: "Final",
      kind: "number",
      secondary: true,
      cell: (r) => cantidad(r.closing_qty, r.base_unit),
    },
    {
      key: "real",
      header: "Uso real",
      kind: "number",
      secondary: true,
      cell: (r) => cantidad(r.real_usage_qty, r.base_unit),
    },
    {
      key: "theoretical",
      header: "Uso teórico",
      kind: "number",
      secondary: true,
      cell: (r) => cantidad(r.theoretical_usage_qty, r.base_unit),
    },
    {
      key: "variance",
      header: "Varianza",
      kind: "number",
      cell: (r) => (
        <span className={cn(r.level === "red" && "font-bold text-destructive")}>
          {cantidad(r.variance_qty, r.base_unit)}
        </span>
      ),
    },
    {
      key: "value",
      header: "En pesos",
      kind: "number",
      // «Sin costo» NUNCA cae como «$ 0» en la columna de plata: el costo
      // del mes saldría redondo y mentiroso.
      cell: (r) =>
        r.variance_value === null ? (
          <span className="text-muted-foreground italic">Sin costo</span>
        ) : (
          <Diferencia valor={r.variance_value} faltaCuando="positivo" />
        ),
      cellTitle: (r) =>
        r.variance_value === null
          ? "Sin costo · origen: ninguno — el insumo no tiene costo oficial ni estimado"
          : `origen: ${COST_SOURCE_LABEL[r.cost_source]}`,
    },
    {
      key: "pct",
      header: "%",
      kind: "number",
      cell: (r) => formatPct(r.variance_pct_bp),
    },
    {
      key: "level",
      header: "Semáforo",
      cell: (r) => (
        <span className="inline-flex items-center gap-1.5">
          <span className={cn("size-1.5 shrink-0 rounded-full", LEVEL_DOT[r.level])} aria-hidden="true" />
          {LEVEL_LABEL[r.level]}
        </span>
      ),
    },
  ]

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">{picker}</div>
      {varianceQuery.data?.available ? <VarianceConcentration data={varianceQuery.data} /> : null}
      <DenseTable
        caption="Varianza entre dos conteos aplicados"
        columns={columns}
        rows={rows}
        rowKey={(r) => String(r.ingredient_id)}
        rowStatus={(r) => LEVEL_STATUS[r.level]}
        legend={LEGEND}
        bar={
          varianceQuery.isLoading ? (
            <div className="flex flex-wrap items-center gap-2 border-b bg-muted px-3 py-2">
              <p className="text-xs text-muted-foreground">Calculando varianza…</p>
            </div>
          ) : (
            <DenseTableBar
              shown={rows.length}
              total={rows.length}
              noun="insumos comparados"
              hidden={
                rows.length > 0 ? `${rows.filter((r) => r.level !== "green").length} para revisar` : undefined
              }
            />
          )
        }
        note={
          <>
            El semáforo lo decide el <b>servidor</b> contra los umbrales de la sede: cambiarlos en Configuración
            cambia los colores de acá. Una varianza no es un robo —es todo lo que las recetas no explican:
            porciones generosas, mermas sin registrar, recetas desactualizadas—.
          </>
        }
        empty={varianceQuery.isLoading ? undefined : empty}
      />
    </div>
  )
}

export default VarianceTab
