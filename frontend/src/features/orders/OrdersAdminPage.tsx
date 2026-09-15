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
import { Badge } from "@/components/ui/badge"
import { CsvExportButton } from "@/components/CsvExportButton"
import { DateRangeFilter } from "@/components/DateRangeFilter"
import { EmptyState } from "@/components/EmptyState"
import { StatTile } from "@/components/StatTile"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { CategoryBars } from "@/features/reports/charts"
import { formatPercent } from "@/features/reports/lib"
import { errorMessage } from "@/lib/errors"
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

function minutesLabel(minutes: number | null | undefined): string {
  return minutes !== null && minutes !== undefined ? `${minutes} min` : "—"
}

function OrderDetailDialog({ orderId, onOpenChange }: { orderId: number | null; onOpenChange: (open: boolean) => void }) {
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
          <p className="text-sm text-muted-foreground">Cargando…</p>
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

function VoidsDetail({ voidDetails }: { voidDetails: AdminOrderListItem["void_details"] }) {
  const rows = voidDetails ?? []
  if (rows.length === 0) return null
  return (
    <ul className="space-y-0.5 text-xs text-muted-foreground">
      {rows.map((v, i) => (
        <li key={`${v.item_id ?? i}`}>
          {v.reason ? (VOID_REASON_LABEL[v.reason] ?? v.reason) : "Motivo no informado"}
          {v.after_bill ? " · después de la cuenta" : ""}
          {v.minutes_since_sent !== null && v.minutes_since_sent !== undefined ? ` · ${v.minutes_since_sent} min tras enviar` : ""}
          {v.authorized_by ? ` · autorizó ${v.authorized_by}` : ""}
        </li>
      ))}
    </ul>
  )
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
    return <p className="text-sm text-muted-foreground">Cargando sedes…</p>
  }
  if (activeStoreId === null) {
    return <p className="text-sm text-muted-foreground">Todavía no hay sedes creadas.</p>
  }

  function toggleFlag(value: string) {
    setFlags((prev) => (prev.includes(value) ? prev.filter((f) => f !== value) : [...prev, value]))
  }

  const report = query.data
  const rows = report?.rows ?? []

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-semibold">Pedidos</h1>
        <CsvExportButton href={adminOrdersCsvUrl(filters)} label="Exportar CSV" />
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <DateRangeFilter idPrefix="orders" from={from} to={to} onChange={(r) => { setFrom(r.from); setTo(r.to) }} />
        <div className="space-y-1">
          <Label htmlFor="orders-status">Estado</Label>
          <Select value={status} onValueChange={(v) => setStatus(!v || v === "all" ? undefined : v)}>
            <SelectTrigger id="orders-status" className="h-10 w-40">
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
        <div className="space-y-1">
          <Label htmlFor="orders-channel">Canal</Label>
          <Select value={channel} onValueChange={(v) => setChannel(!v || v === "all" ? undefined : v)}>
            <SelectTrigger id="orders-channel" className="h-10 w-40">
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
      </div>

      <div className="flex flex-wrap gap-2">
        {FLAG_OPTIONS.map((flag) => (
          <button
            key={flag.value}
            type="button"
            aria-pressed={flags.includes(flag.value)}
            onClick={() => toggleFlag(flag.value)}
            className={`min-h-11 rounded-full border px-3 text-sm ${flags.includes(flag.value) ? "border-primary bg-primary/10" : "border-border"}`}
          >
            {flag.label}
          </button>
        ))}
      </div>

      {query.isLoading ? (
        <p className="text-sm text-muted-foreground">Cargando pedidos…</p>
      ) : query.isError ? (
        <EmptyState role="alert" title="No se pudieron cargar los pedidos" description={errorMessage(query.error)} />
      ) : report ? (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <StatTile label="Comandas en el período" value={String(rows.length)} />
            <StatTile
              label="Ítems enviados al cobrar"
              value={formatPercent(report.sent_at_payment_ratio)}
              hint="Debieron enviarse a cocina antes de presentar la cuenta"
            />
            <StatTile
              label="Anulaciones después de la cuenta"
              value={String(rows.reduce((acc, r) => acc + (r.voids_after_bill ?? 0), 0))}
            />
          </div>

          <section className="space-y-3">
            <h2 className="text-sm font-semibold">Tiempo de cocina por estación (listo − enviado)</h2>
            <KitchenStationTimes stations={report.kitchen_times_by_station} />
          </section>

          {rows.length === 0 ? (
            <EmptyState title="Ningún pedido coincide con estos filtros" />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>#</TableHead>
                    <TableHead>Canal</TableHead>
                    <TableHead>Mesas</TableHead>
                    <TableHead>Estado</TableHead>
                    <TableHead>Abierta</TableHead>
                    <TableHead>Pagada</TableHead>
                    <TableHead>Mesa (min)</TableHead>
                    <TableHead>Cuenta→cobro (min)</TableHead>
                    <TableHead>Total</TableHead>
                    <TableHead>Medio de pago</TableHead>
                    <TableHead>Anulaciones</TableHead>
                    <TableHead>Cortesías</TableHead>
                    <TableHead>Descuentos</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row) => (
                    <TableRow key={row.id} className="cursor-pointer" onClick={() => setDetailId(row.id)}>
                      <TableCell>{row.id}</TableCell>
                      <TableCell>{row.channel ? CHANNEL_LABEL[row.channel] ?? row.channel : "—"}</TableCell>
                      <TableCell>{(row.tables ?? []).join(", ") || "—"}</TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          <Badge variant="outline">{row.status ? ORDER_STATUS_LABEL[row.status] ?? row.status : "—"}</Badge>
                          {row.transferred ? <Badge variant="secondary">Trasladada</Badge> : null}
                          {row.is_staff_meal ? <Badge variant="secondary">Personal</Badge> : null}
                        </div>
                      </TableCell>
                      <TableCell>{formatInstant(row.opened_at)}</TableCell>
                      <TableCell>{formatInstant(row.paid_at)}</TableCell>
                      <TableCell className="tabular-nums">{minutesLabel(row.table_minutes)}</TableCell>
                      <TableCell className="tabular-nums">{minutesLabel(row.bill_to_paid_minutes)}</TableCell>
                      <TableCell className="tabular-nums">{formatCOP(row.total)}</TableCell>
                      <TableCell>{(row.payment_methods ?? []).join(", ") || "—"}</TableCell>
                      <TableCell className="tabular-nums">
                        {row.voided_items ?? 0}
                        {row.voids_after_bill ? ` (${row.voids_after_bill} después de la cuenta)` : ""}
                        <VoidsDetail voidDetails={row.void_details} />
                      </TableCell>
                      <TableCell className="tabular-nums">{row.courtesies ?? 0}</TableCell>
                      <TableCell className="tabular-nums">{formatCOP(row.discount_total)}</TableCell>
                      <TableCell className="text-right">
                        {/* La fila entera abre el detalle con el mouse (`onClick` de arriba,
                            conveniencia visual); este botón es el mismo trigger operable con
                            teclado — un <tr onClick> solo no tiene equivalente de teclado. */}
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation()
                            setDetailId(row.id)
                          }}
                          className="rounded text-xs text-muted-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                        >
                          Ver detalle #{row.id} →
                        </button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      ) : null}

      <OrderDetailDialog orderId={detailId} onOpenChange={(open) => !open && setDetailId(null)} />
    </div>
  )
}

export default OrdersAdminPage
