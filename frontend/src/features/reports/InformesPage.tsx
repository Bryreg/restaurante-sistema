import { useQuery } from "@tanstack/react-query"
import { ArrowRight, Calendar, ChevronDown, ChevronRight } from "lucide-react"
import { useId, useState } from "react"
import { Link } from "react-router-dom"

import { adminListOrders, type AdminOrderListItem } from "@/api/orders"
import {
  getReportsOverview,
  type DishMixGroup,
  type MenuSummaryOut,
  type PeakHoursSeriesOut,
  type PreviousPeriodOut,
  type ReportsOverviewOut,
  type SalesBucketOut,
  type StoreRowOut,
  type StoresWeekSeriesOut,
} from "@/api/reports"
import { useSession } from "@/app/session"
import { useStoreSelection } from "@/app/storeContext"
import { DenseTable, HeadlineFigure, PageHeader, Segmentado, type DenseColumn } from "@/components/admin"
import { Cargando } from "@/components/Cargando"
import {
  BarList,
  BarrasConReferencia,
  ChartFrame,
  ColumnChart,
  QuadrantScatter,
  ResumenLateral,
  type RenglonResumen,
} from "@/components/charts"
import { DateRangeFilter } from "@/components/DateRangeFilter"
import { EmptyState } from "@/components/EmptyState"
import { StatTile, cifraOSinDato } from "@/components/StatTile"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { errorMessage } from "@/lib/errors"
import { formatPct } from "@/lib/format"
import { formatCOP } from "@/lib/money"
import { cn } from "@/lib/utils"

import { OrderDetailBody } from "@/features/orders/OrdersAdminPage"
import { fichaPersonaHref } from "./fichas/rutas"
import { CHANNEL_LABEL, ORDER_STATUS_LABEL } from "@/features/orders/lib"

import {
  formatCompacto,
  formatDelta,
  formatPctConSigno,
  formatPercentInt,
  formatPuntos,
  formatRangoConDia,
  formatRangoCorto,
  methodLabel,
  rangoDePeriodo,
  todayInBogota,
  type Periodo,
} from "./lib"
import { CsvExportButton } from "@/components/CsvExportButton"
import { csvUrl } from "@/api/client"

/**
 * «Informes» (handoff del panel, pantalla 11 · `AdminInformes.dc.html`): un
 * solo scroll con cinco preguntas —Ventas, Margen, Mix de platos, Horas pico
 * y Por sede—, cada una con su gráfico «barra + raya» y su resumen lateral.
 * El selector de sede recalcula todo junto (una sola llamada a
 * `GET /admin/reports/overview`); el período de entrada son los últimos 7
 * días cerrados contra la semana anterior.
 *
 * Esta pantalla no suma ni divide plata: las series llegan con el dato, su
 * raya y de qué lado quedó cada punto (`app/reports/series.py`). Acá sólo se
 * formatea, se eligen filas y se escriben frases con lo que ya vino.
 *
 * Lo que había antes en la página (medios de pago, ventas por hora, top de
 * productos, por persona, canal y zona, domicilios, ingeniería de menú,
 * costo y margen, historial de comandas) no se borró: se movió a «Más del
 * período», plegado al pie.
 */

const PERIODOS: readonly { value: Periodo; label: string }[] = [
  { value: "ultimos7", label: "Últimos 7 días" },
  { value: "hoy", label: "Hoy" },
  { value: "semana", label: "Esta semana" },
  { value: "mes", label: "Este mes" },
  { value: "rango", label: "Rango…" },
]

// ---------------------------------------------------------------------------
// Piezas chicas.
// ---------------------------------------------------------------------------

function Seccion({
  titulo,
  children,
  acciones,
  className,
}: {
  titulo: string
  children: React.ReactNode
  acciones?: React.ReactNode
  className?: string
}): React.JSX.Element {
  const id = useId()
  return (
    <section aria-labelledby={id} className={cn("min-w-0 rounded-lg border bg-card p-4", className)}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 id={id} className="text-xs font-bold tracking-wide text-muted-foreground uppercase">
          {titulo}
        </h2>
        {acciones}
      </div>
      {children}
    </section>
  )
}

/** «Sin dato» con su motivo: nunca un $ 0 inventado. */
function SinDato({ motivo }: { motivo: string }): React.JSX.Element {
  return (
    <p className="sin-dato sin-dato--calmo text-sm">{motivo}</p>
  )
}

/** El pie de una tarjeta de indicador: la variación que manda el servidor. */
function contraAnterior(delta: number | null | undefined, p: PreviousPeriodOut | null | undefined): string | undefined {
  if (!p) return undefined
  if (p.net === null) return p.null_reason ?? "Sin período anterior con qué comparar."
  const d = formatDelta(delta)
  const cuando = `${formatRangoCorto(p.date_from, p.date_to)}${p.partial ? ", parcial" : ""}`
  return d === null ? `Sin variación: el período anterior (${cuando}) no tiene base.` : `${d} vs ${cuando}`
}

function channelLabel(key: string): string {
  return CHANNEL_LABEL[key] ?? key
}

// ---------------------------------------------------------------------------
// Secciones.
// ---------------------------------------------------------------------------

function Indicadores({ total }: { total: SalesBucketOut }): React.JSX.Element {
  const p = total.previous_period
  return (
    <section aria-label="Indicadores" className="space-y-2">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Venta neta" value={formatCOP(total.net)} hint={contraAnterior(p?.delta_bp, p)} />
        <StatTile
          label="Comandas"
          value={total.orders !== undefined ? String(total.orders) : "—"}
          hint={contraAnterior(p?.orders_delta_bp, p)}
        />
        <StatTile
          label="Ticket promedio"
          {...cifraOSinDato(total.avg_ticket, "No hay comandas pagadas en el período.")}
          hint={total.avg_ticket === null || total.avg_ticket === undefined ? undefined : contraAnterior(p?.avg_ticket_delta_bp, p)}
        />
        <StatTile
          label="Ticket por comensal"
          {...cifraOSinDato(total.avg_per_cover, "Ninguna comanda del período contó comensales. No es cero.")}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        Propinas {formatCOP(total.tips)} — no son venta, no entran en la venta neta.
      </p>
    </section>
  )
}

