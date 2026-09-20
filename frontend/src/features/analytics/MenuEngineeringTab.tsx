/**
 * Admin → Analítica → Ingeniería de menú (T4, `GET /admin/menu-engineering`):
 * clasificación por plato sobre el costo CONGELADO en el ítem — nunca
 * revalorado con la carta de hoy (spec.md § T4). `available`/`reason` mandan
 * cuando no hay ventas del período.
 */
import { useQuery } from "@tanstack/react-query"
import { useState } from "react"

import { getMenuEngineering } from "@/api/analytics"
import { DateRangeFilter } from "@/components/DateRangeFilter"
import { EmptyState } from "@/components/EmptyState"
import { Badge } from "@/components/ui/badge"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { errorMessage } from "@/lib/errors"
import { formatCOP } from "@/lib/money"

import { formatBasisPoints } from "@/features/inventory/lib"

import { daysAgoLocal, menuEngineeringLabel, menuEngineeringTone, todayLocal } from "./lib"

const TONE_BADGE: Record<"default" | "warning" | "critical", "secondary" | "outline" | "destructive"> = {
  default: "secondary",
  warning: "outline",
  critical: "destructive",
}

export function MenuEngineeringTab({ storeId }: { storeId: number }): React.JSX.Element {
  const [from, setFrom] = useState(daysAgoLocal(30))
  const [to, setTo] = useState(todayLocal())

  const query = useQuery({
    queryKey: ["analytics", "menu-engineering", storeId, from, to],
    queryFn: () => getMenuEngineering({ storeId, from, to }),
  })

  const rows = query.data?.rows ?? []

  return (
    <div className="space-y-4">
      <DateRangeFilter idPrefix="menu-engineering" from={from} to={to} onChange={(r) => { setFrom(r.from); setTo(r.to) }} />

      {query.isLoading ? (
        <p className="text-sm text-muted-foreground">Clasificando la carta…</p>
      ) : query.isError ? (
        <EmptyState role="alert" title="No se pudo calcular la ingeniería de menú" description={errorMessage(query.error)} action={{ label: "Reintentar", onClick: () => void query.refetch() }} />
      ) : !query.data?.available ? (
        <EmptyState title="Ingeniería de menú no disponible" description={query.data?.reason ?? "No hay ventas con costo congelado en este período."} />
      ) : rows.length === 0 ? (
        <EmptyState title="No hay platos para clasificar en este período" />
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Plato</TableHead>
                <TableHead>Clasificación</TableHead>
                <TableHead>Unidades vendidas</TableHead>
                <TableHead>Margen de contribución</TableHead>
                <TableHead>Popularidad</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.product_id}>
                  <TableCell>{row.product_name ?? `#${row.product_id}`}</TableCell>
                  <TableCell>
                    <Badge variant={TONE_BADGE[menuEngineeringTone(row.classification)]}>{menuEngineeringLabel(row.classification)}</Badge>
                    {row.classification_reason ? (
                      <p className="mt-0.5 text-xs text-muted-foreground">{row.classification_reason}</p>
                    ) : null}
                  </TableCell>
                  <TableCell className="tabular-nums">{row.qty_sold ?? "—"}</TableCell>
                  <TableCell className="tabular-nums">{formatCOP(row.contribution_margin ?? null)}</TableCell>
                  <TableCell className="tabular-nums">{formatBasisPoints(row.popularity_share_bp ?? null)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}

export default MenuEngineeringTab
