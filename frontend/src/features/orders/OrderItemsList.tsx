import { CheckCheck, ChevronRight, Gift, Minus, MoreHorizontal, Percent, Plus, XCircle } from "lucide-react"
import { useState } from "react"

import { useSession } from "@/app/session"
import type { OrderItemOut } from "@/api/orders"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { formatCOP } from "@/lib/money"
import { cn } from "@/lib/utils"

import {
  courseGroupLabel,
  groupByCourse,
  ITEM_STATUS_BADGE_VARIANT,
  ITEM_STATUS_LABEL,
  nextRoundNo as deriveNextRoundNo,
  VOID_REASON_LABEL,
} from "./lib"

export interface OrderItemsListProps {
  items: OrderItemOut[]
  onIncrement: (item: OrderItemOut) => void
  onDecrement: (item: OrderItemOut) => void
  onVoid: (item: OrderItemOut) => void
  onCourtesy: (item: OrderItemOut) => void
  onDiscount: (item: OrderItemOut) => void
  /**
   * «Servido»: el plato que cocina marcó listo ya llegó a la mesa. Sin él
   * (una pantalla que no sirve) el botón no aparece.
   */
  onServed?: (item: OrderItemOut) => void
  busyItemId?: number | null
  /**
   * Número de la ronda que se está armando (`nextRoundNo` de `./lib`), para
   * el rótulo «Ronda N · sin enviar». Sin él se deriva de los `round_no` de
   * los ítems.
   */
  nextRoundNo?: number
}

/**
 * Una línea del pedido como en el tiquete, en UN renglón: «2×  Nombre»,
 * debajo y en letra chica lo que cocina tiene que leer (modificadores,
 * opciones del combo, nota), y a la derecha el `net` que manda el backend —
 * el cliente no lo multiplica ni lo suma (AGENTS.md § "una sola
 * matemática"). Las acciones (cantidad, anular, cortesía, descuento) ya no
 * viven en cada línea —eran ~120 px por plato—: tocar la línea abre su
 * panel (el patrón de Square). «Servido» sí queda a mano, porque es lo que
 * el mesero hace con la bandeja en la otra mano.
 */
function OrderLine({
  item,
  showStatus,
  busy,
  onOpen,
  onServed,
}: {
  item: OrderItemOut
  showStatus: boolean
  busy: boolean
  onOpen: (item: OrderItemOut) => void
  onServed?: (item: OrderItemOut) => void
}) {
  const isVoided = item.status === "voided"
  const isCourtesy = item.courtesy !== null && item.courtesy !== undefined
  const name = item.name ?? "—"
  const qty = item.qty ?? 1
  const details = [
    item.modifiers_text ?? null,
    ...(item.combo_selections ?? []).map((selection) => selection.product_name || selection.group_name || null),
  ].filter((text): text is string => Boolean(text))

  const content = (
    <>
      <span className="pt-px text-base font-extrabold tabular-nums">{qty}×</span>
      <span className="min-w-0 space-y-0.5">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className={cn("font-semibold leading-tight", isVoided && "text-muted-foreground line-through")}>{name}</span>
          {showStatus && item.status ? (
            <Badge variant={ITEM_STATUS_BADGE_VARIANT[item.status] ?? "outline"}>
              {ITEM_STATUS_LABEL[item.status] ?? item.status}
            </Badge>
          ) : null}
          {item.seat !== null && item.seat !== undefined ? <Badge variant="outline">Asiento {item.seat}</Badge> : null}
          {isCourtesy ? <Badge variant="secondary">Cortesía</Badge> : null}
          {item.is_delivery_fee ? <Badge variant="outline">No va a cocina</Badge> : null}
        </span>
        {details.length > 0 ? <span className="block text-xs leading-snug text-muted-foreground">{details.join(" · ")}</span> : null}
        {item.note ? <span className="block text-xs leading-snug text-muted-foreground">Nota: {item.note}</span> : null}
        {isVoided && item.void ? (
          <span className="block text-xs text-destructive">
            Anulado: {item.void.reason ? (VOID_REASON_LABEL[item.void.reason] ?? item.void.reason) : "—"}
            {item.void.after_bill ? " · después de presentar cuenta" : ""}
          </span>
        ) : null}
      </span>
      <span className="text-right text-sm tabular-nums">
        <span className={cn("block font-semibold", isVoided && "text-muted-foreground line-through")}>{formatCOP(item.net)}</span>
        {item.discount ? <span className="block text-xs text-muted-foreground">Descuento: {formatCOP(item.discount)}</span> : null}
      </span>
    </>
  )

  const gridClass = "grid grid-cols-[2.5rem_minmax(0,1fr)_auto] items-start gap-x-2"

  return (
    <li className="flex items-center gap-2 border-b last:border-b-0" data-slot="order-line">
      {isVoided ? (
        <div className={cn(gridClass, "min-h-14 flex-1 py-2")}>{content}</div>
      ) : (
        <button
          type="button"
          className={cn(
            gridClass,
            "min-h-14 flex-1 rounded-md py-2 text-left transition-colors hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring active:bg-muted",
          )}
          aria-haspopup="dialog"
          aria-label={`${qty}× ${name}: acciones`}
          onClick={() => onOpen(item)}
        >
          {content}
        </button>
      )}
      {!isVoided && item.status === "ready" && onServed ? (
        <Button
          type="button"
          className="h-14 shrink-0"
          disabled={busy}
          onClick={() => onServed(item)}
          aria-label={`Servido: ${item.name ?? "ítem"}`}
        >
          <CheckCheck className="size-4" aria-hidden="true" />
          Servido
        </Button>
      ) : null}
      {!isVoided && item.status !== "ready" ? (
        <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      ) : null}
    </li>
  )
}

