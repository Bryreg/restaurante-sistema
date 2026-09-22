import { ListOrdered, MoreHorizontal, Percent, Receipt, XCircle } from "lucide-react"
import { useState } from "react"
import { useNavigate, useParams } from "react-router-dom"

import { useSession } from "@/app/session"
import type { CatalogComboOut, CatalogProductOut } from "@/api/catalog"
import { newIdempotencyKey } from "@/api/client"
import {
  addDiscount,
  addItems,
  courtesyItem,
  fireCourse,
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
  type PreBillOut,
  type VoidReason,
} from "@/api/orders"
import { EmptyState } from "@/components/EmptyState"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { errorMessage } from "@/lib/errors"
import { formatCOP } from "@/lib/money"
import { formatClock, formatInstant, isTodayInBogota } from "@/lib/businessDate"

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
  useOrder,
  useOrderMutationHandler,
} from "./hooks"
import { CHANNEL_LABEL, courseLabel, elapsedLabel, ORDER_STATUS_LABEL } from "./lib"

type ItemTarget = { product?: CatalogProductOut; combo?: CatalogComboOut }
type VoidTarget = { scope: "order" } | { scope: "item"; item: OrderItemOut }
type DiscountTarget = { scope: "order" } | { scope: "item"; item: OrderItemOut }

