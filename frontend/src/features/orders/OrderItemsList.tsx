import { CheckCheck, Gift, Minus, MoreHorizontal, Percent, Plus, XCircle } from "lucide-react"
import { useState } from "react"

import { useSession } from "@/app/session"
import type { OrderItemOut } from "@/api/orders"
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
   * con quien lo manda; el handoff agrupa en «Sin enviar» y «En cocina».
   */
  nextRoundNo?: number
  /** La línea sin enviar elegida: muestra sus notas rápidas (handoff `PosComanda`). */
  selectedItemId?: number | null
  /** Tocar una línea sin enviar la elige. Sin esto, sus acciones quedan en «⋯». */
  onSelect?: (item: OrderItemOut) => void
  /** Pone o saca una nota rápida de la línea elegida («Sin cebolla»). */
  onToggleNote?: (item: OrderItemOut, note: string) => void
  /** «Otra nota…»: la nota escrita a mano. */
  onOtherNote?: (item: OrderItemOut) => void
  /** Una acción al lado del rótulo «En cocina» («Marcar todo servido»). */
  sentAction?: React.ReactNode
}

/** «Asiento 2 · Fuerte»: asiento y tiempo de la línea (handoff «Burbujas» 9c). */
function lineTag(item: OrderItemOut): string | null {
  const parts: string[] = []
  if (item.seat !== null && item.seat !== undefined) parts.push(`Asiento ${item.seat}`)
  if (item.course) parts.push(courseLabel(item.course))
  return parts.length > 0 ? parts.join(" · ") : null
}

/** La pastilla de 24 px de debajo de una línea sin enviar. */
const LINE_PILL_CLASS = "inline-flex min-h-6 items-center rounded-xl px-[9px] py-0.5 text-xs leading-tight"

/**
 * El estado de lo que ya salió, en pastilla de 26 px (12/600): «Listo» en
 * `success-soft`; lo demás (en preparación, entregado, anulado) en gris.
 */
function StatusPill({ item }: { item: OrderItemOut }): React.JSX.Element | null {
  const label = item.status === "sent" ? "En preparación" : item.status ? ITEM_STATUS_LABEL[item.status] : null
  if (!label) return null
  return (
    <span
      className={cn(
        "inline-flex h-[26px] shrink-0 items-center rounded-[13px] px-2.5 text-xs font-semibold whitespace-nowrap",
        item.status === "ready" ? "bg-success-soft text-success" : "bg-muted text-muted-foreground",
      )}
    >
      {label}
    </span>
  )
}

/** El botón «⋯» de una línea: abre su panel de acciones. */
function LineMenuButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-haspopup="dialog"
      aria-label={label}
      onClick={onClick}
      className="-my-2.5 -mr-2 grid size-11 shrink-0 place-items-center rounded-[14px] text-muted-foreground transition-colors hover:bg-card focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      <MoreHorizontal className="size-5" aria-hidden="true" />
    </button>
  )
}

/**
 * Una línea sin enviar (handoff «Burbujas» 9c): un pozo con la cantidad, el
 * nombre y el `net` que manda el backend —el cliente no lo multiplica ni lo
 * suma (AGENTS.md § "una sola matemática")—. Debajo, a 32 px, la pastilla
 * blanca «Asiento N · Tiempo» y, si los hay, los modificadores y la nota en
 * pastillas `warning-soft` (reemplazan la cinta amarilla anterior).
 *
 * Tocarla la **elige** (muestra sus notas rápidas de 56 px); sus acciones
 * —cantidad, anular, cortesía, descuento— están en el panel que abre «⋯».
 */