/** Una ronda del pedido, con sus líneas agrupadas bajo el rótulo del curso. */
function RoundSection({
  title,
  items,
  unsent,
  busyItemId,
  onOpen,
  onServed,
}: {
  title: string
  items: OrderItemOut[]
  unsent: boolean
  busyItemId: number | null
  onOpen: (item: OrderItemOut) => void
  onServed?: (item: OrderItemOut) => void
}) {
  return (
    <section
      aria-label={title}
      className={cn("rounded-xl p-3", unsent ? "border-2 border-primary/50 bg-card" : "border bg-muted/40")}
    >
      <h3 className={cn("text-xs font-semibold tracking-wider uppercase", unsent ? "text-primary" : "text-muted-foreground")}>
        {title}
      </h3>
      {items.length === 0 ? (
        <p className="pt-2 text-sm text-muted-foreground">Tocá un plato de la carta para empezar la ronda.</p>
      ) : (
        groupByCourse(items).map((group) => (
          <div key={group.course || "sin-curso"}>
            <p className="pt-2 font-mono text-[11px] tracking-wider text-muted-foreground uppercase">
              {courseGroupLabel(group.course)}
            </p>
            <ul>
              {group.items.map((item) => (
                <OrderLine
                  key={item.id}
                  item={item}
                  showStatus={!unsent}
                  busy={busyItemId === item.id}
                  onOpen={onOpen}
                  onServed={onServed}
                />
              ))}
            </ul>
          </div>
        ))
      )}
    </section>
  )
}

const SHEET_ACTION_CLASS = "h-14 w-full justify-start gap-3 px-4 text-base"

/**
 * El panel de una línea: todo lo que se le puede hacer, con botones de
 * 56 px. Cortesía y descuento se ven de entrada sólo para quien suele darlos
 * (supervisor o administrador, o quien tiene un tope de descuento propio);
 * para el resto quedan detrás de «Más». No es un permiso —el backend pide el
 * PIN de un supervisor igual—: es que el mesero no tropiece con ellos.
 */
