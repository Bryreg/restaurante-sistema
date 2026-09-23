/**
 * Admin → Nómina y propinas → Horas (T3, `GET /admin/payroll/hours`):
 * jornada por persona del período — ordinarias, nocturnas, dominicales,
 * festivas y extras. Las horas viajan como texto ya formateado por el
 * servidor (mismo criterio que `qty_base`): esta pantalla nunca las suma, ni
 * las multiplica por un recargo — ésa es la liquidación (`RunsTab`), no acá.
 */
import { useQuery } from "@tanstack/react-query"
import { useState } from "react"

import { getPayrollHours, type PayrollHoursRowOut } from "@/api/payroll"
import { Cargando } from "@/components/Cargando"
import { DenseTable, DenseTableBar, type DenseColumn } from "@/components/admin"
import { DateRangeFilter } from "@/components/DateRangeFilter"
import { EmptyState } from "@/components/EmptyState"
import { errorMessage } from "@/lib/errors"

const HOURS_COLUMNS: readonly DenseColumn<PayrollHoursRowOut>[] = [
  { key: "person", header: "Persona", kind: "name", cell: (r) => r.employee_name ?? `#${r.employee_id}` },
  { key: "ordinary", header: "Ordinarias", kind: "number", cell: (r) => r.ordinary_hours ?? "—" },
  { key: "night", header: "Nocturnas", kind: "number", cell: (r) => r.night_hours ?? "—" },
  { key: "sunday", header: "Dominicales", kind: "number", cell: (r) => r.sunday_hours ?? "—" },
  { key: "holiday", header: "Festivas", kind: "number", cell: (r) => r.holiday_hours ?? "—" },
  { key: "overtime", header: "Horas extra", kind: "number", cell: (r) => r.overtime_hours ?? "—" },
]

import { daysAgoLocal, todayLocal } from "./lib"

export function HoursTab({ storeId }: { storeId: number }): React.JSX.Element {
  const [from, setFrom] = useState(daysAgoLocal(15))
  const [to, setTo] = useState(todayLocal())

  const query = useQuery({
    queryKey: ["payroll", "hours", storeId, from, to],
    queryFn: () => getPayrollHours({ storeId, from, to }),
  })

  const rows = query.data?.rows ?? []

  return (
    <div className="space-y-4">
      <DateRangeFilter idPrefix="payroll-hours" from={from} to={to} onChange={(r) => { setFrom(r.from); setTo(r.to) }} />

      {query.isLoading ? (
        <Cargando texto="Cargando la jornada del período…" />
      ) : query.isError ? (
        <EmptyState reason="error" title="No se pudo cargar la jornada" description={errorMessage(query.error)} action={{ label: "Reintentar", onClick: () => void query.refetch() }} />
      ) : !query.data?.available ? (
        <EmptyState reason="dependency" title="Jornada no disponible" description={query.data?.reason ?? "Faltan datos del período para calcularla."} />
      ) : rows.length === 0 ? (
        <EmptyState
          reason="dependency"
          title="No hay jornada registrada en este período"
          description="Las horas salen del roster del turno: si nadie marcó entrada y salida, no hay jornada que mostrar."
          action={{ label: "Ver los turnos en Dinero", to: "/admin/dinero" }}
        />
      ) : (
        <DenseTable
          caption="Jornada por persona en el período, separada por tipo de hora."
          columns={HOURS_COLUMNS}
          rows={rows}
          rowKey={(r) => String(r.employee_id)}
          maxBodyHeightPx={460}
          bar={<DenseTableBar shown={rows.length} total={rows.length} noun="personas con jornada" hidden={`del ${from} al ${to}`} />}
          legend={[
            {
              term: "«—» no es 0",
              meaning: "esa persona no registró horas de ese tipo en el período; no es que trabajara cero.",
            },
            {
              term: "Ordinarias ≠ pagadas",
              meaning: "acá se cuentan horas, no plata. Lo que se paga sale de la tarifa y de la tabla de recargos.",
            },
          ]}
        />
      )}
    </div>
  )
}

export default HoursTab