export function OrderPage(): React.JSX.Element {
  const { orderId: orderIdParam } = useParams<{ orderId: string }>()
  const orderId = orderIdParam ? Number(orderIdParam) : null
  const navigate = useNavigate()
  const { hasFeature } = useSession()

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

  function saveOrder(updated: NonNullable<typeof order>) {
    if (orderId !== null) queryClient.setQueryData(orderQueryKey(orderId), updated)
  }

  if (orderId === null || Number.isNaN(orderId)) {
    return <EmptyState role="alert" title="Comanda inválida" />
  }
  if (orderQuery.isLoading) {
    return <p className="text-sm text-muted-foreground">Cargando comanda…</p>
  }
  if (!order) {
    return <EmptyState role="alert" title="No se pudo cargar la comanda" description={error ?? undefined} />
  }

  const items = order.items ?? []
  const pendingCount = items.filter((item) => item.status === "pending").length
  // Unidades, no renglones: «5 unidades» cuando hay dos bandejas, dos gaseosas
  // y un postre. Contar renglones diría «3» con cinco platos sobre la mesa, y
  // ese número es justo el que el mesero compara contra lo que ve servido.
  const unidades = items.reduce((suma, item) => suma + (item.qty ?? 1), 0)
  // «Marchar» (pos.courses): un curso por cada valor distinto entre los
  // ítems vivos (no anulados) que lo tienen — el orden es el de primera
  // aparición, nunca alfabético ni inventado.
  const coursesInOrder: string[] = []
  for (const item of items) {
    if (item.status === "voided" || !item.course) continue
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
      authorizerFlow.close()
    } catch (err) {
      handleError(err, { pin, retry: (retryPin) => void handleAddItem(itemIn, retryPin), onStale: () => setItemTarget(null) })
    } finally {
      setItemPending(false)
    }
  }

  // ---------------------------------------------------------------------
  // Cantidad (sólo `pending`).
  // ---------------------------------------------------------------------
  async function handleQtyChange(item: OrderItemOut, nextQty: number) {
    if (!order || nextQty < 1) return
    setBusyItemId(item.id)
    try {
      const updated = await patchItem(order.id, item.id, { expected_version: order.version ?? 0, qty: nextQty })
      saveOrder(updated)
    } catch (err) {
      handleError(err, { retry: () => void handleQtyChange(item, nextQty) })
    } finally {
      setBusyItemId(null)
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
      authorizerFlow.close()
    } catch (err) {
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
      authorizerFlow.close()
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
  // Enviar a cocina.
  // ---------------------------------------------------------------------
  async function handleSend() {
    if (!order) return
    setSendPending(true)
    try {
      const updated = await sendOrder(order.id, { expected_version: order.version ?? 0 }, newIdempotencyKey())
      saveOrder(updated)
    } catch (err) {
      handleError(err, { retry: () => void handleSend() })
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

  // **El título de la cabecera `m2b`**: «Mesa 7 · 4 personas». Lo primero que
  // se lee es de quién es la comanda, no su número interno: el «#501» no le
  // dice nada a quien está parado al lado de la mesa.
  const tablesLabel = (order.tables ?? []).map((t) => t.number).join(", ")
  const titleParts: string[] = []
  if (order.channel === "dine_in" && tablesLabel) titleParts.push(`Mesa ${tablesLabel}`)
  else titleParts.push(order.channel ? CHANNEL_LABEL[order.channel] : "Comanda")
  if (order.channel === "takeout" && order.takeout?.customer_name) titleParts.push(order.takeout.customer_name)
  if (order.channel === "staff_meal" && order.consumed_by?.name) titleParts.push(order.consumed_by.name)
  if (order.channel === "platform" && order.platform?.name) titleParts.push(order.platform.name)
  if (order.covers) titleParts.push(`${order.covers} ${order.covers === 1 ? "persona" : "personas"}`)

  // La sub-línea: cuándo se abrió, cuánto lleva y quién la atiende. El «lleva
  // 52 min» sale del MISMO formateador que el resto del POS (`elapsedLabel`),
  // no de una cuenta nueva acá.
  const subtitleParts: string[] = []
  if (order.opened_at) {
    // **Sólo la hora si la comanda es de hoy** (`m2b`: «Abierta 7:48 p. m.»).
    // La fecha entera —«22 de sept de 2026, 09:35 a m»— es ruido en una
    // comanda que se abrió hace veinte minutos y empuja al mesero a leer
    // cinco palabras para encontrar el dato de una. Si la comanda viene de
    // otro día operativo, la fecha vuelve: entonces sí es lo importante.
    const deHoy = isTodayInBogota(order.opened_at)
    subtitleParts.push(
      `Abierta ${deHoy ? formatClock(order.opened_at) : formatInstant(order.opened_at)}`,
    )
    subtitleParts.push(`lleva ${elapsedLabel(order.opened_at)}`)
  }
  if (order.opened_by?.name) subtitleParts.push(order.opened_by.name)
  // Domicilio y plataforma (pedido 2c): dirección/teléfono/domiciliario, o el
  // número de pedido — sólo texto informativo, ningún cálculo.
  if (order.channel === "delivery" && order.delivery) {
    if (order.delivery.address) subtitleParts.push(order.delivery.address)
    if (order.delivery.phone) subtitleParts.push(order.delivery.phone)
    if (order.delivery.courier?.name) subtitleParts.push(`Domiciliario: ${order.delivery.courier.name}`)
  }
  if (order.channel === "platform" && order.platform?.external_id) {
    subtitleParts.push(`Pedido ${order.platform.external_id}`)
  }

  return (
    /* **La pantalla de la tablet, no una página larga** (`m2b`, pantalla 2).
       Alto fijo: la cabecera arriba, y debajo dos columnas que scrollean cada
       una por su lado. La cuenta NO puede irse debajo del pliegue — el botón
       de mandar a cocina es el control más usado del salón. */
    <div className="flex h-full min-h-0 flex-col gap-3">
      {/* **La cabecera de `m2b`**: banda propia sobre fondo gris, con la cifra
          que va corriendo anclada a la derecha. «Va en» —no «Total»— porque la
          comanda sigue abierta y el número va a seguir subiendo. */}
      <header className="flex shrink-0 flex-wrap items-start gap-4 rounded-xl border bg-muted px-4 py-3">
        <div className="min-w-0">
          <h1 className="text-xl leading-tight font-semibold">{titleParts.join(" · ")}</h1>
          {subtitleParts.length > 0 ? (
            <p className="mt-0.5 text-sm text-muted-foreground">{subtitleParts.join(" · ")}</p>
          ) : null}
          {/* **«Abierta» no se dibuja**: es el estado por defecto de esta
              pantalla y una insignia que siempre dice lo mismo deja de
              leerse. Las que SÍ dicen algo —cuenta presentada, comanda
              cerrada o anulada— siguen. */}
          {order.status !== "open" || order.bill_presented_at ? (
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              {order.status && order.status !== "open" ? (
                <Badge variant="outline">{ORDER_STATUS_LABEL[order.status] ?? order.status}</Badge>
              ) : null}
              {order.bill_presented_at ? (
                <Badge variant="secondary">Cuenta presentada · {formatClock(order.bill_presented_at)}</Badge>
              ) : null}
            </div>
          ) : null}
          {order.note ? <p className="mt-1.5 text-sm text-muted-foreground">Nota: {order.note}</p> : null}
        </div>
        <div className="ml-auto text-right">
          <span className="block text-xs text-muted-foreground">Va en</span>
          <span className="block text-[1.6rem] leading-tight font-bold tabular-nums">{formatCOP(order.totals?.total)}</span>
        </div>
      </header>

      {error ? (
        <p role="alert" className="shrink-0 text-sm text-destructive">
          {error}
        </p>
      ) : null}

      {/* Carta y cuenta, lado a lado. La cuenta es fija de 384 px: el mesero
          toca platos a la izquierda y ve crecer el total a la derecha sin
          desplazarse. Bajo el punto de quiebre caen una debajo de otra. */}
      <div className="grid min-h-0 flex-1 items-start gap-4 xl:grid-cols-[minmax(0,1fr)_384px]">
        <div className="min-h-0 min-w-0 overflow-y-auto xl:h-full">
          {isOrderOpenish ? (
            <div className="space-y-3">
              <CatalogPanel
                channel={order.channel ?? "counter"}
                onSelectProduct={(product) => setItemTarget({ product })}
                onSelectCombo={(combo) => setItemTarget({ combo })}
              />
              {/* La frase de la maqueta, **con su filete azul a la
                  izquierda**. No es decorativo: en `m2b` ese filete marca las
                  notas que explican plata —el 8 % acá, la propina en el
                  cobro— y las separa de un pie de página cualquiera. Sin él
                  la frase se lee como letra chica y es justo la que evita la
                  discusión de si el impuesto se suma al final. */}
              <p className="border-l-[3px] border-primary py-0.5 pl-3 text-xs text-muted-foreground">
                Los precios de la carta <b className="text-foreground">ya incluyen el impuesto al consumo del 8 %</b>.
                Lo que el cliente ve acá es lo que paga.
              </p>
            </div>
          ) : null}
        </div>

        {/* **La cuenta**: un solo panel. Los renglones scrollean adentro y el
            total se queda pegado abajo (`m2b` lo resuelve con `margin-top:auto`
            sobre una columna de alto fijo). */}
        <aside className="flex min-h-0 flex-col overflow-y-auto rounded-xl border bg-card p-4 xl:h-full">
          {/* **La cabecera de la cuenta** (`m2b`): el icono de lista, el
              rótulo en versalita y las unidades a la derecha. Nada más —la
              maqueta no pone una fila de botones acá, y tenía razón: tres
              acciones grises arriba de los renglones son lo primero que se
              ve al abrir la comanda, cuando lo primero que hay que ver es
              qué pidió la mesa. */}
          <div className="flex shrink-0 items-center gap-2">
            <ListOrdered className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <h2 className="text-[0.76rem] font-bold tracking-[0.07em] uppercase">La cuenta</h2>
            <span className="ml-auto text-xs whitespace-nowrap text-muted-foreground">
              {unidades} {unidades === 1 ? "unidad" : "unidades"}
            </span>

            {/* Las tres acciones de la comanda entera, detrás de un menú.
                Siguen a un toque de distancia y dejan de competir con los
                renglones; «Anular comanda» además deja de estar a un dedo
                de «Ir a cobrar», que era la vecindad más cara de la
                pantalla. El descuento vive además en el cobro (`m2b`
                pantalla 3, «Aplicar descuento»), que es donde se decide. */}
            {isOrderOpenish ? (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-8 shrink-0 text-muted-foreground"
                      disabled={preBillPending}
                      aria-label="Más acciones de esta comanda"
                    >
                      <MoreHorizontal className="size-4" aria-hidden="true" />
                    </Button>
                  }
                />
                <DropdownMenuContent align="end">
                  {hasFeature("pos.pre_bill") ? (
                    <DropdownMenuItem disabled={preBillPending} onClick={() => void handlePresentBill()}>
                      <Receipt className="size-4" aria-hidden="true" />
                      {preBillPending ? "Presentando…" : "Presentar cuenta"}
                    </DropdownMenuItem>
                  ) : null}
                  {hasFeature("pos.discounts") ? (
                    <DropdownMenuItem onClick={() => setDiscountTarget({ scope: "order" })}>
                      <Percent className="size-4" aria-hidden="true" />
                      Descuento de la comanda
                    </DropdownMenuItem>
                  ) : null}
                  <DropdownMenuItem onClick={() => setVoidTarget({ scope: "order" })}>
                    <XCircle className="size-4" aria-hidden="true" />
                    Anular comanda
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </div>

          {/* Los renglones scrollean acá adentro. El mínimo no es decorativo:
              sin él, un pie alto los comprime hasta cero y la cuenta —que es
              el motivo de la pantalla— desaparece sin que nada falle. */}
          <div className="mt-3 min-h-[10rem] flex-1 overflow-y-auto">
            <OrderItemsList
              items={items}
              busyItemId={busyItemId}
              onIncrement={(item) => void handleQtyChange(item, (item.qty ?? 1) + 1)}
              onDecrement={(item) => void handleQtyChange(item, (item.qty ?? 1) - 1)}
              onVoid={(item) => setVoidTarget({ scope: "item", item })}
              onCourtesy={(item) => {
                setCourtesyError(null)
                setCourtesyTarget(item)
              }}
              onDiscount={(item) => setDiscountTarget({ scope: "item", item })}
            />
          </div>

          {hasFeature("pos.courses") && coursesInOrder.length > 0 ? (
            <div className="mt-3 shrink-0 space-y-2 border-t pt-3">
              <h3 className="text-xs font-medium text-muted-foreground">Marchar</h3>
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
            </div>
          ) : null}

          {/* La raya gruesa que separa la cuenta de su total: en la maqueta es
              `border-top: 2px solid var(--ink)`. Misma convención que la banda
              de cifra del admin — abajo de la raya va el resultado. */}
          <div className="mt-3 shrink-0 border-t-2 border-foreground pt-3">
            <div className="flex items-baseline gap-3 py-1">
              <span className="text-base">Total de la cuenta</span>
              <span className="ml-auto text-2xl font-bold tabular-nums">{formatCOP(order.totals?.total)}</span>
            </div>
            {/* El corte que pide `m2b`: qué ya no se puede quitar sin permiso y
                qué sí. Los dos renglones los calcula el servidor y SUMAN el
                total — no son dos cuentas distintas. */}
            <div className="flex items-baseline gap-3 py-1 text-sm">
              <span className="text-muted-foreground">Ya está en cocina o servido</span>
              <span className="ml-auto font-bold tabular-nums">{formatCOP(order.totals?.sent_total)}</span>
            </div>
            <div className="flex items-baseline gap-3 py-1 text-sm">
              <span className="text-muted-foreground">Sin mandar todavía</span>
              <span className="ml-auto font-bold tabular-nums">{formatCOP(order.totals?.pending_total)}</span>
            </div>
            {(order.totals?.discount_total ?? 0) > 0 ? (
              <div className="flex items-baseline gap-3 py-1 text-sm">
                <span className="text-muted-foreground">Descuentos</span>
                <span className="ml-auto tabular-nums">−{formatCOP(order.totals?.discount_total)}</span>
              </div>
            ) : null}
            {isOrderOpenish ? (
              <div className="mt-3 space-y-2">
                {hasFeature("kitchen.view") ? (
                  <Button
                    type="button"
                    className="h-12 w-full"
                    disabled={sendPending || pendingCount === 0}
                    onClick={() => void handleSend()}
                  >
                    {sendPending
                      ? "Enviando…"
                      : pendingCount === 0
                        ? "Todo está en cocina"
                        : `Mandar ${pendingCount} ${pendingCount === 1 ? "línea" : "líneas"} a cocina`}
                  </Button>
                ) : null}
                <Button
                  type="button"
                  variant="outline"
                  className="h-12 w-full"
                  onClick={() => navigate(`/pos/cobro/${order.id}`)}
                >
                  {order.channel === "counter" ? "Cobrar" : "Ir a cobrar"}
                </Button>
                {/* La advertencia de la maqueta, palabra por palabra: explica
                    por qué el botón de quitar desaparece en los renglones que
                    ya salieron. */}
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Lo que ya salió a cocina no se borra desde acá: se anula con autorización y queda en el historial.
                </p>
              </div>
            ) : null}
          </div>
        </aside>
      </div>

      <ItemDialog
        open={itemTarget !== null}
        onOpenChange={(open) => !open && setItemTarget(null)}
        product={itemTarget?.product}
        combo={itemTarget?.combo}
        channel={order.channel ?? "counter"}
        pending={itemPending}
        onConfirm={(itemIn) => void handleAddItem(itemIn)}
      />

      <VoidDialog
        open={voidTarget !== null}
        onOpenChange={(open) => !open && setVoidTarget(null)}
        title={voidTarget?.scope === "order" ? "Anular comanda" : `Anular ${voidTarget?.scope === "item" ? (voidTarget.item.name ?? "ítem") : ""}`}
        pending={voidPending}
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
      />

      <AuthorizerDialog
        open={authorizerFlow.open}
        onOpenChange={(open) => !open && authorizerFlow.close()}
        onSubmit={authorizerFlow.submitPin}
        pending={authorizerFlow.pending}
        errorMessage={authorizerFlow.pinError}
        reason="Esta acción supera el límite y necesita autorización de supervisor o administrador."
      />
    </div>
  )
}

export default OrderPage
