/**
 * Admin → Analítica → Ingeniería de menú (T4, `GET /admin/menu-engineering`):
 * clasificación por plato sobre el costo CONGELADO en el ítem — nunca
 * revalorado con la carta de hoy (spec.md § T4). `available`/`reason` mandan
 * cuando no hay ventas del período.
 */
import { useQuery } from "@tanstack/react-query"
import { useState } from "react"

import { getMenuEngineering, type MenuEngineeringRowOut } from "@/api/analytics"
import { DenseTable, DenseTableBar, type DenseColumn, type RowStatus } from "@/components/admin"
import { DateRangeFilter } from "@/components/DateRangeFilter"
import { EmptyState } from "@/components/EmptyState"
import { Badge } from "@/components/ui/badge"
import { errorMessage } from "@/lib/errors"
import { formatCOP } from "@/lib/money"

import { formatBasisPoints } from "@/features/inventory/lib"

import { daysAgoLocal, menuEngineeringLabel, menuEngineeringTone, todayLocal } from "./lib"

const TONE_BADGE: Record<"default" | "warning" | "critical", "secondary" | "outline" | "destructive"> = {
  default: "secondary",
  warning: "outline",
  critical: "destructive",
}

/**
 * § 8 · La franja de estado de la primera celda deja ver la forma del
 * problema sin leer: un «Perro» y un «Enigma» se distinguen de un golpe.
 */
function menuRowStatus(row: MenuEngineeringRowOut): RowStatus {
  // «Sin clasificar» NO es verde: no saber no es estar bien, igual que `—` no
  // es `0` (`docs/PATRONES-ADMIN.md` § 5). Sin franja, que es lo honesto.
  if (!row.classification || row.classification === "unclassified") return "none"
  const tone = menuEngineeringTone(row.classification)
  return tone === "critical" ? "critical" : tone === "warning" ? "warning" : "ok"
}

const MENU_COLUMNS: readonly DenseColumn<MenuEngineeringRowOut>[] = [
  { key: "product", header: "Plato", kind: "name", cell: (r) => r.product_name ?? `#${r.product_id}` },
  {
    key: "class",
    header: "Clasificación",
    cell: (r) => (
      <Badge variant={TONE_BADGE[menuEngineeringTone(r.classification)]}>{menuEngineeringLabel(r.classification)}</Badge>
    ),
  },
  {
    // Lo largo va al `title` y lo corto a la celda: la fila NO crece (§ 8).
    key: "why",
    header: "Por qué",
    kind: "secondary",
    cell: (r) => r.classification_reason ?? "—",
    cellTitle: (r) => r.classification_reason ?? undefined,
  },
  { key: "qty", header: "Unidades vendidas", kind: "number", cell: (r) => r.qty_sold ?? "—" },
  {
    key: "margin",
    header: "Margen de contribución",
    kind: "number",
    cell: (r) => formatCOP(r.contribution_margin ?? null),
  },
  {
    key: "popularity",
    header: "Popularidad",
    kind: "number",
    cell: (r) => formatBasisPoints(r.popularity_share_bp ?? null),
  },
]

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
        <EmptyState reason="error" title="No se pudo calcular la ingeniería de menú" description={errorMessage(query.error)} action={{ label: "Reintentar", onClick: () => void query.refetch() }} />
      ) : !query.data?.available ? (
        <EmptyState reason="dependency" title="Ingeniería de menú no disponible" description={query.data?.reason ?? "No hay ventas con costo congelado en este período."} />
      ) : rows.length === 0 ? (
        <EmptyState
          reason="filter"
          title="No hay platos para clasificar en este período"
          description="El filtro puesto es el rango de fechas: no hubo ventas costeadas en él."
        />
      ) : (
        <DenseTable
          caption="Platos del período clasificados por popularidad y margen de contribución."
          columns={MENU_COLUMNS}
          rows={rows}
          rowKey={(r) => String(r.product_id)}
          rowStatus={menuRowStatus}
          maxBodyHeightPx={460}
          bar={<DenseTableBar shown={rows.length} total={rows.length} noun="platos clasificados" />}
          legend={[
            { term: "Estrella", meaning: "se vende mucho y deja mucho. No la toques." },
            { term: "Caballo de batalla", meaning: "se vende mucho y deja poco: el precio o la ficha es lo que hay que mirar." },
            { term: "Enigma", meaning: "deja mucho pero se vende poco: es un problema de carta, no de cocina." },
            { term: "Perro", meaning: "ni se vende ni deja. Sacarlo libera compra y espacio." },
            { term: "Sin clasificar", meaning: "no es «malo»: es que no hubo costo congelado con qué clasificarlo." },
          ]}
          note="Sobre el costo CONGELADO en cada ítem vendido, nunca revalorado con la carta de hoy."
        />
      )}
    </div>
  )
}

export default MenuEngineeringTab
