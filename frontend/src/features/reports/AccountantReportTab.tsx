import { useQuery } from "@tanstack/react-query"
import { useState } from "react"

import { accountantReportCsvUrl, getAccountantReport, type AccountantRowOut } from "@/api/reports"
import { CsvExportButton } from "@/components/CsvExportButton"
import { EmptyState } from "@/components/EmptyState"
import { StatTile } from "@/components/StatTile"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { formatBusinessDate } from "@/lib/businessDate"
import { errorMessage } from "@/lib/errors"
import { formatCOP } from "@/lib/money"

import { methodLabel, todayInBogota } from "./lib"

type PeriodKind = "month" | "bimester"

const MONTH_LABEL: Record<number, string> = {
  1: "Enero", 2: "Febrero", 3: "Marzo", 4: "Abril", 5: "Mayo", 6: "Junio",
  7: "Julio", 8: "Agosto", 9: "Septiembre", 10: "Octubre", 11: "Noviembre", 12: "Diciembre",
}

const BIMESTER_LABEL: Record<number, string> = {
  1: "Enero – Febrero", 2: "Marzo – Abril", 3: "Mayo – Junio",
  4: "Julio – Agosto", 5: "Septiembre – Octubre", 6: "Noviembre – Diciembre",
}

function rateLine(row: AccountantRowOut): string {
  if (row.by_rate.length === 0) return "—"
  return row.by_rate
    .map((r) => `${r.rate}%: base ${formatCOP(r.documents_base)} / nota ${formatCOP(r.notes_base)}`)
    .join(" · ")
}

/**
 * "Informe para el contador" (SPEC-NEGOCIO §8.3, §9.3): por día operativo y
 * tarifa — base, impuesto, documentos, notas, propinas (informativas); por
 * bimestre o por mes. Todo número sale de `AccountantReportOut`, nunca se
 * recalcula acá.
 */
export function AccountantReportTab({ storeId }: { storeId: number }): React.JSX.Element {
  const nowParts = todayInBogota().split("-")
  const [year, setYear] = useState(Number(nowParts[0]))
  const [periodKind, setPeriodKind] = useState<PeriodKind>("month")
  const [periodValue, setPeriodValue] = useState(Number(nowParts[1]))

  const query = useQuery({
    queryKey: ["admin-accountant-report", storeId, year, periodKind, periodValue],
    queryFn: () =>
      getAccountantReport({
        storeId,
        year,
        month: periodKind === "month" ? periodValue : undefined,
        bimester: periodKind === "bimester" ? periodValue : undefined,
      }),
  })

  const periodOptions = periodKind === "month" ? MONTH_LABEL : BIMESTER_LABEL
  const csvUrl = accountantReportCsvUrl({
    storeId,
    year,
    month: periodKind === "month" ? periodValue : undefined,
    bimester: periodKind === "bimester" ? periodValue : undefined,
  })

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label htmlFor="accountant-year">Año</Label>
            <Input
              id="accountant-year"
              type="number"
              className="h-10 w-24"
              value={String(year)}
              onChange={(e) => setYear(Number(e.target.value) || year)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="accountant-period-kind">Período</Label>
            <Select
              value={periodKind}
              onValueChange={(v) => {
                const kind = v as PeriodKind
                setPeriodKind(kind)
                setPeriodValue(kind === "month" ? Number(nowParts[1]) : Math.ceil(Number(nowParts[1]) / 2))
              }}
            >
              <SelectTrigger id="accountant-period-kind" className="h-10 w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="month">Mensual</SelectItem>
                <SelectItem value="bimester">Bimestral</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="accountant-period-value">{periodKind === "month" ? "Mes" : "Bimestre"}</Label>
            <Select value={String(periodValue)} onValueChange={(v) => setPeriodValue(Number(v))}>
              <SelectTrigger id="accountant-period-value" className="h-10 w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(periodOptions).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <CsvExportButton href={csvUrl} label="Exportar CSV" />
      </div>

      {query.isLoading ? (
        <p className="text-sm text-muted-foreground">Cargando el informe del contador…</p>
      ) : query.isError ? (
        <EmptyState
          role="alert"
          title="No se pudo cargar el informe"
          description={errorMessage(query.error)}
          action={{ label: "Reintentar", onClick: () => void query.refetch() }}
        />
      ) : query.data ? (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatTile label="Base de documentos" value={formatCOP(query.data.documents_total_base)} />
            <StatTile label="Impuesto de documentos" value={formatCOP(query.data.documents_total_tax)} />
            <StatTile label="Base de notas" value={formatCOP(query.data.notes_total_base)} />
            <StatTile label="Impuesto de notas" value={formatCOP(query.data.notes_total_tax)} />
            <StatTile label="Propinas del período (informativo)" value={formatCOP(query.data.tips_total)} />
          </div>

          {query.data.totals_by_method.length > 0 ? (
            <div className="flex flex-wrap gap-3">
              {query.data.totals_by_method.map((m) => (
                <div key={m.method} className="rounded-md border px-3 py-2 text-sm">
                  <span className="text-muted-foreground">{methodLabel(m.method)}: </span>
                  <span className="font-medium tabular-nums">{formatCOP(m.amount)}</span>
                </div>
              ))}
            </div>
          ) : null}

          {query.data.rows.length === 0 ? (
            <EmptyState title="Sin documentos en este período" />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Día operativo</TableHead>
                    <TableHead>Documentos</TableHead>
                    <TableHead>Notas</TableHead>
                    <TableHead>Propinas</TableHead>
                    <TableHead>Por tarifa</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {query.data.rows.map((row) => (
                    <TableRow key={row.business_date}>
                      <TableCell>{formatBusinessDate(row.business_date)}</TableCell>
                      <TableCell className="tabular-nums">{row.documents_count}</TableCell>
                      <TableCell className="tabular-nums">{row.notes_count}</TableCell>
                      <TableCell className="tabular-nums">{formatCOP(row.tips_amount)}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{rateLine(row)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      ) : null}
    </div>
  )
}

export default AccountantReportTab
