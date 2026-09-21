import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { Link } from "react-router-dom"

import { countsCsvUrl, listCounts, type CountOut, type CountScope } from "@/api/inventory"
import {
  DenseTable,
  DenseTableBar,
  TimeAgo,
  type DenseColumn,
  type LegendEntry,
  type RowStatus,
} from "@/components/admin"
import { CsvExportButton } from "@/components/CsvExportButton"
import { DateRangeFilter } from "@/components/DateRangeFilter"
import { EmptyState } from "@/components/EmptyState"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { errorMessage } from "@/lib/errors"

import { daysAgoLocal, todayLocal } from "./lib"
import { OpenCountDialog } from "./OpenCountDialog"

const SCOPE_LABEL: Record<CountScope, string> = {
  key_items: "Críticos",
  full: "Completo",
}

const LEGEND: readonly LegendEntry[] = [
  {
    term: "Abierto",
    meaning: "se está capturando. Los renglones se pueden corregir todas las veces que haga falta.",
  },
  {
    term: "Aplicado",
    meaning: (
      <>
        ya movió el stock, y <b>no se deshace</b>: se hace una sola vez y queda el ajuste por conteo en el
        libro de movimientos.
      </>
    ),
  },
  {
    term: "Parcial",
    meaning: (
      <>
        faltan renglones por confirmar. <b>No es cero</b>: es que todavía nadie los contó.
      </>
    ),
  },
]

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
    queryFn: () =>
      listCounts({
        storeId,
        scope: scope === "all" ? undefined : scope,
        from,
        to,
      }),
  })

  const counts = query.data ?? []
  const open = counts.filter((c) => c.status !== "applied").length

  // Un conteo abierto es lo único que pide algo del dueño; el aplicado ya no
  // cambia. Es la distinción del patrón 3 llevada a la franja de la fila.
  function statusOf(count: CountOut): RowStatus {
    return count.status === "applied" ? "none" : "warning"
  }

  const columns: readonly DenseColumn<CountOut>[] = [
    {
      key: "id",
      header: "#",
      kind: "id",
      // `#12` es UNA palabra: nunca `#1` / `2` (patrón 8, la regla dura).
      cell: (c) => (
        <Link to={`/admin/inventario/conteos/${c.id}`} className="text-primary underline underline-offset-2">
          #{c.id}
        </Link>
      ),
    },
    { key: "scope", header: "Alcance", cell: (c) => SCOPE_LABEL[c.scope] },
    {
      key: "status",
      header: "Estado",
      cell: (c) => (
        <span className="inline-flex items-center gap-1.5">
          <span
            className={
              c.status === "applied" ? "size-1.5 rounded-full bg-success" : "size-1.5 rounded-full bg-warning"
            }
            aria-hidden="true"
          />
          {c.status === "applied" ? "Aplicado" : "Abierto"}
        </span>
      ),
    },
    {
      key: "opened",
      header: "Abierto el",
      kind: "secondary",
      cell: (c) => <TimeAgo iso={c.opened_at} />,
    },
    { key: "by", header: "Por", cell: (c) => c.opened_by_employee_name },
    {
      key: "lines",
      header: "Renglones",
      kind: "number",
      cell: (c) => (
        <span>
          {c.lines_counted} / {c.lines_total}
          {c.lines_counted < c.lines_total ? (
            <span className="ml-1 text-xs text-muted-foreground">(parcial)</span>
          ) : null}
        </span>
      ),
    },
    {
      key: "applied",
      header: "Aplicado el",
      kind: "secondary",
      cell: (c) =>
        c.applied_at ? (
          <span>
            <TimeAgo iso={c.applied_at} /> — {c.applied_by_employee_name}
          </span>
        ) : (
          "—"
        ),
    },
  ]

  if (query.isError) {
    return (
      <EmptyState
        role="alert"
        title="No se pudieron cargar los conteos"
        description={errorMessage(query.error)}
        action={{ label: "Reintentar", onClick: () => void query.refetch() }}
      />
    )
  }

  // Los filtros son **armazón**, no datos: cargando se conservan (patrón
  // 13, «cargando conserva el armazón y esqueletea sólo los datos»). Si
  // desaparecieran mientras llega la respuesta, lo que la persona acaba de
  // elegir parpadearía en cada consulta.
  const filters = (
    <>
      <DateRangeFilter
        idPrefix="counts"
        from={from}
        to={to}
        onChange={(r) => {
          setFrom(r.from)
          setTo(r.to)
        }}
      />
      <div className="flex items-center gap-2">
        <Label htmlFor="counts-scope">Alcance</Label>
        <Select value={scope} onValueChange={(v) => setScope(v as CountScope | "all")}>
          <SelectTrigger id="counts-scope" className="h-8 w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos</SelectItem>
            <SelectItem value="key_items">Críticos</SelectItem>
            <SelectItem value="full">Completo</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <CsvExportButton
        href={countsCsvUrl({
          storeId,
          scope: scope === "all" ? undefined : scope,
          from,
          to,
        })}
      />
      <OpenCountDialog
        storeId={storeId}
        onOpened={() =>
          void queryClient.invalidateQueries({
            queryKey: ["inventory", "counts", storeId],
          })
        }
      />
    </>
  )

  return (
    <div className="space-y-3">
      <DenseTable
        caption="Conteos de inventario"
        columns={columns}
        rows={counts}
        rowKey={(c) => String(c.id)}
        rowStatus={statusOf}
        legend={LEGEND}
        bar={
          <DenseTableBar
            shown={counts.length}
            total={counts.length}
            noun="conteos en el período"
            hidden={query.isLoading ? "contando…" : open > 0 ? `${open} todavía abiertos` : undefined}
          >
            {filters}
          </DenseTableBar>
        }
        note={
          <>
            El conteo se captura <b>a ciegas</b>: la pantalla de captura no muestra el stock del sistema, para
            que lo contado no se parezca a lo esperado. <b>Aplicarlo no se deshace</b> y pide PIN de
            administrador.
          </>
        }
        empty={
          query.isLoading ? undefined : (
            <EmptyState
              title="Sin conteos en este período"
              description="Abrí uno con «Abrir conteo», o ampliá el rango de fechas si el último quedó más atrás."
            />
          )
        }
      />
    </div>
  )
}

export default CountsTab
