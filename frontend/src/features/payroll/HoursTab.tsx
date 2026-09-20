/**
 * Admin → Nómina y propinas → Horas (T3, `GET /admin/payroll/hours`):
 * jornada por persona del período — ordinarias, nocturnas, dominicales,
 * festivas y extras. Las horas viajan como texto ya formateado por el
 * servidor (mismo criterio que `qty_base`): esta pantalla nunca las suma, ni
 * las multiplica por un recargo — ésa es la liquidación (`RunsTab`), no acá.
 */
import { useQuery } from "@tanstack/react-query"
import { useState } from "react"

import { getPayrollHours } from "@/api/payroll"
import { DateRangeFilter } from "@/components/DateRangeFilter"
import { EmptyState } from "@/components/EmptyState"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { errorMessage } from "@/lib/errors"

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
        <p className="text-sm text-muted-foreground">Cargando la jornada del período…</p>
      ) : query.isError ? (
        <EmptyState role="alert" title="No se pudo cargar la jornada" description={errorMessage(query.error)} action={{ label: "Reintentar", onClick: () => void query.refetch() }} />
      ) : !query.data?.available ? (
        <EmptyState title="Jornada no disponible" description={query.data?.reason ?? "Faltan datos del período para calcularla."} />
      ) : rows.length === 0 ? (
        <EmptyState title="No hay jornada registrada en este período" />
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Persona</TableHead>
                <TableHead>Ordinarias</TableHead>
                <TableHead>Nocturnas</TableHead>
                <TableHead>Dominicales</TableHead>
                <TableHead>Festivas</TableHead>
                <TableHead>Horas extra</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.employee_id}>
                  <TableCell>{row.employee_name ?? `#${row.employee_id}`}</TableCell>
                  <TableCell className="tabular-nums">{row.ordinary_hours ?? "—"}</TableCell>
                  <TableCell className="tabular-nums">{row.night_hours ?? "—"}</TableCell>
                  <TableCell className="tabular-nums">{row.sunday_hours ?? "—"}</TableCell>
                  <TableCell className="tabular-nums">{row.holiday_hours ?? "—"}</TableCell>
                  <TableCell className="tabular-nums">{row.overtime_hours ?? "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}

export default HoursTab
