import { useQuery } from "@tanstack/react-query"
import { useState } from "react"

import { getSales, salesCsvUrl, type SalesBucketOut, type SalesGroupBy } from "@/api/reports"
import { CsvExportButton } from "@/components/CsvExportButton"
import { DateRangeFilter } from "@/components/DateRangeFilter"
import { EmptyState } from "@/components/EmptyState"
import { StatTile } from "@/components/StatTile"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { errorMessage } from "@/lib/errors"
import { formatCOP } from "@/lib/money"

import { CategoryBars, TrendLine } from "./charts"
import { GROUP_BY_LABEL, daysAgoInBogota, isSequentialGroupBy, methodLabel, todayInBogota } from "./lib"

function bucketLabel(row: SalesBucketOut, groupBy: SalesGroupBy): string {
  if (groupBy === "method") return methodLabel(row.key)
  return row.label ?? row.key
}

/**
 * "Ventas": ¿qué vendí y cómo me pagaron?, agrupado como pida la persona
 * (SPEC-NEGOCIO §9.3). Todo número sale tal cual de `SalesBucketOut` — este
 * componente sólo formatea y elige la forma visual según `group_by`.
 */
export function SalesTab({ storeId }: { storeId: number }): React.JSX.Element {
  const [from, setFrom] = useState(daysAgoInBogota(6))
  const [to, setTo] = useState(todayInBogota())
  const [groupBy, setGroupBy] = useState<SalesGroupBy>("business_date")

  const query = useQuery({
    queryKey: ["admin-sales", storeId, from, to, groupBy],
    queryFn: () => getSales({ storeId, from, to, groupBy }),
  })

  return (
    <div className="space-y-4">
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
          role="alert"
          title="No se pudieron cargar las ventas"
          description={errorMessage(query.error)}
          action={{ label: "Reintentar", onClick: () => void query.refetch() }}
        />
      ) : query.data ? (
        <SalesReport report={query.data} groupBy={groupBy} />
      ) : null}
    </div>
  )
}

function SalesReport({ report, groupBy }: { report: { rows: SalesBucketOut[]; total: SalesBucketOut }; groupBy: SalesGroupBy }): React.JSX.Element {
  const { rows, total } = report

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Ventas cobradas" value={formatCOP(total.gross)} />
        <StatTile label="Ventas netas" value={formatCOP(total.net)} />
        <StatTile label="Impuesto discriminado" value={formatCOP(total.tax)} />
        <StatTile label="Propinas (informativo)" value={formatCOP(total.tips)} />
        <StatTile label="Comandas pagadas" value={total.orders !== undefined ? String(total.orders) : "—"} />
        <StatTile label="Comensales" value={total.covers !== null && total.covers !== undefined ? String(total.covers) : "—"} />
        <StatTile label="Ticket promedio" value={formatCOP(total.avg_ticket)} />
        <StatTile label="Ticket por comensal" value={formatCOP(total.avg_per_cover)} />
      </div>

      {rows.length === 0 ? (
        <EmptyState title="Sin ventas en este período" description="Elegí otro rango de fechas." />
      ) : (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold">{GROUP_BY_LABEL[groupBy]}</h2>
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

          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{GROUP_BY_LABEL[groupBy]}</TableHead>
                  <TableHead>Bruto</TableHead>
                  <TableHead>Neto</TableHead>
                  <TableHead>Impuesto</TableHead>
                  <TableHead>Propinas</TableHead>
                  <TableHead>Comandas</TableHead>
                  <TableHead>Comensales</TableHead>
                  <TableHead>Ticket prom.</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.key}>
                    <TableCell>{bucketLabel(row, groupBy)}</TableCell>
                    <TableCell className="tabular-nums">{formatCOP(row.gross)}</TableCell>
                    <TableCell className="tabular-nums">{formatCOP(row.net)}</TableCell>
                    <TableCell className="tabular-nums">{formatCOP(row.tax)}</TableCell>
                    <TableCell className="tabular-nums">{formatCOP(row.tips)}</TableCell>
                    <TableCell className="tabular-nums">{row.orders ?? "—"}</TableCell>
                    <TableCell className="tabular-nums">{row.covers ?? "—"}</TableCell>
                    <TableCell className="tabular-nums">{formatCOP(row.avg_ticket)}</TableCell>
                  </TableRow>
                ))}
                <TableRow className="font-medium">
                  <TableCell>Total</TableCell>
                  <TableCell className="tabular-nums">{formatCOP(total.gross)}</TableCell>
                  <TableCell className="tabular-nums">{formatCOP(total.net)}</TableCell>
                  <TableCell className="tabular-nums">{formatCOP(total.tax)}</TableCell>
                  <TableCell className="tabular-nums">{formatCOP(total.tips)}</TableCell>
                  <TableCell className="tabular-nums">{total.orders ?? "—"}</TableCell>
                  <TableCell className="tabular-nums">{total.covers ?? "—"}</TableCell>
                  <TableCell className="tabular-nums">{formatCOP(total.avg_ticket)}</TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>
        </section>
      )}
    </div>
  )
}

export default SalesTab
