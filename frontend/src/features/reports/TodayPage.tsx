import { useQuery } from "@tanstack/react-query"
import { Banknote, CalendarDays, Clock, CreditCard, Download, Package, type LucideIcon } from "lucide-react"
import { useEffect } from "react"
import { Link, useLocation } from "react-router-dom"

import type { PanelCashOut } from "@/api/panel"
import type { OpeningHour } from "@/api/stores"
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
  type LabelAlertOut,
  type LotAlertOut,
  type NegativeStockAlertOut,
  type PayableAlertOut,
  type PrepAlertOut,
  type TodayBlock,
  type TodayOut,
  type TodayReceptionLineOut,
  type UnavailableProductOut,
  type UncostedProductOut,
} from "@/api/reports"
import { useEsCelular } from "@/app/celular"
import { useSession } from "@/app/session"
import { useStoreSelection } from "@/app/storeContext"
import {
  AllClearEmptyState,
  Burbuja,
  EstadoPastilla,
  IrRedondo,
  NoticeRail,
  Pozo,
  PageHeader,
  type FilterLinkProps,
  type Notice,
  type NoticeSeverity,
  type RowStatus,
} from "@/components/admin"
import { Cargando } from "@/components/Cargando"
import { ColumnasHora, type ColumnaHora } from "@/components/charts"
import { EmptyState } from "@/components/EmptyState"
import { SinDato } from "@/components/SinDato"
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
import { AhoraSede, SemaforoSedes, usePanelAhora } from "./PanelAhora"


const REFRESH_MS = 30_000

/**
 * El ancla de «Requiere tu atención». La usa «Avisos» de la barra inferior
 * del celular (`app/AdminLayout.tsx`, `ANCLA_AVISOS`): el mismo texto en los
 * dos lados, y la prueba de esta pantalla lo fija.
 */
const ANCLA_ATENCION = "requiere-atencion"

/** «Buenas tardes, Óscar»: el saludo de Hoy, con el primer nombre de quien entró. */
function saludo(ahora: Date, nombre?: string | null): string {
  // La hora de la sede (Bogotá), no la del navegador.
  const h = Number(
    new Intl.DateTimeFormat("en-US", { hour: "numeric", hourCycle: "h23", timeZone: "America/Bogota" }).format(ahora),
  )
  const parte = h < 12 ? "Buenos días" : h < 19 ? "Buenas tardes" : "Buenas noches"
  const primero = nombre?.trim().split(/\s+/)[0]
  return primero ? `${parte}, ${primero}` : parte
}

/**
 * Las horas de reloj del turno normal abierto según el horario de la sede
 * para el día de la semana de `isoDate` («11:00»–«22:00» → 11 a 21). Si cierra
 * pasada la medianoche, da la vuelta. `null` si ese día no tiene horario.
 */
/** La hora de reloj en Bogotá de un instante ISO. */
function horaBogota(iso: string): number {
  return Number(
    new Intl.DateTimeFormat("en-US", { hour: "numeric", hourCycle: "h23", timeZone: "America/Bogota" }).format(new Date(iso)),
  )
}

