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

import { getBankLedger, type BankLedgerEntryOut } from "@/api/banking"
import { Cargando } from "@/components/Cargando"
import { DenseTable, DenseTableBar, HeadlineFigure, type DenseColumn } from "@/components/admin"
import { DateRangeFilter } from "@/components/DateRangeFilter"
import { EmptyState } from "@/components/EmptyState"
import { formatBusinessDate } from "@/lib/businessDate"
import { errorMessage } from "@/lib/errors"
import { formatCOP } from "@/lib/money"

import { daysAgoLocal, ledgerKindLabel, todayLocal } from "./lib"

const LEDGER_COLUMNS: readonly DenseColumn<BankLedgerEntryOut>[] = [
  { key: "date", header: "Fecha", kind: "name", cell: (e) => formatBusinessDate(e.business_date) },
  // La celda escribe la palabra del negocio, no el enum (§ 8c).
  { key: "kind", header: "Tipo", cell: (e) => ledgerKindLabel(e.kind) },
  { key: "amount", header: "Monto", kind: "number", cell: (e) => formatCOP(e.amount ?? null) },
  {
    key: "detail",
    header: "Detalle",
    kind: "secondary",
    cell: (e) => e.reference ?? e.note ?? "—",
    cellTitle: (e) => e.note ?? undefined,
  },
]

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
        <Cargando texto="Cargando el libro del banco…" />
      ) : query.isError ? (
        <EmptyState reason="error" title="No se pudo cargar el libro del banco" description={errorMessage(query.error)} action={{ label: "Reintentar", onClick: () => void query.refetch() }} />
      ) : entries.length === 0 ? (
        <EmptyState
          reason="filter"
          title="No hay movimientos de banco en este período"
          description={`El filtro puesto es el período: ${from} a ${to}.`}
        />
      ) : (
        <div className="space-y-4">
          {/* § 4 · El total del período no es un número suelto: es la suma
              de sus tres orígenes, dibujada como libro. */}
          {totals ? (
            <HeadlineFigure
              label="Total del período"
              value={formatCOP(totals.total)}
              note={`${entries.length} ${entries.length === 1 ? "movimiento" : "movimientos"} entre el ${from} y el ${to}.`}
              ledger={{
                rows: [
                  { label: "Consignaciones", value: formatCOP(totals.deposits) },
                  { label: "Liquidaciones de datáfono (neto)", value: formatCOP(totals.card_settlements_net) },
                  { label: "Transferencias", value: formatCOP(totals.transfers) },
                ],
                total: { label: "Total del período", value: formatCOP(totals.total) },
              }}
            />
          ) : null}
          <DenseTable
            caption="Movimientos de banco del período: consignaciones, liquidaciones y transferencias."
            columns={LEDGER_COLUMNS}
            rows={entries}
            // El `id` es de la tabla de origen: una consignación #3 y un abono de datáfono #3 conviven.
            rowKey={(entry) => `${entry.kind}-${entry.id ?? `${entry.business_date}-${entry.amount}`}`}
            maxBodyHeightPx={460}
            bar={<DenseTableBar shown={entries.length} total={entries.length} noun="movimientos de banco" hidden={`del ${from} al ${to}`} />}
            legend={[
              {
                term: "Liquidación neta",
                meaning: "lo que el datáfono abonó después de su comisión y sus retenciones. El bruto no llega nunca al banco.",
              },
              {
                term: "Este libro no es el extracto",
                meaning: "es lo que el sistema tiene registrado. Si el banco dice otra cosa, lo que falta es registrar el dato.",
              },
            ]}
          />
        </div>
      )}
    </div>
  )
}

export default LedgerTab
