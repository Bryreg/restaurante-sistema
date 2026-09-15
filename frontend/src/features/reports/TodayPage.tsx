import { useQuery } from "@tanstack/react-query"
import {
  AlertTriangle,
  Banknote,
  Clock,
  PackageX,
  ReceiptText,
  RotateCcw,
  Table2,
  Users,
  UtensilsCrossed,
} from "lucide-react"

import { getToday, type AlertOut, type OpenOrderAgeOut, type UnavailableProductOut } from "@/api/reports"
import { useStoreSelection } from "@/app/storeContext"
import { EmptyState } from "@/components/EmptyState"
import { StatTile } from "@/components/StatTile"
import { Badge } from "@/components/ui/badge"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { formatBusinessDate } from "@/lib/businessDate"
import { errorMessage } from "@/lib/errors"
import { formatCOP } from "@/lib/money"

import { AttentionCard, type AttentionTone } from "./AttentionCard"
import { CategoryBars } from "./charts"
import { ALERT_LEVEL_TONE, alertRoute, methodLabel } from "./lib"

const REFRESH_MS = 30_000

function hourLabel(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`
}

interface AttentionItem {
  key: string
  title: string
  body: string
  to: string
  ctaLabel: string
  tone: AttentionTone
}

function directAttentionItems(today: {
  expected_cash?: number | null
  unsent_count?: number
  unpaid_count?: number
  unavailable_products?: UnavailableProductOut[]
  pending_refunds_count?: number
  unreviewed_closes_count?: number
}): AttentionItem[] {
  const items: AttentionItem[] = []

  if (today.expected_cash === null || today.expected_cash === undefined) {
    items.push({
      key: "no-shift",
      title: "Sin turno abierto",
      body: "No hay un turno de caja abierto en esta sede en este momento.",
      to: "/admin/dinero",
      ctaLabel: "Abrir Dinero",
      tone: "critical",
    })
  }

  const unsent = today.unsent_count ?? 0
  const unpaid = today.unpaid_count ?? 0
  if (unsent > 0 || unpaid > 0) {
    const parts: string[] = []
    if (unsent > 0) parts.push(`${unsent} sin enviar a cocina`)
    if (unpaid > 0) parts.push(`${unpaid} con cuenta presentada sin cobrar`)
    items.push({
      key: "stale-orders",
      title: "Comandas atascadas",
      body: `${parts.join(" · ")}, hace más del tiempo esperado.`,
      to: "/admin/pedidos",
      ctaLabel: "Ver Pedidos",
      tone: "warning",
    })
  }

  const unavailable = today.unavailable_products ?? []
  if (unavailable.length > 0) {
    const names = unavailable.slice(0, 3).map((p) => p.name ?? `#${p.product_id}`)
    const rest = unavailable.length - names.length
    items.push({
      key: "unavailable",
      title: `${unavailable.length} producto${unavailable.length === 1 ? "" : "s"} agotado${unavailable.length === 1 ? "" : "s"}`,
      body: rest > 0 ? `${names.join(", ")} y ${rest} más.` : names.join(", "),
      to: "/admin/carta",
      ctaLabel: "Ver Carta",
      tone: "warning",
    })
  }

  const pendingRefunds = today.pending_refunds_count ?? 0
  if (pendingRefunds > 0) {
    items.push({
      key: "pending-refunds",
      title: `${pendingRefunds} devolución${pendingRefunds === 1 ? "" : "es"} pendiente${pendingRefunds === 1 ? "" : "s"}`,
      body: "Sin turno abierto al emitir la nota — quedaron sin saldar.",
      to: "/admin/fiscal/devoluciones-pendientes",
      ctaLabel: "Ver devoluciones pendientes",
      tone: "warning",
    })
  }

  const unreviewed = today.unreviewed_closes_count ?? 0
  if (unreviewed > 0) {
    items.push({
      key: "unreviewed-closes",
      title: `${unreviewed} cierre${unreviewed === 1 ? "" : "s"} sin revisar`,
      body: "El paso 2 del cierre a ciegas todavía no se completó.",
      to: "/admin/dinero",
      ctaLabel: "Ver Dinero",
      tone: "default",
    })
  }

  return items
}