function LineActionsSheet({
  item,
  busy,
  courtesyEnabled,
  discountsEnabled,
  showMoneyActions,
  onClose,
  handlers,
}: {
  item: OrderItemOut | null
  busy: boolean
  courtesyEnabled: boolean
  discountsEnabled: boolean
  showMoneyActions: { courtesy: boolean; discount: boolean }
  onClose: () => void
  handlers: Omit<OrderItemsListProps, "items" | "busyItemId" | "nextRoundNo">
}) {
  const [showMore, setShowMore] = useState(false)
  const open = item !== null
  const name = item?.name ?? "ítem"
  const qty = item?.qty ?? 1
  const isPending = item?.status === "pending"
  const isCourtesy = item?.courtesy !== null && item?.courtesy !== undefined

  const courtesyAvailable = courtesyEnabled && !isCourtesy
  const courtesyVisible = courtesyAvailable && (showMoneyActions.courtesy || showMore)
  const discountVisible = discountsEnabled && (showMoneyActions.discount || showMore)
  const hasHidden =
    !showMore && ((courtesyAvailable && !showMoneyActions.courtesy) || (discountsEnabled && !showMoneyActions.discount))

  function run(action: (item: OrderItemOut) => void) {
    if (!item) return
    onClose()
    action(item)
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setShowMore(false)
          onClose()
        }
      }}
    >
      <SheetContent side="bottom" showCloseButton={false} className="mx-auto max-h-[calc(100dvh-2rem)] max-w-xl overflow-y-auto rounded-t-2xl">
        <SheetHeader>
          <SheetTitle className="text-lg font-semibold">
            {qty}× {name}
          </SheetTitle>
          <SheetDescription>{item?.status ? (ITEM_STATUS_LABEL[item.status] ?? item.status) : ""}</SheetDescription>
        </SheetHeader>
        {item ? (
          <div className="space-y-2 px-4 pb-4">
            {isPending ? (
              <div className="flex items-center gap-3">
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="size-14"
                  aria-label={`Restar una unidad de ${name}`}
                  disabled={busy || qty <= 1}
                  onClick={() => handlers.onDecrement(item)}
                >
                  <Minus className="size-5" aria-hidden="true" />
                </Button>
                <span className="w-10 text-center text-lg font-semibold tabular-nums">{qty}</span>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="size-14"
                  aria-label={`Sumar una unidad de ${name}`}
                  disabled={busy}
                  onClick={() => handlers.onIncrement(item)}
                >
                  <Plus className="size-5" aria-hidden="true" />
                </Button>
              </div>
            ) : null}

            {item.status === "ready" && handlers.onServed ? (
              <Button
                type="button"
                className={SHEET_ACTION_CLASS}
                disabled={busy}
                onClick={() => run((target) => handlers.onServed?.(target))}
              >
                <CheckCheck className="size-5" aria-hidden="true" />
                Servido
              </Button>
            ) : null}

            <Button
              type="button"
              variant="outline"
              className={cn(SHEET_ACTION_CLASS, "text-destructive")}
              disabled={busy}
              onClick={() => run(handlers.onVoid)}
              aria-label={`Anular ${name}`}
            >
              <XCircle className="size-5" aria-hidden="true" />
              Anular
            </Button>

            {courtesyVisible ? (
              <Button
                type="button"
                variant="outline"
                className={SHEET_ACTION_CLASS}
                disabled={busy}
                onClick={() => run(handlers.onCourtesy)}
                aria-label={`Cortesía de ${name}`}
              >
                <Gift className="size-5" aria-hidden="true" />
                Cortesía
              </Button>
            ) : null}

            {discountVisible ? (
              <Button
                type="button"
                variant="outline"
                className={SHEET_ACTION_CLASS}
                disabled={busy}
                onClick={() => run(handlers.onDiscount)}
                aria-label={`Descuento de ${name}`}
              >
                <Percent className="size-5" aria-hidden="true" />
                Descuento
              </Button>
            ) : null}

            {hasHidden ? (
              <Button type="button" variant="ghost" className={SHEET_ACTION_CLASS} onClick={() => setShowMore(true)}>
                <MoreHorizontal className="size-5" aria-hidden="true" />
                Más
              </Button>
            ) : null}

            <Button
              type="button"
              variant="secondary"
              className={cn(SHEET_ACTION_CLASS, "justify-center")}
              onClick={() => {
                setShowMore(false)
                onClose()
              }}
            >
              Cerrar
            </Button>
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  )
}

