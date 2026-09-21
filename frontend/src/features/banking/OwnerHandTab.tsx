/**
 * Admin → Banco → Mano del dueño (T1, `GET /admin/bank/owner-hand`): lo
 * retirado y todavía no consignado ni gastado. Los cuatro números
 * (`withdrawn`, `deposited`, `spent`, `balance`) llegan calculados del
 * servidor — esta pantalla los pinta tal cual, nunca resta uno de otro
 * (checklist de la fase: "la mano del dueño cuadra: retirado − consignado −
 * gastado", verificado por el backend y el auditor, no acá).
 */
import { useQuery } from "@tanstack/react-query"
import { useState } from "react"

import { getOwnerHand } from "@/api/banking"
import { GroupLabel, HeadlineFigure } from "@/components/admin"
import { DateRangeFilter } from "@/components/DateRangeFilter"
import { EmptyState } from "@/components/EmptyState"
import { StatTile } from "@/components/StatTile"
import { errorMessage } from "@/lib/errors"
import { formatCOP } from "@/lib/money"

import { daysAgoLocal, todayLocal } from "./lib"

export function OwnerHandTab({ storeId }: { storeId: number }): React.JSX.Element {
  const [from, setFrom] = useState(daysAgoLocal(30))
  const [to, setTo] = useState(todayLocal())

  const query = useQuery({
    queryKey: ["banking", "owner-hand", storeId, from, to],
    queryFn: () => getOwnerHand({ storeId, from, to }),
  })

  return (
    <div className="space-y-4">
      <DateRangeFilter idPrefix="owner-hand" from={from} to={to} onChange={(r) => { setFrom(r.from); setTo(r.to) }} />

      {query.isLoading ? (
        <p className="text-sm text-muted-foreground">Calculando la mano del dueño…</p>
      ) : query.isError ? (
        <EmptyState reason="error" title="No se pudo calcular la mano del dueño" description={errorMessage(query.error)} action={{ label: "Reintentar", onClick: () => void query.refetch() }} />
      ) : query.data?.reason ? (
        <EmptyState reason="dependency" title="Mano del dueño no disponible" description={query.data.reason} />
      ) : (
        <div className="space-y-4">
          {/* § 4 · «Saldo en mano» es una resta, no un dato suelto: lo que se
              retiró menos lo que volvió al banco menos lo que se gastó. Los
              cuatro números llegan calculados del servidor — acá no se resta
              nada (AGENTS.md § "una sola matemática, en el backend"). */}
          <HeadlineFigure
            label="Saldo en mano"
            value={formatCOP(query.data?.balance ?? null)}
            note={`Lo que salió del cajón entre el ${from} y el ${to} y todavía no volvió al banco ni se gastó.`}
            ledger={{
              rows: [
                { label: "Retirado", value: formatCOP(query.data?.withdrawn ?? null) },
                { label: "Consignado", value: formatCOP(query.data?.deposited ?? null), kind: "subtract" },
                { label: "Gastado", value: formatCOP(query.data?.spent ?? null), kind: "subtract" },
              ],
              total: { label: "Saldo en mano", value: formatCOP(query.data?.balance ?? null) },
            }}
          />
          {query.data?.withdrawn_from_pickups !== undefined || query.data?.spent_on_tips !== undefined ? (
            <GroupLabel label="De dónde sale y en qué se fue" says="el desglose que el servidor manda cuando lo tiene">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <StatTile
                  label="Retirado por relevo"
                  value={formatCOP(query.data?.withdrawn_from_pickups ?? null)}
                  hint="Sacado del cajón durante el turno."
                />
                <StatTile
                  label="Retirado al cerrar turno"
                  value={formatCOP(query.data?.withdrawn_from_shift_close ?? null)}
                  hint="Lo que quedó a consignar y se llevó."
                />
                <StatTile
                  label="Gastado en propinas"
                  value={formatCOP(query.data?.spent_on_tips ?? null)}
                  hint="Repartos pagados de la plata en mano."
                />
                <StatTile
                  label="Gastado en devoluciones"
                  value={formatCOP(query.data?.spent_on_refunds ?? null)}
                  hint="Notas saldadas sin pasar por el cajón."
                />
              </div>
            </GroupLabel>
          ) : null}
        </div>
      )}
    </div>
  )
}

export default OwnerHandTab
