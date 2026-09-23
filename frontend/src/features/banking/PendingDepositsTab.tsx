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

import { getPendingDeposits, type PendingDepositOut } from "@/api/banking"
import { Cargando } from "@/components/Cargando"
import { DenseTable, DenseTableBar, type RowStatus } from "@/components/admin"
import { DateRangeFilter } from "@/components/DateRangeFilter"
import { EmptyState } from "@/components/EmptyState"
import { SinDato } from "@/components/SinDato"
import { formatBusinessDate } from "@/lib/businessDate"
import { errorMessage } from "@/lib/errors"
import { formatCOP } from "@/lib/money"

/** § 8b · Con saldo pendiente la fila se marca; sin dato, no se marca en rojo. */
function pendingStatus(row: PendingDepositOut): RowStatus {
  if (row.to_deposit === null || row.to_deposit === undefined) return "none"
  return row.outstanding !== null && row.outstanding !== undefined && row.outstanding > 0 ? "warning" : "ok"
}

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
        <Cargando texto="Cargando saldo por consignar…" />
      ) : query.isError ? (
        <EmptyState reason="error" title="No se pudo cargar el saldo por consignar" description={errorMessage(query.error)} action={{ label: "Reintentar", onClick: () => void query.refetch() }} />
      ) : (query.data ?? []).length === 0 ? (
        <EmptyState
          reason="filter"
          title="No hay turnos cerrados en este período"
          description={`El filtro puesto es el período: ${from} a ${to}. Un turno abierto todavía no tiene saldo por consignar.`}
        />
      ) : (
        <DenseTable
          caption="Turnos cerrados del período, con lo que queda por consignar."
          columns={[
            { key: "shift", header: "Turno", kind: "id", cell: (r) => `#${r.shift_id}` },
            { key: "date", header: "Fecha", cell: (r) => formatBusinessDate(r.business_date) },
            {
              // `null` NO es `$ 0`: se dice «Sin datos» con el motivo que da
              // el servidor, al lado y no abajo, para que la fila no crezca.
              key: "to_deposit",
              header: "Por consignar",
              kind: "number",
              cell: (r) =>
                r.to_deposit === null ? (
                  <SinDato motivo={r.reason} />
                ) : (
                  formatCOP(r.to_deposit)
                ),
            },
            { key: "deposited", header: "Consignado", kind: "number", cell: (r) => formatCOP(r.deposited ?? null) },
            { key: "outstanding", header: "Saldo", kind: "number", cell: (r) => formatCOP(r.outstanding ?? null) },
            {
              key: "actions",
              header: "Acciones",
              kind: "actions",
              cell: (r) =>
                r.outstanding !== null && r.outstanding !== undefined && r.outstanding > 0 ? (
                  <CreateDepositDialog
                    storeId={storeId}
                    triggerLabel="Consignar"
                    triggerVariant="outline"
                    initialShiftIds={[r.shift_id]}
                  />
                ) : null,
            },
          ]}
          rows={query.data ?? []}
          rowKey={(r) => String(r.shift_id)}
          rowStatus={pendingStatus}
          maxBodyHeightPx={460}
          bar={
            <DenseTableBar
              shown={(query.data ?? []).length}
              total={(query.data ?? []).length}
              noun="turnos cerrados"
              hidden={`del ${from} al ${to}`}
            />
          }
          legend={[
            {
              term: "«Sin datos»",
              meaning:
                "no es cero: el turno cerró sin conteo de efectivo, así que no hay de dónde sacar cuánto había para consignar.",
            },
            {
              term: "Saldo",
              meaning: "lo que falta consignar de ese turno. Con saldo en cero no se ofrece «Consignar»: ya está.",
            },
          ]}
        />
      )}
    </div>
  )
}

export default PendingDepositsTab
