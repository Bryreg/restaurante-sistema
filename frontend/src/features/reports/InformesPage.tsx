import { useQuery } from "@tanstack/react-query"
import { ArrowRight, ChevronDown, ChevronRight } from "lucide-react"
import { useId, useState } from "react"
import { Link } from "react-router-dom"

import { adminListOrders, type AdminOrderListItem } from "@/api/orders"
import {
  getReportsOverview,
  type MenuSummaryOut,
  type PreviousPeriodOut,
  type ReportsOverviewOut,
  type SalesBucketOut,
  type StoreRowOut,
} from "@/api/reports"
import { useSession } from "@/app/session"
import { useStoreSelection } from "@/app/storeContext"
import { DenseTable, PageHeader, type DenseColumn } from "@/components/admin"
import { Cargando } from "@/components/Cargando"
import { BarList, ChartFrame, ColumnChart } from "@/components/charts"
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
import { CHANNEL_LABEL, ORDER_STATUS_LABEL } from "@/features/orders/lib"

import {
  formatDelta,
  formatPercentInt,
  formatRangoCorto,
  methodLabel,
  rangoDePeriodo,
  todayInBogota,
  type Periodo,
} from "./lib"

/**
 * «Informes»: todo el período en un solo scroll, número primero (el dueño lo
 * pidió mirando el Informes de café-sistema). Una sola llamada
 * (`GET /admin/reports/overview`) trae todas las secciones; esta pantalla no
 * suma ni divide plata: formatea lo que manda el servidor, elige qué filas
 * mostrar y en qué forma.
 */

const PERIODOS: readonly { value: Periodo; label: string }[] = [
  { value: "hoy", label: "Hoy" },
  { value: "semana", label: "Semana" },
  { value: "mes", label: "Mes" },
  { value: "rango", label: "Rango" },
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
    <p className="text-sm text-muted-foreground">
      <span className="sin-dato mr-2 px-2 py-0.5">Sin dato</span>
      {motivo}
    </p>
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

function PorPersona({ rows }: { rows: SalesBucketOut[] }): React.JSX.Element {
  const columns: readonly DenseColumn<SalesBucketOut>[] = [
    { key: "persona", header: "Persona", kind: "name", cell: (r) => r.label ?? r.key },
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
    <span className="text-muted-foreground">
      <span className="sin-dato mr-1.5 px-1.5 py-0.5 text-xs">Sin dato</span>
      {motivo}
    </span>
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
// La pantalla.
// ---------------------------------------------------------------------------

export function InformesPage(): React.JSX.Element {
  const { stores, activeStoreId, loading: storeLoading } = useStoreSelection()
  const { me, hasFeature } = useSession()
  const hoy = todayInBogota()
  const [periodo, setPeriodo] = useState<Periodo>("semana")
  const [rango, setRango] = useState(() => rangoDePeriodo("semana", hoy))
  const [todas, setTodas] = useState(false)

  const conSelector = stores.length > 1 || hasFeature("multi_store")
  const consolidado = conSelector && todas
  const storeParam: number | "all" | null = consolidado ? "all" : activeStoreId
  const { from, to } = periodo === "rango" ? rango : rangoDePeriodo(periodo, hoy)

  const query = useQuery({
    queryKey: ["admin-reports-overview", storeParam, from, to],
    queryFn: () => getReportsOverview({ storeId: storeParam as number | "all", from, to }),
    enabled: storeParam !== null && from !== "" && to !== "" && from <= to,
  })

  if (storeLoading) return <Cargando texto="Cargando sedes…" />
  if (activeStoreId === null) {
    return <p className="text-sm text-muted-foreground">Todavía no hay sedes creadas.</p>
  }

  const activa = stores.find((s) => s.id === activeStoreId)?.name ?? "Sede activa"
  const data = query.data

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <PageHeader
        name="Informes"
        question="Cómo te fue en el período: venta, cómo te pagaron, a qué hora, qué se vendió, quién vendió y por qué canal, todo en una sola página. Las cifras las calcula el servidor con la misma cuenta que Ventas."
        context={[
          { label: "Período", value: formatRangoCorto(from, to) },
          { label: "Sede", value: consolidado ? `Todas (${stores.length})` : activa },
        ]}
        actions={
          <>
            {conSelector ? (
              <div role="group" aria-label="Sede" className="flex items-center gap-1">
                <span className="mr-1 text-sm text-muted-foreground">Sede:</span>
                {[
                  { value: false, label: activa },
                  { value: true, label: "Todas las sedes" },
                ].map((o) => (
                  <button
                    key={String(o.value)}
                    type="button"
                    aria-pressed={todas === o.value}
                    onClick={() => setTodas(o.value)}
                    className={cn(
                      "rounded-md border px-3 py-1 text-sm",
                      todas === o.value
                        ? "border-primary bg-primary text-primary-foreground font-bold"
                        : "border-border bg-card text-foreground hover:bg-accent",
                    )}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            ) : null}
            <div role="group" aria-label="Período" className="flex items-center gap-1">
              {PERIODOS.map((p) => (
                <button
                  key={p.value}
                  type="button"
                  aria-pressed={periodo === p.value}
                  onClick={() => {
                    if (p.value === "rango") setRango({ from, to })
                    setPeriodo(p.value)
                  }}
                  className={cn(
                    "rounded-full px-3 py-1 text-sm",
                    periodo === p.value
                      ? "bg-primary font-bold text-primary-foreground"
                      : "bg-muted text-foreground hover:bg-accent",
                  )}
                >
                  {p.label}
                </button>
              ))}
            </div>
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
        <div className="space-y-5">
          <Indicadores total={data.total} />
          {data.by_store ? <PorSede rows={data.by_store} /> : null}
          <MetodoDePago rows={data.by_method} />
          <VentasPorHora data={data} />
          <div className="grid gap-5 lg:grid-cols-2">
            <TopDeProductos data={data} />
            <PorPersona rows={data.by_employee} />
          </div>
          <CanalYZona channels={data.by_channel} zones={data.by_zone} />
          <DomiciliosYClientes data={data} />
          <IngenieriaDeMenu menu={data.menu_engineering} />
          {me?.kind === "admin" ? <CostoYMargen data={data} /> : null}
          <HistorialDeComandas storeId={consolidado ? null : activeStoreId} from={from} to={to} />
        </div>
      ) : null}
    </div>
  )
}

export default InformesPage
