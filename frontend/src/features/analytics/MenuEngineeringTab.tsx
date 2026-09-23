/**
 * Admin → Analítica → Ingeniería de menú (T4, `GET /admin/menu-engineering`):
 * clasificación por plato sobre el costo CONGELADO en el ítem — nunca
 * revalorado con la carta de hoy (spec.md § T4). `available`/`reason` mandan
 * cuando no hay ventas del período.
 *
 * Lectura de arriba abajo (analista #5, científico #7): el resumen por
 * acción («3 para sacar o rediseñar, 7 para revisar precio…») desde
 * `counts_by_class`; la matriz popularidad × margen POR UNIDAD con los dos
 * umbrales del servidor rotulados y los «perro» resaltados; y la tabla
 * ordenada por acción con «Qué hacer» (`recommended_action`). La
 * clasificación, los umbrales y la acción son del backend: acá se eligen,
 * se ordenan y se cuentan filas.
 */
import { useQuery } from "@tanstack/react-query"
import { useState } from "react"

import { getMenuEngineering, type MenuEngineeringOut, type MenuEngineeringRowOut } from "@/api/analytics"
import { DenseTable, DenseTableBar, type DenseColumn, type RowStatus } from "@/components/admin"
import { ChartFrame, QuadrantScatter, type ScatterPunto } from "@/components/charts"
import { DateRangeFilter } from "@/components/DateRangeFilter"
import { EmptyState } from "@/components/EmptyState"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { errorMessage } from "@/lib/errors"
import { formatFechaCorta, formatPct } from "@/lib/format"
import { formatCOP } from "@/lib/money"
import { cn } from "@/lib/utils"

import { daysAgoLocal, menuEngineeringLabel, menuEngineeringTone, ordenPorAccion, todayLocal } from "./lib"
import { menuResumen } from "./titulares"

/**
 * § 8 · La franja de estado de la primera celda deja ver la forma del
 * problema sin leer. «Perro» en ámbar (nunca rojo: el rojo es faltante).
 */
function menuRowStatus(row: MenuEngineeringRowOut): RowStatus {
  // «Sin clasificar» NO es verde: no saber no es estar bien, igual que `—` no
  // es `0` (`docs/PATRONES-ADMIN.md` § 5). Sin franja, que es lo honesto.
  if (!row.classification || row.classification === "unclassified") return "none"
  const tone = menuEngineeringTone(row.classification)
  return tone === "warning" ? "warning" : row.classification === "star" ? "ok" : "none"
}

function ClaseBadge({ row }: { row: MenuEngineeringRowOut }): React.JSX.Element {
  const ambar = menuEngineeringTone(row.classification) === "warning"
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md border px-1.5 py-px text-xs font-medium whitespace-nowrap",
        ambar ? "border-warning/45 bg-warning/10 text-foreground" : "border-border bg-secondary text-secondary-foreground",
      )}
    >
      {row.insufficient_sample ? "Muestra chica" : menuEngineeringLabel(row.classification)}
    </span>
  )
}

/** «Qué hacer»: la acción del servidor; sin clasificar, por qué no la hay. */
function QueHacer({ row }: { row: MenuEngineeringRowOut }): React.JSX.Element {
  if (row.recommended_action) return <span className="font-medium">{row.recommended_action}</span>
  if (row.insufficient_sample) {
    return <span className="text-muted-foreground italic">Esperar más ventas (muestra chica)</span>
  }
  return <span className="text-muted-foreground italic">Cargar su costo para clasificarlo</span>
}

const MENU_COLUMNS: readonly DenseColumn<MenuEngineeringRowOut>[] = [
  { key: "product", header: "Plato", kind: "name", cell: (r) => r.product_name ?? `#${r.product_id}` },
  { key: "todo", header: "Qué hacer", cell: (r) => <QueHacer row={r} /> },
  { key: "class", header: "Clasificación", cell: (r) => <ClaseBadge row={r} /> },
  { key: "category", header: "Categoría", kind: "secondary", cell: (r) => r.category_name ?? "—" },
  { key: "qty", header: "Unidades vendidas", kind: "number", cell: (r) => r.qty_sold ?? "—" },
  {
    key: "popularity",
    header: "Popularidad",
    kind: "number",
    cell: (r) => formatPct(r.popularity_share_bp ?? null),
  },
  {
    key: "unit-margin",
    header: "Margen por unidad",
    kind: "number",
    cell: (r) => formatCOP(r.contribution_margin_per_unit ?? null),
  },
  {
    key: "margin-pct",
    header: "Margen %",
    kind: "number",
    cell: (r) => formatPct(r.margin_pct_bp ?? null),
  },
  {
    key: "margin",
    header: "Margen del período",
    kind: "number",
    cell: (r) => formatCOP(r.contribution_margin ?? null),
  },
  {
    // Lo largo va al `title` y lo corto a la celda: la fila NO crece (§ 8).
    key: "why",
    header: "Por qué",
    kind: "secondary",
    cell: (r) => r.classification_reason ?? "—",
    cellTitle: (r) => r.classification_reason ?? undefined,
  },
]

