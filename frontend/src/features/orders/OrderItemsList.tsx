import { Gift, Minus, Percent, Plus, XCircle } from "lucide-react"

import { useSession } from "@/app/session"
import type { OrderItemOut } from "@/api/orders"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { formatCOP } from "@/lib/money"

import { COURSE_BADGE_VARIANT, ITEM_STATUS_BADGE_VARIANT, ITEM_STATUS_LABEL, VOID_REASON_LABEL, courseLabel } from "./lib"

export interface OrderItemsListProps {
  items: OrderItemOut[]
  onIncrement: (item: OrderItemOut) => void
  onDecrement: (item: OrderItemOut) => void
  onVoid: (item: OrderItemOut) => void
  onCourtesy: (item: OrderItemOut) => void
  onDiscount: (item: OrderItemOut) => void
  busyItemId?: number | null
}

/**
 * Lista de ítems con estado y curso "por color" (variantes tokenizadas de
 * `Badge`, nunca un color crudo). Cantidad editable sólo en `pending`
 * (SPEC-NEGOCIO §3.3); anular, cortesía y descuento por ítem detrás de sus
 * flags — el botón desaparece sin la función, el backend sigue siendo la
 * barrera.
 */
export function OrderItemsList({
  items,
  onIncrement,
  onDecrement,
  onVoid,
  onCourtesy,
  onDiscount,
  busyItemId = null,
}: OrderItemsListProps): React.JSX.Element {
  const { hasFeature } = useSession()
  const courtesyEnabled = hasFeature("pos.courtesies")
  const discountsEnabled = hasFeature("pos.discounts")

  if (items.length === 0) {
    return <p className="text-sm text-muted-foreground">Todavía no hay ítems en esta comanda.</p>
  }

  return (
    <ul className="space-y-2">
      {items.map((item) => {
        const isPending = item.status === "pending"
        const isVoided = item.status === "voided"
        const isCourtesy = item.courtesy !== null && item.courtesy !== undefined
        const busy = busyItemId === item.id
        return (
          <li key={item.id} className="rounded-lg border p-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{item.name ?? "—"}</span>
                  {item.status ? (
                    <Badge variant={ITEM_STATUS_BADGE_VARIANT[item.status] ?? "outline"}>
                      {ITEM_STATUS_LABEL[item.status] ?? item.status}
                    </Badge>
                  ) : null}
                  {item.course ? (
                    <Badge variant={COURSE_BADGE_VARIANT[item.course] ?? "outline"}>{courseLabel(item.course)}</Badge>
                  ) : null}
                  {item.seat !== null && item.seat !== undefined ? (
                    <Badge variant="outline">Asiento {item.seat}</Badge>
                  ) : null}
                  {isCourtesy ? <Badge variant="secondary">Cortesía</Badge> : null}
                </div>
                {item.modifiers_text ? <p className="text-xs text-muted-foreground">{item.modifiers_text}</p> : null}
                {item.note ? <p className="text-xs text-muted-foreground">Nota: {item.note}</p> : null}
                {isVoided && item.void ? (
                  <p className="text-xs text-destructive">
                    Anulado: {item.void.reason ? (VOID_REASON_LABEL[item.void.reason] ?? item.void.reason) : "—"}
                    {item.void.after_bill ? " · después de presentar cuenta" : ""}
                  </p>
                ) : null}
              </div>
              <div className="text-right text-sm tabular-nums text-muted-foreground">
                <p>{formatCOP(item.net)}</p>
                {item.discount ? <p className="text-xs">Descuento: {formatCOP(item.discount)}</p> : null}
              </div>
            </div>

            <div className="mt-2 flex flex-wrap items-center gap-2">
              {isPending ? (
                <div className="flex items-center gap-1">
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className="size-11"
                    aria-label={`Restar una unidad de ${item.name ?? "ítem"}`}
                    disabled={busy || (item.qty ?? 1) <= 1}
                    onClick={() => onDecrement(item)}
                  >
                    <Minus className="size-4" aria-hidden="true" />
                  </Button>
                  <span className="w-6 text-center tabular-nums">{item.qty ?? 1}</span>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className="size-11"
                    aria-label={`Sumar una unidad de ${item.name ?? "ítem"}`}
                    disabled={busy}
                    onClick={() => onIncrement(item)}
                  >
                    <Plus className="size-4" aria-hidden="true" />
                  </Button>
                </div>
              ) : (
                <span className="text-sm tabular-nums text-muted-foreground">Cant. {item.qty ?? 1}</span>
              )}

              {!isVoided ? (
                <Button
                  type="button"
                  variant="ghost"
                  className="h-11"
                  disabled={busy}
                  onClick={() => onVoid(item)}
                  aria-label={`Anular ${item.name ?? "ítem"}`}
                >
                  <XCircle className="size-4" aria-hidden="true" />
                  Anular
                </Button>
              ) : null}

              {courtesyEnabled && !isVoided && !isCourtesy ? (
                <Button
                  type="button"
                  variant="ghost"
                  className="h-11"
                  disabled={busy}
                  onClick={() => onCourtesy(item)}
                  aria-label={`Cortesía de ${item.name ?? "ítem"}`}
                >
                  <Gift className="size-4" aria-hidden="true" />
                  Cortesía
                </Button>
              ) : null}

              {discountsEnabled && !isVoided ? (
                <Button
                  type="button"
                  variant="ghost"
                  className="h-11"
                  disabled={busy}
                  onClick={() => onDiscount(item)}
                  aria-label={`Descuento de ${item.name ?? "ítem"}`}
                >
                  <Percent className="size-4" aria-hidden="true" />
                  Descuento
                </Button>
              ) : null}
            </div>
          </li>
        )
      })}
    </ul>
  )
}

export default OrderItemsList
