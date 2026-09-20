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
        <EmptyState role="alert" title="No se pudo calcular la mano del dueño" description={errorMessage(query.error)} action={{ label: "Reintentar", onClick: () => void query.refetch() }} />
      ) : query.data?.reason ? (
        <EmptyState title="Mano del dueño no disponible" description={query.data.reason} />
      ) : (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatTile label="Retirado" value={formatCOP(query.data?.withdrawn ?? null)} />
            <StatTile label="Consignado" value={formatCOP(query.data?.deposited ?? null)} />
            <StatTile label="Gastado" value={formatCOP(query.data?.spent ?? null)} />
            <StatTile label="Saldo en mano" value={formatCOP(query.data?.balance ?? null)} tone="warning" />
          </div>
          {query.data?.withdrawn_from_pickups !== undefined || query.data?.spent_on_tips !== undefined ? (
            <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
              <StatTile label="Retirado por relevo" value={formatCOP(query.data?.withdrawn_from_pickups ?? null)} />
              <StatTile label="Retirado al cerrar turno" value={formatCOP(query.data?.withdrawn_from_shift_close ?? null)} />
              <StatTile label="Gastado en propinas" value={formatCOP(query.data?.spent_on_tips ?? null)} />
              <StatTile label="Gastado en devoluciones" value={formatCOP(query.data?.spent_on_refunds ?? null)} />
            </div>
          ) : null}
        </div>
      )}
    </div>
  )
}

export default OwnerHandTab