const TODAS = "todas"

/** La matriz: sólo platos clasificados (con muestra y costo), con los umbrales del servidor. */
function MatrizMenu({ data, rows }: { data: MenuEngineeringOut; rows: readonly MenuEngineeringRowOut[] }): React.JSX.Element | null {
  const umbralX = data.popularity_threshold_bp
  const umbralY = data.avg_contribution_margin_per_unit
  if (umbralX === null || umbralX === undefined || umbralY === null || umbralY === undefined) return null
  const clasificados = rows.filter(
    (r) =>
      r.classification &&
      r.classification !== "unclassified" &&
      r.popularity_share_bp !== null &&
      r.popularity_share_bp !== undefined &&
      r.contribution_margin_per_unit !== null &&
      r.contribution_margin_per_unit !== undefined,
  )
  if (clasificados.length === 0) return null
  const puntos: ScatterPunto[] = clasificados.map((r) => ({
    key: String(r.product_id),
    etiqueta: r.product_name ?? `#${r.product_id}`,
    x: r.popularity_share_bp as number,
    y: r.contribution_margin_per_unit as number,
    resaltar: r.classification === "dog",
  }))
  const perros = clasificados.filter((r) => r.classification === "dog")
  const titular =
    perros.length === 0
      ? `Ningún plato cae abajo a la izquierda: todos se venden o dejan más de ${formatCOP(umbralY)} por unidad`
      : `${perros.length === 1 ? "Un plato queda" : `${perros.length} platos quedan`} abajo a la izquierda: se ${perros.length === 1 ? "vende" : "venden"} poco y ${perros.length === 1 ? "deja" : "dejan"} menos de ${formatCOP(umbralY)} por unidad`
  // Contar unidades vendidas es contar, no plata.
  const unidades = clasificados.reduce((n, r) => n + (r.qty_sold ?? 0), 0)
  const ventana =
    data.date_from && data.date_to ? `${formatFechaCorta(data.date_from)} al ${formatFechaCorta(data.date_to)}` : undefined
  return (
    <div className="rounded-lg border bg-card p-4">
      <ChartFrame
        titular={titular}
        detalle={
          <>
            Cada punto es un plato: a la derecha, más vendido; arriba, más margen por unidad. Las líneas son los umbrales
            del servidor (popularidad mínima {formatPct(umbralX, 2)}; margen promedio {formatCOP(umbralY)}). Los
            «perro» van resaltados.
          </>
        }
        muestra={{ n: unidades, unidad: "unidades vendidas", ventana, minimo: data.min_units ?? 20 }}
        tabla={{
          columnas: [
            { key: "plato", header: "Plato" },
            { key: "pop", header: "Popularidad", align: "right" },
            { key: "mu", header: "Margen por unidad", align: "right" },
            { key: "clase", header: "Clasificación" },
          ],
          filas: clasificados.map((r) => ({
            plato: r.product_name ?? `#${r.product_id}`,
            pop: formatPct(r.popularity_share_bp ?? null),
            mu: formatCOP(r.contribution_margin_per_unit ?? null),
            clase: menuEngineeringLabel(r.classification),
          })),
        }}
      >
        <QuadrantScatter
          puntos={puntos}
          umbralX={{ valor: umbralX, etiqueta: `Popularidad mínima ${formatPct(umbralX, 2)}` }}
          umbralY={{ valor: umbralY, etiqueta: `Margen promedio ${formatCOP(umbralY)}` }}
          ejeX={{ titulo: "Popularidad (% de las unidades vendidas)", formato: (v) => formatPct(v, 0) }}
          ejeY={{ titulo: "Margen por unidad", formato: formatCOP }}
          cuadrantes={["Estrella", "Enigma", "Perro", "Caballo de batalla"]}
          resumen={`${titular}. ${clasificados.length} platos clasificados; el detalle está en la tabla.`}
        />
      </ChartFrame>
    </div>
  )
}

