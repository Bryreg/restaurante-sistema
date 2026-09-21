import { useQuery } from "@tanstack/react-query"
import { Banknote, ReceiptText, Table2, Users, UtensilsCrossed } from "lucide-react"

import {
  getToday,
  type AlertOut,
  type IngredientAlertOut,
  type LotAlertOut,
  type NegativeStockAlertOut,
  type OpenOrderAgeOut,
  type PayableAlertOut,
  type PrepAlertOut,
  type UnavailableProductOut,
  type UncostedProductOut,
} from "@/api/reports"
import { useStoreSelection } from "@/app/storeContext"
import {
  AllClearEmptyState,
  DenseTable,
  DenseTableBar,
  GroupLabel,
  HeadlineFigure,
  FilterLink,
  NoticeRail,
  PageHeader,
  TimeAgo,
  type DenseColumn,
  type FilterLinkProps,
  type Notice,
  type NoticeSeverity,
  type RowStatus,
} from "@/components/admin"
import { EmptyState } from "@/components/EmptyState"
import { StatTile } from "@/components/StatTile"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { formatBusinessDate, formatInstant } from "@/lib/businessDate"
import { errorMessage } from "@/lib/errors"
import { formatCOP } from "@/lib/money"

import { CHANNEL_LABEL } from "@/features/orders/lib"

import { CategoryBars } from "./charts"
import { ALERT_LEVEL_TONE, alertRoute, methodLabel } from "./lib"

const REFRESH_MS = 30_000

