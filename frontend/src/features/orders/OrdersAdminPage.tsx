import { useQuery } from "@tanstack/react-query"
import { Download } from "lucide-react"
import { useState } from "react"

import { useStoreSelection } from "@/app/storeContext"
import { adminGetOrder, adminListOrders, adminOrdersCsvUrl, type AdminOrderListItem, type OrderOut } from "@/api/orders"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { EmptyState } from "@/components/EmptyState"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { errorMessage } from "@/lib/errors"
import { formatCOP } from "@/lib/money"
import { formatInstant } from "@/lib/businessDate"

import { CHANNEL_LABEL, ORDER_STATUS_LABEL } from "./lib"

const FLAG_OPTIONS: { value: string; label: string }[] = [
  { value: "voided", label: "Anuladas" },
  { value: "courtesy", label: "Con cortesía" },
  { value: "discounted", label: "Con descuento" },
  { value: "staff_meal", label: "Consumo de personal" },
  { value: "transferred", label: "Trasladadas" },
  { value: "after_bill", label: "Cambios después de la cuenta" },
]

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

/**
 * Admin → Pedidos (mínimo de 1b-1, SPEC-NEGOCIO §9.3 "Pedidos" — p50/p90 y
 * el resto quedan para 1b-2). Lista de comandas abiertas y cerradas con
 * estados, tiempos y anulaciones.
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

  const query = useQuery<AdminOrderListItem[]>({
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

  const rows = query.data ?? []

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-semibold">Pedidos</h1>
        <Button render={<a href={adminOrdersCsvUrl(filters)} target="_blank" rel="noreferrer" />} variant="outline" className="h-11 gap-2">
          <Download className="size-4" aria-hidden="true" />
          Exportar CSV
        </Button>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label htmlFor="orders-from">Desde</Label>
          <Input id="orders-from" type="date" className="h-10" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="orders-to">Hasta</Label>
          <Input id="orders-to" type="date" className="h-10" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
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
      ) : rows.length === 0 ? (
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
                <TableHead>Total</TableHead>
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
                    </div>
                  </TableCell>
                  <TableCell>{formatInstant(row.opened_at)}</TableCell>
                  <TableCell>{formatInstant(row.paid_at)}</TableCell>
                  <TableCell className="tabular-nums">{formatCOP(row.total)}</TableCell>
                  <TableCell className="tabular-nums">
                    {row.voided_items ?? 0}
                    {row.voids_after_bill ? ` (${row.voids_after_bill} después de la cuenta)` : ""}
                  </TableCell>
                  <TableCell className="tabular-nums">{row.courtesies ?? 0}</TableCell>
                  <TableCell className="tabular-nums">{formatCOP(row.discount_total)}</TableCell>
                  <TableCell className="text-right text-xs text-muted-foreground">Ver detalle →</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <OrderDetailDialog orderId={detailId} onOpenChange={(open) => !open && setDetailId(null)} />
    </div>
  )
}

export default OrdersAdminPage
