/**
 * Admin → Banco → Consignaciones (T1, `GET`/`POST /admin/deposits`). Lista
 * las consignaciones del período, con su comprobante, y ofrece registrar una
 * nueva sin turno preseleccionado (para cuando una consignación cubre varios
 * turnos a la vez).
 */
import { useQuery } from "@tanstack/react-query"
import { useState } from "react"

import { getDeposits, type DepositOut } from "@/api/banking"
import { Cargando } from "@/components/Cargando"
import { DenseTable, DenseTableBar, TimeAgo, type DenseColumn } from "@/components/admin"
import { DateRangeFilter } from "@/components/DateRangeFilter"
import { EmptyState } from "@/components/EmptyState"
import { Badge } from "@/components/ui/badge"
import { formatBusinessDate, formatInstant } from "@/lib/businessDate"
import { errorMessage } from "@/lib/errors"
import { formatCOP } from "@/lib/money"

/**
 * Cinco a la vista (mapa de pantallas, regla 3): cuándo, cuánto, contra qué
 * turnos, si tiene comprobante y si se reversó. Banco, referencia, quién la
 * registró y hace cuánto quedan detrás de «Más columnas».
 */
const DEPOSIT_COLUMNS: readonly DenseColumn<DepositOut>[] = [
  { key: "date", header: "Fecha", kind: "name", cell: (d) => formatBusinessDate(d.business_date) },
  { key: "amount", header: "Monto", kind: "number", cell: (d) => formatCOP(d.amount ?? null) },
  {
    // Lo largo va al `title`: la fila no crece (§ 8).
    key: "shifts",
    header: "Turnos imputados",
    kind: "secondary",
    cell: (d) =>
      d.allocations && d.allocations.length > 0
        ? d.allocations.map((a) => `#${a.shift_id} (${formatCOP(a.amount)})`).join(", ")
        : "Mano del dueño",
    cellTitle: (d) =>
      d.allocations && d.allocations.length > 0
        ? undefined
        : "Sin imputar a ningún turno: esta consignación entra como «la mano del dueño».",
  },
  { key: "bank", header: "Banco", secondary: true, cell: (d) => d.bank_name ?? "—" },
  { key: "reference", header: "Referencia", kind: "secondary", secondary: true, cell: (d) => d.bank_reference ?? "—" },
  {
    key: "receipt",
    header: "Comprobante",
    cell: (d) => (d.receipt_photo ? <Badge variant="secondary">Con foto</Badge> : <Badge variant="outline">Sin foto</Badge>),
  },
  { key: "who", header: "Registrada por", secondary: true, cell: (d) => d.employee_name ?? "—" },
  {
    key: "when",
    header: "Hace",
    kind: "secondary",
    secondary: true,
    cell: (d) => <TimeAgo iso={d.deposited_at} />,
    cellTitle: (d) => (d.deposited_at ? formatInstant(d.deposited_at) : undefined),
  },
  {
    key: "status",
    header: "Estado",
    cell: (d) => (d.status === "reversed" ? <Badge variant="destructive">Reversada</Badge> : <span className="text-muted-foreground">—</span>),
  },
]

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
        <Cargando texto="Cargando consignaciones…" />
      ) : query.isError ? (
        <EmptyState reason="error" title="No se pudieron cargar las consignaciones" description={errorMessage(query.error)} action={{ label: "Reintentar", onClick: () => void query.refetch() }} />
      ) : (query.data ?? []).length === 0 ? (
        <EmptyState
          reason="filter"
          title="No hay consignaciones registradas en este período"
          description={`El filtro puesto es el período: ${from} a ${to}.`}
        />
      ) : (
        <DenseTable
          caption="Consignaciones del período, con los turnos que imputan y su comprobante."
          columns={DEPOSIT_COLUMNS}
          rows={query.data ?? []}
          rowKey={(d) => String(d.id)}
          rowInactive={(d) => d.status === "reversed"}
          maxBodyHeightPx={460}
          bar={
            <DenseTableBar
              shown={(query.data ?? []).length}
              total={(query.data ?? []).length}
              noun="consignaciones"
              hidden={`del ${from} al ${to}`}
            />
          }
          legend={[
            {
              term: "Mano del dueño",
              meaning: "la consignación no se imputó a ningún turno: entra al saldo que el dueño tiene encima.",
            },
            {
              term: "Sin foto",
              meaning: "quedó registrada, pero sin comprobante del banco adjunto. No es que no exista: es que no se puede mostrar.",
            },
            {
              term: "Reversada",
              meaning: "se anuló. La fila se deja a la vista, apagada, porque la plata sí se movió alguna vez.",
            },
          ]}
        />
      )}
    </div>
  )
}

export default DepositsTab
