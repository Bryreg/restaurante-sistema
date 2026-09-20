/**
 * Admin → Nómina y propinas → Liquidaciones (T3,
 * `GET`/`POST /admin/payroll/runs`): liquidación del período. La respuesta
 * nombra qué tabla(s) vigente(s) usó — esta pantalla lo muestra siempre,
 * nunca lo asume (spec.md § T3, contrato de API mínimo: "mostralo en
 * pantalla"). Campos verificados por lectura directa de `app/payroll/
 * schemas.py::PayrollRunOut` (`tables_used`/`lines`, no `surcharge_table_
 * used`/`rows` como asumía la primera versión de este archivo).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"

import { createPayrollRun, getPayrollRuns, type PayrollRunOut } from "@/api/payroll"
import { DateRangeFilter } from "@/components/DateRangeFilter"
import { EmptyState } from "@/components/EmptyState"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { formatBusinessDate } from "@/lib/businessDate"
import { errorMessage } from "@/lib/errors"
import { formatCOP } from "@/lib/money"

import { formatBasisPoints } from "@/features/inventory/lib"

import { daysAgoLocal, todayLocal } from "./lib"

function RunDetail({ run }: { run: PayrollRunOut }): React.JSX.Element {
  const tables = run.tables_used ?? []
  const lines = run.lines ?? []
  return (
    <div className="space-y-3">
      {tables.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {tables.map((table, index) => (
            <Badge key={`${table.valid_from}-${index}`} variant="secondary">
              Tabla vigente desde {formatBusinessDate(table.valid_from)}: nocturno {formatBasisPoints(table.night_surcharge_bp)}, dominical/festivo{" "}
              {formatBasisPoints(table.sunday_holiday_surcharge_bp)}, extra {formatBasisPoints(table.overtime_surcharge_bp)}
            </Badge>
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">Esta liquidación no informó qué tabla de recargos usó.</p>
      )}
      {lines.length === 0 ? (
        <p className="text-sm text-muted-foreground">Sin renglones por persona en esta liquidación.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Persona</TableHead>
              <TableHead>Base</TableHead>
              <TableHead>Recargo nocturno</TableHead>
              <TableHead>Recargo dominical/festivo</TableHead>
              <TableHead>Hora extra</TableHead>
              <TableHead>Total</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {lines.map((line) => (
              <TableRow key={line.employee_id}>
                <TableCell>{line.employee_name ?? `#${line.employee_id}`}</TableCell>
                <TableCell className="tabular-nums">{formatCOP(line.base_pay)}</TableCell>
                <TableCell className="tabular-nums">{formatCOP(line.night_surcharge)}</TableCell>
                <TableCell className="tabular-nums">{formatCOP(line.sunday_holiday_surcharge)}</TableCell>
                <TableCell className="tabular-nums">{formatCOP(line.overtime_pay)}</TableCell>
                <TableCell className="tabular-nums font-medium">
                  {line.total === null ? (
                    <span className="text-muted-foreground">Sin datos{line.pay_reason ? `: ${line.pay_reason}` : ""}</span>
                  ) : (
                    formatCOP(line.total)
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  )
}

export function RunsTab({ storeId }: { storeId: number }): React.JSX.Element {
  const [from, setFrom] = useState(daysAgoLocal(15))
  const [to, setTo] = useState(todayLocal())
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const queryClient = useQueryClient()

  const query = useQuery({
    queryKey: ["payroll", "runs", storeId, from, to],
    queryFn: () => getPayrollRuns({ storeId, from, to }),
  })

  const mutation = useMutation({
    mutationFn: () => createPayrollRun(storeId, { date_from: from, date_to: to }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["payroll", "runs"] }),
  })

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <DateRangeFilter idPrefix="payroll-runs" from={from} to={to} onChange={(r) => { setFrom(r.from); setTo(r.to) }} />
        <Button type="button" className="h-11" disabled={mutation.isPending} onClick={() => mutation.mutate()}>
          Liquidar este período
        </Button>
      </div>
      {mutation.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(mutation.error)}
        </p>
      ) : null}
      {mutation.isSuccess && !mutation.data.available ? (
        <p role="alert" className="text-sm text-destructive">
          No se pudo liquidar: {mutation.data.reason ?? "faltan datos del período."}
        </p>
      ) : null}

      {query.isLoading ? (
        <p className="text-sm text-muted-foreground">Cargando liquidaciones…</p>
      ) : query.isError ? (
        <EmptyState role="alert" title="No se pudieron cargar las liquidaciones" description={errorMessage(query.error)} action={{ label: "Reintentar", onClick: () => void query.refetch() }} />
      ) : (query.data ?? []).length === 0 ? (
        <EmptyState title="No hay liquidaciones en este período" />
      ) : (
        <div className="space-y-3">
          {(query.data ?? []).map((run) => (
            <div key={run.id} className="rounded-lg border p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-sm font-semibold">
                    Liquidación #{run.id} ·{" "}
                    {run.available ? (
                      formatCOP(run.total_amount)
                    ) : (
                      <span className="text-muted-foreground">Sin datos{run.reason ? `: ${run.reason}` : ""}</span>
                    )}
                  </p>
                  <p className="text-xs text-muted-foreground">{formatBusinessDate(run.date_from)} – {formatBusinessDate(run.date_to)}</p>
                </div>
                <Button type="button" variant="outline" size="sm" onClick={() => setExpandedId(expandedId === run.id ? null : run.id)}>
                  {expandedId === run.id ? "Ocultar detalle" : "Ver detalle"}
                </Button>
              </div>
              {expandedId === run.id ? (
                <div className="mt-3 overflow-x-auto">
                  <RunDetail run={run} />
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default RunsTab
