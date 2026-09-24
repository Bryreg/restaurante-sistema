import { useQuery } from "@tanstack/react-query"
import { useState } from "react"

import { useStoreSelection } from "@/app/storeContext"
import {
  adminGetOrder,
  adminListOrders,
  adminOrdersCsvUrl,
  type AdminOrderKitchenStationTimeOut,
  type AdminOrderListItem,
  type AdminOrdersReportOut,
  type OrderOut,
} from "@/api/orders"
import {
  DenseTable,
  DenseTableBar,
  FilterEmptyState,
  GroupLabel,
  PageHeader,
  TimeAgo,
  type DenseColumn,
  type LegendEntry,
} from "@/components/admin"
import { Cargando } from "@/components/Cargando"
import { CsvExportButton } from "@/components/CsvExportButton"
import { DateRangeFilter } from "@/components/DateRangeFilter"
import { EmptyState } from "@/components/EmptyState"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { CategoryBars } from "@/features/reports/charts"
import { formatPercent } from "@/features/reports/lib"
import { errorMessage } from "@/lib/errors"
import { cn } from "@/lib/utils"
import { formatCOP } from "@/lib/money"
import { formatInstant } from "@/lib/businessDate"

import { CHANNEL_LABEL, ORDER_STATUS_LABEL, VOID_REASON_LABEL } from "./lib"

const FLAG_OPTIONS: { value: string; label: string }[] = [
  { value: "voided", label: "Anuladas" },
  { value: "courtesy", label: "Con cortesía" },
  { value: "discounted", label: "Con descuento" },
  { value: "staff_meal", label: "Consumo de personal" },
  { value: "transferred", label: "Trasladadas" },
  { value: "after_bill", label: "Cambios después de la cuenta" },
]

/** La leyenda del pie: las distinciones que Pedidos separa a propósito. */
const ORDERS_LEGEND: readonly LegendEntry[] = [
  {
    term: "Tras la cuenta",
    meaning: (
      <>
        la anulación llegó <b>después de presentar la cuenta</b>. No es lo mismo que una anulación normal: el
        cliente ya había visto el total, y por eso pide autorización.
      </>
    ),
  },
  {
    term: "Cortesía",
    meaning: "el plato salió y no se cobró. Sale del inventario igual; lo que no entra es la venta.",
  },
  {
    term: "Sin enviar",
    meaning: (
      <>
        no es <b>sin cobrar</b>: un ítem que se cobró sin haber pasado por cocina se vendió igual, pero nunca
        se preparó contra comanda.
      </>
    ),
  },
]

/**
 * **La cifra protagonista de Pedidos** (mapa de pantallas, regla 1): grande,
 * `tabular-nums`, y en rojo sólo cuando dice que algo falta revisar. El valor
 * llega ya escrito; acá no se calcula nada.
 */
function CifraProtagonista({ label, value, alerta }: { label: string; value: string; alerta: boolean }) {
  return (
    <div className="min-w-0">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p
        className={cn(
          "mt-0.5 text-4xl leading-none font-bold tracking-tight tabular-nums",
          alerta ? "text-destructive" : "text-foreground",
        )}
      >
        {value}
      </p>
    </div>
  )
}

function minutesLabel(minutes: number | null | undefined): string {
  return minutes !== null && minutes !== undefined ? `${minutes} min` : "—"
}