function horasDelTurno(horario: OpeningHour[], isoDate: string): Set<number> | null {
  // `weekday` del servidor: 0 = lunes. `getUTCDay`: 0 = domingo.
  const dia = (new Date(`${isoDate}T12:00:00Z`).getUTCDay() + 6) % 7
  const h = horario.find((x) => x.weekday === dia)
  if (!h) return null
  const [ah] = h.open.split(":").map(Number)
  const [ch, cm] = h.close.split(":").map(Number)
  if (ah === undefined || ch === undefined || Number.isNaN(ah) || Number.isNaN(ch)) return null
  const fin = cm ? ch + 1 : ch
  const out = new Set<number>()
  for (let i = 0, x = ah; i < 24 && x % 24 !== fin % 24; i++, x++) out.add(x % 24)
  return out.size > 0 ? out : null
}

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
  labels_expired?: LabelAlertOut | null
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
      tab: "Cuadres",
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
      tab: shiftId !== undefined ? `Turno #${shiftId}` : "Cuadres",
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

  // Etiquetas de cocina vencidas que siguen en la cocina: se botan desde la
  // tablet (leyendo el QR), y eso queda como merma con PIN.
  const labelsAlert = today.labels_expired
  if (labelsAlert && labelsAlert.expired > 0) {
    items.push({
      key: "labels-expired",
      title: `${labelsAlert.expired} etiqueta${labelsAlert.expired === 1 ? "" : "s"} vencida${labelsAlert.expired === 1 ? "" : "s"} en la cocina`,
      body: `${labelsAlert.expired_names.join(", ")}${labelsAlert.due_today > 0 ? ` · ${labelsAlert.due_today} vence${labelsAlert.due_today === 1 ? "" : "n"} hoy` : ""}.`,
      why: {
        term: "Etiquetas vencidas",
        text: "Pasó su «usar antes de» y nadie la marcó como acabada ni botada. En la tablet se lee el QR y se bota: queda como merma.",
      },
      to: "/admin/inventario?tab=etiquetas",
      ctaLabel: "Ver Etiquetas",
      tone: "critical",
      screen: "Inventario",
      tab: "Etiquetas",
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
/**
 * El día que muestran los bloques cuando Hoy repasa otro día (antes de la
 * primera venta): su fecha ISO, para la descarga, y cómo se nombra.
 */
interface RecapDay {
  date: string
  /** «ayer (mar 29 sep)» o «el mar 29 sep». */
  label: string
  /** «Ayer» o «Mar 29 sep»: encabezado de columna. */
  short: string
}

function HourlySales({
  today,
  recap = null,
  horario = [],
  aperturaTurno = null,
}: {
  today: TodayOut
  recap?: RecapDay | null
  /** El horario de la sede (`opening_hours`): el turno normal abierto. */
  horario?: OpeningHour[]
  /** Cuándo se abrió el turno de hoy (ISO), si ya abrió: el turno puede abrir antes del horario. */
  aperturaTurno?: string | null
}): React.JSX.Element {
  const hours: HourBucketOut[] = today.sales_by_hour ?? []
  const reference = today.sales_by_hour_reference ?? []
  const c = today.comparison ?? null
  const dia = c ? weekdayName(c.reference_business_date) : null

  // Sin una sola hora con venta, el eje vacío (y la trama de las horas que
  // faltan) no dice nada y se ve roto: va la pregunta y una línea. Mirar si
  // alguna hora trae venta no es calcular.
  if (hours.every((h) => h.pending || h.net === 0)) {
    return (
      <section className="min-w-0" data-slot="ventas-por-hora-vacio">
        <h2 className="text-[15px] font-semibold tracking-normal">Ventas por hora</h2>
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
  } else if (peak && recap) {
    titular = `La hora más fuerte de ${recap.label} fue la de las ${hourLabel(peak.hour)}`
  } else if (peak) {
    titular = `La hora más fuerte va siendo la de las ${hourLabel(peak.hour)}`
  } else if (c && c.net === 0 && dia) {
    titular = `Todavía no hay ventas; el ${dia} pasado a esta hora tampoco`
  } else {
    titular = "Todavía no hay ventas hoy"
  }

  const detalle = [
    "Venta neta por hora de reloj, sin propina, desde el corte del día.",
    hasReference && dia ? `La raya es el ${dia} pasado, día completo.` : null,
    pendingCount > 0 ? "Columna clara: horas que todavía no llegan (no son $ 0)." : null,
  ]
    .filter(Boolean)
    .join(" ")

  const refLabel = dia ? `${dia.charAt(0).toUpperCase()}${dia.slice(1)} pasado` : "Semana pasada"
  // La hora en curso (la última que ya llegó) va en tinta; sólo hoy, no en
  // el repaso de otro día. Elegir cuál es selección, no matemática.
  const enCurso = recap ? undefined : [...hours].reverse().find((h) => !h.pending)
  // Las horas del turno normal abierto: las del horario de la sede para ese
  // día de la semana, más cualquier hora fuera de él con venta (hoy o la
  // semana pasada) y la hora en curso. Sin horario cargado, de la primera a
  // la última hora con venta. Elegir qué horas se ven es selección.
  const turno = horasDelTurno(horario, recap?.date ?? today.business_date)
  const horaApertura = !recap && aperturaTurno ? horaBogota(aperturaTurno) : null
  if (horaApertura !== null) turno?.add(horaApertura)
  const conVenta = (h: HourBucketOut) =>
    (!h.pending && h.net > 0) || (referenceByHour.get(h.hour) ?? 0) > 0 || h.hour === enCurso?.hour
  const entra = (h: HourBucketOut) => conVenta(h) || (turno?.has(h.hour) ?? false)
  const primera = hours.findIndex(entra)
  const ultima = hours.length - 1 - [...hours].reverse().findIndex(entra)
  const visibles = primera === -1 ? hours : hours.slice(primera, ultima + 1)
  const columnas: ColumnaHora[] = visibles.map((h) => ({
    key: String(h.hour),
    etiqueta: hourTick(h.hour),
    valor: h.pending ? null : h.net,
    referencia: hasReference ? (referenceByHour.get(h.hour) ?? null) : null,
  }))

  return (
    // «Burbujas» (handoff `MinHoyC`): «Por hora» con su leyenda, columnas sin
    // eje y la hora debajo. Va dentro de la burbuja de la venta, sin
    // superficie propia. La conclusión y el método quedan para el lector de
    // pantalla y en el `title` de cada columna.
    <section className="flex min-w-0 flex-col gap-3" aria-label={recap ? `Ventas por hora · ${recap.short}` : "Ventas por hora"}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <h2 className="mr-auto text-sm font-semibold tracking-normal text-foreground">
          {recap ? `Por hora · ${recap.short}` : "Por hora"}
        </h2>
        <p className="sr-only">{titular}</p>
        <p className="sr-only">{detalle}</p>
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden="true" className="size-2.5 rounded-[3px] bg-data-bar" />
          {recap ? recap.short : "Hoy"}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden="true" className="w-3.5 border-t-2 border-foreground" />
          {refLabel}, día completo
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden="true" className="size-2.5 rounded-[3px] bg-foreground" />
          Hora en curso
        </span>
      </div>
      <ColumnasHora
        datos={columnas}
        actual={enCurso ? String(enCurso.hour) : undefined}
        formato={formatCOP}
        etiquetaSerie={recap ? recap.short : "Hoy"}
        etiquetaReferencia={hasReference ? `${refLabel} (día completo)` : undefined}
        resumen={
          `Columnas de venta neta por hora de ${recap ? recap.label : "hoy"}${peak ? `; la más alta, las ${hourLabel(peak.hour)} con ${formatCOP(peak.net)}` : ", todavía sin ventas"}` +
          `${pendingCount > 0 ? `; ${pendingCount} horas todavía no llegan` : ""}.`
        }
      />
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
  date = null,
  children,
}: {
  title: string
  block: TodayBlock
  storeId: number
  /** El día repasado (antes de la primera venta); sin él, la descarga es de hoy. */
  date?: string | null
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
      <div className="min-w-0">
        <h2 className="text-[15px] font-semibold tracking-normal">{title}</h2>
        {children}
      </div>
      <a
        href={todayBlockCsvUrl(block, storeId, date)}
        target="_blank"
        rel="noreferrer"
        title={`Descargar «${title}» (CSV)`}
        className="inline-flex h-8 items-center gap-1.5 rounded-full bg-muted px-3 text-xs font-semibold text-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <Download className="size-3.5 shrink-0" aria-hidden="true" />
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
    <Pozo>
      <div className="flex items-center gap-1.5">
        {Icon ? <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" /> : null}
        <p className="min-w-0 text-[13px] text-muted-foreground">{label}</p>
      </div>
      <SinDato forma="bloque" motivo={motivo} className="mt-1" />
    </Pozo>
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
function DayFigures({ today, recap = null }: { today: TodayOut; recap?: RecapDay | null }): React.JSX.Element {
  const cash = today.cash_sales ?? null
  const card = today.card_sales ?? null
  return (
    <div className="space-y-2">
      {recap ? (
        <p className="rounded-2xl bg-muted px-4 py-3 text-sm text-muted-foreground" data-slot="repaso">
          Todavía no hay ventas hoy: estas cifras y los bloques de abajo son de{" "}
          <b className="font-semibold text-foreground">{recap.label}</b>. Cambian solos con la primera venta de hoy.
        </p>
      ) : null}
      {/* «Burbujas»: las cuatro cifras son cuatro pozos dentro de la burbuja
          de la venta, 8 px entre ellos. */}
      <div className="grid min-w-0 grid-cols-2 gap-2 lg:grid-cols-4">
        {today.avg_ticket === null || today.avg_ticket === undefined ? (
          <IndicadorSinDato label="Ticket promedio" motivo="todavía sin tickets pagados hoy" />
        ) : (
          <Cifra label="Ticket promedio" value={formatCOP(today.avg_ticket)} hint="sin propina" />
        )}
        <Cifra
          label="Número de tickets"
          value={today.orders !== undefined && today.orders !== null ? String(today.orders) : "—"}
          hint="cobrados y cerrados"
        />
        {cash === null ? (
          <IndicadorSinDato label="Ventas en efectivo" motivo="sin el desglose por medio de pago" icon={Banknote} />
        ) : (
          <Cifra
            label="Ventas en efectivo"
            value={formatCOP(cash.net)}
            hint={`${cash.payments} ${cash.payments === 1 ? "pago" : "pagos"}`}
            icon={Banknote}
          />
        )}
        {card === null ? (
          <IndicadorSinDato label="Ventas en tarjeta" motivo="sin el desglose por medio de pago" icon={CreditCard} />
        ) : (
          <Cifra
            label="Ventas en tarjeta"
            value={formatCOP(card.net)}
            hint={`${card.payments} ${card.payments === 1 ? "pago" : "pagos"}`}
            icon={CreditCard}
          />
        )}
      </div>
      <Plegable resumen="Cómo leer estas cifras" className="px-1">
        <Definiciones items={CIFRAS_EXPLICADAS} className="sm:grid-cols-2" />
      </Plegable>
    </div>
  )
}

/** Una cifra secundaria en su pozo: rótulo, cifra y una línea de detalle. */
function Cifra({
  label,
  value,
  hint,
  icon: Icon,
}: {
  label: string
  value: string
  hint?: string
  icon?: LucideIcon
}): React.JSX.Element {
  return (
    <Pozo className="min-w-0">
      <div className="flex items-center gap-1.5">
        {Icon ? <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" /> : null}
        <p className="min-w-0 text-[13px] leading-tight text-muted-foreground">{label}</p>
      </div>
      <p className="mt-0.5 text-[22px] leading-tight font-medium tracking-[-0.02em] whitespace-nowrap tabular-nums">{value}</p>
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </Pozo>
  )
}

/**
 * **La venta del día, con todo lo que responde a la misma pregunta** (handoff
 * «Burbujas», Hoy § 3): la cifra grande con su comparación en pastilla y el
 * botón redondo que lleva a Ventas; las cuatro cifras en pozos; las ventas
 * por hora; y al pie el libro en una línea. Todo del servidor.
 */
function VentaPrincipal({
  etiqueta,
  cifra,
  nota,
  comparacion,
  deltaBp,
  libro,
  otros,
  celular,
  children,
}: {
  etiqueta: string
  cifra: string
  nota?: string
  comparacion?: ReturnType<typeof todayComparison>
  deltaBp?: number | null
  libro: { label: string; value: string; resta?: boolean }[]
  otros: TodayOut["other_payment_sales"]
  celular: boolean
  children: React.ReactNode
}): React.JSX.Element {
  const tono = deltaBp === null || deltaBp === undefined || comparacion?.tono === "apagada"
    ? "neutral"
    : deltaBp > 0
      ? "success"
      : deltaBp < 0
        ? "warning"
        : "neutral"
  return (
    <Burbuja aria-label="Ventas de hoy" className="flex flex-col gap-5 md:p-7">
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <p className="text-sm text-muted-foreground">{etiqueta}</p>
          <p
            className="mt-1 text-[44px] leading-none font-medium tracking-[-0.03em] whitespace-nowrap tabular-nums md:text-[64px]"
            data-slot="cifra-venta"
          >
            {cifra}
          </p>
          {nota ? <p className="mt-2 text-[13px] text-muted-foreground">{nota}</p> : null}
          {comparacion ? (
            <p className="mt-3 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-sm text-muted-foreground">
              <EstadoPastilla tono={tono} sinForma={/^[▲▼=]/.test(comparacion.delta)}>
                {comparacion.delta}
              </EstadoPastilla>
              <span>{comparacion.label}</span>
              {comparacion.detail ? <span className="tabular-nums">{comparacion.detail}</span> : null}
            </p>
          ) : null}
        </div>
        {celular ? null : <IrRedondo to="/admin/ventas" label="Ver el día completo" grande />}
      </div>
      {children}
      <dl className="flex flex-wrap items-baseline gap-x-6 gap-y-1 border-t pt-4 text-[13px] text-muted-foreground" data-slot="libro">
        {libro.map((r) => (
          <div key={r.label} className="flex items-baseline gap-1.5">
            <dt>{r.label}</dt>
            <dd className="font-medium whitespace-nowrap text-foreground tabular-nums">
              {r.resta ? "− " : ""}
              {r.value}
            </dd>
          </div>
        ))}
        {otros !== null && otros !== undefined && otros.payments > 0 ? (
          <div
            className="flex items-baseline gap-1.5 md:ml-auto"
            title="Transferencia, plataformas y bonos: con efectivo y tarjeta completan la venta neta."
          >
            <dt>Otros medios</dt>
            <dd className="whitespace-nowrap tabular-nums">
              {formatCOP(otros.net)} · {otros.payments} {otros.payments === 1 ? "pago" : "pagos"}
            </dd>
          </div>
        ) : null}
      </dl>
    </Burbuja>
  )
}

/**
 * «Lo más vendido» (handoff «Burbujas», Hoy § 5): cada plato con sus
 * unidades y su venta neta, y una barra de 6 px que dice cuánto pesa contra
 * el primero. El orden y las cifras son del servidor; el largo de la barra
 * es dibujo, no una cifra.
 */
function TopProducts({
  today,
  storeId,
  recap = null,
}: {
  today: TodayOut
  storeId: number
  recap?: RecapDay | null
}): React.JSX.Element {
  const products = today.top_products ?? []
  // El largo de la barra sale de la participación que manda el servidor
  // (`share_bp`), relativa a la del primero: dibujo, no plata.
  const mayor = Math.max(0, ...products.map((p) => p.share_bp ?? 0))
  return (
    <section className="burbuja min-w-0 rounded-[24px] bg-card p-6" data-slot="lo-mas-vendido">
      <BlockHeader
        title={recap ? `Lo más vendido · ${recap.short}` : "Lo más vendido hoy"}
        block="top-products"
        storeId={storeId}
        date={recap?.date}
      />
      {products.length === 0 ? (
        <EmptyState title="Todavía no se vendió nada hoy" description="Cuando se cobre la primera comanda, sus platos aparecen acá." />
      ) : (
        <ul
          className="flex flex-col gap-3.5"
          aria-label={`Productos más vendidos ${recap ? recap.label : "hoy"}, con unidades y venta neta. Por venta neta, sin impuesto ni propina; la descarga trae todos.`}
        >
          {products.map((p) => (
            <li key={p.key} className="flex flex-col gap-1.5">
              <span className="flex items-baseline gap-3 text-sm">
                <span className="min-w-0 flex-1 truncate">{p.label}</span>
                <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                  {p.units === null ? "—" : `${p.units} u.`}
                </span>
                <span className="w-[5.5rem] shrink-0 text-right tabular-nums">{formatCOP(p.net)}</span>
              </span>
              {p.share_bp !== null && mayor > 0 ? (
                <span aria-hidden="true" className="h-1.5 overflow-hidden rounded-full bg-muted">
                  <span
                    className="block h-full rounded-full bg-data-bar"
                    style={{ width: `${Math.max(2, (p.share_bp / mayor) * 100)}%` }}
                  />
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
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

/**
 * «Lo que entró» (handoff «Burbujas», Hoy § 5): cada recepción en un pozo
 * con su ícono — insumo y cantidad, proveedor, lote y hora, y a la derecha
 * cuándo vence. Un lote por vencer (≤ 7 días, la regla de Lotes, del
 * servidor) va en ámbar; uno vencido, en rojo. Sin «Compras», se dice que la
 * función está apagada: no es «no entró nada».
 */
function Receptions({
  today,
  storeId,
  recap = null,
}: {
  today: TodayOut
  storeId: number
  recap?: RecapDay | null
}): React.JSX.Element {
  const lines = today.receptions_today ?? []
  if (!today.receptions_enabled) {
    return (
      <section className="burbuja min-w-0 rounded-[24px] bg-card p-6" data-slot="entradas-apagadas">
        <h2 className="text-[15px] font-semibold tracking-normal">Lo que entró hoy</h2>
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
    <section className="burbuja min-w-0 rounded-[24px] bg-card p-6" data-slot="lo-que-entro">
      <BlockHeader
        title={recap ? `Lo que entró · ${recap.short}` : "Lo que entró hoy"}
        block="receptions"
        storeId={storeId}
        date={recap?.date}
      >
        {soon > 0 ? (
          <p className="mt-0.5 text-[13px] font-semibold text-warning">
            {soon} {soon === 1 ? "lote vence pronto" : "lotes vencen pronto"}.
          </p>
        ) : null}
      </BlockHeader>
      {lines.length === 0 ? (
        <EmptyState title="Hoy no entró mercancía" description="Las recepciones confirmadas del día aparecen acá, con su lote." />
      ) : (
        <ul
          className="flex flex-col gap-2"
          aria-label={`Lo que entró ${recap ? recap.label : "hoy"}: insumo, cantidad en unidad de compra, proveedor, lote, hora, quién recibió y vencimiento.`}
        >
          {lines.map((r) => {
            const status = receptionStatus(r)
            const word = expiryWord(r.days_to_expiry)
            return (
              <li
                key={r.line_id}
                data-status={status}
                className="flex items-center gap-3 rounded-2xl bg-muted px-3.5 py-3"
              >
                <span className="grid size-9 shrink-0 place-items-center rounded-full bg-card">
                  <Package className="size-4" aria-hidden="true" />
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="text-sm">
                    <span className="font-medium">{r.ingredient_name}</span> ·{" "}
                    <span className="tabular-nums">{`${r.qty} ${r.purchase_unit}`}</span>
                  </span>
                  <span className="text-xs text-muted-foreground">
                    <span>{r.supplier_name}</span> · {r.lot_code ? <span>lote {r.lot_code}</span> : <span>sin lote</span>} ·{" "}
                    {formatClockTime(r.received_at)} · <span>{r.received_by}</span>
                  </span>
                </span>
                <span
                  className={cn(
                    "shrink-0 text-right text-xs font-semibold",
                    status === "critical" ? "text-destructive" : status === "warning" ? "text-warning" : "text-muted-foreground",
                  )}
                >
                  {r.expires_at ? (
                    <>
                      {word ? word.charAt(0).toUpperCase() + word.slice(1) : formatFechaCorta(r.expires_at)}
                      <span className="block font-normal">{formatFechaCorta(r.expires_at)}</span>
                    </>
                  ) : (
                    "Sin vencimiento"
                  )}
                </span>
              </li>
            )
          })}
        </ul>
      )}
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
  const { activeStoreId, stores, loading: storeLoading } = useStoreSelection()
  const { panel: panelAhora } = usePanelAhora()
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
            <div className="grid items-start gap-3 xl:grid-cols-[minmax(0,1fr)_380px]">
              <div className="flex min-w-0 flex-col gap-3 xl:col-start-1 xl:row-start-1">
                <Skeleton className="h-[34rem] w-full rounded-[24px]" />
                <Skeleton className="h-52 w-full rounded-[24px]" />
              </div>
              <Skeleton className="h-48 rounded-[24px] xl:col-start-2 xl:row-start-1 xl:h-96" />
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
  const yesterdayClose = today.yesterday_close ?? null
  // Un ayer abierto pero sin ventas tampoco dice nada: sólo con comandas.
  // Si ayer no vendió (cierra lunes, o una demo sin datos recientes), el
  // servidor manda el último día con ventas (`last_sales_close`): la cifra
  // grande nunca queda en $ 0 sin contexto.
  const yesterdaySold = yesterdayClose !== null && yesterdayClose.operated && yesterdayClose.orders > 0
  const lastSales = today.last_sales_close ?? null
  const yesterday = yesterdaySold ? yesterdayClose : lastSales
  const beforeFirstSale = today.orders === 0 && yesterday !== null && yesterday.orders > 0
  // Antes de la primera venta, los bloques repasan ese mismo día (el
  // servidor manda `recap` con sus cifras): la mañana sirve para ver cómo
  // cerró ayer. Con la primera venta, `recap` deja de venir y vuelve hoy.
  const recapData = today.orders === 0 ? (today.recap ?? null) : null
  const recap: RecapDay | null = recapData
    ? {
        date: recapData.business_date,
        label: recapData.is_yesterday
          ? `ayer (${formatFechaCorta(recapData.business_date)})`
          : `el ${formatFechaCorta(recapData.business_date)}`,
        short: recapData.is_yesterday ? "Ayer" : formatFechaCorta(recapData.business_date),
      }
    : null
  const shown: TodayOut = recapData
    ? {
        ...today,
        orders: recapData.orders,
        avg_ticket: recapData.avg_ticket,
        cash_sales: recapData.cash_sales ?? null,
        card_sales: recapData.card_sales ?? null,
        other_payment_sales: recapData.other_payment_sales ?? null,
        sales_by_hour: recapData.sales_by_hour,
        sales_by_hour_reference: [],
        comparison: null,
        top_products: recapData.top_products,
        receptions_today: recapData.receptions,
      }
    : today

  const updatedIso = new Date(query.dataUpdatedAt).toISOString()

  return (
    <div className="space-y-4">
      <PageHeader
        // «Burbujas» (Hoy § 1): en Hoy el título es un saludo.
        name={saludo(new Date(query.dataUpdatedAt), me?.user?.name)}
        question="¿Cuánto se vendió hoy, qué se vendió, qué mercancía entró y qué necesita una decisión tuya?"
        // En el celular la barra de arriba ya dice «hace 14 s» (captura 13a):
        // la franja de contexto repetía lo mismo en dos renglones.
        context={celular ? [] : [
          {
            label: "Así van las sedes a las",
            value: formatClockTime(updatedIso),
            title: formatInstant(updatedIso),
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
      />

      {/* Dos columnas en el escritorio: el día a la izquierda, en el orden
          que pidió el dueño, y «Requiere tu atención» a la derecha, pegado.
          En el celular es una sola columna y los avisos van al final: el
          orden del código es el orden de lectura (foco y lector de
          pantalla incluidos). */}
      {/* El semáforo de las sedes, a todo el ancho (Hoy § 1). */}
      <SemaforoSedes />

      <div className="grid items-start gap-3 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="flex min-w-0 flex-col gap-3 xl:col-start-1 xl:row-start-1">
          {/* § 4 · La plata nunca es un número suelto: es una resta, y se
              compara contra el mismo día de la semana pasada a la misma hora
              (`comparison`, del servidor: acá no se calcula). Antes de la
              primera venta la cifra grande es la de cómo cerró ayer (o el
              último día con ventas), y el libro sigue siendo el de hoy. */}
          <VentaPrincipal
            etiqueta={
              beforeFirstSale && yesterday
                ? yesterdaySold
                  ? "Todavía no hay ventas hoy · ayer cerró en"
                  : "Todavía no hay ventas hoy · el último día con ventas cerró en"
                : "Ventas netas de hoy"
            }
            cifra={formatCOP(beforeFirstSale && yesterday ? yesterday.net : today.net)}
            nota={
              beforeFirstSale && yesterday
                ? [
                    formatFechaCorta(yesterday.business_date),
                    `${yesterday.orders} ${yesterday.orders === 1 ? "ticket" : "tickets"}`,
                    yesterday.avg_ticket !== null ? `ticket promedio ${formatCOP(yesterday.avg_ticket)}` : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")
                : undefined
            }
            // Antes de la primera venta la cifra grande es de otro día: la
            // comparación de hoy ($ 0 contra la semana pasada) no le
            // corresponde y confunde. Vuelve con la primera venta.
            comparacion={beforeFirstSale && yesterday ? undefined : comparison}
            deltaBp={today.comparison?.delta_bp ?? null}
            // El pie del diseño: el libro de hoy en una línea.
            libro={[
              { label: beforeFirstSale && yesterday ? "Cobrado hoy" : "Cobrado", value: formatCOP(today.gross) },
              { label: "Impuesto", value: formatCOP(today.tax), resta: true },
              ...(today.tips_total !== undefined
                ? [{ label: "Propinas, no son venta", value: formatCOP(today.tips_total) }]
                : []),
              // En el repaso la cifra grande es de otro día: la venta de hoy
              // se dice aparte, para que el $ 0 de hoy no se pierda.
              ...(beforeFirstSale && yesterday
                ? [{ label: "Ventas netas de hoy", value: formatCOP(today.net) }]
                : []),
            ]}
            otros={shown.other_payment_sales ?? null}
            celular={celular}
          >
            <DayFigures today={shown} recap={recap} />
            <HourlySales
              today={shown}
              recap={recap}
              horario={stores.find((x) => x.id === activeStoreId)?.opening_hours ?? []}
              aperturaTurno={panelAhora?.cash?.opened_at ?? null}
            />
          </VentaPrincipal>

          {/* «Ahora» de la sede activa: cinco burbujas en dos columnas. */}
          <AhoraSede />

          <div className="grid min-w-0 items-start gap-3 lg:grid-cols-2">
            <TopProducts today={shown} storeId={activeStoreId} recap={recap} />
            <Receptions today={shown} storeId={activeStoreId} recap={recap} />
          </div>
        </div>

        <div className="min-w-0 xl:col-start-2 xl:row-start-1 xl:self-stretch">
          <AttentionRail attention={attention} today={today} storeId={activeStoreId} celular={celular} />
        </div>
      </div>
    </div>
  )
}

export default TodayPage
