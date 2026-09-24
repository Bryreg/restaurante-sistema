import { useQuery } from "@tanstack/react-query"
import { useState } from "react"

import { getSales, salesCsvUrl, type PreviousPeriodOut, type SalesBucketOut } from "@/api/reports"
import {
  DenseTable,
  DenseTableBar,
  FilterEmptyState,
  GroupLabel,
  HeadlineFigure,
  type DenseColumn,
} from "@/components/admin"
import { Cargando } from "@/components/Cargando"
import {
  BarList,
  ChartFrame,
  ColumnChart,
  Stacked100,
  TrendLine,
  type ColumnaTabla,
  type Muestra,
} from "@/components/charts"
import { CsvExportButton } from "@/components/CsvExportButton"
import { DateRangeFilter } from "@/components/DateRangeFilter"
import { EmptyState } from "@/components/EmptyState"
import { StatTile, cifraOSinDato } from "@/components/StatTile"
import { Badge } from "@/components/ui/badge"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { errorMessage } from "@/lib/errors"
import { formatFechaCorta, formatPct } from "@/lib/format"
import { formatCOP } from "@/lib/money"
import { cn } from "@/lib/utils"

import { CHANNEL_LABEL } from "@/features/orders/lib"

import {
  daysAgoInBogota,
  formatDelta,
  formatPercentInt,
  formatRangoCorto,
  GROUP_BY_LABEL,
  GROUP_BY_OPTION,
  isLineGroupBy,
  methodLabel,
  recipeCoverageTone,
  shortDay,
  todayInBogota,
  type SalesGrouping,
} from "./lib"
import { Definiciones, Plegable, type Definicion } from "./Plegable"

/** El orden del selector: primero el tiempo, después cómo se pagó, quién y qué. */
const GROUP_BY_ORDER: readonly SalesGrouping[] = [
  "business_date",
  "shift",
  "hour",
  "method",
  "channel",
  "employee",
  "zone",
  "product",
  "category",
]

function bucketLabel(row: SalesBucketOut, groupBy: SalesGrouping): string {
  if (groupBy === "method") return methodLabel(row.key)
  if (groupBy === "channel") return CHANNEL_LABEL[row.key] ?? row.label ?? row.key
  if (groupBy === "business_date") return formatFechaCorta(row.key)
  return row.label ?? row.key
}

/** La etiqueta corta del eje: «vie 18», «#12», «13». */
function axisLabel(row: SalesBucketOut, groupBy: SalesGrouping): string {
  if (groupBy === "business_date") return shortDay(formatFechaCorta(row.key))
  if (groupBy === "shift") return (row.label ?? row.key).replace(/^Turno\s*/i, "")
  if (groupBy === "hour") return String(row.key).padStart(2, "0")
  return bucketLabel(row, groupBy)
}

/** Un día que la sede NO abrió (`operated=false`): su $ 0 no es un mal día. */
function isClosedDay(row: SalesBucketOut): boolean {
  return row.operated === false
}

const DEFAULT_DAYS_BACK = 6

/**
 * El pie de cada tarjeta de «Del período» y de la cobertura, plegado debajo
 * (mapa de pantallas, regla 2). Son las mismas frases que iban bajo cada
 * cifra; el aviso de cobertura baja no está acá: es un estado y se ve.
 */
const INDICADORES_EXPLICADOS: readonly Definicion[] = [
  { term: "Comandas pagadas", meaning: "cobradas y cerradas en el rango elegido." },
  { term: "Comensales", meaning: "contados al abrir la mesa." },
  { term: "Ticket promedio", meaning: "sobre venta neta, sin propina." },
  { term: "Ticket por comensal", meaning: "sobre las comandas que sí contaron comensales." },
  { term: "Cobertura de receta", meaning: "porción de la venta neta con ficha técnica de verdad." },
  { term: "Costo teórico", meaning: "lo que las fichas dicen que costó." },
  { term: "Margen bruto teórico", meaning: "ventas netas − costo teórico." },
]

