import { useQuery } from "@tanstack/react-query"
import { useState } from "react"

import { adminNoveltiesCsvUrl, listAdminNovelties, type NoveltyStatus } from "@/api/novelties"
import { Cargando } from "@/components/Cargando"
import { CsvExportButton } from "@/components/CsvExportButton"
import { DateRangeFilter } from "@/components/DateRangeFilter"
import { EmptyState } from "@/components/EmptyState"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { daysAgoInBogota, todayInBogota } from "@/features/reports/lib"
import { errorMessage } from "@/lib/errors"

import { NoveltyItem } from "./NoveltyItem"
import { NOVELTIES_QUERY_KEYS } from "./lib"

/**
 * Histórico de novedades de la sede (admin): todas o sólo las abiertas, por
 * rango de días operativos, con CSV. Sólo lectura: se resuelven desde la
 * bandeja de Hoy o desde el POS. Nada se borra.
 */
export function NoveltiesHistory({ storeId }: { storeId: number }): React.JSX.Element {
  const [from, setFrom] = useState(daysAgoInBogota(30))
  const [to, setTo] = useState(todayInBogota())
  const [status, setStatus] = useState<NoveltyStatus>("all")

  const query = useQuery({
    queryKey: NOVELTIES_QUERY_KEYS.adminHistory(storeId, status, from, to),
    queryFn: () => listAdminNovelties({ storeId, status, from, to }),
  })
  const rows = query.data ?? []

  return (
    <section aria-labelledby="historico-novedades" className="space-y-3">
      <h3 id="historico-novedades" className="text-base font-semibold">
        Novedades del turno
      </h3>
      <div className="flex flex-wrap items-end gap-3">
        <DateRangeFilter
          idPrefix="novelties"
          from={from}
          to={to}
          onChange={(r) => {
            setFrom(r.from)
            setTo(r.to)
          }}
        />
        <div className="flex items-center gap-2">
          <Label htmlFor="novelties-status">Estado</Label>
          <Select value={status} onValueChange={(v) => setStatus(v as NoveltyStatus)}>
            <SelectTrigger id="novelties-status" className="h-8 w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todas</SelectItem>
              <SelectItem value="open">Sólo abiertas</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <CsvExportButton href={adminNoveltiesCsvUrl({ storeId, status, from, to })} />
      </div>
      {query.isLoading ? (
        <Cargando />
      ) : query.isError ? (
        <EmptyState
          role="alert"
          title="No se pudieron cargar las novedades"
          description={errorMessage(query.error)}
          action={{ label: "Reintentar", onClick: () => void query.refetch() }}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          title="Sin novedades en este período"
          description="Probá otro rango de fechas. Las novedades se registran desde el POS, en el panel del turno."
        />
      ) : (
        <ul className="space-y-2">
          {rows.map((n) => (
            <NoveltyItem key={n.id} novelty={n} />
          ))}
        </ul>
      )}
    </section>
  )
}
