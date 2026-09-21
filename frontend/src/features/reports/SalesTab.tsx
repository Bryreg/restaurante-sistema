import { useQuery } from "@tanstack/react-query"
import { useState } from "react"

import { getSales, salesCsvUrl, type SalesBucketOut, type SalesGroupBy } from "@/api/reports"
import {
  DenseTable,
  DenseTableBar,
  FilterEmptyState,
  GroupLabel,
  HeadlineFigure,
  type DenseColumn,
} from "@/components/admin"
import { CsvExportButton } from "@/components/CsvExportButton"
import { DateRangeFilter } from "@/components/DateRangeFilter"
import { EmptyState } from "@/components/EmptyState"
import { StatTile } from "@/components/StatTile"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { errorMessage } from "@/lib/errors"
import { formatCOP } from "@/lib/money"

import { CategoryBars, TrendLine } from "./charts"
import {
  daysAgoInBogota,
  formatPercentInt,
  GROUP_BY_LABEL,
  isSequentialGroupBy,
  methodLabel,
  recipeCoverageTone,
  todayInBogota,
} from "./lib"

function bucketLabel(row: SalesBucketOut, groupBy: SalesGroupBy): string {
  if (groupBy === "method") return methodLabel(row.key)
  return row.label ?? row.key
}

const DEFAULT_DAYS_BACK = 6

/**
 * "Ventas": ¿qué vendí y cómo me pagaron?, agrupado como pida la persona
 * (SPEC-NEGOCIO §9.3). Todo número sale tal cual de `SalesBucketOut` — este
 * componente sólo formatea y elige la forma visual según `group_by`.
 */
