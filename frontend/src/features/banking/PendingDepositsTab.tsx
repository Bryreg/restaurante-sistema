/**
 * Admin → Banco → Por consignar (T1, `GET /admin/deposits/pending`): el
 * saldo por consignar por turno cerrado. `to_deposit` se LEE de
 * `Shift.to_deposit` (snapshot de cierre) — esta pantalla nunca lo
 * recalcula, y cuando llega `null` (turno cerrado sin conteo) se pinta como
 * "sin datos" con su motivo, nunca `$0` (AGENTS.md § "una sola matemática" y
 * "`null` no es `0`", error nº7 del proyecto).
 */
import { useQuery } from "@tanstack/react-query"
import { useState } from "react"

import { getPendingDeposits } from "@/api/banking"
import { DateRangeFilter } from "@/components/DateRangeFilter"
import { EmptyState } from "@/components/EmptyState"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { formatBusinessDate } from "@/lib/businessDate"
import { errorMessage } from "@/lib/errors"
import { formatCOP } from "@/lib/money"

import { CreateDepositDialog } from "./CreateDepositDialog"
import { daysAgoLocal, todayLocal } from "./lib"

export function PendingDepositsTab({ storeId }: { storeId: number }): React.JSX.Element {
  const [from, setFrom] = useState(daysAgoLocal(30))
  const [to, setTo] = useState(todayLocal())

  const query = useQuery({
    queryKey: ["banking", "deposits-pending", storeId, from, to],
    queryFn: () => getPendingDeposits({ storeId, from, to }),
  })

  return (
    <div className="space-y-4">
      <DateRangeFilter idPrefix="deposits-pending" from={from} to={to} onChange={(r) => { setFrom(r.from); setTo(r.to) }} />

      {query.isLoading ? (
        <p className="text-sm text-muted-foreground">Cargando saldo por consignar…</p>
      ) : query.isError ? (
        <EmptyState role="alert" title="No se pudo cargar el saldo por consignar" description={errorMessage(query.error)} action={{ label: "Reintentar", onClick: () => void query.refetch() }} />
      ) : (query.data ?? []).length === 0 ? (
        <EmptyState title="No hay turnos cerrados en este período" />
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Turno</TableHead>
                <TableHead>Fecha</TableHead>
                <TableHead>Por consignar</TableHead>
                <TableHead>Consignado</TableHead>
                <TableHead>Saldo</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {(query.data ?? []).map((row) => (
                <TableRow key={row.shift_id}>
                  <TableCell>#{row.shift_id}</TableCell>
                  <TableCell>{formatBusinessDate(row.business_date)}</TableCell>
                  <TableCell className="tabular-nums">
                    {row.to_deposit === null ? (
                      <span className="text-muted-foreground">
                        Sin datos{row.reason ? <span className="block text-xs">{row.reason}</span> : null}
                      </span>
                    ) : (
                      formatCOP(row.to_deposit)
                    )}
                  </TableCell>
                  <TableCell className="tabular-nums">{formatCOP(row.deposited ?? null)}</TableCell>
                  <TableCell className="tabular-nums font-medium">{formatCOP(row.outstanding ?? null)}</TableCell>
                  <TableCell>
                    {row.outstanding !== null && row.outstanding !== undefined && row.outstanding > 0 ? (
                      <CreateDepositDialog
                        storeId={storeId}
                        triggerLabel="Consignar"
                        triggerVariant="outline"
                        initialShiftIds={[row.shift_id]}
                      />
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}

export default PendingDepositsTab
