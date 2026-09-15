import { useQuery } from "@tanstack/react-query"
import { useState } from "react"

import { getUnavailableLog, unavailableLogCsvUrl } from "@/api/reports"
import { CsvExportButton } from "@/components/CsvExportButton"
import { DateRangeFilter } from "@/components/DateRangeFilter"
import { EmptyState } from "@/components/EmptyState"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { formatInstant } from "@/lib/businessDate"
import { errorMessage } from "@/lib/errors"
import { formatCOP } from "@/lib/money"

import { daysAgoInBogota, todayInBogota } from "./lib"

/**
 * "Agotados del día" (SPEC-NEGOCIO §10): sólo puede listar lo que SIGUE
 * agotado ahora mismo dentro del rango (el backend no guarda una bitácora
 * histórica todavía — ver `estimated_lost_sales` como estimación, nunca una
 * cifra exacta, y `null` cuando no hay ventas previas para estimar).
 */
export function UnavailableLogTab({ storeId }: { storeId: number }): React.JSX.Element {
  const [from, setFrom] = useState(daysAgoInBogota(6))
  const [to, setTo] = useState(todayInBogota())

  const query = useQuery({
    queryKey: ["admin-unavailable-log", storeId, from, to],
    queryFn: () => getUnavailableLog({ storeId, from, to }),
  })

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <DateRangeFilter idPrefix="unavailable" from={from} to={to} onChange={(r) => { setFrom(r.from); setTo(r.to) }} />
        <CsvExportButton href={unavailableLogCsvUrl({ storeId, from, to })} label="Exportar CSV" />
      </div>
      <p className="text-xs text-muted-foreground">
        Sólo productos que SIGUEN agotados ahora. Las ventas perdidas son una estimación sobre el promedio de los 7
        días de negocio anteriores — "—" cuando no hubo ventas previas para estimar.
      </p>

      {query.isLoading ? (
        <p className="text-sm text-muted-foreground">Cargando agotados…</p>
      ) : query.isError ? (
        <EmptyState
          role="alert"
          title="No se pudo cargar el registro de agotados"
          description={errorMessage(query.error)}
          action={{ label: "Reintentar", onClick: () => void query.refetch() }}
        />
      ) : (query.data ?? []).length === 0 ? (
        <EmptyState title="Sin agotados en este período" description="Ningún producto sigue agotado en el rango elegido." />
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Producto</TableHead>
                <TableHead>Agotado desde</TableHead>
                <TableHead>Quién</TableHead>
                <TableHead>Unidades perdidas est.</TableHead>
                <TableHead>Ventas perdidas est.</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(query.data ?? []).map((row) => (
                <TableRow key={row.product_id}>
                  <TableCell>{row.name ?? `#${row.product_id}`}</TableCell>
                  <TableCell>{formatInstant(row.unavailable_at)}</TableCell>
                  <TableCell>{row.by?.name ?? "—"}</TableCell>
                  <TableCell className="tabular-nums">{row.estimated_lost_units ?? "—"}</TableCell>
                  <TableCell className="tabular-nums">{formatCOP(row.estimated_lost_sales)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}

export default UnavailableLogTab
