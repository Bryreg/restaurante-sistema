import { useQuery } from "@tanstack/react-query"
import { useState } from "react"

import { getWasteAnalysis } from "@/api/inventory"
import { csvUrl } from "@/api/client"
import { CsvExportButton } from "@/components/CsvExportButton"
import { DateRangeFilter } from "@/components/DateRangeFilter"
import { EmptyState } from "@/components/EmptyState"
import { errorMessage } from "@/lib/errors"
import { formatCantidad, formatPct } from "@/lib/format"
import { formatCOP } from "@/lib/money"

import { daysAgoLocal, todayLocal, UNIT_LABEL, WASTE_TYPE_LABEL } from "./lib"

/** El costo de un grupo: `null` es «sin costo» (ninguna merma lo tenía), nunca $0. */
function Costo({ cost, uncosted }: { cost: number | null; uncosted: number }): React.JSX.Element {
  if (cost === null) {
    return (
      <span className="text-muted-foreground" title="Ninguna de estas mermas tiene costo cargado">
        Sin costo
      </span>
    )
  }
  return (
    <span title={uncosted > 0 ? `${uncosted} sin costo: no están sumadas` : undefined}>
      {formatCOP(cost)}
      {uncosted > 0 ? <span className="text-muted-foreground"> +{uncosted} sin costo</span> : null}
    </span>
  )
}

function Tabla({
  titulo,
  cabeza,
  filas,
}: {
  titulo: string
  cabeza: string
  filas: { key: string; nombre: React.ReactNode; detalle?: React.ReactNode; entries: number; cost: number | null; uncosted: number; share: number | null }[]
}): React.JSX.Element {
  return (
    <section className="space-y-2" aria-label={titulo}>
      <h3 className="text-sm font-semibold">{titulo}</h3>
      {filas.length === 0 ? (
        <p className="text-sm text-muted-foreground">Ninguna en el período.</p>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-xs text-muted-foreground">
            <tr>
              <th className="px-2 py-1 text-left font-medium">{cabeza}</th>
              <th className="px-2 py-1 text-right font-medium">Registros</th>
              <th className="px-2 py-1 text-right font-medium">Al costo</th>
              <th className="px-2 py-1 text-right font-medium">Del total</th>
            </tr>
          </thead>
          <tbody>
            {filas.map((f) => (
              <tr key={f.key} className="border-t">
                <td className="px-2 py-1.5">
                  {f.nombre}
                  {f.detalle ? <span className="ml-1 text-xs text-muted-foreground">{f.detalle}</span> : null}
                </td>
                <td className="px-2 py-1.5 text-right tabular-nums">{f.entries}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">
                  <Costo cost={f.cost} uncosted={f.uncosted} />
                </td>
                <td className="px-2 py-1.5 text-right tabular-nums">{f.share === null ? "—" : formatPct(f.share)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}

/**
 * Inventario › Análisis de mermas (tanda 5, i6): cuánto se perdió en el
 * período, en plata al costo congelado de cada merma, por motivo, por insumo
 * y por persona responsable. Sólo administración (lleva costos). Los totales
 * y porcentajes los calcula el servidor; el consumo interno y el traslado se
 * muestran aparte porque no son pérdida.
 */
export function WasteAnalysisTab({ storeId }: { storeId: number }): React.JSX.Element {
  const [range, setRange] = useState(() => ({ from: daysAgoLocal(29), to: todayLocal() }))
  const query = useQuery({
    queryKey: ["inventory", "waste-analysis", storeId, range.from, range.to],
    queryFn: () => getWasteAnalysis(storeId, range),
  })
  const data = query.data

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <DateRangeFilter idPrefix="waste-analysis" from={range.from} to={range.to} onChange={setRange} />
        <CsvExportButton href={csvUrl("/admin/waste/analysis", { store_id: storeId, from: range.from, to: range.to })} />
      </div>
      {query.isLoading ? (
        <p className="text-sm text-muted-foreground">Sumando las mermas…</p>
      ) : query.isError || !data ? (
        <EmptyState reason="error" title="No se pudo armar el análisis de mermas" description={errorMessage(query.error)} />
      ) : (
        <>
          <p className="text-sm" data-testid="merma-total">
            {data.entries === 0 ? (
              "Ninguna merma registrada en el período."
            ) : (
              <>
                Se perdieron <b className="tabular-nums">{data.cost === null ? "—" : formatCOP(data.cost)}</b> al costo en{" "}
                {data.entries} {data.entries === 1 ? "merma" : "mermas"}
                {data.uncosted_entries > 0 ? ` (${data.uncosted_entries} sin costo, no sumadas)` : ""}.
              </>
            )}
          </p>
          <div className="grid gap-6 lg:grid-cols-2">
            <Tabla
              titulo="Por motivo"
              cabeza="Motivo"
              filas={data.by_reason.map((r) => ({
                key: r.type,
                nombre: WASTE_TYPE_LABEL[r.type] ?? r.type,
                detalle: r.loss ? undefined : "no es pérdida",
                entries: r.entries,
                cost: r.cost,
                uncosted: r.uncosted_entries,
                share: r.share_bp,
              }))}
            />
            <Tabla
              titulo="Por persona"
              cabeza="Responsable"
              filas={data.by_person.map((p) => ({
                key: String(p.employee_id),
                nombre: p.employee_name,
                entries: p.entries,
                cost: p.cost,
                uncosted: p.uncosted_entries,
                share: p.share_bp,
              }))}
            />
          </div>
          <Tabla
            titulo="Por insumo"
            cabeza="Insumo o preparación"
            filas={data.by_ingredient.map((i) => ({
              key: `${i.kind}-${i.item_id}`,
              nombre: i.name,
              detalle: formatCantidad(i.qty, UNIT_LABEL[i.unit] ?? i.unit),
              entries: i.entries,
              cost: i.cost,
              uncosted: i.uncosted_entries,
              share: i.share_bp,
            }))}
          />
        </>
      )}
    </div>
  )
}

export default WasteAnalysisTab
