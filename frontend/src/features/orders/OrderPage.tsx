import { ArrowLeft, CheckCheck, MoreHorizontal, Percent, ReceiptText, Send, XCircle } from "lucide-react"
import { useRef, useState } from "react"
import { useNavigate, useParams } from "react-router-dom"
import { toast } from "sonner"

import { usePosTarea } from "@/app/posTarea"
import { puedeManejarCaja } from "@/app/puesto"
import { useSession } from "@/app/session"
import type { CatalogComboOut, CatalogProductOut } from "@/api/catalog"
import { newIdempotencyKey } from "@/api/client"
import {
  addDiscount,
  addItems,
  courtesyItem,
  fireCourse,
  markServed,
  patchItem,
  presentBill,
  sendOrder,
  voidItem,
  voidOrder,
  type CourtesyReason,
  type DiscountKind,
  type DiscountReason,
  type OrderItemIn,
  type OrderItemOut,
  type OrderOut,
  type PreBillOut,
  type VoidReason,
} from "@/api/orders"
import { Burbuja, EstadoPastilla, SegmentadoTactil } from "@/components/admin"
import { Cargando } from "@/components/Cargando"
import { EmptyState } from "@/components/EmptyState"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Textarea } from "@/components/ui/textarea"
import { errorMessage } from "@/lib/errors"
import { formatCOP } from "@/lib/money"
import { formatInstant } from "@/lib/businessDate"
import { cn } from "@/lib/utils"

import { AuthorizerDialog } from "./AuthorizerDialog"
import { CatalogPanel } from "./CatalogPanel"
import { CourtesyDialog } from "./CourtesyDialog"
import { DiscountDialog } from "./DiscountDialog"
import { ItemDialog } from "./ItemDialog"
import { OrderItemsList } from "./OrderItemsList"
import { PreBillDialog } from "./PreBillDialog"
import { VoidDialog } from "./VoidDialog"
import {
  applyStaleOrder,
  isStaleVersionError,
  orderQueryKey,
  STALE_VERSION_MESSAGE,
  TABLES_STATUS_QUERY_KEY,
  useOrder,
  useOrderMutationHandler,
} from "./hooks"
import {
  CHANNEL_LABEL,
  courseLabel,
  elapsedMinutesLabel,
  findMergeableLine,
  isDishLine,
  ORDER_STATUS_LABEL,
  productNeedsOptions,
  toggleNote,
  unsentItemCount,
  unsentQtyByProduct,
  VOID_NEEDS_PIN_TEXT,
} from "./lib"

/**
 * `required`: el diálogo se abrió porque el plato pide algo (no porque la
 * persona pidió «Elegir opciones»): al completar el único grupo obligatorio,
 * el plato entra solo.
 */
type ItemTarget = { product?: CatalogProductOut; combo?: CatalogComboOut; required?: boolean }
type VoidTarget = { scope: "order" } | { scope: "item"; item: OrderItemOut }
type DiscountTarget = { scope: "order" } | { scope: "item"; item: OrderItemOut }

/**
 * ¿Esta anulación va a pedir PIN? La misma regla que el servidor
 * (`app/orders/service.py::void_item`): lo que ya salió de `pending`, o
 * cualquier cosa con la cuenta presentada. Sólo decide el aviso previo; el
 * PIN lo exige el backend.
 */
function voidNeedsAuthorizer(target: VoidTarget | null, order: OrderOut | undefined): boolean {
  if (!target || !order) return false
  if (order.bill_presented_at) return true
  if (target.scope === "item") return target.item.status !== "pending"
  return (order.items ?? []).some((item) => item.status !== "pending" && item.status !== "voided")
}

/** Los tiempos que se eligen en la comanda (handoff 9c: Entrada · Fuerte · Postre). */
const CHOOSABLE_COURSES = ["starter", "main", "dessert"] as const

/** «Todos» en el interruptor de asiento: el plato no va a un asiento. */
const ALL_SEATS = "todos"

/**
 * El título es la mesa, que es como el mesero la piensa («Mesa 2»); el resto
 * de los canales, su nombre y número («Mostrador #12»).
 */
function orderTitleOf(order: OrderOut): string {
  const tables = (order.tables ?? []).map((t) => t.number).join(", ")
  if (order.channel === "dine_in" && tables !== "") return `Mesa ${tables}`
  return `${order.channel ? CHANNEL_LABEL[order.channel] : "Comanda"} #${order.id}`
}

/** La pastilla de la barra (como en el cobro): «Mesa 4» o «#12». */
function orderContextLabel(order: OrderOut): string {
  const tables = (order.tables ?? []).map((t) => t.number).join(", ")
  return tables !== "" ? `Mesa ${tables}` : `#${order.id}`
}

/** Los botones del pozo final (60 px, radio 16). */
const FOOT_BUTTON_CLASS =
  "inline-flex h-[60px] min-w-0 items-center justify-center gap-2 rounded-2xl px-3 font-semibold transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-none disabled:cursor-not-allowed [&_svg]:size-[18px] [&_svg]:shrink-0"
