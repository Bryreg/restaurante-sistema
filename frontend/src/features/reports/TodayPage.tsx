import { useQuery } from "@tanstack/react-query"
import {
  Banknote,
  BarChart3,
  CalendarDays,
  Clock,
  Coins,
  RefreshCw,
  Table2,
  UtensilsCrossed,
  type LucideIcon,
} from "lucide-react"
import { useEffect } from "react"
import { Link, useLocation } from "react-router-dom"

import {
  CASH_DIFF_SUMMARY_ALERT_TYPE,
  getToday,
  type AlertOut,
  type CashDiffSummaryPayload,
  type HourBucketOut,
  type IngredientAlertOut,
  type LotAlertOut,
  type NegativeStockAlertOut,
  type OpenOrderAgeOut,
  type PayableAlertOut,
  type PrepAlertOut,
  type TodayOut,
  type UnavailableProductOut,
  type UncostedProductOut,
} from "@/api/reports"
import { useSession } from "@/app/session"
import { useStoreSelection } from "@/app/storeContext"
import {
  AllClearEmptyState,
  DenseTable,
  DenseTableBar,
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
import { Cargando } from "@/components/Cargando"
import { ChartFrame, ColumnChart, type ColumnDatum } from "@/components/charts"
import { EmptyState } from "@/components/EmptyState"
import { SinDato } from "@/components/SinDato"
import { StatTile } from "@/components/StatTile"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { formatBusinessDate, formatInstant } from "@/lib/businessDate"
import { errorMessage } from "@/lib/errors"
import { formatDuracion, formatFechaCorta, formatPct } from "@/lib/format"
import { formatCOP } from "@/lib/money"
import { cn } from "@/lib/utils"

import { CHANNEL_LABEL } from "@/features/orders/lib"

import {
  ALERT_LEVEL_TONE,
  alertRoute,
  businessDateOfInstant,
  deltaWord,
  formatDelta,
  methodLabel,
  weekdayName,
} from "./lib"
import { NoveltiesTray } from "@/features/novelties"
import { receptionDraftsTrayItem } from "@/features/purchases"
import { RequestsTray } from "@/features/requests"

import { Definiciones, Plegable, type Definicion } from "./Plegable"

/** El ancla de la bandeja: solicitudes y novedades que el salón le dejó al dueño. */
const ANCLA_BANDEJA = "bandeja"

const REFRESH_MS = 30_000

/**
 * La cifra rectora en verde, que en este admin es el color de la venta (mapa
 * de pantallas, regla 1). `HeadlineFigure` dibuja la cifra en tinta y la usan
 * otras pantallas, así que el color se pone desde acá, sobre su `text-4xl`.
 */
const CIFRA_VENTA = "xl:col-start-1 [&_.text-4xl]:text-success"

/**
 * El ancla de «Requiere tu atención». La usa «Avisos» de la barra inferior
 * del celular (`app/AdminLayout.tsx`, `ANCLA_AVISOS`): el mismo texto en los
 * dos lados, y la prueba de esta pantalla lo fija.
 */
const ANCLA_ATENCION = "requiere-atencion"

function hourLabel(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`
}

/** La hora corta para el eje: «06», «13». */
function hourTick(hour: number): string {
  return String(hour).padStart(2, "0")
}

/**
 * La hora del corte del día, como la escribe `a2`: «3:00 a. m.». Sale de
 * `me.store.cutoff_hour`, que el servidor ya manda en la sesión — acá no se
 * calcula ninguna fecha, sólo se escribe un entero en palabras.
 */
function cutoffLabel(hour: number): string {
  const ampm = hour < 12 ? "a. m." : "p. m."
  const h12 = hour % 12 === 0 ? 12 : hour % 12
  return `${h12}:00 ${ampm}`
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
  /** Lo que se ve en el riel: el dato corto (nombres, recuentos) y la consecuencia. */
  body: string
  /**
   * Por qué importa, en una frase. **No va en el riel**: va plegada en
   * «Cómo leer estos avisos», debajo (mapa de pantallas, regla 2: la
   * explicación no ocupa la primera lectura). `term` nombra la clase de
   * aviso sin la cifra, para no repetir el título del riel. Los avisos del
   * servidor no la traen: su `body` ya es corto.
   */
  why?: { term: string; text: string }
  to: string
  ctaLabel: string
  tone: AttentionTone
  /** La pantalla destino **en palabras** (`docs/PATRONES-ADMIN.md` § 6). */
  screen: string
  /** La pestaña destino en palabras, si la tiene. */
  tab?: string
  /** El filtro que el enlace deja puesto, en palabras. Sin filtro, no hay pastilla. */
  filter?: string
  /**
   * La plata en juego, en pesos enteros, TAL COMO LA MANDA el servidor
   * (`AlertOut.amount`, `payables_overdue_total`,
   * `ingredients_negative_amount`). Sólo ordena y se escribe: `null`/ausente
   * = el aviso no es de plata, y no se dibuja «$ 0».
   */
  amount?: number | null
  /** Cómo se escribe `amount` en el riel, si no es un `formatCOP` pelado. */
  amountText?: string
}

/**
 * Días de calendario entre dos fechas de negocio ISO («2026-09-18»). Es una
 * cuenta de FECHAS, no de plata: sólo decide la gravedad del aviso de lo sin
 * consignar. `null` si alguna no se puede leer — entonces no se escala.
 */
function daysBetween(fromIso: string | null | undefined, toIso: string | null | undefined): number | null {
  const parse = (iso: string | null | undefined) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? "")
    return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null
  }
  const a = parse(fromIso)
  const b = parse(toIso)
  if (a === null || b === null) return null
  // Dos medianoches UTC: la diferencia es un múltiplo exacto de un día.
  return (b - a) / 86_400_000
}

/** Más de estos días sin consignar la plata más vieja y el aviso pasa a crítico. */
const UNDEPOSITED_CRITICAL_DAYS = 3

function directAttentionItems(today: {
  business_date?: string
  deposits_to_confirm_count?: number
  undeposited_total?: number | null
  undeposited_oldest_date?: string | null
  reception_drafts_pending_count?: number
  requests_pending_count?: number
  novelties_open_count?: number
  novelties_urgent_count?: number
  transfers_incoming_count?: number
  payables_overdue_total?: number | null
  ingredients_negative_amount?: number | null
  ingredients_negative_unvalued?: number
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
      body: "No hay un turno de caja abierto ahora.",
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
    // Las mismas palabras que el pie de la tarjeta «Comandas abiertas».
    if (unsent > 0) parts.push(`${unsent} sin enviar`)
    if (unpaid > 0) parts.push(`${unpaid} sin cobrar`)
    items.push({
      key: "stale-orders",
      title: "Comandas atascadas",
      body: `${parts.join(" · ")}.`,
      why: { term: "Atascadas", text: "Llevan más del tiempo esperado sin enviar a cocina, o con la cuenta presentada sin cobrar." },
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
      body: "Quedaron sin saldar.",
      why: { term: "Devoluciones pendientes", text: "No había un turno abierto al emitir la nota." },
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
      body: "Falta el paso 2 del cierre a ciegas.",
      to: "/admin/dinero",
      ctaLabel: "Ver Dinero",
      tone: "default",
      screen: "Dinero",
      tab: "Operacional",
    })
  }

  // Consignar desde el POS (2026-09-24). Con «Consignaciones» apagada el
  // servidor manda `0`/`null` y ninguno de los dos avisos entra.
  const toConfirm = today.deposits_to_confirm_count ?? 0
  if (toConfirm > 0) {
    items.push({
      key: "deposits-to-confirm",
      title: `${toConfirm} consignaci${toConfirm === 1 ? "ón" : "ones"} por confirmar`,
      body: "Las registró quien tenía la caja, desde el POS. Ya descuentan del saldo por consignar.",
      why: {
        term: "Consignaciones por confirmar",
        text: "Mirá el comprobante y confirmala, o rechazala con su motivo: rechazada, la plata vuelve a figurar por consignar.",
      },
      to: "/admin/banco?tab=consignaciones",
      ctaLabel: "Ver Banco",
      tone: "warning",
      screen: "Banco",
      tab: "Consignaciones",
    })
  }

  // El total lo suma el servidor (`undeposited_total`): acá sólo se escribe.
  // `null` = sin saldo publicado, no «$ 0».
  const undeposited = today.undeposited_total
  if (undeposited !== null && undeposited !== undefined && undeposited > 0) {
    const oldest = today.undeposited_oldest_date ?? null
    const age = daysBetween(oldest, today.business_date)
    items.push({
      key: "undeposited",
      title: oldest
        ? `${formatCOP(undeposited)} sin consignar desde el ${formatFechaCorta(oldest)}`
        : `${formatCOP(undeposited)} sin consignar`,
      body: "Venta de días anteriores que todavía no llegó al banco.",
      why: {
        term: "Sin consignar",
        text: `Plata de cierres que sigue en el cajón o en la mano. Con más de ${UNDEPOSITED_CRITICAL_DAYS} días, el aviso pasa a crítico.`,
      },
      to: "/admin/banco?tab=por-consignar",
      ctaLabel: "Ver Por consignar",
      tone: age !== null && age > UNDEPOSITED_CRITICAL_DAYS ? "critical" : "warning",
      screen: "Banco",
      tab: "Por consignar",
    })
  }

  // La rutina del turno en el POS (2026-09-25): lo que el salón le dejó al
  // dueño. Solicitudes y novedades se resuelven en la bandeja de abajo
  // (`#bandeja`); recepciones y traslados, en su pantalla.
  const reception = receptionDraftsTrayItem(today.reception_drafts_pending_count)
  if (reception) items.push(reception)

  const requestsPending = today.requests_pending_count ?? 0
  if (requestsPending > 0) {
    items.push({
      key: "requests-pending",
      title: `${requestsPending} solicitud${requestsPending === 1 ? "" : "es"} del salón por resolver`,
      body: "Pedidos de insumos o de sencilla hechos desde el POS.",
      to: `/admin/hoy#${ANCLA_BANDEJA}`,
      ctaLabel: "Ver la bandeja",
      tone: "warning",
      screen: "Hoy",
      tab: "Bandeja",
    })
  }

  const noveltiesOpen = today.novelties_open_count ?? 0
  if (noveltiesOpen > 0) {
    const urgent = today.novelties_urgent_count ?? 0
    items.push({
      key: "novelties-open",
      title: `${noveltiesOpen} novedad${noveltiesOpen === 1 ? "" : "es"} sin resolver`,
      body: urgent > 0 ? `${urgent} urgente${urgent === 1 ? "" : "s"}.` : "Pasan de turno hasta que alguien las resuelve.",
      to: `/admin/hoy#${ANCLA_BANDEJA}`,
      ctaLabel: "Ver la bandeja",
      tone: urgent > 0 ? "critical" : "warning",
      screen: "Hoy",
      tab: "Bandeja",
    })
  }

  const transfersIn = today.transfers_incoming_count ?? 0
  if (transfersIn > 0) {
    items.push({
      key: "transfers-incoming",
      title: `${transfersIn} traslado${transfersIn === 1 ? "" : "s"} por recibir`,
      body: "Otra sede mandó insumos; entran al inventario cuando se reciben.",
      to: "/admin/inventario?tab=movimientos",
      ctaLabel: "Ver Movimientos",
      tone: "warning",
      screen: "Inventario",
      tab: "Movimientos y mermas",
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
    const uncostedNeg = today.ingredients_negative_unvalued ?? 0
    items.push({
      key: "ingredients-negative",
      title: `${negative.length} insumo${negative.length === 1 ? "" : "s"} en negativo`,
      body:
        (rest > 0 ? `${names.join(", ")} y ${rest} más — ` : `${names.join(", ")} — `) +
        "no bloquea la venta." +
        // Lo que no entra en el monto se dice al lado del monto, no plegado.
        (uncostedNeg > 0
          ? ` ${uncostedNeg} sin costo todavía: no entran en el monto.`
          : ""),
      why: { term: "En negativo", text: "Es deuda de registro, no escasez real. Revisá la causa probable en Movimientos." },
      // Lo que vale lo que falta, sumado por el servidor. `null` = ningún
      // insumo en negativo tiene costo: no hay monto, no «$ 0».
      amount: today.ingredients_negative_amount ?? null,
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
        (rest > 0 ? `${names.join(", ")} y ${rest} más — ` : `${names.join(", ")} — `) + "stock ≤ 0.",
      why: { term: "Preparaciones sin producir", text: "Producilas, o revisá si conviene pasarlas a explotada." },
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
        "el inventario no se movió.",
      why: { term: "Platos sin descontar", text: "Se vendieron sin receta ni insumo directo: la venta siguió, pero no descontaron nada." },
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
      body: `${parts.join(" · ")}.`,
      why: { term: "Lotes vencidos", text: "Un lote vencido no se da de baja solo: hay que registrar la merma." },
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
      // El saldo vencido sumado por el servidor (`payables_overdue_total`):
      // sumar los `balance` acá sería matemática de plata en el cliente.
      amount: today.payables_overdue_total ?? null,
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
      body: "Sin aprobar no se pueden pagar.",
      why: { term: "Cuentas por revisar", text: "Un administrador las aprueba antes de pagarlas: es el control entre quien recibe y quien paga." },
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
          ? `${days} días sin un conteo completo aplicado.`
          : "Nunca se aplicó un conteo completo en esta sede.",
      why: { term: "Sin conteo completo", text: "Con más de 14 días sin un conteo completo, el food cost real no se publica hasta que haya uno." },
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

/**
 * El aviso resumen de caja (`cash_diff_summary`): el texto lo escribe el
 * servidor; acá se le suma quién lleva racha, que viaja en el `payload`
 * («Luz Marina Gómez, 3 cierres seguidos»). Nada se suma ni se cuenta de
 * nuevo: `streaks` ya llega ordenada, la más larga primero.
 */
function cashSummaryBody(alert: AlertOut): string {
  const payload = alert.payload as Partial<CashDiffSummaryPayload> | null | undefined
  const streaks = payload?.streaks ?? []
  if (streaks.length === 0) return alert.body
  const rachas = streaks
    .slice(0, 2)
    .map((s) => `${s.employee_name}, ${s.streak} cierres seguidos`)
    .join("; ")
  const resto = streaks.length > 2 ? ` y ${streaks.length - 2} más` : ""
  return `${alert.body} Racha: ${rachas}${resto}.`
}

/** «faltan $ 68.000» / «sobran $ 12.000»: la palabra dice el signo, sin «−$» con «faltante». */
function cashSummaryAmount(amount: number): string {
  if (amount < 0) return `faltan ${formatCOP(-amount)}`
  if (amount > 0) return `sobran ${formatCOP(amount)}`
  return formatCOP(amount)
}

function alertToItem(alert: AlertOut): AttentionItem {
  const route = alertRoute(alert.type)
  const summary = alert.type === CASH_DIFF_SUMMARY_ALERT_TYPE
  const amount = alert.amount ?? null
  return {
    key: `alert-${alert.type}-${alert.created_at}`,
    title: alert.title,
    body: summary ? cashSummaryBody(alert) : alert.body,
    to: route.to,
    ctaLabel: route.label,
    tone: ALERT_LEVEL_TONE[alert.level] ?? "default",
    screen: route.screen,
    tab: route.tab,
    filter: route.filter,
    amount,
    amountText: summary && amount !== null ? cashSummaryAmount(amount) : undefined,
  }
}

const TONE_RANK: Record<AttentionTone, number> = { critical: 0, warning: 1, default: 2 }

/** Cuánta plata mueve el aviso, para ORDENAR (no se dibuja): sin monto, al final. */
function magnitude(item: AttentionItem): number {
  return item.amount === null || item.amount === undefined ? -1 : Math.abs(item.amount)
}

/**
 * Gravedad primero y, dentro de la misma gravedad, la plata en juego de
 * mayor a menor (el mismo criterio con que el servidor ordena `alerts`).
 * Los que no son de plata quedan después, en el orden en que llegaron.
 */
function sortAttention(items: AttentionItem[]): AttentionItem[] {
  return items
    .map((item, i) => ({ item, i }))
    .sort((a, b) => {
      const tono = TONE_RANK[a.item.tone] - TONE_RANK[b.item.tone]
      if (tono !== 0) return tono
      const ma = magnitude(a.item)
      const mb = magnitude(b.item)
      if (ma !== mb) return mb > ma ? 1 : -1
      return a.i - b.i
    })
    .map(({ item }) => item)
}

/**
 * Un aviso, con el enlace que nombra a dónde lleva **en palabras**
 * (`docs/PATRONES-ADMIN.md` § 6 y § 7): la consulta cruda
 * (`?tab=stock&negative=1`) viaja en `to` y no se dibuja nunca.
 */
function toNotice(item: AttentionItem): Notice {
  const link: FilterLinkProps = { to: item.to, screen: item.screen, tab: item.tab, filter: item.filter }
  // **Todos con la misma forma**: título, por qué duele, destino. Lo que
  // dice la gravedad es el riel de color del `NoticeRail`, no la forma del
  // aviso (`admin/a2`, `.av` / `.av.crit` / `.av.warn`). Antes el no crítico
  // colapsaba a una línea con el cuerpo corriendo apagado detrás del título,
  // y con siete avisos seguidos el riel parecía dos listas distintas.
  return {
    id: item.key,
    severity: SEVERITY_OF_TONE[item.tone],
    title: item.title,
    consequence: item.body,
    link,
    amount:
      item.amount === null || item.amount === undefined ? undefined : (item.amountText ?? formatCOP(item.amount)),
  }
}

/** Cuántos avisos se ven de entrada en el riel (mapa de pantallas: «como máximo 5»). */
const VISIBLE_NOTICES = 5

/**
 * «Requiere tu atención» con **cinco avisos a la vista** y el resto detrás
 * de un solo «Ver n más» (mapa de pantallas aprobado para Hoy). El corte lo
 * hace el riel (`limit`), en cualquier ancho, y sus recuentos —el total del
 * encabezado y el de cada gravedad— siguen diciendo cuántos hay de verdad,
 * no cuántos se ven. La cola «para cuando puedas» no cuenta: el riel ya la
 * pliega.
 */
function AttentionRail({ attention }: { attention: AttentionItem[] }): React.JSX.Element {
  // Una vez por clase de aviso, aunque haya dos del mismo tipo.
  const porQue = [
    ...new Map(
      attention.flatMap((a) => (a.why ? [[a.why.term, { term: a.why.term, meaning: a.why.text }] as const] : [])),
    ).values(),
  ]

  // El `sticky` del escritorio pasa del riel a este envoltorio: pegado sólo
  // el riel, al bajar se montaba encima del plegable, que quedaba en su
  // lugar debajo de él. El padre es el que se estira por toda
  // la columna, así que el envoltorio tiene por dónde correr. Lleva también
  // el ancla de «Avisos»; `scroll-mt-28`: en el celular la barra superior
  // pega en dos renglones (~88 px) y taparía el título.
  return (
    <div
      id={ANCLA_ATENCION}
      tabIndex={-1}
      className="scroll-mt-28 focus:outline-none xl:sticky xl:top-4"
    >
      <NoticeRail
        title="Requiere tu atención"
        className="static"
        limit={VISIBLE_NOTICES}
        // `sortAttention` deja los urgentes primero, en el orden del riel.
        notices={attention.map(toNotice)}
        empty={
          <AllClearEmptyState
            title="Todo al día"
            description="No hay comandas atascadas, agotados, devoluciones pendientes ni cierres sin revisar."
          />
        }
      />
      {porQue.length > 0 ? (
        <Plegable resumen="Cómo leer estos avisos" className="mt-2 px-1">
          <Definiciones items={porQue} />
        </Plegable>
      ) : null}
    </div>
  )
}

/** La franja de estado de la fila: la forma del problema, sin leer (§ 8b). */
function openOrderStatus(order: OpenOrderAgeOut): RowStatus {
  if (order.unpaid_flag) return "critical"
  if (order.unsent_flag) return "warning"
  return "none"
}

/**
 * De qué día operativo viene una comanda abierta, dicho contra el de hoy:
 * «Viene de ayer» o «Viene del lun 21 sep». `null` = es de hoy, o no se sabe
 * (sin `opened_at` o sin la hora de corte de la sede): no se adivina.
 */
function carriedOverLabel(
  order: OpenOrderAgeOut,
  ctx: { businessDate: string; yesterday: string | null; cutoffHour: number | null | undefined },
): string | null {
  if (!order.opened_at || ctx.cutoffHour === null || ctx.cutoffHour === undefined) return null
  const opened = businessDateOfInstant(order.opened_at, ctx.cutoffHour)
  // Fechas ISO: compararlas como texto es compararlas en el calendario.
  if (opened === null || opened >= ctx.businessDate) return null
  if (ctx.yesterday !== null && opened === ctx.yesterday) return "Viene de ayer"
  return `Viene del ${formatFechaCorta(opened)}`
}

function openOrderColumns(ctx: {
  businessDate: string
  yesterday: string | null
  cutoffHour: number | null | undefined
}): readonly DenseColumn<OpenOrderAgeOut>[] {
  return [
    // Un número de comanda es UNA palabra: `#1418`, nunca `141` / `8` (§ 8).
    { key: "id", header: "Comanda", kind: "id", cell: (o) => `#${o.id}` },
    // La celda escribe la palabra del negocio, no el enum: `Mesa`, no
    // `dine_in`. Las mesas van en la misma celda —«Mesa · 4, 5»— y no en
    // columna propia: para mostrador y domicilio esa columna era un «—» por
    // fila, y la tabla pasaba de las cinco columnas a la vista (regla 3).
    {
      key: "channel",
      header: "Canal · mesa",
      cell: (o) => {
        const canal = o.channel ? (CHANNEL_LABEL[o.channel] ?? o.channel) : "—"
        const mesas = (o.tables ?? []).join(", ")
        return mesas ? `${canal} · ${mesas}` : canal
      },
    },
    {
      key: "opened",
      header: "Abierta hace",
      kind: "number",
      // «16 h 8 min», no «968 min»; y si la comanda cruzó el corte del día,
      // se dice: una mesa de anoche no es una mesa lenta de hoy.
      cell: (o) => {
        const carried = carriedOverLabel(o, ctx)
        return carried ? (
          <span className="inline-flex flex-wrap items-center justify-end gap-1.5">
            <Badge variant="outline" className="font-normal">
              {carried}
            </Badge>
            {formatDuracion(o.minutes_since_opened)}
          </span>
        ) : (
          formatDuracion(o.minutes_since_opened)
        )
      },
      cellTitle: (o) => (o.opened_at ? formatInstant(o.opened_at) : undefined),
    },
    {
      // Detrás de «Más columnas»: la columna «Aviso» ya dice «Sin cobrar»
      // cuando la cuenta presentada se pasó del tiempo.
      key: "presented",
      header: "Presentada hace",
      kind: "number",
      secondary: true,
      cell: (o) => formatDuracion(o.minutes_since_bill_presented),
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
}

/**
 * **Tabla densa** de las comandas todavía abiertas (`docs/PATRONES-ADMIN.md`
 * § 8): barra con el recuento, franja de estado en la primera celda, la
 * palabra del negocio en vez del enum y la leyenda al pie, una sola vez.
 */
function OpenOrdersTable({
  orders,
  businessDate,
  yesterday,
  cutoffHour,
}: {
  orders: OpenOrderAgeOut[]
  businessDate: string
  yesterday: string | null
  cutoffHour: number | null | undefined
}): React.JSX.Element {
  const flagged = orders.filter((o) => o.unsent_flag || o.unpaid_flag).length
  return (
    <DenseTable
      caption="Comandas todavía abiertas, con canal, mesa, antigüedad y total."
      columns={openOrderColumns({ businessDate, yesterday, cutoffHour })}
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
 * El pie de cada tarjeta de indicadores, plegado en «Cómo leer estos
 * indicadores». Son las mismas frases que antes iban bajo cada cifra.
 */
const INDICADORES_EXPLICADOS: readonly Definicion[] = [
  { term: "Comandas pagadas", meaning: "cobradas y cerradas: ya no cambian." },
  { term: "Ticket promedio", meaning: "sobre venta neta, sin propina." },
  { term: "Ticket por comensal", meaning: "sobre las comandas que sí contaron comensales, no sobre todas." },
  { term: "Comensales", meaning: "contados al abrir la mesa." },
  { term: "Mesas ocupadas", meaning: "del total de mesas activas de la sede." },
  { term: "Efectivo esperado", meaning: "lo que el turno abierto debería tener en el cajón ahora." },
  {
    term: "Propinas de hoy",
    meaning: "no son venta del restaurante (Ley 1935 de 2018): se reparten entre el personal y no entran en las ventas netas.",
  },
]

/**
 * Un indicador que llegó `null`. `StatTile` sólo sabe dibujar una cifra, y
 * acá lo que hay que dibujar es **qué falta** (`SinDato`): rayado, apagado y
 * nunca en rojo aunque la tarjeta vaya con tono crítico —el tono es del
 * contexto (no hay turno), no del dato—. Mismo marco que `StatTile` para que
 * la grilla no se vea despareja.
 */
function IndicadorSinDato({
  label,
  motivo,
  icon: Icon,
  tone = "default",
  link,
}: {
  label: string
  motivo: string
  icon?: LucideIcon
  tone?: "default" | "critical"
  link?: FilterLinkProps
}): React.JSX.Element {
  return (
    <div
      className={cn(
        "rounded-lg border border-l-[3px] p-4",
        tone === "critical" ? "border-destructive/30 border-l-destructive bg-destructive/5" : "border-border border-l-border",
      )}
    >
      <div className="flex items-center gap-1.5">
        {Icon ? <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" /> : null}
        <p className="min-w-0 text-sm text-muted-foreground">{label}</p>
      </div>
      <SinDato forma="bloque" motivo={motivo} className="mt-1" />
      {link ? <FilterLink {...link} className="mt-2" /> : null}
    </div>
  )
}

/**
 * La comparación de la cifra rectora: hoy contra el mismo día de la semana
 * pasada HASTA LA MISMA HORA (`TodayOut.comparison`). Todo viene hecho del
 * servidor —el neto de entonces y la variación en puntos básicos—; acá sólo
 * se escribe. Sin comparación posible se dice por qué, nunca «0 %».
 */
function todayComparison(
  c: TodayOut["comparison"],
): { label: string; delta: string; detail?: string } | undefined {
  if (!c) return undefined
  const dia = weekdayName(c.reference_business_date)
  const label = `Contra el ${dia} pasado a esta hora`
  if (c.net === null) {
    return {
      label: c.null_reason ?? `No hay datos del ${dia} pasado: no hay contra qué comparar.`,
      delta: "Sin dato",
    }
  }
  const delta = formatDelta(c.delta_bp)
  if (delta === null) {
    // Sin divisor no hay variación: se dice qué pasó ese día, corto.
    return {
      label,
      delta: "Sin dato",
      detail: c.reference_operated === false ? "ese día no abrió" : `no había vendido: ${formatCOP(c.net)}`,
    }
  }
  return { label, delta, detail: `entonces ${formatCOP(c.net)}` }
}

/**
 * «Ventas por hora» (analista #3, científico #12): columnas —la hora es
 * ORDINAL—, las 24 horas en el orden del día operativo tal como llegan (desde
 * el corte, nunca reordenadas por `hour`). Una hora `pending` todavía no
 * pasó: va como hueco rayado, no como venta $ 0. La marca gris de cada
 * columna es el mismo día de la semana pasada, día completo.
 */
function HourlySales({ today }: { today: TodayOut }): React.JSX.Element {
  const hours: HourBucketOut[] = today.sales_by_hour ?? []
  const reference = today.sales_by_hour_reference ?? []
  const c = today.comparison ?? null
  const dia = c ? weekdayName(c.reference_business_date) : null

  if (hours.length === 0) {
    return (
      <section className="min-w-0 rounded-lg border bg-card p-4 xl:col-start-1">
        <h2 className="text-sm font-bold">Ventas por hora</h2>
        <p className="mt-2 text-sm text-muted-foreground">Todavía no hay ventas hoy.</p>
      </section>
    )
  }

  const referenceByHour = new Map(reference.map((h) => [h.hour, h.net]))
  const hasReference = reference.length > 0
  const datos: ColumnDatum[] = hours.map((h) => ({
    key: String(h.hour),
    etiqueta: hourTick(h.hour),
    valor: h.pending ? null : h.net,
  }))
  const serieReferencia = hasReference ? hours.map((h) => referenceByHour.get(h.hour) ?? null) : undefined
  const pendingCount = hours.filter((h) => h.pending).length
  // Elegir la hora más alta de una serie que el servidor ya mandó es
  // selección, no matemática de negocio: no se suma ni se promedia nada.
  const peak = hours.reduce<HourBucketOut | null>(
    (best, h) => (h.pending || h.net <= 0 ? best : best === null || h.net > best.net ? h : best),
    null,
  )

  let titular: string
  if (c && c.delta_bp !== null && c.delta_bp !== undefined && dia) {
    const palabra = deltaWord(c.delta_bp)
    titular =
      palabra === "igual"
        ? `Vas igual que el ${dia} pasado a esta hora`
        : `Vas ${formatPct(c.delta_bp < 0 ? -c.delta_bp : c.delta_bp)} ${palabra} del ${dia} pasado a esta hora`
  } else if (peak) {
    titular = `La hora más fuerte va siendo la de las ${hourLabel(peak.hour)}`
  } else if (c && c.net === 0 && dia) {
    titular = `Todavía no hay ventas; el ${dia} pasado a esta hora tampoco`
  } else {
    titular = "Todavía no hay ventas hoy"
  }

  const detalle = [
    "Venta neta por hora de reloj, sin propina, desde el corte del día.",
    hasReference && dia ? `La marca gris es el ${dia} pasado, día completo.` : null,
    pendingCount > 0 ? "Rayado: horas que todavía no llegan (no son $ 0)." : null,
  ]
    .filter(Boolean)
    .join(" ")

  const refLabel = dia ? `${dia.charAt(0).toUpperCase()}${dia.slice(1)} pasado` : "Semana pasada"

  return (
    <section className="min-w-0 rounded-lg border bg-card p-4 xl:col-start-1">
      <h2 className="mb-2 text-xs font-bold tracking-wider text-muted-foreground uppercase">Ventas por hora</h2>
      <ChartFrame
        titular={titular}
        // El método del gráfico se lee una vez: va plegado (regla 2), y a la
        // vista queda el titular, que es la conclusión.
        detalle={<Plegable resumen="Cómo leer esto">{detalle}</Plegable>}
        tabla={{
          columnas: [
            { key: "hora", header: "Hora" },
            { key: "hoy", header: "Hoy", align: "right" },
            ...(hasReference ? [{ key: "ref", header: `${refLabel} (día completo)`, align: "right" as const }] : []),
            { key: "comandas", header: "Comandas", align: "right" },
          ],
          filas: hours.map((h) => ({
            hora: hourLabel(h.hour),
            hoy: h.pending ? <span className="text-muted-foreground italic">todavía no llega</span> : formatCOP(h.net),
            ref: hasReference ? formatCOP(referenceByHour.get(h.hour)) : undefined,
            comandas: h.pending ? "" : String(h.orders ?? "—"),
          })),
        }}
      >
        <ColumnChart
          datos={datos}
          formato={formatCOP}
          serieReferencia={serieReferencia}
          etiquetaSerie="Hoy"
          etiquetaSerieReferencia={`${refLabel}, día completo`}
          resumen={
            `Columnas de venta neta por hora de hoy${peak ? `; la más alta, las ${hourLabel(peak.hour)} con ${formatCOP(peak.net)}` : ", todavía sin ventas"}` +
            `${pendingCount > 0 ? `; ${pendingCount} horas todavía no llegan` : ""}. El detalle está en la tabla.`
          }
        />
      </ChartFrame>
      {peak && c && c.delta_bp !== null && c.delta_bp !== undefined ? (
        <p className="mt-3 border-t pt-2 text-xs text-muted-foreground">
          La hora más fuerte del día va siendo la de las <b className="text-foreground">{hourLabel(peak.hour)}</b>, con{" "}
          <b className="text-foreground">{formatCOP(peak.net)}</b> netos.
        </p>
      ) : null}
    </section>
  )
}

/**
 * "Hoy" (SPEC-NEGOCIO §9.3): pulso del día + "Requiere tu atención", con los
 * patrones del escritorio del dueño aplicados (`docs/PATRONES-ADMIN.md`):
 * cabecera con la pregunta que contesta (§ 2), la plata leída como una resta
 * (§ 4), las ocho tarjetas con `—` que no es `0` (§ 5), el riel de avisos
 * pegado a la derecha con encabezado de gravedad (§ 7) y la tabla densa con
 * recuento y leyenda al pie (§ 8). Con «Orden y aire» (mapa de pantallas
 * aprobado) la primera lectura es sólo de cifras: el riel muestra cinco
 * avisos y el resto a un toque, y lo que explica —el pie de cada tarjeta,
 * el método del gráfico, el porqué de cada aviso— va plegado.
 */
export function TodayPage(): React.JSX.Element {
  const { activeStoreId, loading: storeLoading } = useStoreSelection()
  const { me } = useSession()
  const cutoffHour = me?.store?.cutoff_hour

  const query = useQuery({
    queryKey: ["admin-today", activeStoreId],
    queryFn: () => getToday(activeStoreId as number),
    enabled: activeStoreId !== null,
    refetchInterval: REFRESH_MS,
  })

  // «Avisos» de la barra del celular trae acá con `#requiere-atencion`. El
  // enrutador no baja solo hasta un ancla, y el riel no existe hasta que
  // llegan los datos: se espera a que estén, se baja y se deja el foco ahí
  // para que el teclado y el lector de pantalla arranquen donde se ve.
  // `location.key` y no sólo `hash`: tocar «Avisos» otra vez, ya parado en
  // el ancla, tiene que volver a bajar.
  const location = useLocation()
  const hayDatos = query.data !== undefined
  useEffect(() => {
    if (location.hash !== `#${ANCLA_ATENCION}` || !hayDatos) return
    const ancla = document.getElementById(ANCLA_ATENCION)
    if (!ancla) return
    // jsdom no implementa `scrollIntoView`.
    ancla.scrollIntoView?.({ block: "start" })
    ancla.focus({ preventScroll: true })
  }, [location.hash, location.key, hayDatos])

  if (storeLoading) {
    return <Cargando texto="Cargando sedes…" />
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
          question="Cómo va el día en curso y qué quedó pendiente de resolver."
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
          <div aria-busy="true" aria-label="Cargando el pulso de hoy">
            {/* El esqueleto copia el reparto de verdad, en el mismo orden:
                la banda, el riel (a su lado desde arriba en el escritorio,
                debajo de ella en el celular), las tarjetas. Si esqueletea
                otra cosa, la pantalla salta al llegar los datos. */}
            <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,22rem)] xl:grid-rows-[repeat(3,auto)_1fr]">
              <Skeleton className="h-[8.5rem] w-full rounded-lg xl:col-start-1" />
              <Skeleton className="h-48 rounded-lg xl:col-start-2 xl:[grid-row:1/-1] xl:h-96" />
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 xl:col-start-1">
                {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
                  <Skeleton key={i} className="h-[7.5rem] rounded-lg" />
                ))}
              </div>
              <Skeleton className="h-52 w-full rounded-lg xl:col-start-1" />
              <Skeleton className="h-60 w-full rounded-lg xl:col-start-1" />
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

  const attention = sortAttention([
    ...directAttentionItems(today),
    ...(today.alerts ?? []).filter((a) => !DEDUPED_ALERT_TYPES.has(a.type)).map(alertToItem),
  ])

  const comparison = todayComparison(today.comparison)
  // Antes de la primera venta, «$ 0» rayado no le dice nada al dueño: se
  // muestra cómo cerró ayer (`yesterday_close`), y el libro sigue siendo el
  // de hoy. Si ayer la sede no abrió, su $ 0 tampoco dice nada: queda hoy.
  const yesterday = today.yesterday_close ?? null
  // Un ayer abierto pero sin ventas tampoco dice nada: sólo con comandas.
  const beforeFirstSale = today.orders === 0 && yesterday !== null && yesterday.operated && yesterday.orders > 0

  const openOrders = today.open_orders ?? []
  const stuck = (today.unsent_count ?? 0) > 0 || (today.unpaid_count ?? 0) > 0
  const noShift = today.expected_cash === null || today.expected_cash === undefined
  const updatedIso = new Date(query.dataUpdatedAt).toISOString()
  const tipsByMethod = today.tips_by_method ?? []

  return (
    // **El riel va al lado de todo, no debajo de la banda.** Es la primera
    // de las cuatro diferencias que el dueño nombró mirando `a2`: ahí el
    // riel arranca a la altura de la banda de cifra y ocupa la columna
    // derecha entera (`.hoy{grid-template-columns:minmax(0,1fr) 336px}`, con
    // la banda **adentro** de `.hoy-col`). Acá la banda estaba afuera de la
    // grilla, así que el riel empezaba 140 px más abajo y la esquina
    // superior derecha —el lugar de la pantalla que más mira— quedaba vacía.
    <div className="space-y-5">
      <PageHeader
        name="Hoy"
        question="Cómo va el día en curso y qué quedó pendiente de resolver."
        context={[
          // Franja de datos cortos (regla 2): «Actualizado hace 14 s». Que se
          // refresca sola y el instante exacto van al `title`.
          {
            label: "Actualizado",
            value: <TimeAgo iso={updatedIso} />,
            title: "Se actualiza sola cada 30 s ·" + " " + formatInstant(updatedIso),
            icon: RefreshCw,
          },
          ...(cutoffHour !== null && cutoffHour !== undefined
            ? [
                {
                  label: "Corte del día a las",
                  value: cutoffLabel(cutoffHour),
                  icon: Clock,
                  title: "Después de esta hora, lo que se venda cuenta para el día siguiente.",
                },
              ]
            : []),
          // «Quedan N comandas abiertas» salió de acá: lo dice la tarjeta
          // «Comandas abiertas», que además lleva a Pedidos.
        ]}
        actions={
          <>
            {/* § 3 de las diferencias nombradas: el período, arriba a la
                derecha y con ícono de calendario, no perdido en la franja de
                contexto. En `a2` es un `.selector`; acá es una **pastilla
                que no se toca**, con la misma métrica y el mismo ícono: esta
                pantalla es, por definición, el día en curso, y un botón que
                abre un calendario sería comportamiento nuevo —elegir otra
                fecha— y no la apariencia que se pidió. El día completo,
                fecha por fecha, es lo que contesta Ventas, y ahí sí va un
                enlace de verdad. */}
            <p
              title="Día operativo"
              className="inline-flex h-8 items-center gap-2 rounded-md border border-input bg-card px-2.5 text-sm font-bold whitespace-nowrap"
            >
              <CalendarDays className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              {formatBusinessDate(today.business_date)}
            </p>
            {/* `title` con el mismo texto que se ve, a propósito: el censo de
                controles lee el código y **no ve un rótulo que viene
                después de un `<svg>`** dentro de un `Button render={<Link/>}`.
                Escrito también en el atributo, el control queda en la red.
                `nativeButton={false}`: acá el disparador es un `<a>`, y sin
                eso Base UI avisa por consola en cada dibujo. */}
            <Button
              variant="outline"
              size="sm"
              nativeButton={false}
              title="Ver el día completo"
              render={<Link to="/admin/ventas" />}
            >
              <BarChart3 className="size-4 shrink-0" aria-hidden="true" />
              Ver el día completo
            </Button>
          </>
        }
      />

      {/* **Un solo nivel de grilla, en el orden en que se lee en el
          celular** (`docs/diseno/propuesta.html`, Momento 5): primero la
          respuesta —la cifra rectora—, después lo que exige actuar, y los
          indicadores al final. Antes el riel iba último en el código y en el
          celular quedaba abajo de todo, después de la tabla de comandas.
          Ahora el orden del código es el de lectura —el foco y el lector de
          pantalla lo siguen— y el escritorio no cambia: desde `xl` el riel
          se va a la columna derecha y ocupa todas las filas
          (`[grid-row:1/-1]`). La última fila es `1fr` para que, si el riel
          mide más que la columna izquierda, lo que sobra caiga debajo del
          último bloque y no repartido entre los bloques. */}
      <div
        className={cn(
          "grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]",
          tipsByMethod.length > 0 ? "xl:grid-rows-[repeat(4,auto)_1fr]" : "xl:grid-rows-[repeat(3,auto)_1fr]",
        )}
      >
        {/* § 4 · La plata nunca es un número suelto: es una resta, y se
            compara contra el mismo día de la semana pasada a la misma hora
            (`comparison`, del servidor: acá no se calcula). */}
        {beforeFirstSale && yesterday ? (
          <HeadlineFigure
            className={CIFRA_VENTA}
            label="Todavía no hay ventas hoy · ayer cerró en"
            value={formatCOP(yesterday.net)}
            note={[
              formatFechaCorta(yesterday.business_date),
              `${yesterday.orders} ${yesterday.orders === 1 ? "comanda pagada" : "comandas pagadas"}`,
              yesterday.avg_ticket !== null ? `ticket promedio ${formatCOP(yesterday.avg_ticket)}` : null,
            ]
              .filter(Boolean)
              .join(" · ")}
            ledger={{
              rows: [
                { label: "Cobrado hoy", value: formatCOP(today.gross) },
                { label: "Impuesto discriminado", value: formatCOP(today.tax), kind: "subtract" },
              ],
              total: { label: "Ventas netas de hoy", value: formatCOP(today.net) },
            }}
            comparison={comparison}
          />
        ) : (
          // Sin nota al pie: las comandas pagadas son la primera tarjeta de
          // abajo, y que el día sigue abierto lo dicen la fecha y «a esta hora».
          <HeadlineFigure
            className={CIFRA_VENTA}
            label="Ventas netas de hoy"
            value={formatCOP(today.net)}
            ledger={{
              rows: [
                { label: "Ventas cobradas", value: formatCOP(today.gross) },
                { label: "Impuesto discriminado", value: formatCOP(today.tax), kind: "subtract" },
              ],
              total: { label: "Ventas netas", value: formatCOP(today.net) },
            }}
            comparison={comparison}
          />
        )}

        {/* § 7 · Una columna pegada a la derecha, siempre visible, con
            encabezado de gravedad y recuento. Lo urgente no queda nunca
            bajo el pliegue. En el celular va justo debajo de la cifra, y
            ahí deja de ser `sticky`: pegado arriba taparía los indicadores
            al bajar. Este envoltorio se estira por toda la columna para
            que el `sticky` del escritorio tenga por dónde correr; el ancla
            de «Avisos» la lleva, adentro, el bloque que se pega
            (`AttentionRail`). */}
        <div className="min-w-0 xl:col-start-2 xl:[grid-row:1/-1] xl:self-stretch">
          <AttentionRail attention={attention} />
        </div>

        {/* **Las ocho tarjetas en una sola grilla**, que es como `a2` las
            dibuja (`.kpis`, ocho `.kpi` en dos filas de cuatro) y lo que
            su propio catálogo de patrones pide: «En Hoy, ocho».

            **Cada tarjeta dice su cifra y nada más** (mapa de pantallas,
            regla 2): el pie que explicaba de qué está hecha —«cobradas y
            cerradas», «sobre venta neta, sin propina»— se leía una vez y
            después era ruido en cada vistazo. Va plegado debajo, en «Cómo
            leer estos indicadores», uno por tarjeta y con las mismas
            palabras. En la tarjeta queda sólo lo que es dato: el desglose de
            las comandas atascadas y el motivo de un «sin dato», que no se
            pliega nunca (`null` no es `0`).

            La octava es **Propinas de hoy**. Sigue dicho, a la vista, que no
            son venta (Ley 1935 de 2018: la propina no es del restaurante), y
            la cifra rectora sigue sin incluirlas. */}
        <div className="min-w-0 space-y-2 xl:col-start-1">
          {/* En el celular, dos columnas (la maqueta del Momento 5): a 360 px
              quedan 158 px por tarjeta, y una cifra de siete dígitos a
              `text-2xl` no entra. Por debajo de `sm` la cifra baja a
              `text-xl` y el relleno a `p-3` desde acá, sin tocar `StatTile`,
              que usan otras setenta pantallas. */}
          <div className="grid min-w-0 grid-cols-2 gap-3 max-sm:[&_.text-2xl]:text-xl max-sm:[&>div]:p-3 lg:grid-cols-4">
            <StatTile label="Comandas pagadas" value={today.orders !== undefined ? String(today.orders) : "—"} />
            {/* § 5 · `null` no es `0`: el servidor manda `null` cuando no
                hay de qué sacar el número, y se dibuja qué falta. Antes
                `formatCOP(null)` escribía un «—» sin motivo. */}
            {today.avg_ticket === null || today.avg_ticket === undefined ? (
              <IndicadorSinDato label="Ticket promedio" motivo="todavía sin comandas pagadas" />
            ) : (
              <StatTile label="Ticket promedio" value={formatCOP(today.avg_ticket)} />
            )}
            {today.avg_per_cover === null || today.avg_per_cover === undefined ? (
              <IndicadorSinDato
                label="Ticket por comensal"
                motivo={
                  (today.orders ?? 0) === 0
                    ? "todavía sin comandas pagadas"
                    : "ninguna comanda pagada hoy registró comensales"
                }
              />
            ) : (
              <StatTile label="Ticket por comensal" value={formatCOP(today.avg_per_cover)} />
            )}
            {today.covers === null || today.covers === undefined ? (
              <IndicadorSinDato label="Comensales" motivo="todavía sin comandas pagadas" />
            ) : (
              <StatTile label="Comensales" value={String(today.covers)} />
            )}
            <StatTile
              label="Mesas ocupadas"
              value={`${today.tables_occupied ?? 0}/${today.tables_total ?? 0}`}
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
              <IndicadorSinDato
                label="Efectivo esperado"
                motivo="no hay un turno de caja abierto"
                tone="critical"
                icon={Banknote}
                link={{ to: "/admin/dinero", screen: "Dinero", tab: "Operacional" }}
              />
            ) : (
              <StatTile
                label="Efectivo esperado"
                value={formatCOP(today.expected_cash)}
                icon={Banknote}
                link={{ to: "/admin/dinero", screen: "Dinero", tab: "Operacional" }}
              />
            )}
            <StatTile label="Propinas de hoy" value={formatCOP(today.tips_total)} hint="No son venta." icon={Coins} />
          </div>
          <Plegable resumen="Cómo leer estos indicadores" className="px-1">
            <Definiciones items={INDICADORES_EXPLICADOS} className="sm:grid-cols-2" />
          </Plegable>
        </div>

        {/* **«Ventas por hora» va acá, debajo de las dos filas de
            tarjetas** — la segunda diferencia que el dueño nombró. Estaba
            en el medio, partiendo la grilla de indicadores en dos, que es
            justo lo que `a2` no hace: primero se lee el pulso entero en
            ocho números, después se mira la forma del día. */}
        <HourlySales today={today} />

        <div className="min-w-0 xl:col-start-1">
          <OpenOrdersTable
            orders={openOrders}
            businessDate={today.business_date}
            yesterday={yesterday?.business_date ?? null}
            // La sesión del administrador no siempre trae la sede; las horas
            // de `sales_by_hour` arrancan en su hora de corte (del servidor).
            cutoffHour={cutoffHour ?? today.sales_by_hour?.[0]?.hour}
          />
        </div>

        {/* **La bandeja** (2026-09-25): lo que el salón le pide al dueño y se
            resuelve acá mismo — solicitudes (aprobar, ajustar, rechazar) y
            novedades (resolver). Sólo aparece si hay algo. */}
        {(today.requests_pending_count ?? 0) > 0 || (today.novelties_open_count ?? 0) > 0 ? (
          <section id={ANCLA_BANDEJA} className="min-w-0 scroll-mt-28 space-y-4 xl:col-start-1">
            <h2 className="text-lg font-bold">Bandeja</h2>
            {(today.requests_pending_count ?? 0) > 0 ? <RequestsTray storeId={activeStoreId} /> : null}
            {(today.novelties_open_count ?? 0) > 0 ? <NoveltiesTray storeId={activeStoreId} /> : null}
          </section>
        ) : null}

        {/* De qué está hecha la propina. `a2` no la modela —su maqueta no
            tiene el dato— así que va al final, después de la tabla, para
            no meterse entre las cuatro zonas que sí ordena. */}
        {tipsByMethod.length > 0 ? (
          <section className="min-w-0 rounded-lg border bg-card p-4 xl:col-start-1">
            <h2 className="text-sm font-bold">Propinas por medio</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              De qué está hecha la propina de la tarjeta de arriba. No es venta del restaurante.
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
      </div>
    </div>
  )
}

export default TodayPage
