import { BellRing, CheckCheck, ChefHat, Flame, Gift, Minus, MoreHorizontal, Percent, Plus, Send, XCircle } from "lucide-react"
import { useState } from "react"

import { useSession } from "@/app/session"
import type { OrderItemOut } from "@/api/orders"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { formatCOP } from "@/lib/money"
import { cn } from "@/lib/utils"

import { courseLabel, ITEM_STATUS_LABEL, splitNote, VOID_REASON_LABEL } from "./lib"
import { useQuickNotes } from "./quickNotes"

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
   * Número de la ronda que se está armando. Se conserva por compatibilidad
   * con quien lo manda; el handoff agrupa en «Sin enviar» y «Ya en cocina».
   */
  nextRoundNo?: number
  /** La línea sin enviar elegida: muestra sus notas rápidas (handoff `PosComanda`). */
  selectedItemId?: number | null
  /** Tocar una línea sin enviar la elige. Sin esto, tocarla abre su panel. */
  onSelect?: (item: OrderItemOut) => void
  /** Pone o saca una nota rápida de la línea elegida («Sin cebolla»). */
  onToggleNote?: (item: OrderItemOut, note: string) => void
  /** «Otra nota…»: la nota escrita a mano. */
  onOtherNote?: (item: OrderItemOut) => void
}

/** «A2 · Fuerte»: asiento y curso de la línea, como en el tiquete. */
function lineTag(item: OrderItemOut): string | null {
  const parts: string[] = []
  if (item.seat !== null && item.seat !== undefined) parts.push(`A${item.seat}`)
  if (item.course) parts.push(courseLabel(item.course))
  return parts.length > 0 ? parts.join(" · ") : null
}

/** El chip de estado de lo que ya salió: Listo (success) o En preparación. */
function StatusChip({ item }: { item: OrderItemOut }): React.JSX.Element | null {
  if (item.status === "ready") {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-success px-[9px] py-[3px] text-[13px] font-bold text-success-foreground">
        <BellRing className="size-3.5" aria-hidden="true" />
        Listo
      </span>
    )
  }
  if (item.status === "sent") {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-secondary px-[9px] py-[3px] text-[13px] font-bold text-secondary-foreground">
        <Flame className="size-3.5" aria-hidden="true" />
        En preparación
      </span>
    )
  }
  if (item.status === "served") {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-full border px-[9px] py-[2px] text-[13px] font-semibold">
        <CheckCheck className="size-3.5" aria-hidden="true" />
        {ITEM_STATUS_LABEL.served}
      </span>
    )
  }
  return null
}

/**
 * Una línea del pedido como en el tiquete, en UN renglón (handoff
 * `PosComanda`): «1×  Nombre   A2 · Fuerte   $ 34.000». Debajo, lo que
 * cocina tiene que leer (modificadores, opciones del combo) y la nota en el
 * amarillo del tiquete (`.tiquete-modificadores`). A la derecha, el `net` que manda el
 * backend — el cliente no lo multiplica ni lo suma (AGENTS.md § "una sola
 * matemática").
 *
 * Lo sin enviar se **elige** tocándolo (muestra sus notas rápidas de 56 px);
 * sus acciones —cantidad, anular, cortesía, descuento— están en el panel que
 * abre «⋯». Lo ya enviado abre el panel al tocarlo, y «Servido» queda a mano
 * cuando está listo: es lo que el mesero hace con la bandeja en la otra mano.
 */
