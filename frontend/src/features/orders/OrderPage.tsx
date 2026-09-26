import { CheckCheck, ReceiptText, Send } from "lucide-react"
import { useRef, useState } from "react"
import { useNavigate, useParams } from "react-router-dom"
import { toast } from "sonner"

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
import { errorMessage } from "@/lib/errors"
import { formatCOP } from "@/lib/money"
import { formatInstant } from "@/lib/businessDate"

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
  findMergeableLine,
  isDishLine,
  nextRoundNo,
  ORDER_STATUS_LABEL,
  productNeedsOptions,
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
    const mergeable = canMerge ? findMergeableLine(current.items ?? [], product) : undefined
    try {
      const updated = mergeable
        ? await patchItem(current.id, mergeable.id, { expected_version: current.version ?? 0, qty: (mergeable.qty ?? 1) + 1 })
        : await addItems(
            current.id,
            { expected_version: current.version ?? 0, items: [{ product_id: product.id, qty: 1 }], authorizer_pin: pin },
            newIdempotencyKey(),
          )
      saveOrder(updated)
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

  return (
    <div className="space-y-6 pb-28">
      <header className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h1 className="text-xl font-bold">{titleParts.join(" · ")}</h1>
            {subtitleParts.length > 0 ? <p className="text-sm text-muted-foreground">{subtitleParts.join(" · ")}</p> : null}
          </div>
          <div className="flex items-center gap-2">
            {order.status ? <Badge variant="outline">{ORDER_STATUS_LABEL[order.status] ?? order.status}</Badge> : null}
            {order.bill_presented_at ? (
              <Badge variant="secondary">Cuenta presentada · {formatInstant(order.bill_presented_at)}</Badge>
            ) : null}
          </div>
        </div>
        {order.note ? <p className="text-sm text-muted-foreground">Nota: {order.note}</p> : null}
      </header>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      {/* Momento 1 de `docs/diseno/propuesta.html`: en la tablet apaisada, la
          carta a la izquierda y el pedido a la derecha; en angosto, apilados. */}
      <div className={isOrderOpenish ? "space-y-6 lg:grid lg:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)] lg:items-start lg:gap-6 lg:space-y-0" : "space-y-6"}>
        {isOrderOpenish ? (
          <section className="space-y-3">
            <h2 className="text-sm font-medium text-muted-foreground">Agregar a la comanda</h2>
            <CatalogPanel
              channel={order.channel ?? "counter"}
              unsentQty={unsentQty}
              quickAdd
              onSelectProduct={handleSelectProduct}
              onSelectCombo={(combo) => setItemTarget({ combo })}
            />
          </section>
        ) : null}

        <div className="space-y-6">
          <section className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-medium text-muted-foreground">Pedido</h2>
              {readyItems.length > 0 ? (
                <Button
                  type="button"
                  variant="outline"
                  className="h-11"
                  disabled={servingAll}
                  onClick={() => void handleServeAll(readyItems)}
                >
                  <CheckCheck className="size-4" aria-hidden="true" />
                  {servingAll ? "Marcando…" : `Marcar todo servido · ${readyItems.length}`}
                </Button>
              ) : null}
            </div>
            <OrderItemsList
              items={items}
              busyItemId={busyItemId}
              nextRoundNo={nextRoundNo(order.rounds, items)}
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
          </section>

          {hasFeature("pos.courses") && coursesInOrder.length > 0 ? (
            <section className="space-y-3">
              <h2 className="text-sm font-medium text-muted-foreground">Marchar</h2>
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
                          className="h-11"
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

          <section className="space-y-2 rounded-lg border p-4">
            <h2 className="text-sm font-medium text-muted-foreground">Totales</h2>
            <dl className="space-y-1 text-sm">
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Subtotal</dt>
                <dd className="tabular-nums">{formatCOP(order.totals?.subtotal)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Descuentos</dt>
                <dd className="tabular-nums">{formatCOP(order.totals?.discount_total)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Impuesto</dt>
                <dd className="tabular-nums">{formatCOP(order.totals?.tax_total)}</dd>
              </div>
              <div className="flex justify-between text-base font-semibold">
                <dt>Total</dt>
                <dd className="tabular-nums">{formatCOP(order.totals?.total)}</dd>
              </div>
              {order.tip ? (
                <div className="flex justify-between text-muted-foreground">
                  <dt>Propina sugerida ({order.tip.suggested_pct}%)</dt>
                  <dd className="tabular-nums">{formatCOP(order.tip.suggested_amount)}</dd>
                </div>
              ) : null}
            </dl>
            {hasFeature("pos.discounts") && isOrderOpenish ? (
              <Button type="button" variant="outline" className="h-11" onClick={() => setDiscountTarget({ scope: "order" })}>
                Descuento de la comanda
              </Button>
            ) : null}
          </section>
        </div>
      </div>

      {isOrderOpenish ? (
        <div className="fixed inset-x-0 bottom-0 z-40 flex flex-wrap items-center justify-end gap-2 border-t bg-background p-3" style={{ paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 0.75rem)" }}>
          <Button type="button" variant="ghost" className="h-14 sm:mr-auto" onClick={() => setVoidTarget({ scope: "order" })}>
            Anular comanda
          </Button>
          {/* Una sola acción en añil por pantalla, y siempre a la vista en la
              barra fija: mientras haya algo sin enviar es «Enviar a cocina ·
              N» (antes quedaba debajo del pedido, tapada por esta barra en la
              tablet vertical); cuando ya salió todo, la cuenta. */}
          {sendIsPrimary ? (
            <>
              {backToTables ? (
                <Button
                  type="button"
                  variant="outline"
                  className="h-14 px-5 text-base"
                  disabled={sendPending}
                  onClick={() => void handleSend({ stay: true })}
                >
                  Enviar y quedarme
                </Button>
              ) : null}
              <Button
                type="button"
                className="h-14 px-6 text-base font-bold"
                disabled={sendPending}
                onClick={() => void handleSend({ stay: false })}
              >
                <Send className="size-5" aria-hidden="true" />
                {sendPending ? "Enviando…" : `Enviar a cocina · ${unsentUnits} ${unsentUnits === 1 ? "ítem" : "ítems"}`}
              </Button>
            </>
          ) : asksForBill ? (
            <Button
              type="button"
              className="h-14 px-6 text-base font-semibold"
              disabled={preBillPending}
              onClick={() => void handlePresentBill()}
            >
              <ReceiptText className="size-5" aria-hidden="true" />
              {preBillPending ? "Pidiendo…" : "Pedir cuenta"}
            </Button>
          ) : (
            <>
              {hasFeature("pos.pre_bill") ? (
                <Button
                  type="button"
                  variant="outline"
                  className="h-14 px-5 text-base"
                  disabled={preBillPending}
                  onClick={() => void handlePresentBill()}
                >
                  {preBillPending ? "Presentando…" : "Presentar cuenta"}
                </Button>
              ) : null}
              <Button type="button" className="h-14 px-6 text-base font-semibold" onClick={() => navigate(`/pos/cobro/${order.id}`)}>
                {order.channel === "counter" ? "Cobrar" : "Cuenta / Cobrar"}
              </Button>
            </>
          )}
        </div>
      ) : null}

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