function PorSede({ rows }: { rows: StoreRowOut[] }): React.JSX.Element {
  const columns: readonly DenseColumn<StoreRowOut>[] = [
    { key: "sede", header: "Sede", kind: "name", cell: (r) => r.store_name },
    { key: "net", header: "Venta neta", kind: "number", cell: (r) => formatCOP(r.net) },
    { key: "share", header: "Participación", kind: "number", cell: (r) => formatPct(r.share_bp) },
    { key: "orders", header: "Comandas", kind: "number", cell: (r) => r.orders },
    { key: "avg", header: "Ticket prom.", kind: "number", cell: (r) => formatCOP(r.avg_ticket) },
  ]
  return (
    <Seccion titulo="Por sede">
      <DenseTable
        caption="Venta, comandas y ticket de cada sede en el período"
        columns={columns}
        rows={rows}
        rowKey={(r) => String(r.store_id)}
      />
    </Seccion>
  )
}

function MetodoDePago({ rows }: { rows: SalesBucketOut[] }): React.JSX.Element {
  return (
    <Seccion titulo="Método de pago">
      {rows.length === 0 ? (
        <SinDato motivo="No hubo pagos en el período." />
      ) : (
        <ul className="flex flex-wrap gap-x-6 gap-y-2">
          {rows.map((r) => (
            <li key={r.key} className="flex items-baseline gap-2">
              <span className="rounded-md bg-muted px-2 py-0.5 text-sm font-bold">{methodLabel(r.key)}</span>
              <span className="font-bold tabular-nums">{formatCOP(r.net)}</span>
              <span className="text-sm text-muted-foreground tabular-nums">
                {r.payments ?? r.orders ?? "—"} {(r.payments ?? r.orders) === 1 ? "pago" : "pagos"} · {formatPct(r.share_bp)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Seccion>
  )
}

function VentasPorHora({ data }: { data: ReportsOverviewOut }): React.JSX.Element {
  const peak = data.peak_hour
  // Se muestran las horas entre la primera y la última con venta: es
  // selección de filas, no cuenta. El orden es el del servidor (día operativo).
  const rows = data.by_hour
  const conVenta = rows.map((r, i) => (r.net !== undefined && r.net > 0 ? i : -1)).filter((i) => i >= 0)
  const visibles = conVenta.length > 0 ? rows.slice(conVenta[0], conVenta[conVenta.length - 1]! + 1) : []
  const titular = peak
    ? `Hora pico: ${peak.label} con ${formatCOP(peak.net)} en ${peak.orders} ${peak.orders === 1 ? "comanda" : "comandas"}`
    : "Sin ventas en el período"
  return (
    <Seccion titulo="Ventas por hora">
      {visibles.length === 0 ? (
        <SinDato motivo="No hubo ventas en el período: no hay hora pico." />
      ) : (
        <ChartFrame
          titular={titular}
          tabla={{
            columnas: [
              { key: "hora", header: "Hora" },
              { key: "net", header: "Venta neta", align: "right" },
              { key: "orders", header: "Comandas", align: "right" },
            ],
            filas: visibles.map((r) => ({ hora: r.label ?? r.key, net: formatCOP(r.net), orders: String(r.orders ?? "—") })),
          }}
        >
          <ColumnChart
            datos={visibles.map((r) => ({ key: r.key, etiqueta: String(r.key).padStart(2, "0"), valor: r.net ?? null }))}
            formato={formatCOP}
            resaltar={peak ? String(peak.hour) : undefined}
            resumen={`Columnas de venta neta por hora; ${titular}.`}
          />
        </ChartFrame>
      )}
    </Seccion>
  )
}

const TODAS = "__todas__"

function TopDeProductos({ data }: { data: ReportsOverviewOut }): React.JSX.Element {
  const [categoria, setCategoria] = useState<string>(TODAS)
  const filtrados = categoria === TODAS ? data.products : data.products.filter((p) => p.category_key === categoria)
  const top = filtrados.slice(0, 10)
  const etiquetaCategoria = (v: string): string =>
    v === TODAS ? "Todas" : (data.categories.find((c) => c.key === v)?.label ?? v)
  return (
    <Seccion
      titulo="Top de productos"
      acciones={
        data.categories.length > 1 ? (
          <div className="flex items-center gap-2">
            <Label htmlFor="informes-categoria" className="text-xs">
              Categoría
            </Label>
            <Select value={categoria} onValueChange={(v) => setCategoria(v ?? TODAS)}>
              <SelectTrigger id="informes-categoria" className="h-8 w-44">
                <SelectValue>{(v: string) => etiquetaCategoria(v)}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={TODAS}>Todas</SelectItem>
                {data.categories.map((c) => (
                  <SelectItem key={c.key} value={c.key}>
                    {c.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null
      }
    >
      {top.length === 0 ? (
        <SinDato motivo="No se vendió ningún producto en el período." />
      ) : (
        <ChartFrame
          titular={`${top[0]!.label}: ${formatCOP(top[0]!.net)}${top[0]!.units !== null ? ` en ${top[0]!.units} u.` : ""}`}
          tabla={{
            columnas: [
              { key: "producto", header: "Producto" },
              { key: "units", header: "Unidades", align: "right" },
              { key: "net", header: "Venta neta", align: "right" },
            ],
            filas: top.map((p) => ({ producto: p.label, units: String(p.units ?? "—"), net: formatCOP(p.net) })),
          }}
        >
          <BarList
            max={10}
            datos={top.map((p) => ({
              key: p.key,
              etiqueta: p.label,
              valor: p.net,
              detalle: p.units !== null ? `${p.units} u.` : undefined,
            }))}
            formato={formatCOP}
          />
        </ChartFrame>
      )}
    </Seccion>
  )
}

function PorPersona({ rows, enlazar }: { rows: SalesBucketOut[]; enlazar: boolean }): React.JSX.Element {
  // Cada persona lleva a su ficha, que muestra esta misma fila (la ficha usa
  // la misma agregación). Con «Todas las sedes» no: la ficha es de una sede.
  const columns: readonly DenseColumn<SalesBucketOut>[] = [
    {
      key: "persona",
      header: "Persona",
      kind: "name",
      cell: (r) =>
        enlazar && /^\d+$/.test(r.key) ? (
          <Link to={fichaPersonaHref(Number(r.key))} className="text-primary hover:underline">
            {r.label ?? r.key}
          </Link>
        ) : (
          (r.label ?? r.key)
        ),
    },
    { key: "orders", header: "Comandas", kind: "number", cell: (r) => r.orders ?? "—" },
    { key: "net", header: "Venta neta", kind: "number", cell: (r) => formatCOP(r.net) },
    { key: "avg", header: "Ticket prom.", kind: "number", cell: (r) => formatCOP(r.avg_ticket) },
  ]
  return (
    <Seccion titulo="Por persona">
      {rows.length === 0 ? (
        <SinDato motivo="Nadie cobró en el período." />
      ) : (
        <DenseTable
          caption="Comandas, venta neta y ticket promedio de quien cobró"
          columns={columns}
          rows={rows}
          rowKey={(r) => r.key}
        />
      )}
    </Seccion>
  )
}

function CanalYZona({ channels, zones }: { channels: SalesBucketOut[]; zones: SalesBucketOut[] }): React.JSX.Element {
  const barras = (rows: SalesBucketOut[], label: (r: SalesBucketOut) => string) =>
    rows.map((r) => ({
      key: r.key,
      etiqueta: label(r),
      valor: r.net ?? null,
      detalle: `${r.orders ?? "—"} ${r.orders === 1 ? "comanda" : "comandas"} · ${formatPct(r.share_bp)}`,
    }))
  return (
    <Seccion titulo="Canal y zona">
      <div className="grid gap-6 md:grid-cols-2">
        <div className="min-w-0">
          <h3 className="mb-2 text-sm font-semibold">Canal</h3>
          {channels.length === 0 ? (
            <SinDato motivo="No hubo ventas en el período." />
          ) : (
            <BarList datos={barras(channels, (r) => channelLabel(r.key))} formato={formatCOP} />
          )}
        </div>
        <div className="min-w-0">
          <h3 className="mb-2 text-sm font-semibold">Zona</h3>
          {zones.length === 0 ? (
            <SinDato motivo="No hubo ventas en el período." />
          ) : (
            <BarList datos={barras(zones, (r) => r.label ?? r.key)} formato={formatCOP} />
          )}
        </div>
      </div>
    </Seccion>
  )
}

function DomiciliosYClientes({ data }: { data: ReportsOverviewOut }): React.JSX.Element {
  const dc = data.delivery_customers
  const canal = (row: SalesBucketOut | null, label: string, nombre: string) =>
    row ? (
      <StatTile
        label={label}
        value={formatCOP(row.net)}
        hint={`${row.orders ?? "—"} ${row.orders === 1 ? "comanda" : "comandas"} · ticket ${formatCOP(row.avg_ticket)}`}
      />
    ) : (
      <StatTile label={label} value={null} nullNote={`No hubo ventas por ${nombre} en el período.`} />
    )
  return (
    <Seccion titulo="Domicilios y clientes">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {canal(dc.delivery, "Domicilios", "domicilio")}
        {canal(dc.platform, "Plataformas", "plataforma")}
        <StatTile
          label="Clientes identificados"
          value={String(dc.identified_customers)}
          hint={`${dc.identified_orders} ${dc.identified_orders === 1 ? "comanda" : "comandas"} con datos de cliente`}
        />
      </div>
      {dc.missing.length > 0 ? (
        <ul className="mt-3 space-y-1">
          {dc.missing.map((m) => (
            <li key={m.key} className="text-sm">
              <span className="font-medium">{m.label}: </span>
              <SinDatoEnLinea motivo={m.reason} />
            </li>
          ))}
        </ul>
      ) : null}
    </Seccion>
  )
}

function SinDatoEnLinea({ motivo }: { motivo: string }): React.JSX.Element {
  return (
    <span className="sin-dato sin-dato--calmo">{motivo}</span>
  )
}

const CUADRANTES: readonly { key: keyof MenuSummaryOut; label: string }[] = [
  { key: "star", label: "Estrellas" },
  { key: "plowhorse", label: "Caballos de batalla" },
  { key: "puzzle", label: "Rompecabezas" },
  { key: "dog", label: "Perros" },
]

function IngenieriaDeMenu({ menu }: { menu: MenuSummaryOut }): React.JSX.Element {
  return (
    <Seccion
      titulo="Ingeniería de menú"
      acciones={
        <Link
          to="/admin/analitica"
          className="inline-flex items-center gap-1 text-sm font-bold text-primary hover:underline"
        >
          Ver la matriz completa
          <ArrowRight className="size-3.5" aria-hidden="true" />
        </Link>
      }
    >
      {menu.available ? (
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {CUADRANTES.map((c) => (
            <div key={c.key}>
              <dt className="text-sm text-muted-foreground">{c.label}</dt>
              <dd className="text-2xl font-semibold tabular-nums">{String(menu[c.key] ?? "—")}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <SinDato motivo={menu.reason ?? "No hay datos suficientes para clasificar los platos."} />
      )}
    </Seccion>
  )
}

function CostoYMargen({ data }: { data: ReportsOverviewOut }): React.JSX.Element {
  const cost = data.cost
  const columns: readonly DenseColumn<SalesBucketOut>[] = [
    { key: "cat", header: "Categoría", kind: "name", cell: (r) => r.label ?? r.key },
    { key: "net", header: "Venta neta", kind: "number", cell: (r) => formatCOP(r.net) },
    { key: "cost", header: "Costo teórico", kind: "number", cell: (r) => formatCOP(r.theoretical_cost) },
    { key: "margin", header: "Margen bruto", kind: "number", cell: (r) => formatCOP(r.gross_margin) },
    { key: "coverage", header: "Cobertura", kind: "number", cell: (r) => formatPercentInt(r.costed_pct) },
  ]
  return (
    <details className="group rounded-lg border bg-card p-4">
      <summary className="flex cursor-pointer list-none items-center gap-2 text-xs font-bold tracking-wide text-muted-foreground uppercase select-none">
        <ChevronRight className="size-4 transition-transform group-open:rotate-90" aria-hidden="true" />
        Costo y margen
      </summary>
      <div className="mt-3 space-y-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <StatTile
            label="Costo teórico"
            {...cifraOSinDato(cost.theoretical_cost, "Ninguna venta del período tuvo ficha técnica con costo.")}
          />
          <StatTile
            label="Margen bruto teórico"
            {...cifraOSinDato(cost.gross_margin, "Ninguna venta del período tuvo ficha técnica con costo.")}
          />
          <StatTile label="Cobertura de receta" value={formatPercentInt(cost.costed_pct)} />
        </div>
        {cost.by_category.length > 0 ? (
          <DenseTable
            caption="Costo teórico y margen por categoría"
            columns={columns}
            rows={cost.by_category}
            rowKey={(r) => r.key}
          />
        ) : null}
      </div>
    </details>
  )
}

function FilaDeComanda({ row }: { row: AdminOrderListItem }): React.JSX.Element {
  const [abierta, setAbierta] = useState(false)
  const idDetalle = useId()
  return (
    <li className="border-b last:border-b-0">
      <button
        type="button"
        aria-expanded={abierta}
        aria-controls={idDetalle}
        onClick={() => setAbierta((v) => !v)}
        className="flex w-full items-center gap-3 px-1 py-2 text-left text-sm hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        {abierta ? (
          <ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        ) : (
          <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        )}
        <span className="w-16 font-mono">#{row.id}</span>
        <span className="flex-1">{row.channel ? channelLabel(row.channel) : "—"}</span>
        <span className="hidden text-muted-foreground sm:inline">
          {row.status ? (ORDER_STATUS_LABEL[row.status] ?? row.status) : "—"}
        </span>
        <span className="w-28 text-right font-bold tabular-nums">{formatCOP(row.total)}</span>
      </button>
      {abierta ? (
        <div id={idDetalle} className="px-8 pb-3">
          <OrderDetailBody orderId={row.id} listRow={row} />
        </div>
      ) : null}
    </li>
  )
}

const HISTORIAL_VISIBLE = 50

function HistorialDeComandas({
  storeId,
  from,
  to,
}: {
  storeId: number | null
  from: string
  to: string
}): React.JSX.Element {
  const query = useQuery({
    queryKey: ["admin-orders", "list", { storeId, from, to }],
    queryFn: () => adminListOrders({ storeId: storeId as number, from, to }),
    enabled: storeId !== null,
  })
  const rows = query.data?.rows ?? []
  return (
    <Seccion
      titulo="Historial de comandas"
      acciones={
        storeId !== null ? (
          <Link
            to="/admin/pedidos"
            className="inline-flex items-center gap-1 text-sm font-bold text-primary hover:underline"
          >
            Filtrar en Pedidos
            <ArrowRight className="size-3.5" aria-hidden="true" />
          </Link>
        ) : null
      }
    >
      {storeId === null ? (
        <SinDato motivo="El historial se mira sede por sede: elegí una sede arriba." />
      ) : query.isLoading ? (
        <Cargando texto="Cargando comandas…" />
      ) : query.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(query.error)}
        </p>
      ) : rows.length === 0 ? (
        <SinDato motivo="No hubo comandas en el período." />
      ) : (
        <>
          <ul aria-label="Comandas del período">
            {rows.slice(0, HISTORIAL_VISIBLE).map((r) => (
              <FilaDeComanda key={r.id} row={r} />
            ))}
          </ul>
          {rows.length > HISTORIAL_VISIBLE ? (
            <p className="mt-2 text-xs text-muted-foreground">
              {HISTORIAL_VISIBLE} de {rows.length}; el resto, en Pedidos.
            </p>
          ) : null}
        </>
      )}
    </Seccion>
  )
}

// ---------------------------------------------------------------------------
// Las cinco preguntas (handoff, pantalla 11).
// ---------------------------------------------------------------------------

/** Una sección del scroll: el nombre (h2 de 18 px) y, a la derecha, sus controles. */
function Pregunta({
  titulo,
  subtitulo,
  acciones,
  children,
}: {
  titulo: string
  subtitulo?: string
  acciones?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  const id = useId()
  return (
    <section aria-labelledby={id} className="flex min-w-0 flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 id={id} className="text-lg leading-snug font-bold">
          {titulo}
        </h2>
        {subtitulo ? <span className="text-[13px] text-muted-foreground">{subtitulo}</span> : null}
        {acciones ? <div className="ml-auto">{acciones}</div> : null}
      </div>
      {children}
    </section>
  )
}

/**
 * El control segmentado del handoff (fondo `muted`, la opción elegida en
 * `card` con sombra). Es un grupo de botones con `aria-pressed`: se alcanza
 * con el teclado y se lee como un grupo con nombre.
 */
/** «▲ +4,1 %», «▼ −1,8 %», «= 0,0 %»: la variación que manda el servidor, con flecha y signo. */
function deltaConFlecha(bp: number | null | undefined, decimales = 1): string | null {
  const texto = formatPctConSigno(bp, decimales)
  if (texto === null || bp === null || bp === undefined) return null
  return `${bp > 0 ? "▲" : bp < 0 ? "▼" : "="} ${texto}`
}

/** «lun 22», «lun 22 y mar 23», «lun 22, mar 23 y jue 25». */
function enumerar(partes: readonly string[]): string {
  if (partes.length <= 1) return partes[0] ?? ""
  return `${partes.slice(0, -1).join(", ")} y ${partes[partes.length - 1]}`
}

function Ventas({
  data,
  nombreSede,
  contraSemana,
}: {
  data: ReportsOverviewOut
  nombreSede: string
  contraSemana: boolean
}): React.JSX.Element {
  const t = data.total
  const p = t.previous_period
  const ds = data.series?.daily_sales
  const delta = deltaConFlecha(p?.delta_bp)
  // Con muy pocas comandas en alguno de los dos períodos (lo marca el
  // servidor), «+136,7 %» o «▼ −100 %» no es una tendencia: se dice apagado.
  const pocaBase = p?.low_base === true && p.net !== null
  const comparacion = p
    ? {
        label: contraSemana ? "Contra semana anterior" : `Contra ${formatRangoCorto(p.date_from, p.date_to)}`,
        delta: pocaBase ? "Muy pocas comandas para comparar" : p.net === null ? "—" : (delta ?? "—"),
        detail:
          p.net === null
            ? (p.null_reason ?? "Sin período anterior.")
            : pocaBase
              ? `${contraSemana ? "La semana anterior" : "El período anterior"}: ${formatCOP(p.net)} en ${(p.orders ?? 0).toLocaleString("es-CO")} ${p.orders === 1 ? "comanda" : "comandas"}`
              : formatCOP(p.net),
        tono: pocaBase || p.net === null || delta === null ? ("apagada" as const) : undefined,
      }
    : undefined
  // Un eje sin ventas ni raya firme no dice nada: la pregunta y una línea.
  const sinVentas =
    ds?.available === true &&
    ds.points.every((pt) => !pt.value) &&
    ds.points.every((pt) => !pt.reference || pt.low_base === true)

  const resumen: RenglonResumen[] = []
  if (ds && ds.available) {
    if (ds.days_with_reference > 0) {
      resumen.push({
        titulo: `${ds.days_above} de ${ds.days_with_reference} días por encima`,
        detalle: pocaBase
          ? "Con tan pocas comandas, la variación del período no es una tendencia."
          : delta !== null && p?.net !== null
            ? `${contraSemana ? "La semana" : "El período"} cerró ${delta} contra ${contraSemana ? "la anterior" : "el anterior"}.`
            : "Sin variación del período: el anterior no tiene base.",
        // Contar días del lado bueno no es una cifra de negocio: es mirar
        // cuántos puntos marcó el servidor.
        tono: ds.days_above * 2 >= ds.days_with_reference ? "success" : "warning",
      })
      const abajo = ds.points.filter((pt) => pt.outside).map((pt) => pt.label)
      if (abajo.length > 0) {
        resumen.push({
          titulo: `${enumerar(abajo)} ${abajo.length === 1 ? "quedó abajo" : "quedaron abajo"}`,
          detalle: "Revisá esos días en Ventas: clima, eventos o personal.",
          tono: "warning",
        })
      }
      const mejor = ds.points.find((pt) => pt.key === ds.best_key)
      if (mejor) {
        resumen.push({ titulo: `El mejor: ${mejor.label}`, detalle: "El que más creció contra su mismo día.", tono: "data" })
      }
    } else {
      resumen.push({
        titulo: "Sin semana anterior con qué comparar",
        detalle: "No hubo ventas esos días: la raya aparece cuando haya una semana de historia.",
        tono: "muted",
      })
    }
  }

  return (
    <Pregunta titulo="Ventas">
      <HeadlineFigure
        label={`Ventas netas · ${nombreSede}`}
        value={formatCOP(t.net)}
        note={[
          `${(t.orders ?? 0).toLocaleString("es-CO")} ${t.orders === 1 ? "comanda" : "comandas"}`,
          t.avg_ticket !== null && t.avg_ticket !== undefined ? `ticket promedio ${formatCOP(t.avg_ticket)}` : null,
        ]
          .filter(Boolean)
          .join(" · ")}
        ledger={{
          rows: [
            { label: "Cobrado en caja y medios", value: formatCOP(t.gross) },
            { label: "Impuesto discriminado", value: formatCOP(t.tax), kind: "subtract" },
          ],
          total: { label: "Ventas netas", value: formatCOP(t.net) },
        }}
        belowTheLine={{ label: "Propinas · pasan a los meseros, no son venta", value: formatCOP(t.tips) }}
        comparison={comparacion}
      />
      {!ds ? null : !ds.available ? (
        <SinDato motivo={ds.reason ?? "No se puede comparar día por día este período."} />
      ) : (
        <BarrasConReferencia
          pregunta={
            contraSemana
              ? "¿Vendí más o menos que la semana pasada?"
              : "¿Vendí más o menos que el mismo día de la semana anterior?"
          }
          variante="columnas"
          malo="debajo"
          flechas
          alto={210}
          formato={formatCOP}
          leyenda={{
            barra: contraSemana ? "Esta semana" : "Ventas netas del día",
            fuera: "Por debajo de la semana anterior",
            raya: "El mismo día de la semana anterior",
          }}
          puntos={ds.points.map((pt) => ({
            key: pt.key,
            etiqueta: pt.label,
            valor: pt.value,
            referencia: pt.reference,
            fuera: pt.outside,
            ahora: pt.now,
            futuro: pt.future,
            // Sin variación (sin raya) o con poca base: arriba no se escribe
            // nada. Un «—» encima de cada día vacío se leía como un error.
            cifra: pt.value === null ? undefined : pt.low_base ? "" : (formatPctConSigno(pt.delta_bp) ?? ""),
            detalle: formatCompacto(pt.value),
          }))}
          rotuloResumen={contraSemana ? "La semana en una línea" : "El período en una línea"}
          resumen={sinVentas ? undefined : resumen}
          vacio={
            sinVentas
              ? contraSemana
                ? "Todavía no hay ventas en estos siete días, ni una semana anterior firme con qué compararlos."
                : "No hay ventas en este período, ni un período anterior firme con qué compararlo."
              : null
          }
        />
      )}
    </Pregunta>
  )
}

function Margen({ data }: { data: ReportsOverviewOut }): React.JSX.Element | null {
  const cm = data.series?.category_margin
  if (!cm) return null
  const meta = cm.reference
  const bajo = cm.points.filter((pt) => pt.outside)
  const sobre = cm.points.filter((pt) => !pt.outside && pt.value !== null && meta !== null)
  const resumen: RenglonResumen[] = []
  for (const pt of bajo.slice(0, 2)) {
    resumen.push({
      titulo: `${pt.label}: ${formatPct(pt.value, 0)}`,
      detalle: `Bajo la meta de ${formatPct(meta, 0)}. Revisá el costo de sus platos y su precio.`,
      tono: "warning",
    })
  }
  if (meta !== null && bajo.length === 0 && sobre.length > 0) {
    resumen.push({
      titulo: "Todas las categorías con costo llegan a la meta",
      detalle: `Ninguna queda bajo ${formatPct(meta, 0)}.`,
      tono: "success",
    })
  }
  if (sobre.length > 0 && bajo.length > 0) {
    const top = sobre.slice(0, 2).map((pt) => pt.label)
    resumen.push({
      titulo: `${enumerar(top)} ${top.length === 1 ? "sostiene" : "sostienen"}`,
      detalle: "Sobre la meta: ofrecerlas en cada mesa sube el margen total.",
      tono: "success",
    })
  }
  const sinCosto = cm.points.filter((pt) => pt.value === null).map((pt) => pt.label)
  if (sinCosto.length > 0) {
    resumen.push({
      titulo: `${sinCosto.length} ${sinCosto.length === 1 ? "categoría" : "categorías"} sin costo`,
      detalle: `${enumerar(sinCosto)}: sin ficha técnica no hay margen. No es 0 %.`,
      tono: "muted",
    })
  }

  return (
    <Pregunta titulo="Margen">
      {cm.points.length === 0 ? (
        <SinDato motivo={cm.reason ?? "No se vendió nada en el período."} />
      ) : (
        <>
          <BarrasConReferencia
            pregunta="¿Qué categoría deja menos plata?"
            variante="filas"
            malo="debajo"
            maximo={10_000}
            formato={(v) => formatPct(v, 0)}
            referenciaComun={meta}
            leyenda={{
              barra: "Margen de la categoría",
              fuera: "Bajo la meta",
              raya: meta !== null ? `Meta: ${formatPct(meta, 0)}` : "Sin meta común",
            }}
            acciones={
              <span className="flex flex-wrap items-baseline gap-x-7 gap-y-1 text-[13px] text-muted-foreground">
                <span>
                  Margen bruto{" "}
                  <b className="text-xl text-foreground tabular-nums">
                    {cm.total_bp === null ? "sin dato" : formatPct(cm.total_bp)}
                  </b>
                </span>
                <span>
                  Costo de lo vendido{" "}
                  <b className="text-foreground tabular-nums">
                    {data.cost.theoretical_cost === null ? "sin dato" : formatCOP(data.cost.theoretical_cost)}
                  </b>
                </span>
              </span>
            }
            puntos={cm.points.map((pt) => ({
              key: pt.key,
              etiqueta: pt.label,
              valor: pt.value,
              referencia: pt.reference,
              fuera: pt.outside,
              cifra: pt.value === null ? undefined : formatPct(pt.value, 0),
              detalle:
                pt.outside && pt.gap_bp !== null
                  ? `${formatPuntos(pt.gap_bp)} bajo la meta`
                  : pt.delta_points_bp === null
                    ? undefined
                    : pt.delta_points_bp === 0
                      ? "igual"
                      : `${pt.delta_points_bp > 0 ? "▲ +" : "▼ −"}${formatPuntos(Math.abs(pt.delta_points_bp))}`,
            }))}
            rotuloResumen="Qué mirar"
            resumen={resumen}
          />
          {cm.reason ? <p className="text-xs text-muted-foreground">{cm.reason}</p> : null}
        </>
      )}
    </Pregunta>
  )
}

const GRUPO_MIX: Record<DishMixGroup, { titulo: string; accion: string; tono: RenglonResumen["tono"] }> = {
  keep: { titulo: "Venden y dejan", accion: "Cuidarlos: que nunca falten.", tono: "success" },
  reprice: { titulo: "Venden, pero dejan poco", accion: "Revisar receta o precio.", tono: "data" },
  promote: { titulo: "Dejan, pero venden poco", accion: "Que el mesero los recomiende.", tono: "data" },
  review: { titulo: "▲ Revisar", accion: "Venden poco y dejan poco.", tono: "warning" },
}

function MixDePlatos({ data }: { data: ReportsOverviewOut }): React.JSX.Element | null {
  const id = useId()
  const mix = data.series?.dish_mix
  if (!mix) return null
  if (!mix.available || mix.avg_units === null || mix.avg_margin_bp === null) {
    return (
      <Pregunta titulo="Mix de platos">
        <SinDato motivo={mix.reason ?? "No hay platos con costo en el período."} />
      </Pregunta>
    )
  }
  const resumen: RenglonResumen[] = (["keep", "reprice", "promote", "review"] as const)
    .map((g) => ({ g, nombres: mix.points.filter((pt) => pt.group === g).map((pt) => pt.label) }))
    .filter((x) => x.nombres.length > 0)
    .map(({ g, nombres }) => ({
      titulo: GRUPO_MIX[g].titulo,
      detalle: `${enumerar(nombres)}. ${GRUPO_MIX[g].accion}`,
      tono: GRUPO_MIX[g].tono,
    }))
  return (
    <Pregunta titulo="Mix de platos">
      <section aria-labelledby={id} className="flex min-w-0 flex-col rounded-lg border bg-card md:flex-row">
        <div className="flex min-w-0 flex-1 flex-col gap-2 p-4">
          <h3 id={id} className="m-0 text-[15px] leading-snug font-bold">
            ¿Qué platos venden y dejan plata?
          </h3>
          <QuadrantScatter
            variante="mix"
            alto={300}
            puntos={mix.points.map((pt) => ({
              key: pt.key,
              etiqueta: pt.label,
              x: pt.units,
              y: pt.margin_bp,
              detalle: formatPct(pt.margin_bp, 0),
              alerta: pt.group === "review",
            }))}
            umbralX={{ valor: mix.avg_units, etiqueta: `Promedio ${mix.avg_units.toLocaleString("es-CO")} u.` }}
            umbralY={{ valor: mix.avg_margin_bp, etiqueta: `Promedio ${formatPct(mix.avg_margin_bp, 0)}` }}
            ejeX={{ titulo: "Unidades vendidas · más a la derecha vende más →", formato: (v) => v.toLocaleString("es-CO") }}
            ejeY={{ titulo: "Margen · más arriba deja más ↑", formato: (v) => formatPct(v, 0) }}
            cuadrantes={["Venden y dejan", "Dejan, pero venden poco", "Revisar", "Venden, pero dejan poco"]}
            cuadranteAlerta={2}
          />
          {mix.without_cost > 0 ? (
            <p className="text-xs text-muted-foreground">
              {mix.without_cost} {mix.without_cost === 1 ? "plato vendido no tiene" : "platos vendidos no tienen"} costo:
              sin costo no hay margen que ubicar. No es 0 %.
            </p>
          ) : null}
        </div>
        <ResumenLateral rotulo="Qué hacer con cada grupo" renglones={resumen} />
      </section>
    </Pregunta>
  )
}

const DIA_PLURAL: Record<string, string> = {
  mon: "Los lunes",
  tue: "Los martes",
  wed: "Los miércoles",
  thu: "Los jueves",
  fri: "Los viernes",
  sat: "Los sábados",
  sun: "Los domingos",
}

function HorasPico({ serie }: { serie: PeakHoursSeriesOut }): React.JSX.Element {
  const [dia, setDia] = useState("avg")
  const vista = serie.views.find((v) => v.key === dia) ?? serie.views[0]
  const opw = serie.orders_per_waiter
  if (!serie.available || !vista) {
    return (
      <Pregunta titulo="Horas pico" subtitulo="¿A qué horas falta gente en el salón?">
        <SinDato motivo={serie.reason ?? "No hay comandas de salón en el período."} />
      </Pregunta>
    )
  }
  const selector = (
    <Segmentado
      etiqueta="Día de la semana"
      chico
      opciones={serie.views.map((v) => ({ value: v.key, label: v.label }))}
      valor={vista.key}
      onChange={setDia}
    />
  )
  // Franjas seguidas de horas que el servidor marcó como pasadas: sólo se
  // agrupan puntos, no se calcula nada.
  const franjas: { desde: number; hasta: number }[] = []
  vista.points.forEach((pt, i) => {
    if (!pt.outside) return
    const ultima = franjas[franjas.length - 1]
    if (ultima && ultima.hasta === i - 1) ultima.hasta = i
    else franjas.push({ desde: i, hasta: i })
  })
  const resumen: RenglonResumen[] =
    vista.days === 0
      ? [{ titulo: "Sin días operados", detalle: "Ese día de la semana no hubo servicio en el período.", tono: "muted" }]
      : franjas.length === 0
        ? [
            {
              titulo: "El salón alcanza todas las horas",
              detalle:
                opw !== null
                  ? `Ninguna hora pasa de ${opw} comandas por mesero.`
                  : "Ninguna hora pasa lo que alcanzan los meseros en turno.",
              tono: "success",
            },
          ]
        : franjas.map(({ desde, hasta }) => {
            const fin = vista.points[hasta + 1]?.label
            return {
              titulo: fin ? `De ${vista.points[desde]!.label} a ${fin}` : `Desde ${vista.points[desde]!.label}`,
              detalle: "Llegan más comandas de las que alcanza el salón con los meseros en turno.",
              tono: "warning" as const,
            }
          })
  const nombreDia = DIA_PLURAL[vista.key] ?? vista.label
  const rotulo =
    vista.key === "avg" ? `Promedio de ${vista.days} ${vista.days === 1 ? "día operado" : "días operados"}` : nombreDia
  return (
    <Pregunta titulo="Horas pico" subtitulo="¿A qué horas falta gente en el salón?" acciones={selector}>
      <BarrasConReferencia
        pregunta={
          vista.key === "avg"
            ? "Comandas de salón por hora, promedio del período"
            : `Comandas de salón por hora, ${nombreDia.toLowerCase()}`
        }
        variante="columnas"
        malo="encima"
        alto={200}
        formato={(v) => v.toLocaleString("es-CO")}
        unidadExtra="meseros"
        leyenda={{
          barra: "Comandas por hora",
          fuera: "Pasan lo que el salón alcanza",
          raya:
            opw !== null
              ? `Lo que alcanzan a atender los meseros en turno (${opw} por persona)`
              : "Lo que alcanzan a atender los meseros en turno",
        }}
        puntos={vista.points.map((pt) => ({
          key: pt.key,
          etiqueta: pt.label,
          valor: pt.value,
          referencia: pt.reference,
          fuera: pt.outside,
          extra: pt.waiters === null ? undefined : String(pt.waiters),
        }))}
        rotuloResumen={rotulo}
        resumen={resumen}
      />
    </Pregunta>
  )
}

function PorSedeBarras({
  serie,
  total,
}: {
  serie: StoresWeekSeriesOut
  total: SalesBucketOut | null
}): React.JSX.Element {
  const p = total?.previous_period
  const deltaTotal = p && p.net !== null ? deltaConFlecha(p.delta_bp) : null
  return (
    <Pregunta titulo="Por sede">
      <BarrasConReferencia
        pregunta="¿Qué sede va mejor?"
        variante="filas"
        malo="debajo"
        formato={formatCOP}
        leyenda={{
          barra: "Ventas netas del período",
          fuera: "Vendió menos que el período anterior",
          raya: "Período anterior",
        }}
        puntos={serie.points.map((pt) => ({
          key: pt.key,
          etiqueta: pt.label,
          valor: pt.value,
          referencia: pt.reference,
          fuera: pt.outside,
          cifra: pt.value === null ? undefined : formatCOP(pt.value),
          // Del lado malo la flecha ya va en la cifra: acá sólo el signo.
          detalle:
            pt.delta_bp === null
              ? "sin período anterior"
              : pt.outside
                ? (formatPctConSigno(pt.delta_bp, 1) ?? undefined)
                : (deltaConFlecha(pt.delta_bp) ?? undefined),
        }))}
        rotuloResumen="Ticket y margen por sede"
        resumen={serie.points.map((pt) => ({
          titulo: pt.label,
          detalle: `Ticket ${pt.avg_ticket === null ? "sin dato" : formatCOP(pt.avg_ticket)} · margen ${
            pt.margin_bp === null || pt.margin_bp === undefined ? "sin dato" : formatPct(pt.margin_bp)
          }`,
          tono: "muted",
        }))}
      />
      {total ? (
        <p className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-t-[3px] border-double border-foreground/60 px-1 pt-2 text-sm font-bold">
          <span>Todas</span>
          <span className="text-xs font-normal text-muted-foreground">
            Ticket promedio{" "}
            {total.avg_ticket === null || total.avg_ticket === undefined ? "sin dato" : formatCOP(total.avg_ticket)}
          </span>
          <span className="ml-auto tabular-nums">
            {formatCOP(total.net)}
            {deltaTotal ? ` · ${deltaTotal}` : ""}
          </span>
        </p>
      ) : null}
    </Pregunta>
  )
}

/** Lo que había antes en Informes, intacto y plegado al pie: nada se borró. */
function MasDelPeriodo({
  data,
  consolidado,
  esAdmin,
  storeId,
  from,
  to,
}: {
  data: ReportsOverviewOut
  consolidado: boolean
  esAdmin: boolean
  storeId: number | null
  from: string
  to: string
}): React.JSX.Element {
  return (
    <details className="group rounded-lg border bg-card">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm font-semibold select-none">
        <ChevronRight className="size-4 transition-transform group-open:rotate-90" aria-hidden="true" />
        Más del período: medios de pago, horas, productos, personas, canales, clientes y comandas
      </summary>
      <div className="space-y-5 border-t p-4">
        <Indicadores total={data.total} />
        {data.by_store ? <PorSede rows={data.by_store} /> : null}
        <MetodoDePago rows={data.by_method} />
        <VentasPorHora data={data} />
        <div className="grid gap-5 lg:grid-cols-2">
          <TopDeProductos data={data} />
          <PorPersona rows={data.by_employee} enlazar={!consolidado} />
        </div>
        <CanalYZona channels={data.by_channel} zones={data.by_zone} />
        <DomiciliosYClientes data={data} />
        <IngenieriaDeMenu menu={data.menu_engineering} />
        {esAdmin ? <CostoYMargen data={data} /> : null}
        <HistorialDeComandas storeId={storeId} from={from} to={to} />
      </div>
    </details>
  )
}

// ---------------------------------------------------------------------------
// La pantalla.
// ---------------------------------------------------------------------------

export function InformesPage(): React.JSX.Element {
  const { stores, activeStoreId, loading: storeLoading } = useStoreSelection()
  const { me, hasFeature } = useSession()
  const hoy = todayInBogota()
  const [periodo, setPeriodo] = useState<Periodo>("ultimos7")
  const [rango, setRango] = useState(() => rangoDePeriodo("ultimos7", hoy))
  // La sede elegida en ESTA pantalla (el selector segmentado del handoff).
  // `null` = la de entrada: todas si hay más de una, la activa si no.
  const [sedeElegida, setSedeElegida] = useState<number | "all" | null>(null)

  const conSelector = stores.length > 1 || hasFeature("multi_store")
  const sede: number | "all" | null = !conSelector
    ? activeStoreId
    : (sedeElegida ?? (stores.length > 1 ? "all" : activeStoreId))
  const consolidado = sede === "all"
  const { from, to } = periodo === "rango" ? rango : rangoDePeriodo(periodo, hoy)
  const rangoValido = from !== "" && to !== "" && from <= to

  const query = useQuery({
    queryKey: ["admin-reports-overview", sede, from, to],
    queryFn: () => getReportsOverview({ storeId: sede as number | "all", from, to }),
    enabled: sede !== null && rangoValido,
  })
  // «Por sede» compara las sedes aunque arriba haya una elegida: es la misma
  // consulta consolidada (misma llave de caché), no una cuenta nueva.
  const todas = useQuery({
    queryKey: ["admin-reports-overview", "all", from, to],
    queryFn: () => getReportsOverview({ storeId: "all", from, to }),
    enabled: stores.length > 1 && !consolidado && rangoValido,
  })

  if (storeLoading) return <Cargando texto="Cargando sedes…" />
  if (activeStoreId === null) {
    return <p className="text-sm text-muted-foreground">Todavía no hay sedes creadas.</p>
  }

  const nombreDe = (id: number): string => stores.find((s) => s.id === id)?.name ?? "Sede activa"
  const nombreSede = consolidado ? "todas las sedes" : nombreDe(sede as number)
  const data = query.data
  const esAdmin = me?.kind === "admin"
  const contraSemana = periodo === "ultimos7"
  const previo = data?.total.previous_period
  const datosSedes = consolidado ? data : todas.data
  const serieSedes = datosSedes?.series?.stores_week

  const opcionesSede: { value: number | "all"; label: string }[] = [
    { value: "all", label: "Todas las sedes" },
    ...stores.map((s) => ({ value: s.id, label: s.name })),
  ]

  return (
    <div className="mx-auto max-w-6xl space-y-[22px]">
      <PageHeader
        name="Informes"
        question="Cómo te fue en el período, en cinco preguntas: si vendiste más que la semana pasada, qué categoría deja menos plata, qué platos venden y dejan, a qué horas falta gente y qué sede va mejor. Las cifras las calcula el servidor con la misma cuenta que Ventas."
        context={[
          {
            label: periodo === "ultimos7" ? "Últimos 7 días cerrados ·" : "Período ·",
            value: rangoValido ? formatRangoConDia(from, to) : "—",
          },
          ...(previo
            ? [
                {
                  label: `Contra ${contraSemana ? "la semana" : "el período"} anterior · ${formatRangoConDia(previo.date_from, previo.date_to)}`,
                },
              ]
            : []),
          ...(periodo === "ultimos7" ? [{ label: "Hoy no entra: el día sigue abierto" }] : []),
        ]}
        actions={
          <>
            {conSelector ? (
              <Segmentado
                etiqueta="Sede"
                opciones={opcionesSede}
                valor={sede ?? activeStoreId}
                onChange={(v) => setSedeElegida(v)}
              />
            ) : null}
            <Select
              value={periodo}
              onValueChange={(v) => {
                const nuevo = (v ?? "ultimos7") as Periodo
                if (nuevo === "rango") setRango({ from, to })
                setPeriodo(nuevo)
              }}
            >
              <SelectTrigger aria-label="Período" className="h-9 min-w-40 gap-1.5 bg-card text-[13px]">
                <Calendar className="size-3.5 shrink-0" aria-hidden="true" />
                <SelectValue>{(v: string) => PERIODOS.find((p) => p.value === v)?.label ?? v}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {PERIODOS.map((p) => (
                  <SelectItem key={p.value} value={p.value}>
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {sede !== null && rangoValido ? (
              <CsvExportButton href={csvUrl("/admin/reports/overview", { store_id: sede, from, to })} />
            ) : null}
          </>
        }
      >
        {periodo === "rango" ? (
          <DateRangeFilter idPrefix="informes" from={rango.from} to={rango.to} onChange={(r) => setRango(r)} />
        ) : null}
      </PageHeader>

      {query.isLoading ? (
        <Cargando texto="Cargando informes…" />
      ) : query.isError ? (
        <EmptyState
          reason="error"
          title="No se pudieron cargar los informes"
          description={errorMessage(query.error)}
          action={{ label: "Reintentar", onClick: () => void query.refetch() }}
        />
      ) : data ? (
        <div className="space-y-[22px]">
          <Ventas data={data} nombreSede={nombreSede} contraSemana={contraSemana} />
          {/* Margen y mix hablan de costo: sólo el administrador (el operador
              no recibe costos ni márgenes, AGENTS.md). */}
          {esAdmin ? <Margen data={data} /> : null}
          {esAdmin ? <MixDePlatos data={data} /> : null}
          {data.series ? <HorasPico key={`${String(sede)}-${from}-${to}`} serie={data.series.peak_hours} /> : null}
          {stores.length > 1 && serieSedes ? (
            <PorSedeBarras serie={serieSedes} total={datosSedes?.total ?? null} />
          ) : null}
          <MasDelPeriodo
            data={data}
            consolidado={consolidado}
            esAdmin={esAdmin}
            storeId={consolidado ? null : (sede as number)}
            from={from}
            to={to}
          />
        </div>
      ) : null}
    </div>
  )
}

export default InformesPage
