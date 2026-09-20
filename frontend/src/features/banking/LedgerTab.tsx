/**
 * Admin → Banco → Libro del banco (T1, `GET /admin/bank/ledger`):
 * consignaciones, liquidaciones de datáfono y transferencias del período, en
 * una sola línea de tiempo, más los totales que el propio servidor suma
 * (`totals`) — ningún total se calcula acá (AGENTS.md § "una sola
 * matemática, en el backend"). Campos verificados por lectura directa de
 * `app/banking/schemas.py::LedgerEntryOut`/`BankLedgerOut` (`entries`, no
 * `rows`).
 */
import { useQuery } from "@tanstack/react-query"
import { useState } from "react"

import { getBankLedger } from "@/api/banking"
import { DateRangeFilter } from "@/components/DateRangeFilter"
import { EmptyState } from "@/components/EmptyState"
import { StatTile } from "@/components/StatTile"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { formatBusinessDate } from "@/lib/businessDate"
import { errorMessage } from "@/lib/errors"
import { formatCOP } from "@/lib/money"

import { daysAgoLocal, ledgerKindLabel, todayLocal } from "./lib"

export function LedgerTab({ storeId }: { storeId: number }): React.JSX.Element {
  const [from, setFrom] = useState(daysAgoLocal(30))
  const [to, setTo] = useState(todayLocal())

  const query = useQuery({
    queryKey: ["banking", "ledger", storeId, from, to],
    queryFn: () => getBankLedger({ storeId, from, to }),
  })

  const entries = query.data?.entries ?? []
  const totals = query.data?.totals

  return (
    <div className="space-y-4">
      <DateRangeFilter idPrefix="bank-ledger" from={from} to={to} onChange={(r) => { setFrom(r.from); setTo(r.to) }} />

      {query.isLoading ? (
        <p className="text-sm text-muted-foreground">Cargando el libro del banco…</p>
      ) : query.isError ? (
        <EmptyState role="alert" title="No se pudo cargar el libro del banco" description={errorMessage(query.error)} action={{ label: "Reintentar", onClick: () => void query.refetch() }} />
      ) : entries.length === 0 ? (
        <EmptyState title="No hay movimientos de banco en este período" />
      ) : (
        <div className="space-y-3">
          {totals ? (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <StatTile label="Consignaciones" value={formatCOP(totals.deposits)} />
              <StatTile label="Liquidaciones de datáfono (neto)" value={formatCOP(totals.card_settlements_net)} />
              <StatTile label="Transferencias" value={formatCOP(totals.transfers)} />
              <StatTile label="Total del período" value={formatCOP(totals.total)} tone="warning" />
            </div>
          ) : null}
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Fecha</TableHead>
                  <TableHead>Tipo</TableHead>
                  <TableHead>Monto</TableHead>
                  <TableHead>Detalle</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {entries.map((entry, index) => (
                  <TableRow key={entry.id ?? `${entry.kind}-${index}`}>
                    <TableCell>{formatBusinessDate(entry.business_date)}</TableCell>
                    <TableCell>{ledgerKindLabel(entry.kind)}</TableCell>
                    <TableCell className="tabular-nums">{formatCOP(entry.amount ?? null)}</TableCell>
                    <TableCell>{entry.reference ?? entry.note ?? "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}
    </div>
  )
}

export default LedgerTab
