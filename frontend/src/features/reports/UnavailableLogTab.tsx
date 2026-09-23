import { useQuery } from "@tanstack/react-query"
import { useState } from "react"

import { getUnavailableLog, unavailableLogCsvUrl, type UnavailableLogRowOut } from "@/api/reports"
import { Cargando } from "@/components/Cargando"
import { DenseTable, DenseTableBar, TimeAgo, type DenseColumn } from "@/components/admin"
import { CsvExportButton } from "@/components/CsvExportButton"
import { DateRangeFilter } from "@/components/DateRangeFilter"
import { EmptyState } from "@/components/EmptyState"
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
const UNAVAILABLE_COLUMNS: readonly DenseColumn<UnavailableLogRowOut>[] = [
  { key: "product", header: "Producto", kind: "name", cell: (r) => r.name ?? `#${r.product_id}` },
  {
    // Lo corto en la celda, el instante exacto en el `title` (§ 8).
    key: "since",
    header: "Agotado hace",
    kind: "secondary",
    cell: (r) => <TimeAgo iso={r.unavailable_at} />,
    cellTitle: (r) => (r.unavailable_at ? formatInstant(r.unavailable_at) : undefined),
  },
  { key: "who", header: "Quién", cell: (r) => r.by?.name ?? "—" },
  { key: "units", header: "Unidades perdidas est.", kind: "number", cell: (r) => r.estimated_lost_units ?? "—" },
  { key: "sales", header: "Ventas perdidas est.", kind: "number", cell: (r) => formatCOP(r.estimated_lost_sales) },
]

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
        <Cargando texto="Cargando agotados…" />
      ) : query.isError ? (
        <EmptyState
          reason="error"
          title="No se pudo cargar el registro de agotados"
          description={errorMessage(query.error)}
          action={{ label: "Reintentar", onClick: () => void query.refetch() }}
        />
      ) : (query.data ?? []).length === 0 ? (
        <EmptyState
          reason="all-clear"
          title="Sin agotados en este período"
          description="Ningún producto sigue agotado en el rango elegido. Es una noticia buena, no una ausencia de datos."
        />
      ) : (
        <DenseTable
          caption="Productos que siguen agotados, con desde cuándo y la venta perdida estimada."
          columns={UNAVAILABLE_COLUMNS}
          rows={query.data ?? []}
          rowKey={(r) => String(r.product_id)}
          maxBodyHeightPx={460}
          bar={
            <DenseTableBar
              shown={(query.data ?? []).length}
              total={(query.data ?? []).length}
              noun="productos todavía agotados"
              hidden={`del ${from} al ${to}`}
            />
          }
          legend={[
            {
              term: "Estimación, no medición",
              meaning: "las unidades y la venta perdida salen del promedio de los 7 días de negocio anteriores.",
            },
            {
              term: "«—» no es 0",
              meaning: "no hubo ventas previas de ese producto con qué estimar. No es que no se haya perdido nada.",
            },
            {
              term: "Sólo lo que SIGUE agotado",
              meaning: "lo que se agotó y se repuso dentro del rango no aparece: no hay bitácora histórica todavía.",
            },
          ]}
        />
      )}
    </div>
  )
}

export default UnavailableLogTab