function OrderLine({
  item,
  sent,
  selected,
  busy,
  onOpen,
  onSelect,
  onServed,
  onToggleNote,
  onOtherNote,
}: {
  item: OrderItemOut
  sent: boolean
  selected: boolean
  busy: boolean
  onOpen: (item: OrderItemOut) => void
  onSelect?: (item: OrderItemOut) => void
  onServed?: (item: OrderItemOut) => void
  onToggleNote?: (item: OrderItemOut, note: string) => void
  onOtherNote?: (item: OrderItemOut) => void
}) {
  const notesFor = useQuickNotes()
  const isVoided = item.status === "voided"
  const isCourtesy = item.courtesy !== null && item.courtesy !== undefined
  const name = item.name ?? "—"
  const qty = item.qty ?? 1
  const tag = lineTag(item)
  const details = [
    item.modifiers_text ?? null,
    ...(item.combo_selections ?? []).map((selection) => selection.product_name || selection.group_name || null),
  ].filter((text): text is string => Boolean(text))
  const notes = splitNote(item.note)

  const row = (
    <>
      <b className={cn("min-w-[26px] shrink-0 tabular-nums", sent ? "text-[17px]" : "text-[18px]")}>{qty}×</b>
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            "block leading-tight",
            sent ? "text-[16px]" : "text-[17px] font-semibold",
            isVoided && "text-muted-foreground line-through",
          )}
        >
          {name}
        </span>
        {details.length > 0 ? (
          <span className="block text-[13px] leading-snug text-muted-foreground">{details.join(" · ")}</span>
        ) : null}
        {isVoided && item.void ? (
          <span className="block text-[13px] text-destructive">
            Anulado: {item.void.reason ? (VOID_REASON_LABEL[item.void.reason] ?? item.void.reason) : "—"}
            {item.void.after_bill ? " · después de presentar cuenta" : ""}
          </span>
        ) : null}
      </span>
      {isCourtesy ? <Badge variant="secondary">Cortesía</Badge> : null}
      {item.is_delivery_fee ? <Badge variant="outline">No va a cocina</Badge> : null}
      {tag && !sent ? (
        <span className="shrink-0 rounded-md bg-secondary px-2 py-0.5 text-[13px] text-secondary-foreground">{tag}</span>
      ) : null}
      {sent ? <StatusChip item={item} /> : null}
      <span className={cn("min-w-[78px] shrink-0 text-right tabular-nums", sent ? "text-[15px]" : "text-[16px]")}>
        <span className={cn("block", isVoided && "text-muted-foreground line-through")}>{formatCOP(item.net)}</span>
        {item.discount ? (
          <span className="block text-[12px] text-muted-foreground">Descuento: {formatCOP(item.discount)}</span>
        ) : null}
      </span>
    </>
  )

  const rowClass = cn(
    "flex min-h-[44px] flex-1 items-center gap-2.5 rounded-[10px] text-left",
    sent && "text-muted-foreground [&_b]:text-foreground",
  )
  const selectable = !sent && !isVoided && onSelect !== undefined

  return (
    <li
      className={cn("flex flex-col gap-1.5 rounded-[10px] px-2 py-1.5", selected && "bg-accent")}
      data-slot="order-line"
    >
      <div className="flex items-center gap-1.5">
        {isVoided ? (
          <div className={rowClass}>{row}</div>
        ) : selectable ? (
          <button
            type="button"
            className={cn(rowClass, "focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring")}
            aria-pressed={selected}
            aria-label={`Elegir ${qty}× ${name}${notes.length > 0 ? `, ${notes.join(", ")}` : ""}`}
            onClick={() => onSelect?.(item)}
          >
            {row}
          </button>
        ) : (
          <button
            type="button"
            className={cn(
              rowClass,
              "transition-colors hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring active:bg-muted",
            )}
            aria-haspopup="dialog"
            aria-label={`${qty}× ${name}: acciones`}
            onClick={() => onOpen(item)}
          >
            {row}
          </button>
        )}
        {selectable ? (
          <Button
            type="button"
            variant="ghost"
            className="size-11 shrink-0 text-muted-foreground [&_svg]:size-5"
            aria-haspopup="dialog"
            aria-label={`${qty}× ${name}: acciones`}
            onClick={() => onOpen(item)}
          >
            <MoreHorizontal aria-hidden="true" />
          </Button>
        ) : null}
        {!isVoided && item.status === "ready" && onServed ? (
          <Button
            type="button"
            variant="outline"
            className="h-11 shrink-0 border-success px-3 text-success"
            disabled={busy}
            onClick={() => onServed(item)}
            aria-label={`Servido: ${item.name ?? "ítem"}`}
          >
            <CheckCheck className="size-4" aria-hidden="true" />
            Servido
          </Button>
        ) : null}
      </div>
      {notes.length > 0 ? (
        <span className="tiquete-modificadores ml-9 self-start">
          {notes.join(" · ")}
        </span>
      ) : null}
      {selected && !sent && onToggleNote ? (
        <div className="ml-9 flex flex-wrap gap-1.5" role="group" aria-label={`Notas rápidas de ${name}`}>
          {notesFor(item.course).map((note) => {
            const on = notes.includes(note)
            return (
              <button
                key={note}
                type="button"
                aria-pressed={on}
                disabled={busy}
                className={cn(
                  "h-[56px] rounded-lg border px-3.5 text-[15px] font-semibold transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-50",
                  // El amarillo del tiquete de cocina (`.tiquete-modificadores`): lo
                  // elegido se lee igual que como lo va a leer la cocina.
                  on ? "border-[#C99A00] bg-[#FFE27A] text-[#1A1A17]" : "border-border bg-background hover:bg-muted",
                )}
                onClick={() => onToggleNote(item, note)}
              >
                {note}
              </button>
            )
          })}
          {onOtherNote ? (
            <button
              type="button"
              disabled={busy}
              className="h-[56px] rounded-lg border border-border bg-background px-3.5 text-[15px] font-semibold transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-50"
              onClick={() => onOtherNote(item)}
            >
              Otra nota…
            </button>
          ) : null}
        </div>
      ) : null}
    </li>
  )
}

