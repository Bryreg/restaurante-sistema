import { CheckCheck, Gift, Minus, Percent, Plus, XCircle } from "lucide-react"

import { useSession } from "@/app/session"
import type { OrderItemOut } from "@/api/orders"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
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

interface ActionHandlers {
  onIncrement: (item: OrderItemOut) => void
  onDecrement: (item: OrderItemOut) => void
  onVoid: (item: OrderItemOut) => void
  onCourtesy: (item: OrderItemOut) => void
  onDiscount: (item: OrderItemOut) => void
  onServed?: (item: OrderItemOut) => void
  busyItemId: number | null
  courtesyEnabled: boolean
  discountsEnabled: boolean
}

/**
 * Una línea del pedido como en el tiquete: «2×  Nombre», debajo y en letra
 * chica lo que cocina tiene que leer (modificadores, opciones del combo,
 * nota), y a la derecha el `net` que manda el backend — el cliente no lo
 * multiplica ni lo suma (AGENTS.md § "una sola matemática").
 */
function OrderLine({ item, showStatus, handlers }: { item: OrderItemOut; showStatus: boolean; handlers: ActionHandlers }) {
  const isPending = item.status === "pending"
  const isVoided = item.status === "voided"
  const isCourtesy = item.courtesy !== null && item.courtesy !== undefined
  const busy = handlers.busyItemId === item.id
  const name = item.name ?? "—"
  const qty = item.qty ?? 1
  const details = [
    item.modifiers_text ?? null,
    ...(item.combo_selections ?? []).map((selection) => selection.product_name || selection.group_name || null),
  ].filter((text): text is string => Boolean(text))

  return (
    <li className="border-b py-2 last:border-b-0" data-slot="order-line">
      <div className="grid grid-cols-[2.5rem_minmax(0,1fr)_auto] items-start gap-x-2">
        <span className="pt-px text-base font-extrabold tabular-nums">{qty}×</span>
        <div className="min-w-0 space-y-0.5">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className={cn("font-semibold leading-tight", isVoided && "text-muted-foreground line-through")}>{name}</span>
            {showStatus && item.status ? (
              <Badge variant={ITEM_STATUS_BADGE_VARIANT[item.status] ?? "outline"}>
                {ITEM_STATUS_LABEL[item.status] ?? item.status}
              </Badge>
            ) : null}
            {item.seat !== null && item.seat !== undefined ? <Badge variant="outline">Asiento {item.seat}</Badge> : null}
            {isCourtesy ? <Badge variant="secondary">Cortesía</Badge> : null}
          </div>
          {details.length > 0 ? <p className="text-xs leading-snug text-muted-foreground">{details.join(" · ")}</p> : null}
          {item.note ? <p className="text-xs leading-snug text-muted-foreground">Nota: {item.note}</p> : null}
          {isVoided && item.void ? (
            <p className="text-xs text-destructive">
              Anulado: {item.void.reason ? (VOID_REASON_LABEL[item.void.reason] ?? item.void.reason) : "—"}
              {item.void.after_bill ? " · después de presentar cuenta" : ""}
            </p>
          ) : null}
        </div>
        <div className="text-right text-sm tabular-nums">
          <p className={cn("font-semibold", isVoided && "text-muted-foreground line-through")}>{formatCOP(item.net)}</p>
          {item.discount ? <p className="text-xs text-muted-foreground">Descuento: {formatCOP(item.discount)}</p> : null}
        </div>
      </div>

      {isVoided ? null : (
        <div className="mt-1 flex flex-wrap items-center gap-1 pl-[2.75rem]">
          {item.status === "ready" && handlers.onServed ? (
            <Button
              type="button"
              className="h-11"
              disabled={busy}
              onClick={() => handlers.onServed?.(item)}
              aria-label={`Servido: ${item.name ?? "ítem"}`}
            >
              <CheckCheck className="size-4" aria-hidden="true" />
              Servido
            </Button>
          ) : null}

          {isPending ? (
            <div className="flex items-center gap-1">
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="size-11"
                aria-label={`Restar una unidad de ${item.name ?? "ítem"}`}
                disabled={busy || qty <= 1}
                onClick={() => handlers.onDecrement(item)}
              >
                <Minus className="size-4" aria-hidden="true" />
              </Button>
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="size-11"
                aria-label={`Sumar una unidad de ${item.name ?? "ítem"}`}
                disabled={busy}
                onClick={() => handlers.onIncrement(item)}
              >
                <Plus className="size-4" aria-hidden="true" />
              </Button>
            </div>
          ) : null}

          <Button
            type="button"
            variant="ghost"
            className="h-11"
            disabled={busy}
            onClick={() => handlers.onVoid(item)}
            aria-label={`Anular ${item.name ?? "ítem"}`}
          >
            <XCircle className="size-4" aria-hidden="true" />
            Anular
          </Button>

          {handlers.courtesyEnabled && !isCourtesy ? (
            <Button
              type="button"
              variant="ghost"
              className="h-11"
              disabled={busy}
              onClick={() => handlers.onCourtesy(item)}
              aria-label={`Cortesía de ${item.name ?? "ítem"}`}
            >
              <Gift className="size-4" aria-hidden="true" />
              Cortesía
            </Button>
          ) : null}

          {handlers.discountsEnabled ? (
            <Button
              type="button"
              variant="ghost"
              className="h-11"
              disabled={busy}
              onClick={() => handlers.onDiscount(item)}
              aria-label={`Descuento de ${item.name ?? "ítem"}`}
            >
              <Percent className="size-4" aria-hidden="true" />
              Descuento
            </Button>
          ) : null}
        </div>
      )}
    </li>
  )
}

/** Una ronda del pedido, con sus líneas agrupadas bajo el rótulo del curso. */
function RoundSection({
  title,
  items,
  unsent,
  handlers,
}: {
  title: string
  items: OrderItemOut[]
  unsent: boolean
  handlers: ActionHandlers
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
                <OrderLine key={item.id} item={item} showStatus={!unsent} handlers={handlers} />
              ))}
            </ul>
          </div>
        ))
      )}
    </section>
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
  const { hasFeature } = useSession()
  const handlers: ActionHandlers = {
    onIncrement,
    onDecrement,
    onVoid,
    onCourtesy,
    onDiscount,
    onServed,
    busyItemId,
    courtesyEnabled: hasFeature("pos.courtesies"),
    discountsEnabled: hasFeature("pos.discounts"),
  }

  if (items.length === 0) {
    return <p className="text-sm text-muted-foreground">Todavía no hay ítems en esta comanda.</p>
  }

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

  return (
    <div className="space-y-3">
      {rounds.map(([roundNo, list]) => (
        <RoundSection
          key={roundNo ?? "sin-ronda"}
          title={roundNo === null ? "Fuera de ronda" : `Ronda ${roundNo} · enviada`}
          items={list}
          unsent={false}
          handlers={handlers}
        />
      ))}
      <RoundSection title={`Ronda ${currentRound} · sin enviar`} items={unsent} unsent handlers={handlers} />
    </div>
  )
}

export default OrderItemsList