/**
 * "Ventas": ¿qué vendí y cómo me pagaron?, agrupado como pida la persona
 * (SPEC-NEGOCIO §9.3). Todo número sale tal cual de `SalesBucketOut` — este
 * componente sólo formatea y elige la forma visual según `group_by`.
 */
export function SalesTab({ storeId }: { storeId: number }): React.JSX.Element {
  const [from, setFrom] = useState(daysAgoInBogota(DEFAULT_DAYS_BACK))
  const [to, setTo] = useState(todayInBogota())
  const [groupBy, setGroupBy] = useState<SalesGrouping>("business_date")

  const query = useQuery({
    queryKey: ["admin-sales", storeId, from, to, groupBy],
    queryFn: () => getSales({ storeId, from, to, groupBy }),
  })

  const resetRange = (): void => {
    setFrom(daysAgoInBogota(DEFAULT_DAYS_BACK))
    setTo(todayInBogota())
  }

  return (
    <div className="space-y-5">
      {/* El período y la agrupación gobiernan TODA la pestaña, no sólo la
          tabla: por eso viven acá arriba, pegados a la cabecera de pantalla,
          y no en la barra de la tabla (`docs/PATRONES-ADMIN.md` § 1 y § 2). */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <DateRangeFilter idPrefix="sales" from={from} to={to} onChange={(r) => { setFrom(r.from); setTo(r.to) }} />
          <div className="space-y-1">
            <Label htmlFor="sales-group-by">Agrupar por</Label>
            <Select value={groupBy} onValueChange={(v) => setGroupBy(v as SalesGrouping)}>
              <SelectTrigger id="sales-group-by" className="h-10 w-48">
                <SelectValue>{(v: string) => GROUP_BY_OPTION[v as SalesGrouping] ?? v}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {GROUP_BY_ORDER.map((value) => (
                  <SelectItem key={value} value={value}>
                    {GROUP_BY_OPTION[value]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <CsvExportButton href={salesCsvUrl({ storeId, from, to, groupBy })} label="Exportar CSV" />
      </div>

      {query.isLoading ? (
        <Cargando texto="Cargando ventas…" />
      ) : query.isError ? (
        <EmptyState
          reason="error"
          title="No se pudieron cargar las ventas"
          description={errorMessage(query.error)}
          action={{ label: "Reintentar", onClick: () => void query.refetch() }}
        />
      ) : query.data ? (
        <SalesReport
          report={query.data}
          groupBy={groupBy}
          range={{ from, to }}
          onResetRange={resetRange}
        />
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// La tabla: columnas según lo que tiene sentido para cada agrupación.
// ---------------------------------------------------------------------------

interface SalesColumn extends DenseColumn<SalesBucketOut> {
  /** Lo que va en la fila de total (`<tfoot>`); sin esto, vacío. */
  total?: (t: SalesBucketOut) => React.ReactNode
}

/**
 * **Cinco columnas a la vista** (mapa de pantallas, regla 3): el renglón, lo
 * que vendió neto, qué parte del período es, cuántas comandas (o pagos, o
 * unidades) y el ticket —o, por plato y categoría, el margen—. Todo lo demás
 * va detrás de «Más columnas» (`secondary`), y **va después**: las cinco que
 * deciden no cambian de lugar al abrirlas, y la fila de total, que se arma
 * aparte, no puede quedar corrida contra su encabezado.
 */
function salesColumns(groupBy: SalesGrouping): readonly SalesColumn[] {
  const line = isLineGroupBy(groupBy)
  const method = groupBy === "method"
  const cols: (SalesColumn | false)[] = [
    {
      key: "bucket",
      header: GROUP_BY_LABEL[groupBy],
      kind: "name",
      cell: (r) =>
        groupBy === "business_date" && isClosedDay(r) ? (
          <span className="inline-flex items-center gap-1.5">
            {bucketLabel(r, groupBy)}
            <Badge variant="outline" className="font-normal">
              No abrió
            </Badge>
          </span>
        ) : (
          bucketLabel(r, groupBy)
        ),
      total: () => "Total",
    },
    { key: "net", header: "Neto", kind: "number", cell: (r) => formatCOP(r.net), total: (t) => formatCOP(t.net) },
    {
      key: "share",
      header: "Participación",
      kind: "number",
      cell: (r) => formatPct(r.share_bp),
    },
    line && { key: "units", header: "Unidades", kind: "number", cell: (r) => r.units ?? "—", total: (t) => t.units ?? "—" },
    method
      ? {
          // Por medio de pago cuenta PAGOS: una comanda mitad efectivo y mitad
          // tarjeta son dos pagos de verdad.
          key: "payments",
          header: "Pagos",
          kind: "number",
          cell: (r) => r.payments ?? r.orders ?? "—",
          total: (t) => t.payments ?? "—",
        }
      : line
        ? false
        : { key: "orders", header: "Comandas", kind: "number", cell: (r) => r.orders ?? "—", total: (t) => t.orders ?? "—" },
    !line && { key: "avg", header: "Ticket prom.", kind: "number", cell: (r) => formatCOP(r.avg_ticket), total: (t) => formatCOP(t.avg_ticket) },
    // Por plato y categoría no hay ticket: la quinta que decide es el margen.
    line && { key: "margin", header: "Margen bruto", kind: "number", cell: (r) => formatCOP(r.gross_margin), total: (t) => formatCOP(t.gross_margin) },
    // --- Detrás de «Más columnas» ---
    { key: "gross", header: "Cobrado", kind: "number", secondary: true, cell: (r) => formatCOP(r.gross), total: (t) => formatCOP(t.gross) },
    { key: "tax", header: "Impuesto", kind: "number", secondary: true, cell: (r) => formatCOP(r.tax), total: (t) => formatCOP(t.tax) },
    // La propina se deja sobre la cuenta, no sobre un plato: en las
    // agrupaciones por línea la columna no existe (el total sí la trae).
    !line && { key: "tips", header: "Propinas", kind: "number", secondary: true, cell: (r) => formatCOP(r.tips), total: (t) => formatCOP(t.tips) },
    !line && !method && { key: "covers", header: "Comensales", kind: "number", secondary: true, cell: (r) => r.covers ?? "—", total: (t) => t.covers ?? "—" },
    !method && { key: "cost", header: "Costo teórico", kind: "number", secondary: true, cell: (r) => formatCOP(r.theoretical_cost), total: (t) => formatCOP(t.theoretical_cost) },
    !line && !method && { key: "margin", header: "Margen bruto", kind: "number", secondary: true, cell: (r) => formatCOP(r.gross_margin), total: (t) => formatCOP(t.gross_margin) },
    !method && { key: "coverage", header: "Cobertura", kind: "number", secondary: true, cell: (r) => formatPercentInt(r.costed_pct), total: (t) => formatPercentInt(t.costed_pct) },
  ]
  return cols.filter((c): c is SalesColumn => c !== false)
}

/**
 * La fila de cierre de la tabla, dentro del `<tfoot>` (§ 8), con las mismas
 * columnas que se ven: las secundarias entran sólo con «Más columnas»
 * abierto, que es lo que `DenseTable` le pasa a `footer`.
 */
function totalsRow(columns: readonly SalesColumn[], total: SalesBucketOut): React.JSX.Element {
  return (
    <tr className="font-bold">
      {columns.map((c) => (
        <td
          key={c.key}
          className={cn(
            c.kind === "number" ? "px-2 py-1.5 text-right whitespace-nowrap tabular-nums" : "px-2 py-1.5",
          )}
        >
          {c.total ? c.total(total) : ""}
        </td>
      ))}
    </tr>
  )
}

// ---------------------------------------------------------------------------
// La comparación de la cifra rectora.
// ---------------------------------------------------------------------------

/**
 * El período del mismo largo inmediatamente anterior (`total.previous_period`):
 * el neto de entonces y la variación los manda el servidor; acá sólo se
 * escriben. Sin comparación posible, se dice por qué — nunca «0 %».
 */
function periodComparison(
  p: PreviousPeriodOut | null | undefined,
): { label: string; delta: string; detail?: string } | undefined {
  if (!p) return undefined
  const label = `Contra el período anterior (${formatRangoCorto(p.date_from, p.date_to)})`
  if (p.net === null) {
    return { label: p.null_reason ?? "No hay datos del período anterior: no hay contra qué comparar.", delta: "Sin dato" }
  }
  const parcial = p.partial ? " La sede empezó a operar dentro de ese período: es contra menos días." : ""
  const delta = formatDelta(p.delta_bp)
  if (delta === null) {
    return {
      label: `${label}: vendió ${formatCOP(p.net)}, así que no hay variación que calcular.${parcial}`,
      delta: "Sin dato",
    }
  }
  return {
    label: `${label}${p.partial ? " · parcial" : ""}`,
    delta,
    detail: `antes ${formatCOP(p.net)}`,
  }
}

// ---------------------------------------------------------------------------
// El gráfico: la forma la decide la agrupación (`@/components/charts`).
// ---------------------------------------------------------------------------

/** La fila más alta (selección, no cuenta), sin los días cerrados ni los sin dato. */
function peakRow(rows: SalesBucketOut[]): SalesBucketOut | null {
  let best: SalesBucketOut | null = null
  for (const r of rows) {
    if (isClosedDay(r) || r.net === undefined || r.net <= 0) continue
    if (best === null || r.net > (best.net as number)) best = r
  }
  return best
}

/** «, 16,1 % del período» si el servidor mandó la participación. */
function shareTail(r: SalesBucketOut, what: string): string {
  return r.share_bp === null || r.share_bp === undefined ? "" : `, ${formatPct(r.share_bp)} ${what}`
}

function nominalTitular(top: SalesBucketOut, groupBy: SalesGrouping): string {
  const name = bucketLabel(top, groupBy)
  const pct = top.share_bp === null || top.share_bp === undefined ? null : formatPct(top.share_bp)
  if (pct === null) return `${name} encabeza con ${formatCOP(top.net)}`
  switch (groupBy) {
    case "method":
      return `${name} se lleva el ${pct} de la venta neta`
    case "channel":
      return `${name} hace el ${pct} de la venta neta`
    case "employee":
      return `${name} vendió el ${pct} del período`
    case "product":
      return `${name} es el plato que más vende: ${pct} de la venta neta`
    default:
      return `${name} hace el ${pct} de la venta neta`
  }
}

/**
 * El método del gráfico —qué se grafica, en qué unidad, qué es el rayado—
 * se lee una vez: va plegado, y a la vista queda el titular, que es la
 * conclusión (mapa de pantallas, regla 2).
 */
function comoLeer(detalle: string): React.JSX.Element {
  return <Plegable resumen="Cómo leer esto">{detalle}</Plegable>
}

function SalesChart({
  rows,
  total,
  groupBy,
  range,
}: {
  rows: SalesBucketOut[]
  total: SalesBucketOut
  groupBy: SalesGrouping
  range: { from: string; to: string }
}): React.JSX.Element {
  const ventana = formatRangoCorto(range.from, range.to)
  const muestra: Muestra | undefined =
    groupBy === "method"
      ? total.payments !== null && total.payments !== undefined
        ? { n: total.payments, unidad: "pagos", ventana }
        : undefined
      : total.orders !== undefined
        ? { n: total.orders, unidad: "comandas", ventana }
        : undefined

  const closedDays = groupBy === "business_date" ? rows.filter(isClosedDay).length : 0
  const shareCol: ColumnaTabla = { key: "share", header: "Participación", align: "right" }
  const countCol: ColumnaTabla = isLineGroupBy(groupBy)
    ? { key: "count", header: "Unidades", align: "right" }
    : groupBy === "method"
      ? { key: "count", header: "Pagos", align: "right" }
      : { key: "count", header: "Comandas", align: "right" }
  const tabla = {
    columnas: [
      { key: "label", header: GROUP_BY_LABEL[groupBy] },
      { key: "net", header: "Venta neta", align: "right" as const },
      shareCol,
      countCol,
    ],
    filas: rows.map((r) => ({
      label:
        groupBy === "business_date" && isClosedDay(r) ? `${bucketLabel(r, groupBy)} · no abrió` : bucketLabel(r, groupBy),
      net: formatCOP(r.net),
      share: formatPct(r.share_bp),
      count: String(
        (isLineGroupBy(groupBy) ? r.units : groupBy === "method" ? (r.payments ?? r.orders) : r.orders) ?? "—",
      ),
    })),
  }

  // --- En el tiempo y en orden propio: columnas (o línea, si son muchas). ---
  if (groupBy === "business_date" || groupBy === "shift" || groupBy === "hour") {
    const peak = peakRow(rows)
    const puntos = rows.map((r) => ({
      key: r.key,
      etiqueta: axisLabel(r, groupBy),
      // Día cerrado → hueco rayado: no es «vendió $ 0», es «no abrió».
      valor: isClosedDay(r) ? null : (r.net ?? null),
    }))
    const noun = groupBy === "business_date" ? "día" : groupBy === "shift" ? "turno" : "hora"
    let titular: string
    if (peak === null) titular = "No hubo ventas en el período"
    else if (groupBy === "business_date")
      titular = `El ${formatFechaCorta(peak.key)} fue el día más fuerte: ${formatCOP(peak.net)}${shareTail(peak, "del período")}`
    else if (groupBy === "shift")
      titular = `El ${bucketLabel(peak, groupBy)} fue el que más vendió: ${formatCOP(peak.net)}${shareTail(peak, "del período")}`
    else
      titular = `La hora más fuerte es la de las ${axisLabel(peak, groupBy)}:00, con ${formatCOP(peak.net)}${shareTail(peak, "de la venta")}`

    const detalle = [
      groupBy === "business_date"
        ? "Venta neta por día operativo, sin propina."
        : groupBy === "shift"
          ? "Venta neta por turno, en el orden en que se abrieron."
          : "Venta neta por hora de reloj, desde el corte del día, sumando el período.",
      closedDays > 0
        ? `Rayado: ${closedDays === 1 ? "un día que la sede no abrió" : `${closedDays} días que la sede no abrió`} (no es venta $ 0).`
        : null,
    ]
      .filter(Boolean)
      .join(" ")
    const resumen =
      `${rows.length} ${noun === "hora" ? "horas" : `${noun}s`}` +
      (peak ? `; el más alto, ${bucketLabel(peak, groupBy)} con ${formatCOP(peak.net)}` : ", sin ventas") +
      (closedDays > 0 ? `; ${closedDays} sin abrir` : "") +
      ". El detalle está en la tabla."

    return (
      <ChartFrame titular={titular} detalle={comoLeer(detalle)} muestra={muestra} tabla={tabla}>
        {rows.length > 45 ? (
          <TrendLine puntos={puntos} formato={formatCOP} resumen={`Línea de ${resumen}`} />
        ) : (
          <ColumnChart
            datos={puntos}
            formato={formatCOP}
            resaltar={peak?.key}
            resumen={`Columnas de ${resumen}`}
          />
        )}
      </ChartFrame>
    )
  }

  // --- Composición (medio de pago, canal): barra 100 % con `share_bp`. ---
  const top = rows.reduce<SalesBucketOut | null>(
    (best, r) => (r.net === undefined ? best : best === null || r.net > (best.net as number) ? r : best),
    null,
  )
  const titular = top ? nominalTitular(top, groupBy) : "No hubo ventas en el período"
  const allShares = rows.length > 0 && rows.every((r) => r.share_bp !== null && r.share_bp !== undefined)

  if ((groupBy === "method" || groupBy === "channel") && allShares) {
    return (
      <ChartFrame
        titular={titular}
        detalle={comoLeer(
          groupBy === "method"
            ? "Participación de cada medio en la venta neta del período, sin propina."
            : "Participación de cada canal en la venta neta del período.",
        )}
        muestra={muestra}
        tabla={tabla}
      >
        <Stacked100
          partes={rows.map((r) => ({
            key: r.key,
            etiqueta: bucketLabel(r, groupBy),
            share_bp: r.share_bp as number,
            valor: formatCOP(r.net),
          }))}
        />
      </ChartFrame>
    )
  }

  // --- Nominal (persona, zona, plato, categoría): barras, top 7 y «y N más». ---
  return (
    <ChartFrame
      titular={titular}
      detalle={comoLeer(`Venta neta por ${GROUP_BY_LABEL[groupBy].toLowerCase()}, de mayor a menor.`)}
      muestra={muestra}
      tabla={tabla}
    >
      <BarList
        datos={rows.map((r) => ({
          key: r.key,
          etiqueta: bucketLabel(r, groupBy),
          valor: r.net ?? null,
          detalle: isLineGroupBy(groupBy)
            ? r.units !== null && r.units !== undefined
              ? `${r.units} u.`
              : undefined
            : r.share_bp !== null && r.share_bp !== undefined
              ? formatPct(r.share_bp)
              : undefined,
        }))}
        formato={formatCOP}
      />
    </ChartFrame>
  )
}

function SalesReport({
  report,
  groupBy,
  range,
  onResetRange,
}: {
  report: { rows: SalesBucketOut[]; total: SalesBucketOut }
  groupBy: SalesGrouping
  range: { from: string; to: string }
  onResetRange: () => void
}): React.JSX.Element {
  const { rows, total } = report
  const rangeLabel = formatRangoCorto(range.from, range.to)
  const columns = salesColumns(groupBy)

  return (
    <div className="space-y-5">
      {/* § 4 · La cifra rectora de esta pantalla, con el libro que la deriva
          —cobrado − impuesto = neto—, la comparación contra el período
          anterior (del servidor) y las propinas ABAJO DE LA RAYA, que es lo
          que mata la tarjeta «Propinas» (error de categoría: la propina no
          es del restaurante, Ley 1935 de 2018). */}
      <HeadlineFigure
        label="Ventas netas del período"
        value={formatCOP(total.net)}
        note={
          total.orders !== undefined
            ? `${total.orders} ${total.orders === 1 ? "comanda pagada" : "comandas pagadas"} · ${rangeLabel}`
            : undefined
        }
        ledger={{
          rows: [
            { label: "Ventas cobradas", value: formatCOP(total.gross) },
            { label: "Impuesto discriminado", value: formatCOP(total.tax), kind: "subtract" },
          ],
          total: { label: "Ventas netas", value: formatCOP(total.net) },
        }}
        belowTheLine={{ label: "Propinas (informativo) — no son venta", value: formatCOP(total.tips) }}
        comparison={periodComparison(total.previous_period)}
      />

      {rows.length === 0 ? (
        <FilterEmptyState
          title="Sin ventas en este período"
          filters={[rangeLabel]}
          onRemove={onResetRange}
          description="No hay ninguna venta cobrada en el rango de fechas elegido. El filtro puesto es el período."
        />
      ) : (
        // El gráfico va ARRIBA de las tarjetas (analista #7): la forma del
        // período se lee antes que los promedios.
        <section className="min-w-0 rounded-lg border bg-card p-4">
          <SalesChart rows={rows} total={total} groupBy={groupBy} range={range} />
        </section>
      )}

      <GroupLabel label="Del período" says="cerrado, ya no cambia">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatTile label="Comandas pagadas" value={total.orders !== undefined ? String(total.orders) : "—"} />
          {total.covers === null || total.covers === undefined ? (
            <StatTile
              label="Comensales"
              value={null}
              nullNote="No es cero: es que nadie los contó. Mostrador no registra comensales."
            />
          ) : (
            <StatTile label="Comensales" value={String(total.covers)} />
          )}
          <StatTile
            label="Ticket promedio"
            {...cifraOSinDato(total.avg_ticket, "no hay comandas pagadas en el período.")}
          />
          <StatTile
            label="Ticket por comensal"
            {...cifraOSinDato(total.avg_per_cover, "ninguna comanda del período contó comensales. No es cero.")}
          />
        </div>
      </GroupLabel>

      {/* Costo teórico, margen bruto y cobertura de receta (pedido 2a). La
          cobertura es el número más honesto del reporte — dice qué porción
          de la venta tuvo ficha técnica de verdad — así que va primero y
          grande, no escondida en una columna; si es baja, el tono la marca
          y el margen de al lado deja de leerse como definitivo. */}
      <GroupLabel label="Qué tan en serio tomar ese margen" says="depende de cuánta venta tuvo ficha técnica">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <StatTile
            label="Cobertura de receta"
            value={formatPercentInt(total.costed_pct)}
            // Cobertura baja es un ESTADO —el margen de al lado no es
            // definitivo—, no una explicación: ésa sí queda a la vista.
            hint={
              recipeCoverageTone(total.costed_pct) === "default"
                ? undefined
                : "Bajo esto, el costo y el margen de al lado no representan toda la venta — la mayoría se vendió sin receta."
            }
            tone={recipeCoverageTone(total.costed_pct)}
            // § 5, regla dura: una tarjeta con tono lleva a algún lado. Sin
            // pestaña en el enlace porque Carta no guarda la suya en la URL:
            // nombrarla sería prometer un filtro que el enlace no pone (§ 6).
            link={{ to: "/admin/carta", screen: "Carta" }}
          />
          <StatTile
            label="Costo teórico"
            {...cifraOSinDato(total.theoretical_cost, "no hay ventas costeadas en el período: faltan fichas técnicas.")}
          />
          <StatTile
            label="Margen bruto teórico"
            {...cifraOSinDato(total.gross_margin, "no hay ventas costeadas en el período: faltan fichas técnicas.")}
          />
        </div>
        <Plegable resumen="Cómo leer estos indicadores" className="mt-2 px-1">
          <Definiciones items={INDICADORES_EXPLICADOS} className="sm:grid-cols-2" />
        </Plegable>
      </GroupLabel>

      {rows.length === 0 ? null : (
        <DenseTable
          caption={`Ventas del período agrupadas por ${GROUP_BY_LABEL[groupBy].toLowerCase()}, con cobrado, neto, participación, impuesto y costo.`}
          columns={columns}
          rows={rows}
          rowKey={(r) => r.key}
          maxBodyHeightPx={420}
          bar={
            <DenseTableBar
              shown={rows.length}
              total={rows.length}
              noun={GROUP_BY_LABEL[groupBy].toLowerCase()}
              hidden={`del ${rangeLabel}`}
            />
          }
          footer={(todas) => totalsRow(todas ? columns : columns.filter((c) => !c.secondary), total)}
          legend={[
            {
              term: "Cobrado ≠ neto",
              meaning: "lo cobrado incluye el impuesto al consumo, que no es del restaurante. El neto es lo que queda.",
            },
            isLineGroupBy(groupBy)
              ? {
                  term: "Sin propinas",
                  meaning: "la propina se deja sobre la cuenta, no sobre un plato: por eso no tiene columna acá. El total de arriba sí la muestra, aparte.",
                }
              : {
                  term: "Propinas",
                  meaning: "van en su columna porque se cobran, pero no son venta ni entran en el neto.",
                },
            groupBy === "method"
              ? {
                  term: "Pagos, no comandas",
                  meaning: "una comanda pagada mitad en efectivo y mitad con tarjeta cuenta un pago en cada medio.",
                }
              : {
                  term: "Cobertura «—»",
                  meaning: "no es 0 %: es que no hubo venta costeada para medirla en ese renglón.",
                },
          ]}
        />
      )}
    </div>
  )
}

export default SalesTab