export function SalesTab({ storeId }: { storeId: number }): React.JSX.Element {
  const [from, setFrom] = useState(daysAgoInBogota(DEFAULT_DAYS_BACK))
  const [to, setTo] = useState(todayInBogota())
  const [groupBy, setGroupBy] = useState<SalesGroupBy>("business_date")

  const query = useQuery({
    queryKey: ["admin-sales", storeId, from, to, groupBy],
    queryFn: () => getSales({ storeId, from, to, groupBy }),
  })

  const resetRange = (): void => {
    setFrom(daysAgoInBogota(DEFAULT_DAYS_BACK))
    setTo(todayInBogota())
  }

  return (
    <div className="space-y-5">
      {/* El período y la agrupación gobiernan TODA la pestaña, no sólo la
          tabla: por eso viven acá arriba, pegados a la cabecera de pantalla,
          y no en la barra de la tabla (`docs/PATRONES-ADMIN.md` § 1 y § 2). */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <DateRangeFilter idPrefix="sales" from={from} to={to} onChange={(r) => { setFrom(r.from); setTo(r.to) }} />
          <div className="space-y-1">
            <Label htmlFor="sales-group-by">Agrupar por</Label>
            <Select value={groupBy} onValueChange={(v) => setGroupBy(v as SalesGroupBy)}>
              <SelectTrigger id="sales-group-by" className="h-10 w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(GROUP_BY_LABEL).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <CsvExportButton href={salesCsvUrl({ storeId, from, to, groupBy })} label="Exportar CSV" />
      </div>

      {query.isLoading ? (
        <p className="text-sm text-muted-foreground">Cargando ventas…</p>
      ) : query.isError ? (
        <EmptyState
          reason="error"
          title="No se pudieron cargar las ventas"
          description={errorMessage(query.error)}
          action={{ label: "Reintentar", onClick: () => void query.refetch() }}
        />
      ) : query.data ? (
        <SalesReport
          report={query.data}
          groupBy={groupBy}
          range={{ from, to }}
          onResetRange={resetRange}
        />
      ) : null}
    </div>
  )
}

/** La fila de cierre de la tabla, dentro del `<tfoot>` (§ 8). */
function totalsRow(total: SalesBucketOut): React.JSX.Element {
  return (
    <tr className="font-bold">
      <td className="px-2 py-1.5">Total</td>
      <td className="px-2 py-1.5 text-right tabular-nums">{formatCOP(total.gross)}</td>
      <td className="px-2 py-1.5 text-right tabular-nums">{formatCOP(total.net)}</td>
      <td className="px-2 py-1.5 text-right tabular-nums">{formatCOP(total.tax)}</td>
      <td className="px-2 py-1.5 text-right tabular-nums">{formatCOP(total.tips)}</td>
      <td className="px-2 py-1.5 text-right tabular-nums">{total.orders ?? "—"}</td>
      <td className="px-2 py-1.5 text-right tabular-nums">{total.covers ?? "—"}</td>
      <td className="px-2 py-1.5 text-right tabular-nums">{formatCOP(total.avg_ticket)}</td>
      <td className="px-2 py-1.5 text-right tabular-nums">{formatCOP(total.theoretical_cost)}</td>
      <td className="px-2 py-1.5 text-right tabular-nums">{formatCOP(total.gross_margin)}</td>
      <td className="px-2 py-1.5 text-right tabular-nums">{formatPercentInt(total.costed_pct)}</td>
    </tr>
  )
}

function salesColumns(groupBy: SalesGroupBy): readonly DenseColumn<SalesBucketOut>[] {
  return [
    { key: "bucket", header: GROUP_BY_LABEL[groupBy], kind: "name", cell: (r) => bucketLabel(r, groupBy) },
    { key: "gross", header: "Cobrado", kind: "number", cell: (r) => formatCOP(r.gross) },
    { key: "net", header: "Neto", kind: "number", cell: (r) => formatCOP(r.net) },
    { key: "tax", header: "Impuesto", kind: "number", cell: (r) => formatCOP(r.tax) },
    { key: "tips", header: "Propinas", kind: "number", cell: (r) => formatCOP(r.tips) },
    { key: "orders", header: "Comandas", kind: "number", cell: (r) => r.orders ?? "—" },
    { key: "covers", header: "Comensales", kind: "number", cell: (r) => r.covers ?? "—" },
    { key: "avg", header: "Ticket prom.", kind: "number", cell: (r) => formatCOP(r.avg_ticket) },
    { key: "cost", header: "Costo teórico", kind: "number", cell: (r) => formatCOP(r.theoretical_cost) },
    { key: "margin", header: "Margen bruto", kind: "number", cell: (r) => formatCOP(r.gross_margin) },
    { key: "coverage", header: "Cobertura", kind: "number", cell: (r) => formatPercentInt(r.costed_pct) },
  ]
}

function SalesReport({
  report,
  groupBy,
  range,
  onResetRange,
}: {
  report: { rows: SalesBucketOut[]; total: SalesBucketOut }
  groupBy: SalesGroupBy
  range: { from: string; to: string }
  onResetRange: () => void
}): React.JSX.Element {
  const { rows, total } = report
  const rangeLabel = `${range.from} a ${range.to}`

  return (
    <div className="space-y-5">
      {/* § 4 · La cifra rectora de esta pantalla, con el libro que la deriva
          —cobrado − impuesto = neto— y las propinas ABAJO DE LA RAYA, que es
          lo que mata la tarjeta «Propinas» (error de categoría: la propina no
          es del restaurante, Ley 1935 de 2018). */}
      <HeadlineFigure
        label="Ventas netas del período"
        value={formatCOP(total.net)}
        note={
          total.orders !== undefined
            ? `${total.orders} ${total.orders === 1 ? "comanda pagada" : "comandas pagadas"} · agrupadas por ${GROUP_BY_LABEL[groupBy].toLowerCase()}`
            : undefined
        }
        ledger={{
          rows: [
            { label: "Ventas cobradas", value: formatCOP(total.gross) },
            { label: "Impuesto discriminado", value: formatCOP(total.tax), kind: "subtract" },
          ],
          total: { label: "Ventas netas", value: formatCOP(total.net) },
        }}
        belowTheLine={{ label: "Propinas (informativo) — no son venta", value: formatCOP(total.tips) }}
      />

      <GroupLabel label="Del período" says="cerrado, ya no cambia">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatTile
            label="Comandas pagadas"
            value={total.orders !== undefined ? String(total.orders) : "—"}
            hint="Cobradas y cerradas en el rango elegido."
          />
          {total.covers === null || total.covers === undefined ? (
            <StatTile
              label="Comensales"
              value={null}
              nullNote="No es cero: es que nadie los contó. Mostrador no registra comensales."
            />
          ) : (
            <StatTile label="Comensales" value={String(total.covers)} hint="Contados al abrir la mesa." />
          )}
          <StatTile label="Ticket promedio" value={formatCOP(total.avg_ticket)} hint="Sobre venta neta, sin propina." />
          <StatTile
            label="Ticket por comensal"
            value={formatCOP(total.avg_per_cover)}
            hint="Sobre las comandas que sí contaron comensales."
          />
        </div>
      </GroupLabel>

      {/* Costo teórico, margen bruto y cobertura de receta (pedido 2a). La
          cobertura es el número más honesto del reporte — dice qué porción
          de la venta tuvo ficha técnica de verdad — así que va primero y
          grande, no escondida en una columna; si es baja, el tono la marca
          y el margen de al lado deja de leerse como definitivo. */}
      <GroupLabel label="Qué tan en serio tomar ese margen" says="depende de cuánta venta tuvo ficha técnica">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <StatTile
            label="Cobertura de receta"
            value={formatPercentInt(total.costed_pct)}
            hint={
              recipeCoverageTone(total.costed_pct) === "default"
                ? "Porción de la venta neta con ficha técnica de verdad."
                : "Bajo esto, el costo y el margen de al lado no representan toda la venta — la mayoría se vendió sin receta."
            }
            tone={recipeCoverageTone(total.costed_pct)}
            // § 5, regla dura: una tarjeta con tono lleva a algún lado. Sin
            // pestaña en el enlace porque Carta no guarda la suya en la URL:
            // nombrarla sería prometer un filtro que el enlace no pone (§ 6).
            link={{ to: "/admin/carta", screen: "Carta" }}
          />
          <StatTile
            label="Costo teórico"
            value={formatCOP(total.theoretical_cost)}
            hint={total.theoretical_cost === null || total.theoretical_cost === undefined ? "Sin ventas costeadas en el período" : "Lo que las fichas dicen que costó."}
          />
          <StatTile
            label="Margen bruto teórico"
            value={formatCOP(total.gross_margin)}
            hint={total.gross_margin === null || total.gross_margin === undefined ? "Sin ventas costeadas en el período" : "Ventas netas − costo teórico"}
          />
        </div>
      </GroupLabel>

      {rows.length === 0 ? (
        <FilterEmptyState
          title="Sin ventas en este período"
          filters={[rangeLabel]}
          onRemove={onResetRange}
          description="No hay ninguna venta cobrada en el rango de fechas elegido. El filtro puesto es el período."
        />
      ) : (
        <section className="space-y-3">
          {isSequentialGroupBy(groupBy) ? (
            <TrendLine
              data={rows.map((r) => ({ key: r.key, label: bucketLabel(r, groupBy), value: r.net ?? 0 }))}
              formatValue={(v) => formatCOP(v)}
            />
          ) : rows.length <= 12 ? (
            <CategoryBars
              data={rows.map((r) => ({ key: r.key, label: bucketLabel(r, groupBy), value: r.net ?? 0 }))}
              formatValue={(v) => formatCOP(v)}
            />
          ) : null}

          <DenseTable
            caption={`Ventas del período agrupadas por ${GROUP_BY_LABEL[groupBy].toLowerCase()}, con cobrado, neto, impuesto, propinas y costo.`}
            columns={salesColumns(groupBy)}
            rows={rows}
            rowKey={(r) => r.key}
            maxBodyHeightPx={420}
            bar={
              <DenseTableBar
                shown={rows.length}
                total={rows.length}
                noun={GROUP_BY_LABEL[groupBy].toLowerCase()}
                hidden={`del ${rangeLabel}`}
              />
            }
            footer={totalsRow(total)}
            legend={[
              {
                term: "Cobrado ≠ neto",
                meaning: "lo cobrado incluye el impuesto al consumo, que no es del restaurante. El neto es lo que queda.",
              },
              {
                term: "Propinas",
                meaning: "van en su columna porque se cobran, pero no son venta ni entran en el neto.",
              },
              {
                term: "Cobertura «—»",
                meaning: "no es 0 %: es que no hubo venta costeada para medirla en ese renglón.",
              },
            ]}
          />
        </section>
      )}
    </div>
  )
}

export default SalesTab