function OrderDetailDialog({
  orderId,
  listRow,
  onOpenChange,
}: {
  orderId: number | null
  /** La fila del listado, que es la que trae `void_details`. */
  listRow?: AdminOrderListItem
  onOpenChange: (open: boolean) => void
}) {
  const query = useQuery<OrderOut>({
    queryKey: ["admin-orders", "detail", orderId],
    queryFn: () => adminGetOrder(orderId as number),
    enabled: orderId !== null,
  })
  const order = query.data

  return (
    <Dialog open={orderId !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Comanda #{orderId}</DialogTitle>
        </DialogHeader>
        {query.isLoading ? (
          <Cargando texto="Cargando…" />
        ) : query.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {errorMessage(query.error)}
          </p>
        ) : order ? (
          <div className="space-y-3 text-sm">
            <dl className="grid grid-cols-2 gap-2">
              <div>
                <dt className="text-muted-foreground">Canal</dt>
                <dd>{order.channel ? CHANNEL_LABEL[order.channel] : "—"}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Estado</dt>
                <dd>{order.status ? ORDER_STATUS_LABEL[order.status] : "—"}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Abierta</dt>
                <dd>{formatInstant(order.opened_at)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Cuenta presentada</dt>
                <dd>{formatInstant(order.bill_presented_at)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Pagada</dt>
                <dd>{formatInstant(order.paid_at)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Total</dt>
                <dd className="tabular-nums">{formatCOP(order.totals?.total)}</dd>
              </div>
            </dl>
            {(listRow?.void_details ?? []).length > 0 ? (
              <div>
                <h3 className="mb-1 font-medium">Anulaciones</h3>
                {/* La pista de auditoría vive acá entera —motivo, si fue
                    después de la cuenta, minutos tras enviar y quién
                    autorizó—. En la fila densa queda el recuento y el mismo
                    texto en el `title`: una sublista adentro de una celda
                    hacía crecer la fila muy por encima de los 34 px del
                    patrón 8. */}
                <ul className="space-y-0.5 text-xs text-muted-foreground">
                  {(listRow?.void_details ?? []).map((v, i) => (
                    <li key={`${v.item_id ?? i}`}>{voidTrailLine(v)}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            <div>
              <h3 className="mb-1 font-medium">Ítems</h3>
              <ul className="space-y-1">
                {(order.items ?? []).map((item) => (
                  <li key={item.id} className="flex justify-between">
                    <span>
                      {item.qty}× {item.name}
                      {item.status === "voided" ? " (anulado)" : ""}
                      {item.courtesy ? " (cortesía)" : ""}
                    </span>
                    <span className="tabular-nums text-muted-foreground">{formatCOP(item.net)}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

/**
 * **La pista de auditoría de cada anulación**, en una línea de texto: motivo,
 * si fue después de la cuenta, minutos tras enviar y quién autorizó
 * (`docs/INVENTARIO-CONTROLES.md` § 16 la marca como «fácil de aplanar en un
 * rediseño»). Se arma una sola vez y se usa en los dos lados: el `title` de
 * la celda densa y el diálogo de detalle, que es donde la comanda se cuenta
 * entera.
 */
export function voidTrailLine(v: NonNullable<AdminOrderListItem["void_details"]>[number]): string {
  return [
    v.reason ? (VOID_REASON_LABEL[v.reason] ?? v.reason) : "Motivo no informado",
    v.after_bill ? "después de la cuenta" : null,
    v.minutes_since_sent !== null && v.minutes_since_sent !== undefined
      ? `${v.minutes_since_sent} min tras enviar`
      : null,
    v.authorized_by ? `autorizó ${v.authorized_by}` : null,
  ]
    .filter((p): p is string => p !== null)
    .join(" · ")
}

function KitchenStationTimes({ stations }: { stations: AdminOrderKitchenStationTimeOut[] }) {
  if (stations.length === 0) {
    return <p className="text-sm text-muted-foreground">Sin ítems enviados a cocina en este período.</p>
  }
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <CategoryBars
        data={stations.map((s) => ({ key: s.station, label: s.station, value: s.p50_seconds }))}
        formatValue={(v) => `${Math.round(v / 60)} min`}
        emptyLabel="Sin datos"
      />
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Estación</TableHead>
              <TableHead>p50</TableHead>
              <TableHead>p90</TableHead>
              <TableHead>Muestras</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {stations.map((s) => (
              <TableRow key={s.station}>
                <TableCell>{s.station}</TableCell>
                <TableCell className="tabular-nums">{Math.round(s.p50_seconds / 60)} min</TableCell>
                <TableCell className="tabular-nums">{Math.round(s.p90_seconds / 60)} min</TableCell>
                <TableCell className="tabular-nums">{s.samples}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}

/**
 * Admin → Pedidos (SPEC-NEGOCIO §9.3 "Pedidos"; ampliado en 1b-2 con tiempos
 * de mesa/cocina/cobro, p50/p90 por estación, `sent_at_payment` y detalle de
 * anulaciones — `app/orders/service.py::admin_list_orders`). ¿Qué comandas
 * están en curso y cuáles se anularon?
 */
export function OrdersAdminPage(): React.JSX.Element {
  const { activeStoreId, loading: storeLoading } = useStoreSelection()
  const [from, setFrom] = useState("")
  const [to, setTo] = useState("")
  const [status, setStatus] = useState<string | undefined>(undefined)
  const [channel, setChannel] = useState<string | undefined>(undefined)
  const [flags, setFlags] = useState<string[]>([])
  const [detailId, setDetailId] = useState<number | null>(null)

  const filters = {
    storeId: activeStoreId ?? 0,
    from: from || undefined,
    to: to || undefined,
    status,
    channel,
    flags: flags.length > 0 ? flags.join(",") : undefined,
  }

  const query = useQuery<AdminOrdersReportOut>({
    queryKey: ["admin-orders", "list", filters],
    queryFn: () => adminListOrders(filters),
    enabled: activeStoreId !== null,
  })

  if (storeLoading) {
    return <Cargando texto="Cargando sedes…" />
  }
  if (activeStoreId === null) {
    return <p className="text-sm text-muted-foreground">Todavía no hay sedes creadas.</p>
  }

  function toggleFlag(value: string) {
    setFlags((prev) => (prev.includes(value) ? prev.filter((f) => f !== value) : [...prev, value]))
  }

  const report = query.data
  const rows = report?.rows ?? []
  // Un recuento de anulaciones (no plata): cuántas llegaron tras la cuenta.
  const anuladasTrasCuenta = rows.reduce((acc, r) => acc + (r.voids_after_bill ?? 0), 0)

  const filterChips = (
    <>
      <DateRangeFilter
        idPrefix="orders"
        from={from}
        to={to}
        onChange={(r) => {
          setFrom(r.from)
          setTo(r.to)
        }}
      />
      <div className="flex items-center gap-2">
        <Label htmlFor="orders-status">Estado</Label>
        <Select value={status} onValueChange={(v) => setStatus(!v || v === "all" ? undefined : v)}>
          <SelectTrigger id="orders-status" className="h-8 w-36">
            <SelectValue placeholder="Todos" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos</SelectItem>
            {Object.entries(ORDER_STATUS_LABEL).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex items-center gap-2">
        <Label htmlFor="orders-channel">Canal</Label>
        <Select value={channel} onValueChange={(v) => setChannel(!v || v === "all" ? undefined : v)}>
          <SelectTrigger id="orders-channel" className="h-8 w-36">
            <SelectValue placeholder="Todos" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos</SelectItem>
            {Object.entries(CHANNEL_LABEL).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <CsvExportButton href={adminOrdersCsvUrl(filters)} label="Exportar CSV" />
    </>
  )

  // A la vista quedan las cinco que deciden (mapa de pantallas, regla 3):
  // número, canal, estado, total y anulaciones. Mesas, horas, tiempos, medio
  // de pago, cortesías y descuentos van detrás de «Más columnas».
  const columns: readonly DenseColumn<AdminOrderListItem>[] = [
    // Un número de comanda es UNA palabra: `#1418`, nunca `141` / `8`.
    { key: "id", header: "#", kind: "id", cell: (r) => `#${r.id}` },
    {
      key: "channel",
      header: "Canal",
      // La palabra del negocio, nunca el enum: «Mesa», no `dine_in`.
      cell: (r) => (r.channel ? (CHANNEL_LABEL[r.channel] ?? r.channel) : "—"),
    },
    { key: "tables", header: "Mesas", secondary: true, cell: (r) => (r.tables ?? []).join(", ") || "—" },
    {
      key: "status",
      header: "Estado",
      cell: (r) => (
        <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
          {r.status ? (ORDER_STATUS_LABEL[r.status] ?? r.status) : "—"}
          {r.transferred ? <span className="rounded border px-1 text-[0.7rem]">Trasladada</span> : null}
          {r.is_staff_meal ? <span className="rounded border px-1 text-[0.7rem]">Personal</span> : null}
        </span>
      ),
    },
    { key: "opened", header: "Abierta", kind: "secondary", secondary: true, cell: (r) => <TimeAgo iso={r.opened_at} /> },
    { key: "paid", header: "Pagada", kind: "secondary", secondary: true, cell: (r) => <TimeAgo iso={r.paid_at} /> },
    { key: "table_min", header: "Mesa (min)", kind: "number", secondary: true, cell: (r) => minutesLabel(r.table_minutes) },
    {
      key: "bill_min",
      header: "Cuenta→cobro (min)",
      kind: "number",
      secondary: true,
      cell: (r) => minutesLabel(r.bill_to_paid_minutes),
    },
    { key: "total", header: "Total", kind: "number", cell: (r) => formatCOP(r.total) },
    {
      key: "methods",
      header: "Medio de pago",
      secondary: true,
      cell: (r) => (r.payment_methods ?? []).join(", ") || "—",
    },
    {
      key: "voids",
      header: "Anulaciones",
      kind: "number",
      // El recuento en la celda; la pista de auditoría entera en el `title` y
      // en el diálogo de detalle. Una sublista acá hacía crecer la fila.
      cell: (r) => (
        <span className={cn(r.voids_after_bill ? "font-bold text-destructive" : undefined)}>
          {r.voided_items ?? 0}
          {r.voids_after_bill ? ` (${r.voids_after_bill} tras la cuenta)` : ""}
        </span>
      ),
      cellTitle: (r) =>
        (r.void_details ?? []).length > 0 ? (r.void_details ?? []).map(voidTrailLine).join("\n") : undefined,
    },
    { key: "courtesies", header: "Cortesías", kind: "number", secondary: true, cell: (r) => r.courtesies ?? 0 },
    { key: "discounts", header: "Descuentos", kind: "number", secondary: true, cell: (r) => formatCOP(r.discount_total) },
    {
      key: "detail",
      header: "",
      kind: "actions",
      // La fila entera abre el detalle con el mouse; este botón es el mismo
      // trigger operable con teclado — un `<tr onClick>` solo no lo sería.
      cell: (r) => (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            setDetailId(r.id)
          }}
          className="rounded text-xs whitespace-nowrap text-muted-foreground underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          Ver detalle #{r.id} →
        </button>
      ),
    },
  ]

  return (
    <div className="space-y-4">
      <PageHeader
        name="Pedidos"
        question="Qué comandas se abrieron, cuánto tardaron y cuáles se anularon — con quién autorizó cada anulación."
      />

      {query.isError ? (
        <EmptyState
          role="alert"
          title="No se pudieron cargar los pedidos"
          description={errorMessage(query.error)}
        />
      ) : (
        <div className="space-y-5">
          {/* **Una cifra protagonista** (mapa de pantallas, regla 1): las
              anulaciones después de la cuenta, que son las que piden
              autorización porque el cliente ya había visto el total. En rojo
              sólo si hay alguna. Las otras dos cifras quedan chicas al lado.
              Son recuentos de filas y una proporción que manda el servidor:
              acá no se suma plata. */}
          <section aria-label="Cifras del período" className="flex flex-wrap items-end gap-x-10 gap-y-3">
            <CifraProtagonista
              label="Anulaciones después de la cuenta"
              value={report ? String(anuladasTrasCuenta) : "—"}
              alerta={anuladasTrasCuenta > 0}
            />
            <dl className="flex flex-wrap gap-x-8 gap-y-2">
              {[
                { label: "Comandas en el período", value: report ? String(rows.length) : "—" },
                {
                  label: "Ítems enviados al cobrar",
                  value: formatPercent(report?.sent_at_payment_ratio),
                  title: "Debieron enviarse a cocina antes de presentar la cuenta",
                },
              ].map((cifra) => (
                <div key={cifra.label} title={cifra.title}>
                  <dt className="text-sm text-muted-foreground">{cifra.label}</dt>
                  <dd className="text-xl font-bold tabular-nums">{cifra.value}</dd>
                </div>
              ))}
            </dl>
          </section>

          <GroupLabel
            label="Tiempo de cocina por estación"
            says="p50 y p90 del período"
          >
            <KitchenStationTimes stations={report?.kitchen_times_by_station ?? []} />
            {/* El método, plegado (mapa de pantallas, regla 2): se lee una
                vez, no cada vez que se abre la pantalla. */}
            <details className="mt-1 text-xs text-muted-foreground">
              <summary className="cursor-pointer rounded-md py-1 font-medium select-none hover:text-foreground">
                Cómo leer esto
              </summary>
              <p className="pb-1">
                Minutos entre que el ítem se envió y quedó listo (listo − enviado), por estación, sobre las
                muestras del período. p50: la mitad de los ítems estuvo lista en ese tiempo o menos; p90: nueve de
                cada diez.
              </p>
            </details>
          </GroupLabel>

          <GroupLabel
            label="Las comandas"
            says="una fila por comanda del período, con su pista de anulaciones"
          >
            {/* Las seis marcas combinables. Son filtros de ESTA tabla, así
                que viven en su barra (§ 1: el alcance se lee por dónde vive
                el control). */}
            <div className="mb-2 flex flex-wrap gap-2">
              {FLAG_OPTIONS.map((flag) => (
                <button
                  key={flag.value}
                  type="button"
                  aria-pressed={flags.includes(flag.value)}
                  onClick={() => toggleFlag(flag.value)}
                  className={`rounded-full border px-3 py-1 text-xs ${flags.includes(flag.value) ? "border-primary bg-primary/10 font-bold text-primary" : "border-border text-muted-foreground"}`}
                >
                  {flag.label}
                </button>
              ))}
            </div>

            <DenseTable
              caption="Comandas del período"
              columns={columns}
              rows={rows}
              rowKey={(r) => String(r.id)}
              rowStatus={(r) => (r.voids_after_bill ? "critical" : r.voided_items ? "warning" : "none")}
              legend={ORDERS_LEGEND}
              bar={
                <DenseTableBar
                  shown={rows.length}
                  total={rows.length}
                  noun="comandas en el período"
                  hidden={
                    query.isLoading
                      ? "contando…"
                      : flags.length > 0
                        ? `filtradas por ${flags.map((f) => FLAG_OPTIONS.find((o) => o.value === f)?.label ?? f).join(" · ")}`
                        : undefined
                  }
                >
                  {filterChips}
                </DenseTableBar>
              }
              empty={
                query.isLoading ? undefined : flags.length > 0 ? (
                  <FilterEmptyState
                    title="Ningún pedido coincide con estos filtros"
                    filters={
                      flags.map((f) => FLAG_OPTIONS.find((o) => o.value === f)?.label ?? f) as [
                        string,
                        ...string[],
                      ]
                    }
                    onRemove={(label) => {
                      const opt = FLAG_OPTIONS.find((o) => o.label === label)
                      if (opt) toggleFlag(opt.value)
                    }}
                  />
                ) : (
                  <EmptyState
                    title="Ningún pedido coincide con estos filtros"
                    description="Probá otro rango de fechas, otro estado u otro canal."
                  />
                )
              }
            />
          </GroupLabel>
        </div>
      )}

      <OrderDetailDialog
        orderId={detailId}
        listRow={rows.find((r) => r.id === detailId)}
        onOpenChange={(open) => !open && setDetailId(null)}
      />
    </div>
  )
}

export default OrdersAdminPage
