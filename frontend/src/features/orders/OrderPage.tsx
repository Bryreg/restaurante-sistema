import { useState } from "react"
import { useNavigate, useParams } from "react-router-dom"

import { useSession } from "@/app/session"
import type { CatalogComboOut, CatalogProductOut } from "@/api/catalog"
import { newIdempotencyKey } from "@/api/client"
import {
  addDiscount,
  addItems,
  courtesyItem,
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
  useOrder,
  useOrderMutationHandler,
} from "./hooks"
import { CHANNEL_LABEL, ORDER_STATUS_LABEL } from "./lib"

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
  const subtitleParts: string[] = []
  if (order.channel === "dine_in" && tablesLabel) subtitleParts.push(`Mesa ${tablesLabel}`)
  if (order.channel === "takeout" && order.takeout?.customer_name) subtitleParts.push(order.takeout.customer_name)
  if (order.channel === "staff_meal" && order.consumed_by?.name) subtitleParts.push(order.consumed_by.name)
  if (order.covers) subtitleParts.push(`${order.covers} comensales`)

  return (
    <div className="space-y-6 pb-28">
      <header className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h1 className="text-lg font-semibold">
              {order.channel ? CHANNEL_LABEL[order.channel] : "Comanda"} · #{order.id}
            </h1>
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

      {isOrderOpenish ? (
        <section className="space-y-3">
          <h2 className="text-sm font-medium text-muted-foreground">Agregar a la comanda</h2>
          <CatalogPanel
            channel={order.channel ?? "counter"}
            onSelectProduct={(product) => setItemTarget({ product })}
            onSelectCombo={(combo) => setItemTarget({ combo })}
          />
        </section>
      ) : null}

      <section className="space-y-3">
        <h2 className="text-sm font-medium text-muted-foreground">Ítems</h2>
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
      </section>

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

      {isOrderOpenish ? (
        <div className="fixed inset-x-0 bottom-0 z-40 flex flex-wrap items-center justify-end gap-2 border-t bg-background p-3" style={{ paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 0.75rem)" }}>
          <Button type="button" variant="ghost" className="h-11" onClick={() => setVoidTarget({ scope: "order" })}>
            Anular comanda
          </Button>
          {hasFeature("kitchen.view") ? (
            <Button type="button" variant="outline" className="h-11" disabled={sendPending || pendingCount === 0} onClick={() => void handleSend()}>
              {sendPending ? "Enviando…" : `Enviar (${pendingCount})`}
            </Button>
          ) : null}
          {hasFeature("pos.pre_bill") ? (
            <Button type="button" variant="outline" className="h-11" disabled={preBillPending} onClick={() => void handlePresentBill()}>
              {preBillPending ? "Presentando…" : "Presentar cuenta"}
            </Button>
          ) : null}
          <Button type="button" className="h-11 px-6 text-base font-semibold" onClick={() => navigate(`/pos/cobro/${order.id}`)}>
            {order.channel === "counter" ? "Cobrar" : "Cuenta / Cobrar"}
          </Button>
        </div>
      ) : null}

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
