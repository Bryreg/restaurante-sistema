import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { Link } from "react-router-dom"

import { countsCsvUrl, listCounts, type CountScope } from "@/api/inventory"
import { CsvExportButton } from "@/components/CsvExportButton"
import { DateRangeFilter } from "@/components/DateRangeFilter"
import { EmptyState } from "@/components/EmptyState"
import { Badge } from "@/components/ui/badge"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { formatInstant } from "@/lib/businessDate"
import { errorMessage } from "@/lib/errors"

import { daysAgoLocal, todayLocal } from "./lib"
import { OpenCountDialog } from "./OpenCountDialog"

const SCOPE_LABEL: Record<CountScope, string> = { key_items: "Críticos", full: "Completo" }

/**
 * Admin → Inventario → Conteos (SPEC-NEGOCIO §5.4 / §9.3). Cada fila lleva a
 * `CountCapturePage.tsx` (`/admin/inventario/conteos/{id}`) — la captura a
 * ciegas vive ahí, nunca acá; este listado sólo abre conteos nuevos y
 * navega a los existentes.
 */
export function CountsTab({ storeId }: { storeId: number }): React.JSX.Element {
  const [scope, setScope] = useState<CountScope | "all">("all")
  const [from, setFrom] = useState(daysAgoLocal(90))
  const [to, setTo] = useState(todayLocal())
  const queryClient = useQueryClient()

  const query = useQuery({
    queryKey: ["inventory", "counts", storeId, scope, from, to],
    queryFn: () => listCounts({ storeId, scope: scope === "all" ? undefined : scope, from, to }),
  })

  const counts = query.data ?? []

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <DateRangeFilter idPrefix="counts" from={from} to={to} onChange={(r) => { setFrom(r.from); setTo(r.to) }} />
          <div className="space-y-1">
            <Label htmlFor="counts-scope">Alcance</Label>
            <Select value={scope} onValueChange={(v) => setScope(v as CountScope | "all")}>
              <SelectTrigger id="counts-scope" className="h-10 w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos</SelectItem>
                <SelectItem value="key_items">Críticos</SelectItem>
                <SelectItem value="full">Completo</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <CsvExportButton href={countsCsvUrl({ storeId, scope: scope === "all" ? undefined : scope, from, to })} />
          <OpenCountDialog
            storeId={storeId}
            onOpened={() => void queryClient.invalidateQueries({ queryKey: ["inventory", "counts", storeId] })}
          />
        </div>
      </div>

      {query.isLoading ? (
        <p className="text-sm text-muted-foreground">Cargando conteos…</p>
      ) : query.isError ? (
        <EmptyState
          role="alert"
          title="No se pudieron cargar los conteos"
          description={errorMessage(query.error)}
          action={{ label: "Reintentar", onClick: () => void query.refetch() }}
        />
      ) : counts.length === 0 ? (
        <EmptyState title="Sin conteos en este período" description="Abrí uno con el botón «Abrir conteo»." />
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>#</TableHead>
                <TableHead>Alcance</TableHead>
                <TableHead>Estado</TableHead>
                <TableHead>Abierto el</TableHead>
                <TableHead>Por</TableHead>
                <TableHead>Renglones</TableHead>
                <TableHead>Aplicado el</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {counts.map((count) => (
                <TableRow key={count.id}>
                  <TableCell>
                    <Link
                      to={`/admin/inventario/conteos/${count.id}`}
                      className="font-medium text-primary underline underline-offset-2"
                    >
                      #{count.id}
                    </Link>
                  </TableCell>
                  <TableCell>{SCOPE_LABEL[count.scope]}</TableCell>
                  <TableCell>
                    <Badge variant={count.status === "applied" ? "secondary" : "outline"}>
                      {count.status === "applied" ? "Aplicado" : "Abierto"}
                    </Badge>
                  </TableCell>
                  <TableCell className="whitespace-nowrap">{formatInstant(count.opened_at)}</TableCell>
                  <TableCell>{count.opened_by_employee_name}</TableCell>
                  <TableCell className="tabular-nums">
                    {count.lines_counted} / {count.lines_total}
                    {count.lines_counted < count.lines_total ? (
                      <span className="ml-1 text-xs text-muted-foreground">(parcial)</span>
                    ) : null}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    {count.applied_at ? `${formatInstant(count.applied_at)} — ${count.applied_by_employee_name}` : "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}

export default CountsTab