const FOOT_SECONDARY_CLASS = cn(
  FOOT_BUTTON_CLASS,
  "bg-card text-[15px] text-foreground enabled:hover:bg-fill-strong disabled:text-muted-foreground",
)
const FOOT_PRIMARY_CLASS = cn(
  FOOT_BUTTON_CLASS,
  "bg-primary text-base text-primary-foreground enabled:hover:bg-primary/90 disabled:opacity-70",
)
/** «Enviar a cocina» sin nada pendiente: en `card` y gris. */
const FOOT_OFF_CLASS = cn(FOOT_BUTTON_CLASS, "bg-card text-base text-muted-foreground")
/** Los botones del encabezado del pedido: pozos de 44 px. */
const HEAD_BUTTON_CLASS =
  "inline-flex h-11 shrink-0 items-center justify-center gap-1.5 rounded-[14px] bg-muted px-3 text-sm font-semibold text-foreground transition-colors hover:bg-fill-strong focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-50 [&_svg]:size-[18px]"
/** Las acciones del menú ⋯ y de «Marchar»: pozos de 56 / 48 px. */
const MENU_ACTION_CLASS =
  "flex h-14 w-full items-center gap-3 rounded-2xl bg-muted px-4 text-left text-base font-semibold transition-colors hover:bg-fill-strong focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-50 [&_svg]:size-5"

