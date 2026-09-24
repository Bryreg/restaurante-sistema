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
import { formatFechaCorta } from "@/lib/format"
import { formatCOP } from "@/lib/money"

import { Explicacion } from "@/components/admin"
import { daysAgoLocal, todayLocal } from "./lib"

/**
 * Cuántos días puede quedarse en la mano la plata de un cierre antes de que
 * la tarjeta pase a ámbar (informe de visualización #15). Tres: lo normal es
 * consignar dos veces por semana, así que ningún cierre debería pasar más
 * de tres días fuera del banco. Más que eso es efectivo expuesto (robo,
 * mezcla con plata personal) y una conciliación que no va a cuadrar con el
 * extracto. Es un umbral de lectura, no una cifra de plata.
 */
export const DIAS_SIN_CONSIGNAR_AVISO = 3

function dias(n: number): string {
  return `${n} ${n === 1 ? "día" : "días"}`
}

/** La antigüedad de la plata más vieja sin consignar, tal como la manda el servidor. */
function PlataMasVieja({ date, days }: { date: string | null | undefined; days: number | null | undefined }): React.JSX.Element {
  if (days === null || days === undefined) {
    // `null` acá NO es «sin dato»: el servidor lo manda cuando no queda
    // plata de cierres por consignar. Es «al día», y así se dice.
    return (
      <StatTile
        label="Plata más vieja sin consignar"
        value="Al día"
        hint="No queda plata de ningún cierre por consignar."
      />
    )
  }
  const tarde = days > DIAS_SIN_CONSIGNAR_AVISO
  return (
    <StatTile
      label="Plata más vieja sin consignar"
      value={days === 0 ? "De hoy" : `Hace ${dias(days)}`}
      tone={tarde ? "warning" : "default"}
      hint={
        `Del cierre del ${formatFechaCorta(date)}. ` +
        (tarde
          ? `Pasa de ${DIAS_SIN_CONSIGNAR_AVISO} días fuera del banco: consignala.`
          : `Hasta ${DIAS_SIN_CONSIGNAR_AVISO} días fuera del banco es lo normal.`)
      }
      link={{ to: "/admin/banco?tab=por-consignar", screen: "Banco", tab: "Por consignar" }}
    />
  )
}

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
            // El libro de abajo ya dice qué es (retirado − consignado −
            // gastado): la nota sólo dice de cuándo.
            note={`Del ${formatFechaCorta(from)} al ${formatFechaCorta(to)}.`}
            ledger={{
              rows: [
                { label: "Retirado", value: formatCOP(query.data?.withdrawn ?? null) },
                { label: "Consignado", value: formatCOP(query.data?.deposited ?? null), kind: "subtract" },
                { label: "Gastado", value: formatCOP(query.data?.spent ?? null), kind: "subtract" },
              ],
              total: { label: "Saldo en mano", value: formatCOP(query.data?.balance ?? null) },
            }}
          />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <PlataMasVieja date={query.data?.oldest_undeposited_date} days={query.data?.oldest_undeposited_days} />
          </div>
          {query.data?.withdrawn_from_pickups !== undefined || query.data?.spent_on_tips !== undefined ? (
            <GroupLabel label="De dónde sale y en qué se fue" says="el desglose que el servidor manda cuando lo tiene">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <StatTile label="Retirado por relevo" value={formatCOP(query.data?.withdrawn_from_pickups ?? null)} />
                <StatTile
                  label="Retirado al cerrar turno"
                  value={formatCOP(query.data?.withdrawn_from_shift_close ?? null)}
                />
                <StatTile label="Gastado en propinas" value={formatCOP(query.data?.spent_on_tips ?? null)} />
                <StatTile label="Gastado en devoluciones" value={formatCOP(query.data?.spent_on_refunds ?? null)} />
              </div>
              {/* Regla 2 · Las pistas de cada tarjeta, plegadas: se leen una
                  vez, no cada vez que se abre la pestaña. */}
              <Explicacion>
                <p>
                  <b>Retirado por relevo</b>: sacado del cajón durante el turno. <b>Retirado al cerrar turno</b>: lo
                  que quedó a consignar y se llevó. <b>Gastado en propinas</b>: repartos pagados de la plata en mano.{" "}
                  <b>Gastado en devoluciones</b>: notas saldadas sin pasar por el cajón.
                </p>
              </Explicacion>
            </GroupLabel>
          ) : null}
        </div>
      )}
    </div>
  )
}

export default OwnerHandTab
