import { useQuery } from "@tanstack/react-query"
import { useState } from "react"

import { accountantReportCsvUrl, getAccountantReport, type AccountantRowOut } from "@/api/reports"
import { DenseTable, DenseTableBar, GroupLabel, type DenseColumn } from "@/components/admin"
import { CsvExportButton } from "@/components/CsvExportButton"
import { EmptyState } from "@/components/EmptyState"
import { StatTile } from "@/components/StatTile"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
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
const ACCOUNTANT_COLUMNS: readonly DenseColumn<AccountantRowOut>[] = [
  { key: "date", header: "Día operativo", kind: "name", cell: (r) => formatBusinessDate(r.business_date) },
  { key: "documents", header: "Documentos", kind: "number", cell: (r) => r.documents_count },
  { key: "notes", header: "Notas", kind: "number", cell: (r) => r.notes_count },
  { key: "tips", header: "Propinas", kind: "number", cell: (r) => formatCOP(r.tips_amount) },
  // Lo largo va al `title` y lo corto a la celda: la fila no crece (§ 8).
  { key: "rates", header: "Por tarifa", kind: "secondary", cell: (r) => rateLine(r), cellTitle: (r) => rateLine(r) },
]

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
          reason="error"
          title="No se pudo cargar el informe"
          description={errorMessage(query.error)}
          action={{ label: "Reintentar", onClick: () => void query.refetch() }}
        />
      ) : query.data ? (
        <div className="space-y-6">
          {/* § 3 · Lo emitido y lo devuelto no son el mismo tipo de número:
              una nota RESTA de lo que el documento sumó. La grilla uniforme
              los aplanaba. */}
          <GroupLabel label="Lo emitido" says="documentos equivalentes POS del período">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <StatTile
                label="Base de documentos"
                value={formatCOP(query.data.documents_total_base)}
                hint="Lo vendido sin el impuesto."
              />
              <StatTile
                label="Impuesto de documentos"
                value={formatCOP(query.data.documents_total_tax)}
                hint="El impuesto al consumo discriminado: no es del restaurante."
              />
              <StatTile
                label="Propinas del período (informativo)"
                value={formatCOP(query.data.tips_total)}
                hint="Ni venta ni impuesto: va aparte por ley (Ley 1935 de 2018)."
              />
            </div>
          </GroupLabel>

          <GroupLabel label="Lo devuelto" says="notas crédito: restan de lo de arriba, no se suman">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <StatTile label="Base de notas" value={formatCOP(query.data.notes_total_base)} hint="Lo devuelto sin el impuesto." />
              <StatTile
                label="Impuesto de notas"
                value={formatCOP(query.data.notes_total_tax)}
                hint="El impuesto que se devuelve con la nota."
              />
            </div>
          </GroupLabel>

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
            <EmptyState
              reason="filter"
              title="Sin documentos en este período"
              description="El filtro puesto es el mes o bimestre elegido: no se emitió ningún documento en él."
            />
          ) : (
            <DenseTable
              caption="Documentos y notas por día operativo, con el desglose por tarifa de impuesto."
              columns={ACCOUNTANT_COLUMNS}
              rows={query.data.rows}
              rowKey={(row) => row.business_date}
              maxBodyHeightPx={460}
              bar={
                <DenseTableBar
                  shown={query.data.rows.length}
                  total={query.data.rows.length}
                  noun="días operativos con documentos"
                />
              }
              legend={[
                {
                  term: "Día operativo ≠ día calendario",
                  meaning: "el día corta a la hora que la sede definió, no a medianoche. Una venta de la 1 a. m. cae en el día anterior.",
                },
                {
                  term: "Por tarifa",
                  meaning: "el desglose que el contador necesita: INC 8 %, IVA 19 % y excluido no se pueden sumar entre sí.",
                },
              ]}
            />
          )}
        </div>
      ) : null}
    </div>
  )
}

export default AccountantReportTab
