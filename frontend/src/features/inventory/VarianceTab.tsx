import { useQuery } from "@tanstack/react-query"
import { useState } from "react"

import {
  getVariance,
  listCounts,
  varianceCsvUrl,
  type VarianceLevel,
  type VarianceRowOut,
} from "@/api/inventory"
import {
  DenseTable,
  DenseTableBar,
  type DenseColumn,
  type LegendEntry,
  type RowStatus,
} from "@/components/admin"
import { COST_SOURCE_LABEL } from "@/components/CostValue"
import { CsvExportButton } from "@/components/CsvExportButton"
import { EmptyState } from "@/components/EmptyState"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { formatCOP } from "@/lib/money"
import { errorMessage } from "@/lib/errors"
import { cn } from "@/lib/utils"

import { formatBasisPoints } from "./lib"

const UNIT_LABEL: Record<string, string> = { g: "g", ml: "ml", unit: "unidad" }

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

  const varianceQuery = useQuery({
    queryKey: ["inventory", "variance", storeId, countId],
    queryFn: () => getVariance({ storeId, countId: countId as number }),
    enabled: countId !== null,
  })

  const picker = (
    <>
      <div className="flex items-center gap-2">
        <Label htmlFor="variance-count">Conteo aplicado</Label>
        <Select
          value={countId === null ? undefined : String(countId)}
          onValueChange={(v) => setCountId(Number(v))}
        >
          <SelectTrigger id="variance-count" className="h-8 w-56">
            <SelectValue placeholder="Elegí un conteo aplicado" />
          </SelectTrigger>
          <SelectContent>
            {appliedCounts.map((count) => (
              <SelectItem key={count.id} value={String(count.id)}>
                #{count.id} — {count.scope === "full" ? "Completo" : "Críticos"} — {count.business_date}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {countId !== null ? <CsvExportButton href={varianceCsvUrl({ storeId, countId })} /> : null}
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
  } else if (countId === null) {
    empty = (
      <EmptyState
        title="Elegí un conteo aplicado"
        description="La varianza compara ese conteo contra el aplicado inmediatamente anterior."
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
      cell: (r) => `${r.opening_qty} ${UNIT_LABEL[r.base_unit] ?? r.base_unit}`,
    },
    {
      key: "inflow",
      header: "Entradas",
      kind: "number",
      cell: (r) => `${r.inflow_qty} ${UNIT_LABEL[r.base_unit] ?? r.base_unit}`,
    },
    {
      key: "closing",
      header: "Final",
      kind: "number",
      cell: (r) => `${r.closing_qty} ${UNIT_LABEL[r.base_unit] ?? r.base_unit}`,
    },
    {
      key: "real",
      header: "Uso real",
      kind: "number",
      cell: (r) => `${r.real_usage_qty} ${UNIT_LABEL[r.base_unit] ?? r.base_unit}`,
    },
    {
      key: "theoretical",
      header: "Uso teórico",
      kind: "number",
      cell: (r) => `${r.theoretical_usage_qty} ${UNIT_LABEL[r.base_unit] ?? r.base_unit}`,
    },
    {
      key: "variance",
      header: "Varianza",
      kind: "number",
      cell: (r) => (
        <span className={cn(r.level === "red" && "font-bold text-destructive")}>
          {r.variance_qty} {UNIT_LABEL[r.base_unit] ?? r.base_unit}
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
          formatCOP(r.variance_value)
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
      cell: (r) => formatBasisPoints(r.variance_pct_bp),
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
    <DenseTable
      caption="Varianza entre dos conteos aplicados"
      columns={columns}
      rows={rows}
      rowKey={(r) => String(r.ingredient_id)}
      rowStatus={(r) => LEVEL_STATUS[r.level]}
      legend={LEGEND}
      bar={
        countId !== null && varianceQuery.isLoading ? (
          <div className="flex flex-wrap items-center gap-2 border-b bg-muted px-3 py-2">
            <p className="text-xs text-muted-foreground">Calculando varianza…</p>
            <div className="ml-auto flex flex-wrap items-center gap-2">{picker}</div>
          </div>
        ) : (
          <DenseTableBar
            shown={rows.length}
            total={rows.length}
            noun="insumos comparados"
            hidden={
              rows.length > 0 ? `${rows.filter((r) => r.level !== "green").length} para revisar` : undefined
            }
          >
            {picker}
          </DenseTableBar>
        )
      }
      note={
        <>
          El semáforo lo decide el <b>servidor</b> contra los umbrales de la sede: cambiarlos en Configuración
          cambia los colores de acá. Una varianza no es un robo —es todo lo que las recetas no explican:
          porciones generosas, mermas sin registrar, recetas desactualizadas—.
        </>
      }
      empty={varianceQuery.isLoading && countId !== null ? undefined : empty}
    />
  )
}

export default VarianceTab