function hourLabel(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`
}

/**
 * Tono heredado de la ola anterior. Se mantiene como vocabulario interno de
 * esta pantalla y se traduce a la gravedad del riel (`NoticeRail`) en un
 * solo lugar, `SEVERITY_OF_TONE`: el patrón 7 pide tres niveles —crítico,
 * aviso y «para cuando puedas»— y el tercero es el que deja plegar la cola
 * sin urgencia.
 */
type AttentionTone = "default" | "warning" | "critical"

const SEVERITY_OF_TONE: Record<AttentionTone, NoticeSeverity> = {
  critical: "critical",
  warning: "warning",
  default: "whenever",
}

interface AttentionItem {
  key: string
  title: string
  body: string
  to: string
  ctaLabel: string
  tone: AttentionTone
  /** La pantalla destino **en palabras** (`docs/PATRONES-ADMIN.md` § 6). */
  screen: string
  /** La pestaña destino en palabras, si la tiene. */
  tab?: string
  /** El filtro que el enlace deja puesto, en palabras. Sin filtro, no hay pastilla. */
  filter?: string
}

function directAttentionItems(today: {
  expected_cash?: number | null
  unsent_count?: number
  unpaid_count?: number
  unavailable_products?: UnavailableProductOut[]
  pending_refunds_count?: number
  unreviewed_closes_count?: number
  ingredients_below_min?: IngredientAlertOut[]
  ingredients_negative?: NegativeStockAlertOut[]
  preps_without_production?: PrepAlertOut[]
  products_discounting_nothing?: UncostedProductOut[]
  lots_expiring_or_expired?: LotAlertOut[]
  payables_overdue?: PayableAlertOut[]
  payables_pending_review_count?: number
  inventory_unreliable?: boolean | null
  days_since_last_full_count?: number | null
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
      screen: "Dinero",
      tab: "Operacional",
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
      screen: "Pedidos",
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
      screen: "Carta",
      tab: "Productos",
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
      screen: "Devoluciones",
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
      screen: "Dinero",
      tab: "Operacional",
    })
  }

  // Pedido 2a: las cuatro alertas nuevas de `GET /admin/today`. Cada una
  // enlaza a la pantalla que la resuelve, ya con el filtro puesto cuando
  // corresponde (SPEC-NEGOCIO §9.3: "cada tarjeta lleva a la pantalla donde
  // se resuelve"). Ninguna trae costo — sólo cantidades y causas.
  const belowMin = today.ingredients_below_min ?? []
  if (belowMin.length > 0) {
    const names = belowMin.slice(0, 3).map((i) => i.name ?? `#${i.ingredient_id}`)
    const rest = belowMin.length - names.length
    items.push({
      key: "ingredients-below-min",
      title: `${belowMin.length} insumo${belowMin.length === 1 ? "" : "s"} bajo el mínimo`,
      body: rest > 0 ? `${names.join(", ")} y ${rest} más — reponé pronto.` : `${names.join(", ")} — reponé pronto.`,
      to: "/admin/inventario?tab=stock&below_min=1",
      ctaLabel: "Ver Stock",
      tone: "warning",
      screen: "Inventario",
      tab: "Stock",
      filter: "bajo mínimo",
    })
  }

  // Negativo NO es lo mismo que "bajo mínimo": es deuda de registro, no
  // escasez real, y se marca distinto (rojo, no ámbar) — SPEC-NEGOCIO §5.2.
  const negative = today.ingredients_negative ?? []
  if (negative.length > 0) {
    const names = negative.slice(0, 3).map((i) => i.name ?? `#${i.ingredient_id}`)
    const rest = negative.length - names.length
    items.push({
      key: "ingredients-negative",
      title: `${negative.length} insumo${negative.length === 1 ? "" : "s"} en negativo`,
      body:
        (rest > 0 ? `${names.join(", ")} y ${rest} más — ` : `${names.join(", ")} — `) +
        "deuda de registro, no bloquea la venta. Revisá la causa probable en Movimientos.",
      to: "/admin/inventario?tab=stock&negative=1",
      ctaLabel: "Ver Stock",
      tone: "critical",
      screen: "Inventario",
      tab: "Stock",
      filter: "negativos",
    })
  }

  const prepsNoProd = today.preps_without_production ?? []
  if (prepsNoProd.length > 0) {
    const names = prepsNoProd.slice(0, 3).map((p) => p.preparation_name ?? `#${p.preparation_id}`)
    const rest = prepsNoProd.length - names.length
    items.push({
      key: "preps-without-production",
      title: `${prepsNoProd.length} preparación${prepsNoProd.length === 1 ? "" : "es"} por lote sin producir`,
      body:
        (rest > 0 ? `${names.join(", ")} y ${rest} más — ` : `${names.join(", ")} — `) +
        "quedan en stock ≤ 0; producilas o revisá si conviene pasarlas a explotada.",
      to: "/admin/preparaciones",
      ctaLabel: "Ver Preparaciones",
      tone: "warning",
      screen: "Preparaciones",
    })
  }

  const uncosted = today.products_discounting_nothing ?? []
  if (uncosted.length > 0) {
    const names = uncosted.slice(0, 3).map((p) => p.product_name ?? `#${p.product_id}`)
    const rest = uncosted.length - names.length
    items.push({
      key: "products-discounting-nothing",
      title: `${uncosted.length} plato${uncosted.length === 1 ? "" : "s"} vendido${uncosted.length === 1 ? "" : "s"} sin descontar nada`,
      body:
        (rest > 0 ? `${names.join(", ")} y ${rest} más — ` : `${names.join(", ")} — `) +
        "se vendieron sin receta ni insumo directo. La venta siguió, pero el inventario no se movió.",
      to: "/admin/carta",
      ctaLabel: "Ver Carta y recetas",
      tone: "warning",
      screen: "Carta",
      tab: "Recetas",
    })
  }

  // Pedido 2b: las tres alertas nuevas de `GET /admin/today` (spec.md
  // «Reads that 2a asked for»). Con la función apagada el backend manda
  // `[]`/`0`/`null` (nunca omite la llave): la tarjeta correspondiente
  // simplemente no entra en `items` — no se dibuja, no se dibuja vacía
  // (SPEC-NEGOCIO §9.3, el mandato de este reparto). Cuentas por pagar
  // enlazan a `/admin/compras` (pantalla de otro agente: no se construye
  // ni se duplica acá, sólo se enlaza por URL).
  const lotsAlert = today.lots_expiring_or_expired ?? []
  if (lotsAlert.length > 0) {
    const expiredCount = lotsAlert.filter((l) => l.status === "expired").length
    const expiringCount = lotsAlert.length - expiredCount
    const parts: string[] = []
    if (expiredCount > 0) parts.push(`${expiredCount} vencido${expiredCount === 1 ? "" : "s"} con stock`)
    if (expiringCount > 0) parts.push(`${expiringCount} por vencer en ≤ 7 días`)
    items.push({
      key: "lots-expiring-or-expired",
      title: `${lotsAlert.length} lote${lotsAlert.length === 1 ? "" : "s"} de insumo por vencer o vencido`,
      body: `${parts.join(" · ")}. Un lote vencido no se da de baja solo — hay que registrar la merma.`,
      to: "/admin/inventario?tab=lotes",
      ctaLabel: "Ver Lotes",
      tone: expiredCount > 0 ? "critical" : "warning",
      screen: "Inventario",
      tab: "Lotes",
    })
  }

  const payablesOverdue = today.payables_overdue ?? []
  if (payablesOverdue.length > 0) {
    const names = payablesOverdue.slice(0, 3).map((p) => p.supplier_name)
    const rest = payablesOverdue.length - names.length
    items.push({
      key: "payables-overdue",
      title: `${payablesOverdue.length} cuenta${payablesOverdue.length === 1 ? "" : "s"} por pagar vencida${payablesOverdue.length === 1 ? "" : "s"}`,
      body: rest > 0 ? `${names.join(", ")} y ${rest} más.` : names.join(", "),
      to: "/admin/compras?tab=cuentas-por-pagar",
      ctaLabel: "Ver Compras",
      tone: "critical",
      screen: "Compras",
      tab: "Cuentas por pagar",
      filter: "vencidas",
    })
  }

  const payablesPendingReview = today.payables_pending_review_count ?? 0
  if (payablesPendingReview > 0) {
    items.push({
      key: "payables-pending-review",
      title: `${payablesPendingReview} cuenta${payablesPendingReview === 1 ? "" : "s"} por pagar pendiente${payablesPendingReview === 1 ? "" : "s"} de revisión`,
      body: "No se pueden pagar hasta que un administrador las apruebe — es el control entre quien recibe y quien paga.",
      to: "/admin/compras?tab=cuentas-por-pagar",
      ctaLabel: "Ver Compras",
      tone: "warning",
      screen: "Compras",
      tab: "Cuentas por pagar",
      filter: "por revisar",
    })
  }

  // `null` = la función está apagada o el dominio no está montado — no es
  // lo mismo que "confiable" (`false`), así que sólo se dibuja la tarjeta
  // cuando el backend afirma explícitamente que NO es confiable.
  if (today.inventory_unreliable === true) {
    const days = today.days_since_last_full_count
    items.push({
      key: "inventory-unreliable",
      title: "Inventario no confiable",
      body:
        days !== null && days !== undefined
          ? `${days} días sin un conteo completo aplicado (más de 14). El food cost real no se publica hasta que haya uno.`
          : "Nunca se aplicó un conteo completo en esta sede. El food cost real no se publica hasta que haya uno.",
      to: "/admin/inventario?tab=salud",
      ctaLabel: "Ver Salud del control",
      tone: "critical",
      screen: "Inventario",
      tab: "Salud del control",
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
    screen: route.screen,
    tab: route.tab,
    filter: route.filter,
  }
}

const TONE_RANK: Record<AttentionTone, number> = { critical: 0, warning: 1, default: 2 }

/**
 * Un aviso, con el enlace que nombra a dónde lleva **en palabras**
 * (`docs/PATRONES-ADMIN.md` § 6 y § 7): la consulta cruda
 * (`?tab=stock&negative=1`) viaja en `to` y no se dibuja nunca.
 */
function toNotice(item: AttentionItem): Notice {
  const link: FilterLinkProps = { to: item.to, screen: item.screen, tab: item.tab, filter: item.filter }
  const severity = SEVERITY_OF_TONE[item.tone]

  // El crítico va **desplegado**: cifra adelante, consecuencia en el cuerpo.
  if (severity === "critical") {
    return { id: item.key, severity, title: item.title, consequence: item.body, link }
  }

  // El resto **colapsa a una línea**. El detalle no se tira: viaja en esa
  // misma línea, apagado. Sin eso el aviso diría «9 insumos bajo el mínimo»
  // y no cuáles, que es justo el dato por el que el dueño hace clic.
  return {
    id: item.key,
    severity,
    title: (
      <>
        {item.title} <span className="text-muted-foreground">— {item.body}</span>
      </>
    ),
    link,
  }
}

/** La franja de estado de la fila: la forma del problema, sin leer (§ 8b). */
function openOrderStatus(order: OpenOrderAgeOut): RowStatus {
  if (order.unpaid_flag) return "critical"
  if (order.unsent_flag) return "warning"
  return "none"
}

function minutesCell(minutes: number | null | undefined): string {
  return minutes === null || minutes === undefined ? "—" : `${minutes} min`
}

const OPEN_ORDER_COLUMNS: readonly DenseColumn<OpenOrderAgeOut>[] = [
  // Un número de comanda es UNA palabra: `#1418`, nunca `141` / `8` (§ 8).
  { key: "id", header: "Comanda", kind: "id", cell: (o) => `#${o.id}` },
  // La celda escribe la palabra del negocio, no el enum: `Mesa`, no `dine_in`.
  { key: "channel", header: "Canal", cell: (o) => (o.channel ? (CHANNEL_LABEL[o.channel] ?? o.channel) : "—") },
  { key: "tables", header: "Mesa", kind: "secondary", cell: (o) => (o.tables ?? []).join(", ") || "—" },
  {
    key: "opened",
    header: "Abierta hace",
    kind: "number",
    cell: (o) => minutesCell(o.minutes_since_opened),
    cellTitle: (o) => (o.opened_at ? formatInstant(o.opened_at) : undefined),
  },
  {
    key: "presented",
    header: "Presentada hace",
    kind: "number",
    cell: (o) => minutesCell(o.minutes_since_bill_presented),
    cellTitle: (o) => (o.bill_presented_at ? formatInstant(o.bill_presented_at) : undefined),
  },
  { key: "total", header: "Total", kind: "number", cell: (o) => formatCOP(o.total) },
  {
    key: "flags",
    header: "Aviso",
    cell: (o) => (
      <span className="flex items-center gap-1">
        {o.unsent_flag ? <Badge variant="secondary">Sin enviar</Badge> : null}
        {o.unpaid_flag ? <Badge variant="destructive">Sin cobrar</Badge> : null}
        {!o.unsent_flag && !o.unpaid_flag ? <span className="text-muted-foreground">—</span> : null}
      </span>
    ),
  },
]

/**
 * **Tabla densa** de las comandas todavía abiertas (`docs/PATRONES-ADMIN.md`
 * § 8): barra con el recuento, franja de estado en la primera celda, la
 * palabra del negocio en vez del enum y la leyenda al pie, una sola vez.
 */
function OpenOrdersTable({ orders }: { orders: OpenOrderAgeOut[] }): React.JSX.Element {
  const flagged = orders.filter((o) => o.unsent_flag || o.unpaid_flag).length
  return (
    <DenseTable
      caption="Comandas todavía abiertas, con canal, mesa, antigüedad y total."
      columns={OPEN_ORDER_COLUMNS}
      rows={orders}
      rowKey={(o) => String(o.id)}
      rowStatus={openOrderStatus}
      maxBodyHeightPx={360}
      bar={
        <DenseTableBar
          shown={orders.length}
          total={orders.length}
          noun="comandas abiertas"
          hidden={flagged > 0 ? `${flagged} con aviso` : "ninguna con aviso"}
        >
          {/* La salida de la tabla es un enlace que nombra a dónde va, no un
              botón disfrazado de enlace (§ 6). */}
          <FilterLink to="/admin/pedidos" screen="Pedidos" />
        </DenseTableBar>
      }
      legend={[
        {
          term: "Sin enviar",
          meaning: "se tomó y nunca llegó a cocina. Nadie está cocinando eso todavía.",
        },
        {
          term: "Sin cobrar",
          meaning: "la cuenta se presentó hace más de lo esperado. Es por donde se va la plata.",
        },
      ]}
      empty={
        <EmptyState
          title="Sin comandas abiertas"
          description="No hay mesas ni pedidos en curso en este momento."
        />
      }
    />
  )
}

/**
 * "Hoy" (SPEC-NEGOCIO §9.3): pulso del día + "Requiere tu atención", con los
 * patrones del escritorio del dueño aplicados (`docs/PATRONES-ADMIN.md`):
 * cabecera con la pregunta que contesta (§ 2), la plata leída como una resta
 * (§ 4), los indicadores partidos en «Del día» y «Ahora mismo» (§ 3), las
 * tarjetas con su pie de composición y `—` que no es `0` (§ 5), el riel de
 * avisos pegado a la derecha con encabezado de gravedad (§ 7) y la tabla
 * densa con recuento y leyenda al pie (§ 8).
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
  // § 13, los dos hermanos del vacío: **cargando conserva el armazón** y
  // esqueletea sólo los datos, con el ancho y el alto de lo que va a llegar;
  // **el error** dice qué contestó el servidor y se reintenta sin perder
  // nada. En los dos casos la cabecera sigue ahí: la pantalla no salta.
  if (query.isLoading || query.isError) {
    return (
      <div className="space-y-5">
        <PageHeader
          name="Hoy"
          question="Cómo va el día en curso: lo que ya entró, lo que todavía está abierto y lo que no puede esperar a mañana."
          context={[{ label: query.isError ? "No se pudo leer el día" : "Leyendo el día…" }]}
        />
        {query.isError ? (
          <EmptyState
            reason="error"
            title="No se pudo cargar «Hoy»"
            description={errorMessage(query.error)}
            action={{ label: "Reintentar", onClick: () => void query.refetch() }}
          />
        ) : (
          <div aria-busy="true" aria-label="Cargando el pulso de hoy" className="space-y-5">
            <Skeleton className="h-[8.5rem] w-full rounded-lg" />
            <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,21rem)]">
              <div className="min-w-0 space-y-5">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  {[0, 1, 2, 3].map((i) => (
                    <Skeleton key={i} className="h-[7.5rem] rounded-lg" />
                  ))}
                </div>
                <Skeleton className="h-52 w-full rounded-lg" />
                <Skeleton className="h-60 w-full rounded-lg" />
              </div>
              <Skeleton className="h-96 rounded-lg" />
            </div>
          </div>
        )}
      </div>
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

  const hourBuckets = today.sales_by_hour ?? []
  const hourBars = hourBuckets.map((h) => ({ key: String(h.hour), label: hourLabel(h.hour), value: h.net }))
  // Elegir el máximo de una serie que el servidor ya mandó es selección, no
  // matemática de negocio: acá no se suma, ni se promedia, ni se deriva un
  // saldo (AGENTS.md § "una sola matemática, en el backend").
  const peakHour = hourBuckets.reduce<(typeof hourBuckets)[number] | null>(
    (best, h) => (best === null || h.net > best.net ? h : best),
    null,
  )

  const openOrders = today.open_orders ?? []
  const stuck = (today.unsent_count ?? 0) > 0 || (today.unpaid_count ?? 0) > 0
  const noShift = today.expected_cash === null || today.expected_cash === undefined
  const updatedIso = new Date(query.dataUpdatedAt).toISOString()
  const tipsByMethod = today.tips_by_method ?? []

  return (
    <div className="space-y-5">
      <PageHeader
        name="Hoy"
        question="Cómo va el día en curso: lo que ya entró, lo que todavía está abierto y lo que no puede esperar a mañana."
        context={[
          {
            label: "Se actualiza sola cada 30 s ·",
            value: <TimeAgo iso={updatedIso} />,
            title: formatInstant(updatedIso),
          },
          { label: "Día operativo", value: formatBusinessDate(today.business_date) },
          {
            label: openOrders.length === 1 ? "comanda todavía abierta" : "comandas todavía abiertas",
            value: String(openOrders.length),
          },
        ]}
      />

      {/* § 4 · La plata nunca es un número suelto: es una resta. Y las
          propinas van ABAJO DE LA RAYA, rotuladas como que no son venta
          (Ley 1935 de 2018: la propina no es del restaurante). Eso es lo
          que mata la tarjeta «Propinas», que era un error de categoría. */}
      <HeadlineFigure
        label="Ventas netas de hoy"
        value={formatCOP(today.net)}
        note={
          today.orders !== undefined
            ? `${today.orders} ${today.orders === 1 ? "comanda pagada" : "comandas pagadas"} · el día sigue abierto`
            : "El día sigue abierto."
        }
        ledger={{
          rows: [
            { label: "Ventas cobradas", value: formatCOP(today.gross) },
            { label: "Impuesto discriminado", value: formatCOP(today.tax), kind: "subtract" },
          ],
          total: { label: "Ventas netas", value: formatCOP(today.net) },
        }}
        belowTheLine={{ label: "Propinas de hoy — no son venta", value: formatCOP(today.tips_total) }}
      />

      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,21rem)]">
        <div className="min-w-0 space-y-5">
          {/* § 3 · Una grilla uniforme aplana cosas de naturaleza distinta. */}
          <GroupLabel label="Del día" says="cerrado, ya no cambia">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <StatTile
                label="Comandas pagadas"
                value={today.orders !== undefined ? String(today.orders) : "—"}
                hint="Cobradas y cerradas: ya no cambian."
                icon={ReceiptText}
              />
              <StatTile
                label="Ticket promedio"
                value={formatCOP(today.avg_ticket)}
                hint="Sobre venta neta, sin propina."
                icon={ReceiptText}
              />
              <StatTile
                label="Ticket por comensal"
                value={formatCOP(today.avg_per_cover)}
                hint="Sobre las comandas que sí contaron comensales, no sobre todas."
                icon={Users}
              />
              {/* § 5 · `—` no es `0`, y se dibuja apagado, nunca en rojo. */}
              {today.covers === null || today.covers === undefined ? (
                <StatTile
                  label="Comensales"
                  value={null}
                  nullNote="No es cero: es que nadie lo contó. Las comandas de mostrador no registran comensales."
                  icon={Users}
                />
              ) : (
                <StatTile
                  label="Comensales"
                  value={String(today.covers)}
                  hint="Contados al abrir la mesa."
                  icon={Users}
                />
              )}
            </div>
          </GroupLabel>

          <section className="rounded-lg border bg-card p-4">
            <div className="flex flex-wrap items-baseline gap-2">
              <h2 className="text-sm font-bold">Ventas por hora</h2>
              <span className="text-xs text-muted-foreground">Netas, sin propina.</span>
            </div>
            <div className="mt-3">
              <CategoryBars data={hourBars} formatValue={(v) => formatCOP(v)} emptyLabel="Todavía no hay ventas hoy" />
            </div>
            {peakHour ? (
              <p className="mt-3 border-t pt-2 text-xs text-muted-foreground">
                La hora más fuerte del día fue la de <b className="text-foreground">{hourLabel(peakHour.hour)}</b>, con{" "}
                <b className="text-foreground tabular-nums">{formatCOP(peakHour.net)}</b> netos.
              </p>
            ) : null}
          </section>

          <GroupLabel label="Ahora mismo" says="vivo — todavía puede cambiar o salir mal">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <StatTile
                label="Mesas ocupadas"
                value={`${today.tables_occupied ?? 0}/${today.tables_total ?? 0}`}
                hint="Del total de mesas activas de la sede."
                icon={Table2}
              />
              {/* § 5, regla dura: una tarjeta con tono lleva a algún lado. */}
              <StatTile
                label="Comandas abiertas"
                value={String(openOrders.length)}
                hint={
                  stuck
                    ? `${today.unsent_count ?? 0} sin enviar · ${today.unpaid_count ?? 0} sin cobrar`
                    : "Ninguna atascada."
                }
                tone={stuck ? "warning" : "default"}
                icon={UtensilsCrossed}
                link={{ to: "/admin/pedidos", screen: "Pedidos" }}
              />
              {noShift ? (
                <StatTile
                  label="Efectivo esperado"
                  value={null}
                  nullNote="Sin turno abierto: no hay caja de la que esperar nada. No es cero."
                  tone="critical"
                  icon={Banknote}
                  link={{ to: "/admin/dinero", screen: "Dinero", tab: "Operacional" }}
                />
              ) : (
                <StatTile
                  label="Efectivo esperado"
                  value={formatCOP(today.expected_cash)}
                  hint="Lo que el turno abierto debería tener en el cajón ahora."
                  icon={Banknote}
                  link={{ to: "/admin/dinero", screen: "Dinero", tab: "Operacional" }}
                />
              )}
            </div>
          </GroupLabel>

          {tipsByMethod.length > 0 ? (
            <section className="rounded-lg border bg-card p-4">
              <h2 className="text-sm font-bold">Propinas por medio</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                De qué está hecha la propina de abajo de la raya. No es venta del restaurante.
              </p>
              <div className="mt-3 flex flex-wrap gap-3">
                {tipsByMethod.map((m) => (
                  <div key={m.method} className="rounded-md border px-3 py-2 text-sm">
                    <span className="text-muted-foreground">{methodLabel(m.method)}: </span>
                    <span className="font-bold tabular-nums">{formatCOP(m.amount)}</span>
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          <OpenOrdersTable orders={openOrders} />
        </div>

        {/* § 7 · Una columna pegada a la derecha, siempre visible, con
            encabezado de gravedad y recuento. Lo urgente no queda nunca bajo
            el pliegue. */}
        <NoticeRail
          title="Requiere tu atención"
          notices={attention.map(toNotice)}
          footNote="Ordenados por gravedad"
          empty={
            <AllClearEmptyState
              title="Todo al día"
              description="No hay comandas atascadas, agotados, devoluciones pendientes ni cierres sin revisar."
            />
          }
        />
      </div>
    </div>
  )
}

export default TodayPage