/**
 * El pedido como lo lee el mesero (Momento 1 de `docs/diseno/propuesta.html`):
 * lo ya enviado, ronda por ronda, y al final la ronda que se está armando
 * («Ronda N · sin enviar»), resaltada porque es la única que todavía cambia.
 * Dentro de cada ronda, las líneas van bajo el rótulo de su curso.
 * Cantidad editable sólo en `pending` (SPEC-NEGOCIO §3.3); anular, cortesía
 * y descuento por ítem detrás de sus flags — el botón desaparece sin la
 * función, el backend sigue siendo la barrera.
 */
export function OrderItemsList({
  items,
  onIncrement,
  onDecrement,
  onVoid,
  onCourtesy,
  onDiscount,
  onServed,
  busyItemId = null,
  nextRoundNo,
}: OrderItemsListProps): React.JSX.Element {
  const { hasFeature, me } = useSession()
  const [openItemId, setOpenItemId] = useState<number | null>(null)

  const role = me?.employee?.role
  const authorizes = role === "supervisor" || role === "admin"
  const showMoneyActions = {
    courtesy: authorizes,
    discount: authorizes || (me?.employee?.discount_limit_pct ?? 0) > 0,
  }

  if (items.length === 0) {
    return <p className="text-sm text-muted-foreground">Todavía no hay ítems en esta comanda.</p>
  }

  // El panel lee la línea de la comanda VIGENTE: tras un «+» la cantidad
  // que muestra es la que devolvió el servidor, no la de cuando se abrió.
  const openItem = openItemId === null ? null : (items.find((item) => item.id === openItemId && item.status !== "voided") ?? null)

  const unsent = items.filter((item) => item.status === "pending")
  // Lo que ya no es `pending`, por ronda y en orden. Un ítem sin `round_no`
  // (anulado antes de enviarse) va aparte, al final de lo enviado.
  const byRound = new Map<number | null, OrderItemOut[]>()
  for (const item of items) {
    if (item.status === "pending") continue
    const key = item.round_no ?? null
    const bucket = byRound.get(key)
    if (bucket) bucket.push(item)
    else byRound.set(key, [item])
  }
  const rounds = [...byRound.entries()].sort(([a], [b]) => (a ?? Number.MAX_SAFE_INTEGER) - (b ?? Number.MAX_SAFE_INTEGER))
  const currentRound = nextRoundNo ?? deriveNextRoundNo(null, items)
  const openLine = (item: OrderItemOut) => setOpenItemId(item.id)

  return (
    <div className="space-y-3">
      {rounds.map(([roundNo, list]) => (
        <RoundSection
          key={roundNo ?? "sin-ronda"}
          title={roundNo === null ? "Fuera de ronda" : `Ronda ${roundNo} · enviada`}
          items={list}
          unsent={false}
          busyItemId={busyItemId}
          onOpen={openLine}
          onServed={onServed}
        />
      ))}
      <RoundSection
        title={`Ronda ${currentRound} · sin enviar`}
        items={unsent}
        unsent
        busyItemId={busyItemId}
        onOpen={openLine}
        onServed={onServed}
      />
      <LineActionsSheet
        item={openItem}
        busy={openItem !== null && busyItemId === openItem.id}
        courtesyEnabled={hasFeature("pos.courtesies")}
        discountsEnabled={hasFeature("pos.discounts")}
        showMoneyActions={showMoneyActions}
        onClose={() => setOpenItemId(null)}
        handlers={{ onIncrement, onDecrement, onVoid, onCourtesy, onDiscount, onServed }}
      />
    </div>
  )
}

export default OrderItemsList