export function MenuEngineeringTab({ storeId }: { storeId: number }): React.JSX.Element {
  const [from, setFrom] = useState(daysAgoLocal(30))
  const [to, setTo] = useState(todayLocal())
  const [categoria, setCategoria] = useState<string>(TODAS)
  const categoryId = categoria === TODAS ? null : Number(categoria)

  const query = useQuery({
    queryKey: ["analytics", "menu-engineering", storeId, from, to, categoryId],
    queryFn: () => getMenuEngineering({ storeId, from, to, categoryId }),
  })
  // Las categorías del filtro salen de la carta entera del mismo período
  // (misma clave que la consulta sin filtro: con «toda la carta» es la misma
  // respuesta, sin un pedido de más).
  const todasQuery = useQuery({
    queryKey: ["analytics", "menu-engineering", storeId, from, to, null],
    queryFn: () => getMenuEngineering({ storeId, from, to, categoryId: null }),
  })
  const categorias = new Map<number, string>()
  for (const r of todasQuery.data?.rows ?? []) {
    if (r.category_id !== null && r.category_id !== undefined) categorias.set(r.category_id, r.category_name ?? `#${r.category_id}`)
  }

  const data = query.data
  const rows = [...(data?.rows ?? [])]
    .map((r, i) => ({ r, i }))
    .sort((a, b) => ordenPorAccion(a.r.classification) - ordenPorAccion(b.r.classification) || a.i - b.i)
    .map(({ r }) => r)
  const resumen = data?.counts_by_class ? menuResumen(data.counts_by_class) : null

  const filtros = (
    <div className="flex flex-wrap items-end gap-3">
      <DateRangeFilter idPrefix="menu-engineering" from={from} to={to} onChange={(r) => { setFrom(r.from); setTo(r.to) }} />
      <div className="flex items-center gap-2">
        <Label htmlFor="menu-engineering-category">Categoría</Label>
        <Select value={categoria} onValueChange={(v) => setCategoria(String(v))}>
          <SelectTrigger id="menu-engineering-category" className="h-8 w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={TODAS}>Toda la carta</SelectItem>
            {[...categorias.entries()].map(([id, nombre]) => (
              <SelectItem key={id} value={String(id)}>
                {nombre}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  )

  return (
    <div className="space-y-4">
      {filtros}

      {query.isLoading ? (
        <p className="text-sm text-muted-foreground">Clasificando la carta…</p>
      ) : query.isError ? (
        <EmptyState reason="error" title="No se pudo calcular la ingeniería de menú" description={errorMessage(query.error)} action={{ label: "Reintentar", onClick: () => void query.refetch() }} />
      ) : !data?.available ? (
        <EmptyState reason="dependency" title="Ingeniería de menú no disponible" description={data?.reason ?? "No hay ventas con costo congelado en este período."} />
      ) : rows.length === 0 ? (
        <EmptyState
          reason="filter"
          title="No hay platos para clasificar en este período"
          description="El filtro puesto es el rango de fechas (y la categoría, si elegiste una): no hubo ventas costeadas en él."
        />
      ) : (
        <>
          {resumen ? (
            <div className="space-y-1" data-testid="menu-resumen">
              <p className="text-lg leading-snug font-semibold">{resumen.titular}</p>
              <p className="text-sm text-muted-foreground">
                {resumen.aparte ? `${resumen.aparte} ` : ""}
                {data.min_units !== undefined ? `Se clasifica con ${data.min_units} unidades vendidas o más. ` : ""}
                {data.costed_pct_bp !== null && data.costed_pct_bp !== undefined
                  ? `${formatPct(data.costed_pct_bp)} del ingreso analizado tiene costo congelado. `
                  : ""}
                {data.excluded_products ? `${data.excluded_products} ${data.excluded_products === 1 ? "producto queda" : "productos quedan"} fuera (cargos como el domicilio, comida del personal).` : ""}
              </p>
            </div>
          ) : null}

          <MatrizMenu data={data} rows={rows} />

          <DenseTable
            caption="Platos del período ordenados por lo que conviene hacer con cada uno."
            columns={MENU_COLUMNS}
            rows={rows}
            rowKey={(r) => String(r.product_id)}
            rowStatus={menuRowStatus}
            maxBodyHeightPx={460}
            bar={<DenseTableBar shown={rows.length} total={rows.length} noun="platos" />}
            legend={[
              { term: "Estrella", meaning: "se vende mucho y deja mucho. No la toques." },
              { term: "Caballo de batalla", meaning: "se vende mucho y deja poco: el precio o la ficha es lo que hay que mirar." },
              { term: "Enigma", meaning: "deja mucho pero se vende poco: es un problema de carta, no de cocina." },
              { term: "Perro", meaning: "ni se vende ni deja. Sacarlo libera compra y espacio." },
              { term: "Muestra chica", meaning: "vendió muy pocas unidades para clasificarlo con confianza: no es «malo», es poco dato." },
              { term: "Sin clasificar", meaning: "no es «malo»: es que no hubo costo congelado con qué clasificarlo." },
            ]}
            note="Sobre el costo CONGELADO en cada ítem vendido, nunca revalorado con la carta de hoy. El margen por unidad es el que ubica al plato en la matriz; el del período es el total en pesos."
          />
        </>
      )}
    </div>
  )
}

export default MenuEngineeringTab