export function OrderPage(): React.JSX.Element {
  const { orderId: orderIdParam } = useParams<{ orderId: string }>()
  const orderId = orderIdParam ? Number(orderIdParam) : null
  const navigate = useNavigate()
  const { hasFeature, me } = useSession()

  const orderQuery = useOrder(orderId)
  const order = orderQuery.data
  const { authorizerFlow, error, setError, handleError, queryClient } = useOrderMutationHandler(orderId)

  const [itemTarget, setItemTarget] = useState<ItemTarget | null>(null)
  const [itemPending, setItemPending] = useState(false)

  const [voidTarget, setVoidTarget] = useState<VoidTarget | null>(null)
  const [voidPending, setVoidPending] = useState(false)

  const [courtesyTarget, setCourtesyTarget] = useState<OrderItemOut | null>(null)
  const [courtesyPending, setCourtesyPending] = useState(false)
  const [courtesyError, setCourtesyError] = useState<string | null>(null)

  const [discountTarget, setDiscountTarget] = useState<DiscountTarget | null>(null)
  const [discountPending, setDiscountPending] = useState(false)

  const [sendPending, setSendPending] = useState(false)
  const [preBill, setPreBill] = useState<PreBillOut | null>(null)
  const [preBillPending, setPreBillPending] = useState(false)
  const [busyItemId, setBusyItemId] = useState<number | null>(null)
  const [firingCourse, setFiringCourse] = useState<string | null>(null)
  const [servingAll, setServingAll] = useState(false)
  // Por qué se pide el PIN esta vez: anular lo enviado lo dice con su texto.
  const [authorizerReason, setAuthorizerReason] = useState<string | null>(null)
  // Los toques rápidos en la carta van en fila: cada uno manda la versión
  // que dejó el anterior. Sin la fila, dos toques seguidos salen con la
  // misma `expected_version` y el segundo rebota con `STALE_VERSION` — un
  // plato perdido en el peor minuto del turno.
  const quickAddQueue = useRef<Promise<void>>(Promise.resolve())
  // Asiento y curso elegidos para lo que se toque en la carta; `null` =
  // «Todos» / el curso por defecto del plato.
  const [chosenSeat, setChosenSeat] = useState<number | null>(null)
  const [chosenCourse, setChosenCourse] = useState<string | null>(null)
  // La línea sin enviar elegida: muestra sus notas rápidas.
  const [selectedItemId, setSelectedItemId] = useState<number | null>(null)
  const [otherNoteItem, setOtherNoteItem] = useState<OrderItemOut | null>(null)
  const [otherNoteText, setOtherNoteText] = useState("")
  // «✓ Enviado a cocina…» en el pozo final, cuando se envía y se sigue en la comanda.
  const [sentNotice, setSentNotice] = useState<string | null>(null)
  // El menú ⋯ del encabezado: las acciones de la comanda entera.
  const [orderMenuOpen, setOrderMenuOpen] = useState(false)
  // La comanda maneja su alto: carta y pedido se desplazan por dentro y el
  // pozo final con «Enviar a cocina» queda fijo. La pastilla de la barra
  // dice en qué tarea se está («Comanda · Mesa 4»).
  usePosTarea({ aLoAncho: true, titulo: order ? `Comanda · ${orderContextLabel(order)}` : null })

  function saveOrder(updated: NonNullable<typeof order>) {
    if (orderId !== null) queryClient.setQueryData(orderQueryKey(orderId), updated)
  }

  /**
   * Una acción que pasó —con o sin PIN—: cierra el diálogo de PIN y borra el
   * aviso rojo que dejó el primer intento («necesita autorización»). Antes el
   * aviso quedaba pegado después de autorizar, como si hubiera fallado.
   */
  function settled() {
    authorizerFlow.close()
    setError(null)
    setAuthorizerReason(null)
  }

  if (orderId === null || Number.isNaN(orderId)) {
    return <EmptyState role="alert" title="Comanda inválida" />
  }
  if (orderQuery.isLoading) {
    return <Cargando texto="Cargando comanda…" />
  }
  if (!order) {
    return <EmptyState role="alert" title="No se pudo cargar la comanda" description={error ?? undefined} />
  }

  const items = order.items ?? []
  const readyItems = items.filter((item) => item.status === "ready")
  // Contar unidades (no plata) sí es del cliente: el número del botón de
  // enviar y el de la insignia de cada plato de la carta.
  const unsentUnits = unsentItemCount(items)
  const unsentQty = unsentQtyByProduct(items)
  // «Marchar» (pos.courses): un curso por cada valor distinto entre los
  // ítems vivos (no anulados) que lo tienen — el orden es el de primera
  // aparición, nunca alfabético ni inventado.
  // El cargo de domicilio no se marcha: no es un plato (aunque viaje con el
  // curso por defecto del producto).
  const coursesInOrder: string[] = []
  for (const item of items) {
    if (item.status === "voided" || !item.course || !isDishLine(item)) continue
    if (!coursesInOrder.includes(item.course)) coursesInOrder.push(item.course)
  }
  const firedCourses = new Map((order.courses_fired ?? []).map((fire) => [fire.course, fire]))
  const isOrderOpenish = order.status === "open" || order.status === "to_pay"
  const seatsOn = hasFeature("pos.seats") && (order.covers ?? 0) > 0
  const coursesOn = hasFeature("pos.courses")

  // ---------------------------------------------------------------------
  // Agregar ítem.
  // ---------------------------------------------------------------------
  async function handleAddItem(itemIn: OrderItemIn, pin?: string) {
    if (!order) return
    setItemPending(true)
    try {
      const updated = await addItems(
        order.id,
        { expected_version: order.version ?? 0, items: [itemIn], authorizer_pin: pin },
        newIdempotencyKey(),
      )
      saveOrder(updated)
      setItemTarget(null)
      setSentNotice(null)
      settled()
    } catch (err) {
      handleError(err, { pin, retry: (retryPin) => void handleAddItem(itemIn, retryPin), onStale: () => setItemTarget(null) })
    } finally {
      setItemPending(false)
    }
  }

  // ---------------------------------------------------------------------
  // Toque en la carta: suma directo salvo que el plato exija elegir algo
  // (modificador obligatorio) o que la persona haya pedido «Elegir
  // opciones» (Momento 1 de `docs/diseno/propuesta.html`).
  // ---------------------------------------------------------------------
  function handleSelectProduct(product: CatalogProductOut, options?: { withOptions: boolean }) {
    if (options?.withOptions) {
      setItemTarget({ product })
      return
    }
    if (productNeedsOptions(product, hasFeature("pos.modifiers"))) {
      setItemTarget({ product, required: true })
      return
    }
    enqueueQuickAdd(product)
  }

  function enqueueQuickAdd(product: CatalogProductOut, pin?: string) {
    quickAddQueue.current = quickAddQueue.current.then(() => quickAdd(product, pin))
  }

  async function quickAdd(product: CatalogProductOut, pin?: string) {
    // La comanda de la caché, no la del render: el toque anterior de la
    // fila ya pudo haberla cambiado (y con ella la versión).
    const current = (orderId !== null ? queryClient.getQueryData<OrderOut>(orderQueryKey(orderId)) : undefined) ?? order
    if (!current) return
    // Sumar a la línea que ya existe deja «2× Limonada» en vez de dos líneas
    // de 1×. Sólo cuando el backend validaría lo mismo por las dos vías: con
    // cupo diario (`daily_remaining`) o con la cuenta ya presentada, el PATCH
    // de cantidad no revisa ni el cupo ni el PIN, así que va una línea nueva
    // por `addItems`, que sí los revisa.
    const canMerge = (product.daily_remaining === null || product.daily_remaining === undefined) && !current.bill_presented_at
    const target = { seat: seatsOn ? chosenSeat : null, course: coursesOn ? chosenCourse : null }
    const mergeable = canMerge ? findMergeableLine(current.items ?? [], product, target) : undefined
    const itemIn: OrderItemIn = { product_id: product.id, qty: 1 }
    if (target.seat !== null) itemIn.seat = target.seat
    if (target.course !== null) itemIn.course = target.course
    try {
      const updated = mergeable
        ? await patchItem(current.id, mergeable.id, { expected_version: current.version ?? 0, qty: (mergeable.qty ?? 1) + 1 })
        : await addItems(
            current.id,
            { expected_version: current.version ?? 0, items: [itemIn], authorizer_pin: pin },
            newIdempotencyKey(),
          )
      saveOrder(updated)
      setSentNotice(null)
      // La línea que acaba de recibir el plato queda elegida: sus notas
      // rápidas («Sin cebolla») están a un toque.
      const known = new Set((current.items ?? []).map((item) => item.id))
      const added = mergeable ?? (updated.items ?? []).find((item) => !known.has(item.id))
      if (added) setSelectedItemId(added.id)
      if (pin !== undefined) settled()
    } catch (err) {
      handleError(err, { pin, retry: (retryPin) => enqueueQuickAdd(product, retryPin) })
    }
  }

  // ---------------------------------------------------------------------
  // Cantidad (sólo `pending`).
  // ---------------------------------------------------------------------
  async function handleQtyChange(item: OrderItemOut, nextQty: number, pin?: string) {
    if (!order || nextQty < 1) return
    setBusyItemId(item.id)
    try {
      const updated = await patchItem(order.id, item.id, {
        expected_version: order.version ?? 0,
        qty: nextQty,
        authorizer_pin: pin,
      })
      saveOrder(updated)
      if (pin !== undefined) settled()
    } catch (err) {
      // Con la cuenta presentada el servidor pide PIN (`BILL_PRESENTED_NEEDS_AUTH`),
      // igual que al agregar: `handleError` abre el mismo diálogo.
      handleError(err, { pin, retry: (retryPin) => void handleQtyChange(item, nextQty, retryPin) })
    } finally {
      setBusyItemId(null)
    }
  }

  // ---------------------------------------------------------------------
  // Nota de una línea sin enviar (notas rápidas u «Otra nota…»).
  // ---------------------------------------------------------------------
  async function handleNoteChange(item: OrderItemOut, note: string, pin?: string) {
    if (!order) return
    setBusyItemId(item.id)
    try {
      const updated = await patchItem(order.id, item.id, {
        expected_version: order.version ?? 0,
        note,
        authorizer_pin: pin,
      })
      saveOrder(updated)
      if (pin !== undefined) settled()
    } catch (err) {
      handleError(err, { pin, retry: (retryPin) => void handleNoteChange(item, note, retryPin) })
    } finally {
      setBusyItemId(null)
    }
  }

  // ---------------------------------------------------------------------
  // Servido: lo que cocina marcó listo ya llegó a la mesa. Cierra el ciclo
  // enviado → listo → servido; sin esto el plato se quedaba «Listo» para
  // siempre y el mapa de mesas no dejaba de avisar.
  // ---------------------------------------------------------------------
  async function handleServed(item: OrderItemOut) {
    if (!order) return
    setBusyItemId(item.id)
    setError(null)
    try {
      saveOrder(await markServed(order.id, item.id, newIdempotencyKey()))
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusyItemId(null)
    }
  }

  async function handleServeAll(ready: OrderItemOut[]) {
    if (!order) return
    setServingAll(true)
    setError(null)
    try {
      // Uno por uno, cada uno con su `Idempotency-Key`: el servidor marca
      // ítem por ítem y un reintento no sirve dos veces.
      for (const item of ready) {
        saveOrder(await markServed(order.id, item.id, newIdempotencyKey()))
      }
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setServingAll(false)
    }
  }

  // ---------------------------------------------------------------------
  // Anular (ítem o comanda comparten motivo tipado + PIN si corresponde).
  // ---------------------------------------------------------------------
  async function handleVoidConfirm(reason: VoidReason, note: string | undefined, pin?: string) {
    if (!order || !voidTarget) return
    setVoidPending(true)
    try {
      const updated =
        voidTarget.scope === "item"
          ? await voidItem(order.id, voidTarget.item.id, { expected_version: order.version ?? 0, reason, note, authorizer_pin: pin })
          : await voidOrder(order.id, { expected_version: order.version ?? 0, reason, note, authorizer_pin: pin })
      saveOrder(updated)
      setVoidTarget(null)
      settled()
    } catch (err) {
      if (pin === undefined && voidNeedsAuthorizer(voidTarget, order)) setAuthorizerReason(`${VOID_NEEDS_PIN_TEXT}.`)
      handleError(err, {
        pin,
        retry: (retryPin) => void handleVoidConfirm(reason, note, retryPin),
        onStale: () => setVoidTarget(null),
      })
    } finally {
      setVoidPending(false)
    }
  }

  // ---------------------------------------------------------------------
  // Cortesía: motivo + PIN los pide el propio diálogo (PIN obligatorio en el backend).
  // ---------------------------------------------------------------------
  async function handleCourtesyConfirm(reason: CourtesyReason, note: string | undefined, pin: string) {
    if (!order || !courtesyTarget) return
    setCourtesyPending(true)
    setCourtesyError(null)
    try {
      const updated = await courtesyItem(order.id, courtesyTarget.id, {
        expected_version: order.version ?? 0,
        reason,
        note,
        authorizer_pin: pin,
      })
      saveOrder(updated)
      setCourtesyTarget(null)
    } catch (err) {
      if (isStaleVersionError(err) && orderId !== null) {
        applyStaleOrder(queryClient, orderId, err)
        setCourtesyTarget(null)
        setError(STALE_VERSION_MESSAGE)
        return
      }
      setCourtesyError(errorMessage(err))
    } finally {
      setCourtesyPending(false)
    }
  }

  // ---------------------------------------------------------------------
  // Descuento por ítem o por comanda.
  // ---------------------------------------------------------------------
  async function handleDiscountConfirm(kind: DiscountKind, value: number, reason: DiscountReason, note: string | undefined, pin?: string) {
    if (!order || !discountTarget) return
    setDiscountPending(true)
    try {
      const updated = await addDiscount(order.id, {
        expected_version: order.version ?? 0,
        scope: discountTarget.scope,
        item_id: discountTarget.scope === "item" ? discountTarget.item.id : undefined,
        kind,
        value,
        reason,
        note,
        authorizer_pin: pin,
      })
      saveOrder(updated)
      setDiscountTarget(null)
      settled()
    } catch (err) {
      handleError(err, {
        pin,
        retry: (retryPin) => void handleDiscountConfirm(kind, value, reason, note, retryPin),
        onStale: () => setDiscountTarget(null),
      })
    } finally {
      setDiscountPending(false)
    }
  }

  // ---------------------------------------------------------------------
  // Enviar a cocina. Con la confirmación grande que pedía la auditoría en
  // la tablet («Mesa 4 · 5 ítems enviados») y, en una mesa, de vuelta al
  // mapa: el mesero ya no tiene nada que hacer acá. «Enviar y quedarme»
  // para seguir cargando (la bebida que falta, la ronda de postres).
  // ---------------------------------------------------------------------
  async function handleSend(opts: { stay: boolean }) {
    if (!order) return
    const sentUnits = unsentUnits
    setSendPending(true)
    try {
      const updated = await sendOrder(order.id, { expected_version: order.version ?? 0 }, newIdempotencyKey())
      saveOrder(updated)
      setError(null)
      toast.success(`${orderTitle} · ${sentUnits} ${sentUnits === 1 ? "ítem enviado" : "ítems enviados"}`, {
        // Grande a propósito: se lee de reojo, con la tablet en la mano y
        // caminando de vuelta al salón.
        className: "py-5! text-lg!",
        classNames: { title: "text-lg! font-bold!" },
        duration: 4000,
      })
      void queryClient.invalidateQueries({ queryKey: TABLES_STATUS_QUERY_KEY })
      if (!opts.stay && backToTables) {
        navigate("/pos/mesas")
      } else {
        setSentNotice(`Enviado a cocina. Seguís en ${isTableOrder ? `la ${orderTitle.toLowerCase()}` : orderTitle}.`)
      }
    } catch (err) {
      handleError(err, { retry: () => void handleSend(opts) })
    } finally {
      setSendPending(false)
    }
  }

  // ---------------------------------------------------------------------
  // «Marchar» un curso (pos.courses, requiere kitchen.view).
  // ---------------------------------------------------------------------
  async function handleFireCourse(course: string) {
    if (!order) return
    setFiringCourse(course)
    try {
      const updated = await fireCourse(order.id, course, { expected_version: order.version ?? 0 }, newIdempotencyKey())
      saveOrder(updated)
    } catch (err) {
      handleError(err, { retry: () => void handleFireCourse(course) })
    } finally {
      setFiringCourse(null)
    }
  }

  // ---------------------------------------------------------------------
  // Presentar cuenta / reimprimir precuenta.
  // ---------------------------------------------------------------------
  async function handlePresentBill() {
    if (!order) return
    setPreBillPending(true)
    try {
      const result = await presentBill(order.id, { expected_version: order.version ?? 0 }, newIdempotencyKey())
      setPreBill(result)
      void queryClient.invalidateQueries({ queryKey: orderQueryKey(orderId) })
    } catch (err) {
      handleError(err, { retry: () => void handlePresentBill() })
    } finally {
      setPreBillPending(false)
    }
  }

  const tablesLabel = (order.tables ?? []).map((t) => t.number).join(", ")
  const isTableOrder = order.channel === "dine_in" && tablesLabel !== ""
  const orderTitle = orderTitleOf(order)
  // «3 comensales · 51 min» al lado del título (handoff 9c).
  const metaParts: string[] = []
  if (order.covers) metaParts.push(`${order.covers} ${order.covers === 1 ? "comensal" : "comensales"}`)
  if (order.opened_at && isOrderOpenish) metaParts.push(elapsedMinutesLabel(order.opened_at))
  const subtitleParts: string[] = []
  if (isTableOrder) subtitleParts.push(`Comanda #${order.id}`)
  if (order.channel === "takeout" && order.takeout?.customer_name) subtitleParts.push(order.takeout.customer_name)
  if (order.channel === "staff_meal" && order.consumed_by?.name) subtitleParts.push(order.consumed_by.name)
  // Domicilio y plataforma (pedido 2c): dirección/teléfono/domiciliario, o
  // plataforma/número de pedido — sólo texto informativo, ningún cálculo.
  if (order.channel === "delivery" && order.delivery) {
    if (order.delivery.address) subtitleParts.push(order.delivery.address)
    if (order.delivery.phone) subtitleParts.push(order.delivery.phone)
    if (order.delivery.courier?.name) subtitleParts.push(`Domiciliario: ${order.delivery.courier.name}`)
  }
  if (order.channel === "platform" && order.platform) {
    if (order.platform.name) subtitleParts.push(order.platform.name)
    if (order.platform.external_id) subtitleParts.push(`Pedido ${order.platform.external_id}`)
  }

  // Después de enviar (o de pedir la cuenta) una mesa vuelve al mapa; el
  // mostrador y los demás canales se quedan: lo que sigue es cobrar.
  const backToTables = order.channel === "dine_in" && hasFeature("pos.tables")
  const canSend = isOrderOpenish && hasFeature("kitchen.view")
  const sendIsPrimary = canSend && unsentUnits > 0
  // Quien no cobra no recorre el cobro entero para fallar al final: «Pedir
  // cuenta» presenta la precuenta y deja la mesa «Por cobrar» para la caja.
  // Misma regla que la caja (`puedeManejarCaja`); el backend decide igual.
  const canCharge = puedeManejarCaja(me?.employee, null)
  const asksForBill = !canCharge && hasFeature("pos.pre_bill")
  // Asiento y curso de lo que se toca en la carta (handoff `PosComanda`):
  // sólo con sus funciones encendidas; el asiento, además, con comensales.
  const seatOptions = seatsOn ? Array.from({ length: order.covers ?? 0 }, (_, index) => index + 1) : []
  const selectedLine = items.find((item) => item.id === selectedItemId && item.status === "pending") ?? null

  // Las acciones de la comanda entera (menú ⋯ del encabezado).
  const discountOrderOn = hasFeature("pos.discounts") && isOrderOpenish
  const hasOrderMenu = backToTables || discountOrderOn || isOrderOpenish
  const unitsLabel = `${unsentUnits} ${unsentUnits === 1 ? "ítem" : "ítems"}`
  // El pozo final: mientras haya algo sin enviar, «Enviar y seguir» y
  // «Enviar a cocina · N»; cuando ya salió todo, la cuenta en ese lugar (o,
  // para quien no cobra, «Enviar a cocina» apagado: «Pedir cuenta» está en
  // el encabezado).
  const showAccount = !sendIsPrimary && !asksForBill
  const showSendOff = !sendIsPrimary && asksForBill && canSend

  return (
    <div
      className={cn(
        "flex min-h-0 flex-1 flex-col overflow-y-auto p-2.5",
        isOrderOpenish && "lg:overflow-hidden",
      )}
    >
      <div
        className={cn(
          "grid gap-2.5",
          isOrderOpenish
            ? "lg:min-h-0 lg:flex-1 lg:grid-cols-[minmax(0,1fr)_420px] lg:grid-rows-[minmax(0,1fr)]"
            : "mx-auto w-full max-w-[40rem]",
        )}
      >
        {isOrderOpenish ? (
          <Burbuja aria-label="Carta" className="flex flex-col gap-3.5 rounded-[24px] p-[18px] lg:min-h-0">
            <CatalogPanel
              channel={order.channel ?? "counter"}
              unsentQty={unsentQty}
              quickAdd
              onSelectProduct={handleSelectProduct}
              onSelectCombo={(combo) => setItemTarget({ combo })}
            />
          </Burbuja>
        ) : null}

        <Burbuja aria-label="Pedido" className="flex flex-col gap-3 rounded-[24px] p-[18px] lg:min-h-0">
          <header className="flex items-start gap-2 px-1">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
                <h1 className="text-xl leading-tight font-semibold">{orderTitle}</h1>
                {metaParts.length > 0 ? (
                  <span className="text-[13px] text-muted-foreground">{metaParts.join(" · ")}</span>
                ) : null}
              </div>
              {subtitleParts.length > 0 ? (
                <p className="text-[13px] text-muted-foreground">{subtitleParts.join(" · ")}</p>
              ) : null}
              {order.note ? <p className="text-[13px] text-muted-foreground">Nota: {order.note}</p> : null}
              {(order.status && order.status !== "open") || order.bill_presented_at ? (
                <div className="flex flex-wrap gap-1.5">
                  {order.status && order.status !== "open" ? (
                    <EstadoPastilla tono="neutral">{ORDER_STATUS_LABEL[order.status] ?? order.status}</EstadoPastilla>
                  ) : null}
                  {order.bill_presented_at ? (
                    <EstadoPastilla tono="warning">Cuenta presentada · {formatInstant(order.bill_presented_at)}</EstadoPastilla>
                  ) : null}
                </div>
              ) : null}
            </div>
            {isOrderOpenish && asksForBill ? (
              // Quien no cobra pide la cuenta desde acá, aunque quede algo sin enviar.
              <button
                type="button"
                className={HEAD_BUTTON_CLASS}
                disabled={preBillPending}
                onClick={() => void handlePresentBill()}
              >
                <ReceiptText aria-hidden="true" />
                {preBillPending ? "Pidiendo…" : "Pedir cuenta"}
              </button>
            ) : null}
            {hasOrderMenu ? (
              <button
                type="button"
                className={cn(HEAD_BUTTON_CLASS, "w-11 px-0")}
                aria-haspopup="dialog"
                aria-label="Más acciones de la comanda"
                onClick={() => setOrderMenuOpen(true)}
              >
                <MoreHorizontal aria-hidden="true" />
              </button>
            ) : null}
          </header>

          {error ? (
            <p role="alert" className="rounded-2xl bg-destructive-soft px-3.5 py-2.5 text-sm font-semibold text-destructive">
              {error}
            </p>
          ) : null}

          {isOrderOpenish && (seatOptions.length > 0 || coursesOn) ? (
            // Handoff 9c: «Asiento» y «Tiempo» a la izquierda, sus
            // interruptores a lo ancho. Cada fila, sólo con su función.
            <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-2.5 gap-y-2 px-1">
              {seatOptions.length > 0 ? (
                <>
                  <span className="text-[13px] text-muted-foreground" aria-hidden="true">
                    Asiento
                  </span>
                  <SegmentadoTactil
                    etiqueta="Asiento"
                    opciones={[
                      ...seatOptions.map((seat) => ({ value: String(seat), label: String(seat) })),
                      { value: ALL_SEATS, label: "Todos" },
                    ]}
                    valor={chosenSeat === null ? ALL_SEATS : String(chosenSeat)}
                    onChange={(value) => setChosenSeat(value === ALL_SEATS ? null : Number(value))}
                    alto={44}
                    columnas={Math.min(seatOptions.length + 1, 6)}
                  />
                </>
              ) : null}
              {coursesOn ? (
                <>
                  <span className="text-[13px] text-muted-foreground" aria-hidden="true">
                    Tiempo
                  </span>
                  <SegmentadoTactil
                    etiqueta="Tiempo"
                    opciones={CHOOSABLE_COURSES.map((course) => ({ value: course, label: courseLabel(course) }))}
                    valor={chosenCourse}
                    // Tocar el elegido lo suelta: el plato vuelve a su tiempo por defecto.
                    onChange={(course) => setChosenCourse((current) => (current === course ? null : course))}
                    alto={44}
                    columnas={CHOOSABLE_COURSES.length}
                  />
                </>
              ) : null}
            </div>
          ) : null}

          <div className="flex flex-col gap-1.5 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
            <OrderItemsList
              items={items}
              busyItemId={busyItemId}
              selectedItemId={selectedLine?.id ?? null}
              onSelect={(item) => setSelectedItemId((current) => (current === item.id ? null : item.id))}
              onToggleNote={(item, note) => void handleNoteChange(item, toggleNote(item.note, note))}
              onOtherNote={(item) => {
                setOtherNoteText("")
                setOtherNoteItem(item)
              }}
              onIncrement={(item) => void handleQtyChange(item, (item.qty ?? 1) + 1)}
              onDecrement={(item) => void handleQtyChange(item, (item.qty ?? 1) - 1)}
              onVoid={(item) => setVoidTarget({ scope: "item", item })}
              onCourtesy={(item) => {
                setCourtesyError(null)
                setCourtesyTarget(item)
              }}
              onDiscount={(item) => setDiscountTarget({ scope: "item", item })}
              onServed={(item) => void handleServed(item)}
              sentAction={
                readyItems.length > 0 ? (
                  <button
                    type="button"
                    className="inline-flex h-11 shrink-0 items-center gap-1.5 rounded-[14px] bg-success-soft px-3 text-[13px] font-semibold text-success transition-opacity focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-50"
                    disabled={servingAll}
                    onClick={() => void handleServeAll(readyItems)}
                  >
                    <CheckCheck className="size-4" aria-hidden="true" />
                    {servingAll ? "Marcando…" : `Marcar todo servido · ${readyItems.length}`}
                  </button>
                ) : null
              }
            />

            {coursesOn && coursesInOrder.length > 0 ? (
              <section className="flex flex-col gap-1.5 pt-2.5" aria-label="Marchar">
                <h2 className="px-1 text-xs font-semibold text-muted-foreground">Marchar</h2>
                <ul className="flex flex-wrap gap-1.5">
                  {coursesInOrder.map((course) => {
                    const fired = firedCourses.get(course)
                    return (
                      <li key={course}>
                        {fired ? (
                          <EstadoPastilla tono="success" className="h-12 rounded-2xl px-3.5 text-[13px]">
                            {courseLabel(course)} marchado · {formatInstant(fired.fired_at)}
                          </EstadoPastilla>
                        ) : (
                          <button
                            type="button"
                            className="inline-flex h-12 items-center rounded-2xl bg-muted px-4 text-[15px] font-semibold transition-colors hover:bg-fill-strong focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-50"
                            disabled={firingCourse === course || !isOrderOpenish}
                            onClick={() => void handleFireCourse(course)}
                          >
                            {firingCourse === course ? "Marchando…" : `Marchar ${courseLabel(course)}`}
                          </button>
                        )}
                      </li>
                    )
                  })}
                </ul>
              </section>
            ) : null}
          </div>

          <div
            className="flex flex-col gap-2.5 rounded-[20px] bg-muted p-3.5"
            style={isOrderOpenish ? { marginBottom: "env(safe-area-inset-bottom, 0px)" } : undefined}
          >
            <span className="flex items-baseline justify-between gap-3">
              <span className="text-sm text-muted-foreground">{isTableOrder ? "Total mesa" : "Total"}</span>
              <b className="text-[26px] leading-tight font-medium tracking-[-0.02em] tabular-nums">
                {formatCOP(order.totals?.total)}
              </b>
            </span>
            {sentNotice ? (
              <span role="status" className="text-[13px] font-semibold text-success">
                ✓ {sentNotice}
              </span>
            ) : null}
            {isOrderOpenish && sendIsPrimary ? (
              <div className={cn("grid gap-2", backToTables ? "grid-cols-[1fr_1.4fr]" : "grid-cols-1")}>
                {backToTables ? (
                  <button
                    type="button"
                    className={FOOT_SECONDARY_CLASS}
                    disabled={sendPending}
                    onClick={() => void handleSend({ stay: true })}
                  >
                    Enviar y seguir
                  </button>
                ) : null}
                <button
                  type="button"
                  className={FOOT_PRIMARY_CLASS}
                  disabled={sendPending}
                  onClick={() => void handleSend({ stay: false })}
                >
                  <Send aria-hidden="true" />
                  {sendPending ? "Enviando…" : `Enviar a cocina · ${unitsLabel}`}
                </button>
              </div>
            ) : null}
            {isOrderOpenish && showSendOff ? (
              <div className={cn("grid gap-2", backToTables ? "grid-cols-[1fr_1.4fr]" : "grid-cols-1")}>
                {backToTables ? (
                  <button type="button" className={FOOT_SECONDARY_CLASS} disabled>
                    Enviar y seguir
                  </button>
                ) : null}
                <button type="button" className={FOOT_OFF_CLASS} disabled>
                  <Send aria-hidden="true" />
                  Enviar a cocina · {unitsLabel}
                </button>
              </div>
            ) : null}
            {isOrderOpenish && showAccount ? (
              <div className={cn("grid gap-2", hasFeature("pos.pre_bill") ? "grid-cols-[1fr_1.4fr]" : "grid-cols-1")}>
                {hasFeature("pos.pre_bill") ? (
                  <button
                    type="button"
                    className={FOOT_SECONDARY_CLASS}
                    disabled={preBillPending}
                    onClick={() => void handlePresentBill()}
                  >
                    <ReceiptText aria-hidden="true" />
                    {preBillPending ? "Presentando…" : "Presentar cuenta"}
                  </button>
                ) : null}
                <button type="button" className={FOOT_PRIMARY_CLASS} onClick={() => navigate(`/pos/cobro/${order.id}`)}>
                  {order.channel === "counter" ? "Cobrar" : "Cuenta / Cobrar"}
                </button>
              </div>
            ) : null}
          </div>
        </Burbuja>
      </div>

      <Sheet open={orderMenuOpen} onOpenChange={setOrderMenuOpen}>
        <SheetContent
          side="bottom"
          showCloseButton={false}
          className="mx-auto max-h-[calc(100dvh-2rem)] max-w-xl overflow-y-auto rounded-t-[24px]"
        >
          <SheetHeader>
            <SheetTitle className="text-lg font-semibold">{orderTitle}</SheetTitle>
            <SheetDescription>Acciones de la comanda</SheetDescription>
          </SheetHeader>
          <div className="flex flex-col gap-2 px-4 pb-4">
            {backToTables ? (
              <button
                type="button"
                className={MENU_ACTION_CLASS}
                onClick={() => {
                  setOrderMenuOpen(false)
                  navigate("/pos/mesas")
                }}
              >
                <ArrowLeft aria-hidden="true" />
                Volver a Mesas
              </button>
            ) : null}
            {discountOrderOn ? (
              <button
                type="button"
                className={MENU_ACTION_CLASS}
                onClick={() => {
                  setOrderMenuOpen(false)
                  setDiscountTarget({ scope: "order" })
                }}
              >
                <Percent aria-hidden="true" />
                Descuento de la comanda
              </button>
            ) : null}
            {isOrderOpenish ? (
              <button
                type="button"
                className={cn(MENU_ACTION_CLASS, "text-destructive")}
                onClick={() => {
                  setOrderMenuOpen(false)
                  setVoidTarget({ scope: "order" })
                }}
              >
                <XCircle aria-hidden="true" />
                Anular comanda
              </button>
            ) : null}
            <button
              type="button"
              className="h-14 w-full rounded-2xl bg-secondary text-base font-semibold text-secondary-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              onClick={() => setOrderMenuOpen(false)}
            >
              Cerrar
            </button>
          </div>
        </SheetContent>
      </Sheet>

      <Dialog open={otherNoteItem !== null} onOpenChange={(open) => !open && setOtherNoteItem(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Nota para {otherNoteItem?.name ?? "el plato"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-1">
            <Label htmlFor="other-note">Otra nota</Label>
            <Textarea
              id="other-note"
              value={otherNoteText}
              maxLength={120}
              onChange={(event) => setOtherNoteText(event.target.value)}
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              className="h-[56px] px-5 text-[16px]"
              disabled={otherNoteText.trim() === "" || otherNoteItem === null}
              onClick={() => {
                if (!otherNoteItem) return
                void handleNoteChange(otherNoteItem, toggleNote(otherNoteItem.note, otherNoteText.trim()))
                setOtherNoteItem(null)
              }}
            >
              Guardar nota
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ItemDialog
        open={itemTarget !== null}
        onOpenChange={(open) => !open && setItemTarget(null)}
        product={itemTarget?.product}
        combo={itemTarget?.combo}
        channel={order.channel ?? "counter"}
        pending={itemPending}
        seatCount={order.covers ?? null}
        autoAddOnRequired={itemTarget?.required === true}
        onConfirm={(itemIn) => void handleAddItem(itemIn)}
      />

      <VoidDialog
        open={voidTarget !== null}
        onOpenChange={(open) => !open && setVoidTarget(null)}
        title={voidTarget?.scope === "order" ? "Anular comanda" : `Anular ${voidTarget?.scope === "item" ? (voidTarget.item.name ?? "ítem") : ""}`}
        pending={voidPending}
        needsAuthorizer={voidNeedsAuthorizer(voidTarget, order)}
        onConfirm={(reason, note) => void handleVoidConfirm(reason, note)}
      />

      <CourtesyDialog
        open={courtesyTarget !== null}
        onOpenChange={(open) => !open && setCourtesyTarget(null)}
        pending={courtesyPending}
        errorMessage={courtesyError}
        onConfirm={(reason, note, pin) => void handleCourtesyConfirm(reason, note, pin)}
      />

      <DiscountDialog
        open={discountTarget !== null}
        onOpenChange={(open) => !open && setDiscountTarget(null)}
        title={discountTarget?.scope === "order" ? "Descuento de la comanda" : "Descuento del ítem"}
        pending={discountPending}
        onConfirm={(kind, value, reason, note) => void handleDiscountConfirm(kind, value, reason, note)}
      />

      <PreBillDialog
        preBill={preBill}
        onOpenChange={(open) => !open && setPreBill(null)}
        pending={preBillPending}
        onReprint={() => void handlePresentBill()}
        onDone={
          backToTables
            ? () => {
                setPreBill(null)
                navigate("/pos/mesas")
              }
            : undefined
        }
      />

      <AuthorizerDialog
        open={authorizerFlow.open}
        onOpenChange={(open) => {
          if (open) return
          authorizerFlow.close()
          setAuthorizerReason(null)
        }}
        onSubmit={authorizerFlow.submitPin}
        pending={authorizerFlow.pending}
        errorMessage={authorizerFlow.pinError}
        reason={authorizerReason ?? "Esta acción supera el límite y necesita autorización de supervisor o administrador."}
      />
    </div>
  )
}

export default OrderPage