/** «Sin enviar · N» (rojo) y «Ya en cocina»: los dos bloques del pedido. */
function LinesSection({
  title,
  tone,
  children,
}: {
  title: string
  tone: "unsent" | "sent"
  children: React.ReactNode
}) {
  const Icon = tone === "unsent" ? Send : ChefHat
  return (
    <section aria-label={title} className="flex flex-col">
      <h3
        className={cn(
          "flex items-center gap-1.5 px-1 pt-1.5 pb-1 text-[13px] font-bold tracking-[0.06em] uppercase",
          tone === "unsent" ? "text-destructive" : "text-muted-foreground",
        )}
      >
        <Icon className="size-3.5" aria-hidden="true" />
        {title}
      </h3>
      {children}
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
  handlers: Pick<OrderItemsListProps, "onIncrement" | "onDecrement" | "onVoid" | "onCourtesy" | "onDiscount" | "onServed">
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
 * El pedido como lo lee el mesero (handoff `PosComanda`): arriba lo que
 * todavía no salió («Sin enviar · N», en rojo: es lo único que cambia y lo
 * que se olvida), y abajo lo que ya está en cocina, ronda por ronda, con su
 * chip Listo / En preparación. Cantidad editable sólo en `pending`
 * (SPEC-NEGOCIO §3.3); anular, cortesía y descuento por ítem detrás de sus
 * flags — el botón desaparece sin la función, el backend sigue siendo la
 * barrera. `N` es la suma de unidades (no de plata): la que dice el botón
 * «Enviar a cocina · N».
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
  selectedItemId = null,
  onSelect,
  onToggleNote,
  onOtherNote,
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
    return <p className="px-1 py-2 text-[15px] text-muted-foreground">Todavía no hay ítems en esta comanda.</p>
  }

  // El panel lee la línea de la comanda VIGENTE: tras un «+» la cantidad
  // que muestra es la que devolvió el servidor, no la de cuando se abrió.
  const openItem = openItemId === null ? null : (items.find((item) => item.id === openItemId && item.status !== "voided") ?? null)

  const unsent = items.filter((item) => item.status === "pending")
  const unsentUnits = unsent.filter((item) => item.is_delivery_fee !== true).reduce((n, item) => n + (item.qty ?? 1), 0)
  // Lo que ya no es `pending`, por ronda y en orden. Un ítem sin `round_no`
  // (anulado antes de enviarse) va al final de lo enviado.
  const sent = items
    .filter((item) => item.status !== "pending")
    .sort((a, b) => (a.round_no ?? Number.MAX_SAFE_INTEGER) - (b.round_no ?? Number.MAX_SAFE_INTEGER))
  const openLine = (item: OrderItemOut) => setOpenItemId(item.id)
  const lineProps = { onOpen: openLine, onSelect, onServed, onToggleNote, onOtherNote }

  return (
    <div className="flex flex-col gap-1">
      <LinesSection title={unsentUnits > 0 ? `Sin enviar · ${unsentUnits}` : "Nada sin enviar"} tone="unsent">
        {unsent.length === 0 ? (
          <p className="px-1 pb-1 text-[14px] text-muted-foreground">Tocá un plato de la carta para empezar la ronda.</p>
        ) : (
          <ul>
            {unsent.map((item) => (
              <OrderLine
                key={item.id}
                item={item}
                sent={false}
                selected={selectedItemId === item.id}
                busy={busyItemId === item.id}
                {...lineProps}
              />
            ))}
          </ul>
        )}
      </LinesSection>
      {sent.length > 0 ? (
        <LinesSection title="Ya en cocina" tone="sent">
          <ul>
            {sent.map((item) => (
              <OrderLine key={item.id} item={item} sent selected={false} busy={busyItemId === item.id} {...lineProps} />
            ))}
          </ul>
        </LinesSection>
      ) : null}
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
