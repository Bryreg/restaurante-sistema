import { useQuery } from "@tanstack/react-query"
import { Banknote, BarChart3, CalendarDays, Clock, CreditCard, Download, RefreshCw, type LucideIcon } from "lucide-react"
import { useEffect } from "react"
import { Link, useLocation } from "react-router-dom"

import type { PanelCashOut } from "@/api/panel"
import {
  CASH_DIFF_SUMMARY_ALERT_TYPE,
  getToday,
  todayBlockCsvUrl,
  type AlertOut,
  type AreaCountAreaTodayOut,
  type AreaCountFlagOut,
  type CashDiffSummaryPayload,
  type HourBucketOut,
  type IngredientAlertOut,
  type LotAlertOut,
  type NegativeStockAlertOut,
  type PayableAlertOut,
  type PrepAlertOut,
  type TodayBlock,
  type TodayOut,
  type TodayReceptionLineOut,
  type TodayTopProductOut,
  type UnavailableProductOut,
  type UncostedProductOut,
} from "@/api/reports"
import { useEsCelular } from "@/app/celular"
import { useSession } from "@/app/session"
import { useStoreSelection } from "@/app/storeContext"
import {
  AllClearEmptyState,
  DenseTable,
  HeadlineFigure,
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
import { Skeleton } from "@/components/ui/skeleton"
import { formatBusinessDate, formatClockTime, formatInstant } from "@/lib/businessDate"
import { errorMessage } from "@/lib/errors"
import { formatFechaCorta, formatPct } from "@/lib/format"
import { formatCOP } from "@/lib/money"
import { cn } from "@/lib/utils"

import { ALERT_LEVEL_TONE, alertRoute, deltaWord, formatDelta, weekdayName } from "./lib"
import { areaCountHref, flagPhrase } from "@/features/inventory/areaCountLib"
import { receptionDraftsTrayItem } from "@/features/purchases"

import { Definiciones, Plegable, type Definicion } from "./Plegable"
import { fichaTurnoHref } from "./fichas/rutas"
import { avisoConEnlace, useAccionables } from "./hoy/Atencion"
import { usePanelAhora } from "./PanelAhora"


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
  area_counts_enabled?: boolean
  area_counts_areas?: AreaCountAreaTodayOut[]
  area_counts_flags?: AreaCountFlagOut[]
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
  current_shift?: PanelCashOut | null
  store_closed?: boolean
  reserve_loans_open_count?: number
  reserve_loans_open_total?: number | null
  attendance_pending_review_count?: number
}): AttentionItem[] {
  const items: AttentionItem[] = []

  // El turno abierto de cualquier día (`current_shift`, la misma lectura que
  // el panel y que Dinero › Operacional). Un turno abandonado de otro día
  // tenía esperado en la tarjeta de abajo y ningún aviso propio: ahora es
  // crítico y lleva a su ficha, donde están el cierre administrativo y los
  // demás rescates.
  const shift = today.current_shift ?? null
  if (shift?.is_stale) {
    items.push({
      key: "shift-stale",
      title: `Turno abandonado del ${formatFechaCorta(shift.business_date)}`,
      body:
        `Sigue abierto y nadie lo cerró. Responsable: ${shift.responsible.name}` +
        (shift.responsible.active ? "." : " (ya no está activo)."),
      why: {
        term: "Turno abandonado",
        text: "Pasó la hora de corte del día siguiente y el turno sigue abierto. No bloquea la venta, pero su plata no se cuadró: cerralo con el cierre administrativo.",
      },
      to: fichaTurnoHref(shift.shift_id),
      ctaLabel: "Ver el turno",
      tone: "critical",
      screen: "Dinero",
      tab: `Turno #${shift.shift_id}`,
    })
  } else if (shift && !shift.responsible.active) {
    items.push({
      key: "responsible-inactive",
      title: "Caja a nombre de alguien inactivo",
      body: `${shift.responsible.name} ya no está activo y el turno #${shift.shift_id} sigue a su nombre.`,
      why: {
        term: "Responsable inactivo",
        text: "Hacé un relevo del turno a alguien activo, o cerralo: la diferencia del cierre se atribuye al responsable.",
      },
      to: fichaTurnoHref(shift.shift_id),
      ctaLabel: "Ver el turno",
      tone: "warning",
      screen: "Dinero",
      tab: `Turno #${shift.shift_id}`,
    })
  }

  if (today.expected_cash === null || today.expected_cash === undefined) {
    // Crítico sólo si hay actividad que pida caja (alguien de caja con
    // entrada, o comandas del día sin turno): el mismo criterio que el
    // semáforo del panel (`store_closed`, del servidor). Sin actividad, la
    // sede está cerrada: de noche no es una alarma.
    const closed = today.store_closed === true
    items.push({
      key: "no-shift",
      title: "Sin turno abierto",
      body: closed
        ? "La sede está cerrada: no hay nadie de caja ni comandas del día."
        : "Hay actividad sin turno de caja: no se puede cobrar.",
      to: "/admin/dinero",
      ctaLabel: "Abrir Dinero",
      tone: closed ? "default" : "critical",
      screen: "Dinero",
      tab: "Operacional",
    })
  }

  // Base de respaldo: un préstamo al cajón vuelve el mismo día. Conteo y
  // total del servidor (`reserve_loans_tray`), los mismos del panel.
  const loans = today.reserve_loans_open_count ?? 0
  if (loans > 0) {
    const shiftId = today.current_shift?.shift_id
    items.push({
      key: "reserve-loans",
      title: `${loans} préstamo${loans === 1 ? "" : "s"} de la base sin devolver`,
      body: "Lo que el cajón tomó de la base de respaldo vuelve el mismo día, antes del conteo de cierre.",
      amount: today.reserve_loans_open_total ?? null,
      to: shiftId !== undefined ? fichaTurnoHref(shiftId) : "/admin/dinero",
      ctaLabel: "Ver el turno",
      tone: "warning",
      screen: "Dinero",
      tab: shiftId !== undefined ? `Turno #${shiftId}` : "Operacional",
    })
  }

  // Asistencia: salidas olvidadas de días anteriores. No suman horas hasta
  // que se corrigen en Nómina › Horas.
  const exits = today.attendance_pending_review_count ?? 0
  if (exits > 0) {
    items.push({
      key: "attendance-review",
      title: `${exits} salida${exits === 1 ? "" : "s"} olvidada${exits === 1 ? "" : "s"} a revisar`,
      body: "Alguien no marcó salida en un día que ya pasó; esas horas no cuentan hasta corregirlas.",
      to: "/admin/nomina?tab=horas",
      ctaLabel: "Ver Horas",
      tone: "warning",
      screen: "Nómina",
      tab: "Horas",
      filter: "salidas a revisar",
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
      // El recuento es de TODOS los cierres sin revisar, de cualquier día:
      // Operacional sólo muestra los de hoy, así que el enlace iba a una
      // tabla donde no estaban. Historial los tiene todos, con su revisión.
      to: "/admin/dinero?tab=historial",
      ctaLabel: "Ver Dinero",
      tone: "default",
      screen: "Dinero",
      tab: "Historial",
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
  // dueño. Solicitudes y novedades se resuelven en el mismo riel («Requiere
  // tu atención», `hoy/Atencion.tsx`: aprobar, rechazar, resolver) — la
  // bandeja de abajo que las repetía salió de Hoy (decisión del dueño,
  // 2026-09-29); recepciones y traslados, en su pantalla.
  const reception = receptionDraftsTrayItem(today.reception_drafts_pending_count)
  if (reception) items.push(reception)

  const requestsPending = today.requests_pending_count ?? 0
  if (requestsPending > 0) {
    items.push({
      key: "requests-pending",
      title: `${requestsPending} solicitud${requestsPending === 1 ? "" : "es"} del salón por resolver`,
      body: "Pedidos de insumos o de sencilla hechos desde el POS.",
      to: `/admin/hoy#${ANCLA_ATENCION}`,
      ctaLabel: "Ver en Requiere tu atención",
      tone: "warning",
      screen: "Hoy",
      tab: "Requiere tu atención",
    })
  }

  const noveltiesOpen = today.novelties_open_count ?? 0
  if (noveltiesOpen > 0) {
    const urgent = today.novelties_urgent_count ?? 0
    items.push({
      key: "novelties-open",
      title: `${noveltiesOpen} novedad${noveltiesOpen === 1 ? "" : "es"} sin resolver`,
      body: urgent > 0 ? `${urgent} urgente${urgent === 1 ? "" : "s"}.` : "Pasan de turno hasta que alguien las resuelve.",
      to: `/admin/hoy#${ANCLA_ATENCION}`,
      ctaLabel: "Ver en Requiere tu atención",
      tone: urgent > 0 ? "critical" : "warning",
      screen: "Hoy",
      tab: "Requiere tu atención",
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

  // Conteo corto por área (2026-09-25). Un área sin conteo de apertura va en
  // rojo, pero el aviso dice que no bloquea nada; cada artículo fuera del
  // umbral es un aviso propio que dice si faltó de noche o en el turno, con
  // la plata que manda el servidor. Los recuentos dentro del umbral no son
  // aviso: los muestra la tarjeta.
  if (today.area_counts_enabled) {
    // `opening_missing` (conteo compartido): la apertura es obligatoria y no
    // está. Sin ese dato, la regla de antes (ningún conteo de apertura).
    const sinApertura = (today.area_counts_areas ?? []).filter((a) => a.opening_missing ?? a.opening === null)
    if (sinApertura.length > 0) {
      const nombres = sinApertura
        .map((a) =>
          a.opening_total ? `${a.area_name} (${a.opening_counted ?? 0} de ${a.opening_total} contados)` : a.area_name,
        )
        .join(", ")
      items.push({
        key: "area-counts-missing",
        title: `${sinApertura.length} área${sinApertura.length === 1 ? "" : "s"} sin conteo de apertura`,
        body: `${nombres}. No bloquea el turno, pero sin apertura no hay faltante de la noche ni del turno.`,
        to: "/admin/inventario?tab=por-area",
        ctaLabel: "Ver Conteo por área",
        tone: "critical",
        screen: "Inventario",
        tab: "Conteo por área",
      })
    }
    for (const f of (today.area_counts_flags ?? []).filter((x) => x.flagged)) {
      const donde = f.window === "night" ? "de noche" : f.window === "shift" ? "en el turno" : "en un recuento sorpresa"
      items.push({
        key: `area-count-flag-${f.count_id}-${f.ingredient_id}`,
        title: `${flagPhrase(f)} ${donde}`,
        body: `${f.area_name} · contó ${f.employee_name}. Pasa el umbral de la sede.`,
        why: {
          term: "Conteo por área",
          text: "De noche: la apertura contra el último cierre. En el turno: el cierre contra la apertura, con lo que entró y salió según el sistema.",
        },
        to: areaCountHref(f.count_id),
        ctaLabel: "Ver el conteo",
        tone: "warning",
        screen: "Inventario",
        tab: "Conteo por área",
        filter: `conteo de ${f.area_name}`,
        amount: f.shortage_value,
      })
    }
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
const DEDUPED_ALERT_TYPES = new Set([
  "order_unsent_too_long",
  "order_unpaid_too_long",
  "product_unavailable",
  "pending_refund",
  // «Turno abandonado» ya es un aviso directo, con la fecha y el responsable.
  "shift_stale",
])

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
  // Los dos que no se resuelven en el riel llevan su botón a la ficha que
  // los resuelve (handoff, `AdminHoy`): el cierre administrativo de un
  // turno abandonado pide su propio flujo, y la base de respaldo no tiene
  // todavía cómo avisarle a la tablet de caja.
  const ir =
    item.key === "shift-stale"
      ? "Cerrar turno abandonado"
      : item.key === "reserve-loans" && item.to !== "/admin/dinero"
        ? "Ver el préstamo en el turno"
        : null
  if (ir) {
    return avisoConEnlace(
      {
        id: item.key,
        severity: SEVERITY_OF_TONE[item.tone],
        title: item.title,
        consequence: item.body,
        amount:
          item.amount === null || item.amount === undefined ? undefined : (item.amountText ?? formatCOP(item.amount)),
      } as Notice,
      { to: item.to, label: ir },
    )
  }
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

/** Cuántos avisos se ven de entrada en el riel (mapa de pantallas: «como máximo 5»; en el celular, 3). */
const VISIBLE_NOTICES = 5
const VISIBLE_NOTICES_CELULAR = 3

const SEVERITY_RANK: Record<NoticeSeverity, number> = { critical: 0, warning: 1, whenever: 2 }

/**
 * «Requiere tu atención»: un riel fijo de 420 px a la derecha (handoff,
 * `AdminHoy` variante A) con **las acciones en el mismo lugar** —confirmar
 * una consignación mirando la foto, aprobar o rechazar un sencillo, revisar
 * una novedad, marcar una salida— y, una vez resuelto, el rastro con
 * «Reversar con motivo» (`hoy/Atencion.tsx`). Los demás avisos siguen con
 * su destino nombrado en palabras.
 *
 * Cinco a la vista y el resto detrás de un solo «Ver n más» (tres en el
 * celular); los recuentos —el total del encabezado y el de cada gravedad—
 * dicen cuántos hay de verdad, no cuántos se ven.
 */
function AttentionRail({
  attention,
  today,
  storeId,
  celular,
}: {
  attention: AttentionItem[]
  today: TodayOut
  storeId: number
  celular: boolean
}): React.JSX.Element {
  const { panel } = usePanelAhora()
  const accionables = useAccionables({ storeId, today, salidas: panel?.staff.pending_review })
  const agregados = attention.filter((a) => !accionables.reemplaza.has(a.key))
  // Una vez por clase de aviso, aunque haya dos del mismo tipo.
  const porQue = [
    ...new Map(
      agregados.flatMap((a) => (a.why ? [[a.why.term, { term: a.why.term, meaning: a.why.text }] as const] : [])),
    ).values(),
  ]
  // Por gravedad; dentro de la misma, primero lo que se resuelve acá. El
  // orden de cada lista ya viene decidido (`sortAttention`, el servidor).
  const notices = [...accionables.notices, ...agregados.map(toNotice)]
    .map((n, i) => ({ n, i }))
    .sort((a, b) => SEVERITY_RANK[a.n.severity] - SEVERITY_RANK[b.n.severity] || a.i - b.i)
    .map(({ n }) => n)

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
        limit={celular ? VISIBLE_NOTICES_CELULAR : VISIBLE_NOTICES}
        notices={notices}
        footNote="Ordenados por gravedad · lo resuelto queda en el historial"
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


/**
 * La comparación de la cifra rectora: hoy contra el mismo día de la semana
 * pasada HASTA LA MISMA HORA (`TodayOut.comparison`). Todo viene hecho del
 * servidor —el neto de entonces y la variación en puntos básicos—; acá sólo
 * se escribe. Sin comparación posible se dice por qué, nunca «0 %».
 */
function todayComparison(
  c: TodayOut["comparison"],
): { label: string; delta: string; detail?: string; tono?: "apagada" } | undefined {
  if (!c) return undefined
  const dia = weekdayName(c.reference_business_date)
  const label = `Contra el ${dia} pasado a esta hora`
  if (c.net === null) {
    return {
      label: c.null_reason ?? `No hay datos del ${dia} pasado: no hay contra qué comparar.`,
      delta: "Sin dato",
      tono: "apagada",
    }
  }
  const delta = formatDelta(c.delta_bp)
  if (delta === null) {
    // Sin divisor no hay variación: se dice qué pasó ese día, corto.
    return {
      label,
      delta: "Sin dato",
      detail: c.reference_operated === false ? "ese día no abrió" : `no había vendido: ${formatCOP(c.net)}`,
      tono: "apagada",
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
function HourlySales({ today, storeId }: { today: TodayOut; storeId: number }): React.JSX.Element {
  const hours: HourBucketOut[] = today.sales_by_hour ?? []
  const reference = today.sales_by_hour_reference ?? []
  const c = today.comparison ?? null
  const dia = c ? weekdayName(c.reference_business_date) : null

  // Sin una sola hora con venta, el eje vacío (y la trama de las horas que
  // faltan) no dice nada y se ve roto: va la pregunta y una línea. Mirar si
  // alguna hora trae venta no es calcular.
  if (hours.every((h) => h.pending || h.net === 0)) {
    return (
      <section className="min-w-0 rounded-lg border bg-card p-4" data-slot="ventas-por-hora-vacio">
        <h2 className="text-xs font-bold tracking-wider text-muted-foreground uppercase">Ventas por hora</h2>
        <p className="mt-1.5 text-sm text-muted-foreground">
          {c && c.net === 0 && dia
            ? `Todavía no hay ventas hoy; el ${dia} pasado a esta hora tampoco.`
            : "Todavía no hay ventas hoy."}
        </p>
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
    <section className="min-w-0 rounded-lg border bg-card p-4">
      <BlockHeader title="Ventas por hora" block="sales-by-hour" storeId={storeId} />
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
 * El encabezado de un bloque de Hoy con su descarga. La descarga es del
 * servidor (`format=csv`: `;`, BOM y encabezados en español), tal como se ve.
 */
function BlockHeader({
  title,
  block,
  storeId,
  children,
}: {
  title: string
  block: TodayBlock
  storeId: number
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
      <div className="min-w-0">
        <h2 className="text-xs font-bold tracking-wider text-muted-foreground uppercase">{title}</h2>
        {children}
      </div>
      <a
        href={todayBlockCsvUrl(block, storeId)}
        target="_blank"
        rel="noreferrer"
        title={`Descargar «${title}» (CSV)`}
        className="inline-flex min-h-11 items-center gap-1.5 rounded-md px-2 text-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        <Download className="size-4 shrink-0" aria-hidden="true" />
        Descargar CSV
      </a>
    </div>
  )
}

/**
 * Una cifra que llegó `null`: se dibuja **qué falta** (`SinDato`), rayado y
 * apagado, con el mismo marco que `StatTile` para que la grilla no se vea
 * despareja. Nunca «$ 0» ni un «—» mudo.
 */
function IndicadorSinDato({
  label,
  motivo,
  icon: Icon,
}: {
  label: string
  motivo: string
  icon?: LucideIcon
}): React.JSX.Element {
  return (
    <div className="rounded-lg border border-l-[3px] border-border border-l-border p-4">
      <div className="flex items-center gap-1.5">
        {Icon ? <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" /> : null}
        <p className="min-w-0 text-sm text-muted-foreground">{label}</p>
      </div>
      <SinDato forma="bloque" motivo={motivo} className="mt-1" />
    </div>
  )
}

/** El pie de cada cifra, plegado en «Cómo leer estas cifras». */
const CIFRAS_EXPLICADAS: readonly Definicion[] = [
  { term: "Ticket promedio", meaning: "venta neta dividida entre los tickets pagados, sin propina. Lo calcula el servidor." },
  { term: "Número de tickets", meaning: "comandas cobradas y cerradas hoy: ya no cambian." },
  {
    term: "Efectivo y tarjeta",
    meaning:
      "la venta neta cobrada por cada medio, sin impuesto ni propina (la propina no es venta, Ley 1935 de 2018). Transferencias y plataformas van aparte, debajo.",
  },
]

/**
 * Las cuatro cifras de debajo de la venta, en el orden que pidió el dueño:
 * ticket promedio, número de tickets, efectivo y tarjeta. Todas del
 * servidor; `null` se dice (no es «$ 0»).
 */
function DayFigures({ today }: { today: TodayOut }): React.JSX.Element {
  const cash = today.cash_sales ?? null
  const card = today.card_sales ?? null
  const other = today.other_payment_sales ?? null
  return (
    <div className="space-y-2">
      {/* A 1440 cada tarjeta mide ~170 px: una cifra de siete dígitos a
          `text-2xl` se partía en dos renglones. Baja a `text-xl` y no se parte. */}
      <div className="grid min-w-0 grid-cols-2 gap-3 max-sm:[&>div]:p-3 lg:grid-cols-4 [&_.text-2xl]:text-xl [&_.text-2xl]:whitespace-nowrap">
        {today.avg_ticket === null || today.avg_ticket === undefined ? (
          <IndicadorSinDato label="Ticket promedio" motivo="todavía sin tickets pagados hoy" />
        ) : (
          <StatTile label="Ticket promedio" value={formatCOP(today.avg_ticket)} />
        )}
        <StatTile
          label="Número de tickets"
          value={today.orders !== undefined && today.orders !== null ? String(today.orders) : "—"}
        />
        {cash === null ? (
          <IndicadorSinDato label="Ventas en efectivo" motivo="sin el desglose por medio de pago" icon={Banknote} />
        ) : (
          <StatTile
            label="Ventas en efectivo"
            value={formatCOP(cash.net)}
            hint={`${cash.payments} ${cash.payments === 1 ? "pago" : "pagos"}`}
            icon={Banknote}
          />
        )}
        {card === null ? (
          <IndicadorSinDato label="Ventas en tarjeta" motivo="sin el desglose por medio de pago" icon={CreditCard} />
        ) : (
          <StatTile
            label="Ventas en tarjeta"
            value={formatCOP(card.net)}
            hint={`${card.payments} ${card.payments === 1 ? "pago" : "pagos"}`}
            icon={CreditCard}
          />
        )}
      </div>
      {other !== null && other.payments > 0 ? (
        <p className="px-1 text-xs text-muted-foreground">
          Otros medios (transferencia, plataformas, bonos): <b className="text-foreground tabular-nums">{formatCOP(other.net)}</b>{" "}
          en {other.payments} {other.payments === 1 ? "pago" : "pagos"}. Con efectivo y tarjeta completan la venta neta.
        </p>
      ) : null}
      <Plegable resumen="Cómo leer estas cifras" className="px-1">
        <Definiciones items={CIFRAS_EXPLICADAS} className="sm:grid-cols-2" />
      </Plegable>
    </div>
  )
}

const TOP_PRODUCT_COLUMNS: readonly DenseColumn<TodayTopProductOut>[] = [
  { key: "label", header: "Producto", kind: "name", cell: (p) => p.label },
  { key: "units", header: "Unidades", kind: "number", cell: (p) => (p.units === null ? "—" : String(p.units)) },
  { key: "net", header: "Venta neta", kind: "number", cell: (p) => formatCOP(p.net) },
]

/** «Top productos vendidos» de hoy: el orden y las cifras son del servidor. */
function TopProducts({ today, storeId }: { today: TodayOut; storeId: number }): React.JSX.Element {
  const products = today.top_products ?? []
  return (
    <section className="min-w-0 rounded-lg border bg-card p-4">
      <BlockHeader title="Top productos vendidos" block="top-products" storeId={storeId}>
        <p className="mt-0.5 text-xs text-muted-foreground">Por venta neta, sin impuesto ni propina. La descarga trae todos.</p>
      </BlockHeader>
      <DenseTable
        caption="Productos más vendidos hoy, con unidades y venta neta."
        columns={TOP_PRODUCT_COLUMNS}
        rows={products}
        rowKey={(p) => p.key}
        empty={<EmptyState title="Todavía no se vendió nada hoy" description="Cuando se cobre la primera comanda, sus platos aparecen acá." />}
      />
    </section>
  )
}

/** Días hasta el vencimiento, en palabras. El número es del servidor. */
function expiryWord(days: number | null): string | null {
  if (days === null) return null
  if (days < 0) return `venció hace ${-days} ${days === -1 ? "día" : "días"}`
  if (days === 0) return "vence hoy"
  return `vence en ${days} ${days === 1 ? "día" : "días"}`
}

function receptionStatus(line: TodayReceptionLineOut): RowStatus {
  if (line.lot_status === "expired") return "critical"
  if (line.lot_status === "expiring") return "warning"
  return "none"
}

const RECEPTION_COLUMNS: readonly DenseColumn<TodayReceptionLineOut>[] = [
  {
    key: "item",
    header: "Insumo · proveedor",
    kind: "name",
    cell: (r) => (
      <span className="flex flex-col">
        <span className="font-medium">{r.ingredient_name}</span>
        <span className="text-xs text-muted-foreground">{r.supplier_name}</span>
      </span>
    ),
  },
  { key: "qty", header: "Cantidad", kind: "number", cell: (r) => `${r.qty} ${r.purchase_unit}` },
  {
    key: "lot",
    header: "Lote · vence",
    cell: (r) => {
      const word = expiryWord(r.days_to_expiry)
      const soon = r.lot_status === "expiring" || r.lot_status === "expired"
      return (
        <span className="flex flex-col">
          <span>{r.lot_code ?? <span className="text-muted-foreground">sin lote</span>}</span>
          {r.expires_at ? (
            <span className={cn("text-xs", soon ? "font-semibold text-warning" : "text-muted-foreground")}>
              {formatFechaCorta(r.expires_at)}
              {word ? ` · ${word}` : ""}
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">sin vencimiento</span>
          )}
        </span>
      )
    },
  },
  {
    key: "received",
    header: "Recibió",
    cell: (r) => (
      <span className="flex flex-col">
        <span>{r.received_by}</span>
        <span className="text-xs text-muted-foreground">{formatClockTime(r.received_at)}</span>
      </span>
    ),
  },
]

/**
 * «Entradas de mercancía del día»: lo que se recibió hoy, con su lote y
 * vencimiento. Un lote por vencer (≤ 7 días, la regla de Lotes, del
 * servidor) va con franja ámbar; uno vencido, roja. Sin «Compras», se dice
 * que la función está apagada: no es «no entró nada».
 */
function Receptions({ today, storeId }: { today: TodayOut; storeId: number }): React.JSX.Element {
  const lines = today.receptions_today ?? []
  if (!today.receptions_enabled) {
    return (
      <section className="min-w-0 rounded-lg border bg-card p-4" data-slot="entradas-apagadas">
        <h2 className="text-xs font-bold tracking-wider text-muted-foreground uppercase">Entradas de mercancía</h2>
        <p className="mt-1.5 text-sm text-muted-foreground">
          «Compras» está apagada en esta sede: no se registran recepciones.{" "}
          <Link to="/admin/features" className="font-medium text-primary underline-offset-4 hover:underline">
            Encenderla en Funciones
          </Link>
        </p>
      </section>
    )
  }
  const soon = lines.filter((l) => l.lot_status === "expiring" || l.lot_status === "expired").length
  return (
    <section className="min-w-0 rounded-lg border bg-card p-4">
      <BlockHeader title="Entradas de mercancía" block="receptions" storeId={storeId}>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Lo recibido hoy, con su lote y vencimiento.
          {soon > 0 ? (
            <b className="font-semibold text-warning">
              {" "}
              {soon} {soon === 1 ? "lote vence pronto" : "lotes vencen pronto"}.
            </b>
          ) : null}
        </p>
      </BlockHeader>
      <DenseTable
        caption="Entradas de mercancía de hoy: insumo, proveedor, cantidad en unidad de compra, lote, vencimiento y quién recibió."
        columns={RECEPTION_COLUMNS}
        rows={lines}
        rowKey={(r) => String(r.line_id)}
        rowStatus={receptionStatus}
        legend={
          soon > 0
            ? [
                { term: "Franja ámbar", meaning: "el lote vence en 7 días o menos." },
                { term: "Franja roja", meaning: "el lote ya venció." },
              ]
            : undefined
        }
        empty={<EmptyState title="Hoy no entró mercancía" description="Las recepciones confirmadas del día aparecen acá, con su lote." />}
      />
    </section>
  )
}

/**
 * "Hoy" según el dueño (2026-09-29): **exactamente** la venta del día con su
 * libro y la comparación contra el mismo día de la semana pasada a esta
 * hora; ticket promedio, número de tickets, efectivo y tarjeta; ventas por
 * hora; top de productos; las entradas de mercancía con su lote; y, en la
 * columna derecha, «Requiere tu atención» con sus acciones. Todo del
 * servidor. En el celular, lo mismo apilado y los avisos al final.
 *
 * Lo que había antes y ya no va acá (semáforo por sede, los bloques de
 * «Ahora», las ocho tarjetas, comandas abiertas, conteo por área, la
 * bandeja, propinas por medio) sigue en su pantalla: Pedidos, Dinero,
 * Inventario y los avisos del riel.
 */
export function TodayPage(): React.JSX.Element {
  const { activeStoreId, loading: storeLoading } = useStoreSelection()
  const { me } = useSession()
  const cutoffHour = me?.store?.cutoff_hour
  const celular = useEsCelular()

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
                la venta, las cuatro cifras, las ventas por hora y los dos
                bloques, con el riel a la derecha en el escritorio. Si
                esqueletea otra cosa, la pantalla salta al llegar los datos. */}
            <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_420px]">
              <div className="flex min-w-0 flex-col gap-5 xl:col-start-1 xl:row-start-1">
                <Skeleton className="h-[8.5rem] w-full rounded-lg" />
                <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                  {[0, 1, 2, 3].map((i) => (
                    <Skeleton key={i} className="h-[7.5rem] rounded-lg" />
                  ))}
                </div>
                <Skeleton className="h-60 w-full rounded-lg" />
                <Skeleton className="h-52 w-full rounded-lg" />
              </div>
              <Skeleton className="h-48 rounded-lg xl:col-start-2 xl:row-start-1 xl:h-96" />
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

  const updatedIso = new Date(query.dataUpdatedAt).toISOString()

  return (
    <div className="space-y-4">
      <PageHeader
        name="Hoy"
        question="¿Cuánto se vendió hoy, qué se vendió, qué mercancía entró y qué necesita una decisión tuya?"
        // En el celular la barra de arriba ya dice «hace 14 s» (captura 13a):
        // la franja de contexto repetía lo mismo en dos renglones.
        context={celular ? [] : [
          {
            label: "Se actualiza sola cada 30 s ·",
            value: <TimeAgo iso={updatedIso} />,
            title: formatInstant(updatedIso),
            icon: RefreshCw,
          },
          {
            label: "Día operativo",
            value: formatBusinessDate(today.business_date),
            icon: CalendarDays,
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
        ]}
        actions={
          // `title` con el mismo texto que se ve, a propósito: el censo de
          // controles lee el código y **no ve un rótulo que viene después de
          // un `<svg>`** dentro de un `Button render={<Link/>}`.
          // `nativeButton={false}`: el disparador es un `<a>`.
          celular ? undefined : (
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
          )
        }
      />

      {/* Dos columnas en el escritorio: el día a la izquierda, en el orden
          que pidió el dueño, y «Requiere tu atención» a la derecha, pegado.
          En el celular es una sola columna y los avisos van al final: el
          orden del código es el orden de lectura (foco y lector de
          pantalla incluidos). */}
      <div className="grid items-start gap-[18px] xl:grid-cols-[minmax(0,1fr)_420px]">
        <div className="flex min-w-0 flex-col gap-5 xl:col-start-1 xl:row-start-1">
          <section aria-label="Ventas de hoy" className="min-w-0">
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
                  `${yesterday.orders} ${yesterday.orders === 1 ? "ticket" : "tickets"}`,
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
          </section>

          <DayFigures today={today} />

          <HourlySales today={today} storeId={activeStoreId} />

          <TopProducts today={today} storeId={activeStoreId} />

          <Receptions today={today} storeId={activeStoreId} />
        </div>

        <div className="min-w-0 xl:col-start-2 xl:row-start-1 xl:self-stretch">
          <AttentionRail attention={attention} today={today} storeId={activeStoreId} celular={celular} />
        </div>
      </div>
    </div>
  )
}

export default TodayPage
