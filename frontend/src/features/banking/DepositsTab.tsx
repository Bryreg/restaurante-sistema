/**
 * Admin → Banco → Consignaciones (T1, `GET`/`POST /admin/deposits`). Lista
 * las consignaciones del período, con su comprobante, y ofrece registrar una
 * nueva sin turno preseleccionado (para cuando una consignación cubre varios
 * turnos a la vez).
 */
import { useQuery } from "@tanstack/react-query"
import { useState } from "react"

import { getDeposits } from "@/api/banking"
import { DateRangeFilter } from "@/components/DateRangeFilter"
import { EmptyState } from "@/components/EmptyState"
import { Badge } from "@/components/ui/badge"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { formatBusinessDate, formatInstant } from "@/lib/businessDate"
import { errorMessage } from "@/lib/errors"
import { formatCOP } from "@/lib/money"

import { CreateDepositDialog } from "./CreateDepositDialog"
import { daysAgoLocal, todayLocal } from "./lib"

export function DepositsTab({ storeId }: { storeId: number }): React.JSX.Element {
  const [from, setFrom] = useState(daysAgoLocal(30))
  const [to, setTo] = useState(todayLocal())

  const query = useQuery({
    queryKey: ["banking", "deposits", storeId, from, to],
    queryFn: () => getDeposits({ storeId, from, to }),
  })

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <DateRangeFilter idPrefix="deposits" from={from} to={to} onChange={(r) => { setFrom(r.from); setTo(r.to) }} />
        <CreateDepositDialog storeId={storeId} />
      </div>

      {query.isLoading ? (
        <p className="text-sm text-muted-foreground">Cargando consignaciones…</p>
      ) : query.isError ? (
        <EmptyState role="alert" title="No se pudieron cargar las consignaciones" description={errorMessage(query.error)} action={{ label: "Reintentar", onClick: () => void query.refetch() }} />
      ) : (query.data ?? []).length === 0 ? (
        <EmptyState title="No hay consignaciones registradas en este período" />
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Fecha</TableHead>
                <TableHead>Monto</TableHead>
                <TableHead>Turnos</TableHead>
                <TableHead>Banco / referencia</TableHead>
                <TableHead>Comprobante</TableHead>
                <TableHead>Registrada por</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(query.data ?? []).map((deposit) => (
                <TableRow key={deposit.id} className={deposit.status === "reversed" ? "opacity-60" : undefined}>
                  <TableCell>{formatBusinessDate(deposit.business_date)}</TableCell>
                  <TableCell className="tabular-nums font-medium">{formatCOP(deposit.amount ?? null)}</TableCell>
                  <TableCell>
                    {deposit.allocations && deposit.allocations.length > 0
                      ? deposit.allocations.map((a) => `#${a.shift_id} (${formatCOP(a.amount)})`).join(", ")
                      : "—"}
                  </TableCell>
                  <TableCell>
                    {deposit.bank_name ?? "—"}
                    {deposit.bank_reference ? <span className="block text-xs text-muted-foreground">{deposit.bank_reference}</span> : null}
                  </TableCell>
                  <TableCell>{deposit.receipt_photo ? <Badge variant="secondary">Con foto</Badge> : <Badge variant="outline">Sin foto</Badge>}</TableCell>
                  <TableCell>
                    {deposit.employee_name ?? "—"}
                    {deposit.deposited_at ? <span className="block text-xs text-muted-foreground">{formatInstant(deposit.deposited_at)}</span> : null}
                    {deposit.status === "reversed" ? <Badge variant="destructive" className="mt-1">Reversada</Badge> : null}
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

export default DepositsTab
