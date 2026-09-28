import { ArrowLeft, CheckCheck, Clock, ReceiptText, Send } from "lucide-react"
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
import { Cargando } from "@/components/Cargando"
import { EmptyState } from "@/components/EmptyState"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
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
  elapsedLabel,
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

/** Los cursos que se eligen en la comanda (handoff `PosComanda`: Entrada · Fuerte · Postre). */
const CHOOSABLE_COURSES = ["starter", "main", "dessert"] as const

/** Botón de «elegir uno» de 56 px (asiento, curso): el elegido en `foreground` lleno. */
function segmentClass(selected: boolean, size: string): string {
  return cn(
    "h-[56px] min-w-0 flex-1 rounded-lg border font-bold transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
    size,
    selected ? "border-foreground bg-foreground text-background" : "border-border bg-background text-foreground hover:bg-muted",
  )
}

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
  // La comanda maneja su alto: carta y pedido se desplazan por dentro y el
  // pie con «Enviar a cocina» queda fijo.
  usePosTarea({ aLoAncho: true })

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
      if (!opts.stay && backToTables) navigate("/pos/mesas")
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
  // El título es la mesa, que es como el mesero la piensa («Mesa 2 · 2
  // comensales»); el número de comanda queda de segunda línea.
  const orderTitle = isTableOrder
    ? `Mesa ${tablesLabel}`
    : `${order.channel ? CHANNEL_LABEL[order.channel] : "Comanda"} #${order.id}`
  const titleParts = [orderTitle]
  if (order.covers) titleParts.push(`${order.covers} ${order.covers === 1 ? "comensal" : "comensales"}`)
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

  return (
    <div className={isOrderOpenish ? "flex min-h-0 flex-1 flex-col" : "flex min-h-0 flex-1 flex-col overflow-y-auto"}>
      <div
        className={
          isOrderOpenish
            ? "min-h-0 flex-1 overflow-y-auto lg:grid lg:grid-cols-[minmax(0,1fr)_470px] lg:overflow-hidden"
            : "flex-1"
        }
      >
        <section className="flex flex-col gap-3 px-4 py-3 lg:min-h-0 lg:overflow-y-auto">
          <header className="flex flex-col gap-1">
            <div className="flex flex-wrap items-center gap-3">
              {backToTables ? (
                <Button
                  type="button"
                  variant="outline"
                  className="h-[56px] gap-1.5 rounded-lg px-3.5 text-[16px] font-semibold [&_svg]:size-5"
                  onClick={() => navigate("/pos/mesas")}
                >
                  <ArrowLeft aria-hidden="true" />
                  Mesas
                </Button>
              ) : null}
              <h1 className="text-[28px] leading-tight font-extrabold">{titleParts.join(" · ")}</h1>
              {order.opened_at && isOrderOpenish ? (
                <span className="ml-auto inline-flex items-center gap-1.5 text-[15px] text-muted-foreground">
                  <Clock className="size-4" aria-hidden="true" />
                  abierta hace {elapsedLabel(order.opened_at)}
                </span>
              ) : null}
            </div>
            <div className="flex flex-wrap items-center gap-2 text-[14px] text-muted-foreground">
              {subtitleParts.length > 0 ? <span>{subtitleParts.join(" · ")}</span> : null}
              {order.status && order.status !== "open" ? (
                <Badge variant="outline">{ORDER_STATUS_LABEL[order.status] ?? order.status}</Badge>
              ) : null}
              {order.bill_presented_at ? (
                <Badge variant="secondary">Cuenta presentada · {formatInstant(order.bill_presented_at)}</Badge>
              ) : null}
              {order.note ? <span>Nota: {order.note}</span> : null}
            </div>
          </header>

          {error ? (
            <p role="alert" className="text-[15px] text-destructive">
              {error}
            </p>
          ) : null}

          {isOrderOpenish ? (
            <CatalogPanel
              channel={order.channel ?? "counter"}
              unsentQty={unsentQty}
              quickAdd
              onSelectProduct={handleSelectProduct}
              onSelectCombo={(combo) => setItemTarget({ combo })}
            />
          ) : null}
        </section>

        <aside
          aria-label="Pedido"
          className="flex flex-col border-t bg-card lg:min-h-0 lg:border-t-0 lg:border-l"
        >
          {isOrderOpenish && (seatOptions.length > 0 || coursesOn) ? (
            <div className="flex flex-col gap-2 border-b px-3.5 py-3">
              {seatOptions.length > 0 ? (
                <div className="flex items-center gap-2" role="group" aria-label="Asiento">
                  <span className="w-[58px] shrink-0 text-[14px] font-semibold text-muted-foreground">Asiento</span>
                  {[...seatOptions, null].map((seat) => (
                    <button
                      key={seat ?? "todos"}
                      type="button"
                      aria-pressed={chosenSeat === seat}
                      className={segmentClass(chosenSeat === seat, "text-[17px]")}
                      onClick={() => setChosenSeat(seat)}
                    >
                      {seat ?? "Todos"}
                    </button>
                  ))}
                </div>
              ) : null}
              {coursesOn ? (
                <div className="flex items-center gap-2" role="group" aria-label="Curso">
                  <span className="w-[58px] shrink-0 text-[14px] font-semibold text-muted-foreground">Curso</span>
                  {CHOOSABLE_COURSES.map((course) => (
                    <button
                      key={course}
                      type="button"
                      aria-pressed={chosenCourse === course}
                      className={segmentClass(chosenCourse === course, "text-[16px]")}
                      // Tocar el elegido lo suelta: el plato vuelve a su curso por defecto.
                      onClick={() => setChosenCourse((current) => (current === course ? null : course))}
                    >
                      {courseLabel(course)}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}

          <div className="flex flex-col gap-2 px-2.5 py-1.5 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
            {readyItems.length > 0 ? (
              <Button
                type="button"
                variant="outline"
                className="h-[56px] self-end text-[15px]"
                disabled={servingAll}
                onClick={() => void handleServeAll(readyItems)}
              >
                <CheckCheck className="size-4" aria-hidden="true" />
                {servingAll ? "Marcando…" : `Marcar todo servido · ${readyItems.length}`}
              </Button>
            ) : null}
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
            />

            {hasFeature("pos.courses") && coursesInOrder.length > 0 ? (
              <section className="flex flex-col gap-2 px-1 pt-2" aria-label="Marchar">
                <h2 className="text-[13px] font-bold tracking-[0.06em] text-muted-foreground uppercase">Marchar</h2>
                <ul className="flex flex-wrap gap-2">
                  {coursesInOrder.map((course) => {
                    const fired = firedCourses.get(course)
                    return (
                      <li key={course}>
                        {fired ? (
                          <Badge variant="secondary" className="h-11 items-center px-3 text-sm">
                            {courseLabel(course)} marchado · {formatInstant(fired.fired_at)}
                          </Badge>
                        ) : (
                          <Button
                            type="button"
                            variant="outline"
                            className="h-[56px] text-[15px]"
                            disabled={firingCourse === course || !isOrderOpenish}
                            onClick={() => void handleFireCourse(course)}
                          >
                            {firingCourse === course ? "Marchando…" : `Marchar ${courseLabel(course)}`}
                          </Button>
                        )}
                      </li>
                    )
                  })}
                </ul>
              </section>
            ) : null}

            {hasFeature("pos.discounts") && isOrderOpenish ? (
              <Button
                type="button"
                variant="ghost"
                className="h-11 self-start text-[15px]"
                onClick={() => setDiscountTarget({ scope: "order" })}
              >
                Descuento de la comanda
              </Button>
            ) : null}
            {isOrderOpenish ? (
              <Button
                type="button"
                variant="ghost"
                className="h-11 self-start text-[15px] text-destructive"
                onClick={() => setVoidTarget({ scope: "order" })}
              >
                Anular comanda
              </Button>
            ) : null}
          </div>
        </aside>
      </div>

      {isOrderOpenish ? (
        <footer
          className="flex flex-wrap items-center gap-2.5 border-t bg-card px-3.5 py-2.5"
          style={{ paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 0.625rem)" }}
        >
          {asksForBill ? (
            <Button
              type="button"
              variant="outline"
              className="h-[64px] gap-2 rounded-lg px-[18px] text-[17px] font-bold [&_svg]:size-5"
              disabled={preBillPending}
              onClick={() => void handlePresentBill()}
            >
              <ReceiptText aria-hidden="true" />
              {preBillPending ? "Pidiendo…" : "Pedir cuenta"}
            </Button>
          ) : null}
          <div className="ml-2 flex flex-col">
            <span className="text-[14px] text-muted-foreground">{isTableOrder ? "Total mesa" : "Total"}</span>
            <b className="text-[24px] leading-tight tabular-nums">{formatCOP(order.totals?.total)}</b>
          </div>
          {/* Las acciones de enviar/cobrar van juntas a la derecha; en la
              tablet vertical bajan a su propio renglón, a lo ancho. */}
          <div className="ml-auto flex gap-2.5 max-lg:w-full max-lg:[&>*]:flex-1">
          {/* Una sola acción en añil por pantalla, y siempre a la vista en el
              pie fijo: mientras haya algo sin enviar es «Enviar a cocina · N»;
              cuando ya salió todo, la cuenta (o nada, para quien no cobra:
              «Pedir cuenta» ya está a la izquierda). */}
          {sendIsPrimary ? (
            <>
              {backToTables ? (
                <Button
                  type="button"
                  variant="outline"
                  className="h-[64px] rounded-lg px-5 text-[17px] font-bold"
                  disabled={sendPending}
                  onClick={() => void handleSend({ stay: true })}
                >
                  Enviar y quedarme
                </Button>
              ) : null}
              <Button
                type="button"
                className="h-[64px] gap-2.5 rounded-lg px-[26px] text-[19px] font-extrabold [&_svg]:size-[22px]"
                disabled={sendPending}
                onClick={() => void handleSend({ stay: false })}
              >
                <Send aria-hidden="true" />
                {sendPending ? "Enviando…" : `Enviar a cocina · ${unsentUnits} ${unsentUnits === 1 ? "ítem" : "ítems"}`}
              </Button>
            </>
          ) : asksForBill ? null : (
            <>
              {hasFeature("pos.pre_bill") ? (
                <Button
                  type="button"
                  variant="outline"
                  className="h-[64px] rounded-lg px-5 text-[17px] font-bold"
                  disabled={preBillPending}
                  onClick={() => void handlePresentBill()}
                >
                  {preBillPending ? "Presentando…" : "Presentar cuenta"}
                </Button>
              ) : null}
              <Button
                type="button"
                className="h-[64px] rounded-lg px-[26px] text-[19px] font-extrabold"
                onClick={() => navigate(`/pos/cobro/${order.id}`)}
              >
                {order.channel === "counter" ? "Cobrar" : "Cuenta / Cobrar"}
              </Button>
            </>
          )}
          </div>
        </footer>
      ) : null}

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