/** Tipos que ya tienen su propia tarjeta directa arriba — evita mostrar el mismo aviso dos veces. */
const DEDUPED_ALERT_TYPES = new Set(["order_unsent_too_long", "order_unpaid_too_long", "product_unavailable", "pending_refund"])

function alertToItem(alert: AlertOut): AttentionItem {
  const route = alertRoute(alert.type)
  return {
    key: `alert-${alert.type}-${alert.created_at}`,
    title: alert.title,
    body: alert.body,
    to: route.to,
    ctaLabel: route.label,
    tone: ALERT_LEVEL_TONE[alert.level] ?? "default",
  }
}

const TONE_RANK: Record<AttentionTone, number> = { critical: 0, warning: 1, default: 2 }

function OpenOrdersTable({ orders }: { orders: OpenOrderAgeOut[] }): React.JSX.Element {
  if (orders.length === 0) {
    return <EmptyState title="Sin comandas abiertas" description="No hay mesas ni pedidos en curso en este momento." />
  }
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>#</TableHead>
            <TableHead>Canal</TableHead>
            <TableHead>Mesas</TableHead>
            <TableHead>Abierta hace</TableHead>
            <TableHead>Cuenta presentada hace</TableHead>
            <TableHead>Total</TableHead>
            <TableHead>Aviso</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {orders.map((order) => (
            <TableRow key={order.id}>
              <TableCell>{order.id}</TableCell>
              <TableCell>{order.channel ?? "—"}</TableCell>
              <TableCell>{(order.tables ?? []).join(", ") || "—"}</TableCell>
              <TableCell className="tabular-nums">
                {order.minutes_since_opened !== undefined ? `${order.minutes_since_opened} min` : "—"}
              </TableCell>
              <TableCell className="tabular-nums">
                {order.minutes_since_bill_presented !== null && order.minutes_since_bill_presented !== undefined
                  ? `${order.minutes_since_bill_presented} min`
                  : "—"}
              </TableCell>
              <TableCell className="tabular-nums">{formatCOP(order.total)}</TableCell>
              <TableCell>
                {order.unsent_flag ? (
                  <Badge variant="destructive" className="mr-1">
                    Sin enviar
                  </Badge>
                ) : null}
                {order.unpaid_flag ? <Badge variant="destructive">Sin cobrar</Badge> : null}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

/**
 * "Hoy" (SPEC-NEGOCIO §9.3): pulso del día + "Requiere tu atención". Cada
 * número responde una pregunta puntual (ver comentario junto a cada
 * `StatTile`); lo que no respondía ninguna se descartó (ver
 * `features/fase-1b-venta/outputs-1b-2/frontend-admin.md` § 3).
 */
export function TodayPage(): React.JSX.Element {
  const { activeStoreId, loading: storeLoading } = useStoreSelection()

  const query = useQuery({
    queryKey: ["admin-today", activeStoreId],
    queryFn: () => getToday(activeStoreId as number),
    enabled: activeStoreId !== null,
    refetchInterval: REFRESH_MS,
  })

  if (storeLoading) {
    return <p className="text-sm text-muted-foreground">Cargando sedes…</p>
  }
  if (activeStoreId === null) {
    return <p className="text-sm text-muted-foreground">Todavía no hay sedes creadas.</p>
  }
  if (query.isLoading) {
    return <p className="text-sm text-muted-foreground">Cargando el pulso de hoy…</p>
  }
  if (query.isError) {
    return (
      <EmptyState
        role="alert"
        title="No se pudo cargar «Hoy»"
        description={errorMessage(query.error)}
        action={{ label: "Reintentar", onClick: () => void query.refetch() }}
      />
    )
  }
  const today = query.data
  if (!today) {
    return <EmptyState title="Sin datos" />
  }

  const attention = [
    ...directAttentionItems(today),
    ...(today.alerts ?? []).filter((a) => !DEDUPED_ALERT_TYPES.has(a.type)).map(alertToItem),
  ].sort((a, b) => TONE_RANK[a.tone] - TONE_RANK[b.tone])

  const hourBars = (today.sales_by_hour ?? []).map((h) => ({ key: String(h.hour), label: hourLabel(h.hour), value: h.net }))

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-lg font-semibold">Hoy</h1>
        <p className="text-sm text-muted-foreground">{formatBusinessDate(today.business_date)}</p>
      </div>

      {/* El número por el que el dueño abre la pantalla: ventas netas del día
          (ventas cobradas − impuesto, SPEC-NEGOCIO §10), grande y primero. */}
      <div className="rounded-lg border p-5">
        <p className="text-sm text-muted-foreground">Ventas netas de hoy</p>
        <p className="mt-1 text-4xl font-semibold tabular-nums">{formatCOP(today.net)}</p>
        <p className="mt-1 text-sm text-muted-foreground">
          {formatCOP(today.gross)} cobrados · {formatCOP(today.tax)} de impuesto discriminado
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <StatTile label="Comandas pagadas" value={today.orders !== undefined ? String(today.orders) : "—"} icon={ReceiptText} />
        <StatTile label="Ticket promedio" value={formatCOP(today.avg_ticket)} icon={ReceiptText} />
        <StatTile label="Ticket por comensal" value={formatCOP(today.avg_per_cover)} icon={Users} />
        <StatTile label="Comensales" value={today.covers !== null && today.covers !== undefined ? String(today.covers) : "—"} icon={Users} />
        <StatTile
          label="Mesas ocupadas"
          value={`${today.tables_occupied ?? 0}/${today.tables_total ?? 0}`}
          icon={Table2}
        />
        <StatTile
          label="Comandas abiertas"
          value={String((today.open_orders ?? []).length)}
          hint={
            (today.unsent_count ?? 0) > 0 || (today.unpaid_count ?? 0) > 0
              ? `${today.unsent_count ?? 0} sin enviar · ${today.unpaid_count ?? 0} sin cobrar`
              : "Ninguna atascada"
          }
          tone={(today.unsent_count ?? 0) > 0 || (today.unpaid_count ?? 0) > 0 ? "warning" : "default"}
          icon={UtensilsCrossed}
        />
        <StatTile
          label="Efectivo esperado"
          value={formatCOP(today.expected_cash)}
          hint={today.expected_cash === null || today.expected_cash === undefined ? "Sin turno abierto" : undefined}
          tone={today.expected_cash === null || today.expected_cash === undefined ? "critical" : "default"}
          icon={Banknote}
        />
        <StatTile label="Propinas de hoy" value={formatCOP(today.tips_total)} icon={Clock} />
      </div>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Ventas por hora</h2>
        <p className="text-sm text-muted-foreground">Ventas netas (sin propina) por hora del día — ¿a qué hora se vende más?</p>
        <CategoryBars data={hourBars} formatValue={(v) => formatCOP(v)} emptyLabel="Todavía no hay ventas hoy" />
      </section>

      {(today.tips_by_method ?? []).length > 0 ? (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold">Propinas por medio</h2>
          <div className="flex flex-wrap gap-3">
            {(today.tips_by_method ?? []).map((m) => (
              <div key={m.method} className="rounded-md border px-3 py-2 text-sm">
                <span className="text-muted-foreground">{methodLabel(m.method)}: </span>
                <span className="font-medium tabular-nums">{formatCOP(m.amount)}</span>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Comandas abiertas</h2>
        <OpenOrdersTable orders={today.open_orders ?? []} />
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Requiere tu atención</h2>
        {attention.length === 0 ? (
          <EmptyState
            icon={RotateCcw}
            title="Todo al día"
            description="No hay comandas atascadas, agotados, devoluciones pendientes ni cierres sin revisar."
          />
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {attention.map((item) => (
              <AttentionCard
                key={item.key}
                title={item.title}
                body={item.body}
                to={item.to}
                ctaLabel={item.ctaLabel}
                tone={item.tone}
                icon={item.tone === "critical" ? AlertTriangle : item.tone === "warning" ? AlertTriangle : PackageX}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

export default TodayPage