function PendingLine({
  item,
  selected,
  busy,
  onOpen,
  onSelect,
  onToggleNote,
  onOtherNote,
}: {
  item: OrderItemOut
  selected: boolean
  busy: boolean
  onOpen: (item: OrderItemOut) => void
  onSelect?: (item: OrderItemOut) => void
  onToggleNote?: (item: OrderItemOut, note: string) => void
  onOtherNote?: (item: OrderItemOut) => void
}) {
  const notesFor = useQuickNotes()
  const isCourtesy = item.courtesy !== null && item.courtesy !== undefined
  const name = item.name ?? "—"
  const qty = item.qty ?? 1
  const tag = lineTag(item)
  const details = [
    item.modifiers_text ?? null,
    ...(item.combo_selections ?? []).map((selection) => selection.product_name || selection.group_name || null),
  ].filter((text): text is string => Boolean(text))
  const notes = splitNote(item.note)
  const hasPills = tag !== null || details.length > 0 || notes.length > 0 || isCourtesy || item.is_delivery_fee === true

  const row = (
    <>
      <b className="w-[22px] shrink-0 font-semibold tabular-nums">{qty}</b>
      <span className="min-w-0 flex-1 leading-snug">{name}</span>
      <span className="shrink-0 text-right tabular-nums">
        <span className="block">{formatCOP(item.net)}</span>
        {item.discount ? (
          <span className="block text-xs text-muted-foreground">Descuento: {formatCOP(item.discount)}</span>
        ) : null}
      </span>
    </>
  )

  return (
    <li
      className={cn(
        "flex flex-col gap-1 rounded-2xl bg-muted px-3.5 py-3",
        selected && "shadow-[inset_0_0_0_2px_var(--foreground)]",
      )}
      data-slot="order-line"
    >
      <div className="flex items-baseline gap-2.5 text-[15px]">
        {onSelect ? (
          <button
            type="button"
            className="flex min-w-0 flex-1 items-baseline gap-2.5 rounded-lg text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            aria-pressed={selected}
            aria-label={`Elegir ${qty}× ${name}${notes.length > 0 ? `, ${notes.join(", ")}` : ""}`}
            onClick={() => onSelect(item)}
          >
            {row}
          </button>
        ) : (
          <div className="flex min-w-0 flex-1 items-baseline gap-2.5">{row}</div>
        )}
        <LineMenuButton label={`${qty}× ${name}: acciones`} onClick={() => onOpen(item)} />
      </div>
      {hasPills ? (
        <span className="ml-8 flex flex-wrap gap-1.5">
          {tag ? <span className={cn(LINE_PILL_CLASS, "bg-card text-muted-foreground")}>{tag}</span> : null}
          {details.length > 0 ? (
            <span className={cn(LINE_PILL_CLASS, "bg-warning-soft font-semibold text-warning")}>{details.join(" · ")}</span>
          ) : null}
          {notes.length > 0 ? (
            <span data-slot="line-note" className={cn(LINE_PILL_CLASS, "bg-warning-soft font-semibold text-warning")}>
              {notes.join(" · ")}
            </span>
          ) : null}
          {isCourtesy ? <span className={cn(LINE_PILL_CLASS, "bg-card font-semibold text-success")}>Cortesía</span> : null}
          {item.is_delivery_fee ? (
            <span className={cn(LINE_PILL_CLASS, "bg-card text-muted-foreground")}>No va a cocina</span>
          ) : null}
        </span>
      ) : null}
      {selected && onToggleNote ? (
        <div className="mt-1 ml-8 flex flex-wrap gap-1.5" role="group" aria-label={`Notas rápidas de ${name}`}>
          {notesFor(item.course).map((note) => {
            const on = notes.includes(note)
            return (
              <button
                key={note}
                type="button"
                aria-pressed={on}
                disabled={busy}
                className={cn(
                  "h-[56px] rounded-2xl px-3.5 text-[15px] font-semibold transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-50",
                  // Lo elegido se lee igual que la pastilla de la nota (y que
                  // como la va a leer la cocina).
                  on ? "bg-warning-soft text-warning shadow-[inset_0_0_0_1.5px_var(--warning)]" : "bg-card text-foreground hover:bg-fill-strong",
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
              className="h-[56px] rounded-2xl bg-card px-3.5 text-[15px] font-semibold transition-colors hover:bg-fill-strong focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-50"
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

/**
 * Una línea que ya salió (handoff «Burbujas» 9c): anillo de 1 px, 48 px,
 * cantidad, nombre en gris y el estado en pastilla. Tocarla abre su panel
 * de acciones; «Servido» queda a mano cuando está lista: es lo que el mesero
 * hace con la bandeja en la otra mano.
 */
function SentLine({
  item,
  busy,
  onOpen,
  onServed,
}: {
  item: OrderItemOut
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
    ...splitNote(item.note),
  ].filter((text): text is string => Boolean(text))

  const row = (
    <>
      <b className="w-[22px] shrink-0 font-semibold tabular-nums">{qty}</b>
      <span className="min-w-0 flex-1 text-muted-foreground">
        <span className={cn("block leading-snug", isVoided && "line-through")}>{name}</span>
        {details.length > 0 ? <span className="block text-xs leading-snug">{details.join(" · ")}</span> : null}
        {isVoided && item.void ? (
          <span className="block text-xs text-destructive">
            Anulado: {item.void.reason ? (VOID_REASON_LABEL[item.void.reason] ?? item.void.reason) : "—"}
            {item.void.after_bill ? " · después de presentar cuenta" : ""}
          </span>
        ) : null}
      </span>
      {isCourtesy ? (
        <span className="inline-flex h-[26px] shrink-0 items-center rounded-[13px] bg-muted px-2.5 text-xs font-semibold text-success">
          Cortesía
        </span>
      ) : null}
      {item.discount ? (
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">Desc. {formatCOP(item.discount)}</span>
      ) : null}
      {item.is_delivery_fee ? (
        <span className="inline-flex h-[26px] shrink-0 items-center rounded-[13px] bg-muted px-2.5 text-xs text-muted-foreground">
          No va a cocina
        </span>
      ) : null}
      <StatusPill item={item} />
    </>
  )
  const rowClass = "flex min-h-[48px] min-w-0 flex-1 items-center gap-2.5 py-1.5 text-left text-[15px]"

  return (
    <li
      className="flex items-center gap-2 rounded-2xl px-3.5 shadow-[inset_0_0_0_1px_var(--border)]"
      data-slot="order-line"
    >
      {isVoided ? (
        // Anulado: no le queda ninguna acción, ni siquiera abrir su panel.
        <div className={rowClass}>{row}</div>
      ) : (
        <button
          type="button"
          className={cn(rowClass, "rounded-xl focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring")}
          aria-haspopup="dialog"
          aria-label={`${qty}× ${name}: acciones`}
          onClick={() => onOpen(item)}
        >
          {row}
        </button>
      )}
      {!isVoided && item.status === "ready" && onServed ? (
        <button
          type="button"
          className="-mr-1.5 inline-flex h-11 shrink-0 items-center gap-1.5 rounded-[14px] bg-success-soft px-3 text-[13px] font-semibold text-success transition-opacity focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-50"
          disabled={busy}
          onClick={() => onServed(item)}
          aria-label={`Servido: ${item.name ?? "ítem"}`}
        >
          <CheckCheck className="size-4" aria-hidden="true" />
          Servido
        </button>
      ) : null}
    </li>
  )
}

/**
 * «▲ Sin enviar · N» (12/600 en `warning`, con el triángulo de 7 px) y «En
 * cocina» (12/600 gris): los dos bloques del pedido.
 */
function LinesSection({
  title,
  tone,
  action,
  children,
}: {
  title: string
  tone: "unsent" | "sent"
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section aria-label={title} className="flex flex-col gap-1.5">
      <div className={cn("flex min-h-6 items-center gap-2 px-1", tone === "unsent" ? "pt-1" : "pt-2.5")}>
        <h3
          className={cn(
            "flex flex-1 items-center gap-1.5 text-xs font-semibold",
            tone === "unsent" ? "text-warning" : "text-muted-foreground",
          )}
        >
          {tone === "unsent" ? (
            <span aria-hidden="true" className="size-[7px] shrink-0 bg-warning [clip-path:polygon(50%_0,100%_100%,0_100%)]" />
          ) : null}
          {title}
        </h3>
        {action}
      </div>
      {children}
    </section>
  )
}

const SHEET_ACTION_CLASS = "h-14 w-full justify-start gap-3 rounded-2xl px-4 text-base"

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
 * El pedido como lo lee el mesero (handoff «Burbujas» 9c): arriba lo que
 * todavía no salió («▲ Sin enviar · N», en `warning`: es lo único que cambia
 * y lo que se olvida), y abajo lo que ya está en cocina, ronda por ronda,
 * con su pastilla Listo / En preparación. Cantidad editable sólo en `pending`
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
  sentAction,
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

  return (
    <div className="flex flex-col gap-1.5">
      <LinesSection title={unsentUnits > 0 ? `Sin enviar · ${unsentUnits}` : "Nada sin enviar"} tone="unsent">
        {unsent.length === 0 ? (
          <p className="px-1 pb-1 text-sm text-muted-foreground">Tocá un plato de la carta para empezar la ronda.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {unsent.map((item) => (
              <PendingLine
                key={item.id}
                item={item}
                selected={selectedItemId === item.id}
                busy={busyItemId === item.id}
                onOpen={openLine}
                onSelect={onSelect}
                onToggleNote={onToggleNote}
                onOtherNote={onOtherNote}
              />
            ))}
          </ul>
        )}
      </LinesSection>
      {sent.length > 0 ? (
        <LinesSection title="En cocina" tone="sent" action={sentAction}>
          <ul className="flex flex-col gap-1.5">
            {sent.map((item) => (
              <SentLine key={item.id} item={item} busy={busyItemId === item.id} onOpen={openLine} onServed={onServed} />
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
