import { Check, Flame, Gift, Minus, MoreHorizontal, Percent, Plus, XCircle } from "lucide-react"

import { useSession } from "@/app/session"
import type { OrderItemOut } from "@/api/orders"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import { formatCOP } from "@/lib/money"

import { VOID_REASON_LABEL, courseLabel, elapsedLabel } from "./lib"

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
 * **Los renglones de la cuenta**, con la forma de `m2b` (pantalla 2).
 *
 * Tres columnas fijas: la cantidad en su recuadro de 38 px, el nombre con sus
 * pastillas debajo, y la plata alineada a la derecha. La cantidad NO es texto
 * suelto —va en su recuadro— porque es el número que el mesero compara contra
 * los platos que ve sobre la mesa, y en una lista de doce renglones un dígito
 * sin caja se pierde.
 *
 * **El renglón sin mandar se pinta de azul suave y sangra hasta el borde de
 * la tarjeta.** Es la única diferencia visual que importa acá: separa lo que
 * todavía se puede quitar con un toque de lo que ya salió a cocina y necesita
 * autorización. La maqueta la resuelve así y la frase al pie del panel la
 * explica con palabras.
 *
 * Cantidad editable sólo en `pending` (SPEC-NEGOCIO §3.3); anular, cortesía y
 * descuento por ítem detrás de sus flags — el botón desaparece sin la función,
 * el backend sigue siendo la barrera.
 */

/**
 * El rótulo de estado con las palabras de la maqueta. «En cocina» dice dónde
 * está el plato; «Enviado» decía qué hizo el sistema, que no es lo que el
 * mesero necesita saber cuando el cliente pregunta.
 */
const ESTADO: Record<string, { texto: string; variante: "outline" | "secondary" | "default" | "destructive" }> = {
  pending: { texto: "Sin mandar", variante: "outline" },
  sent: { texto: "En cocina", variante: "default" },
  ready: { texto: "Listo", variante: "secondary" },
  served: { texto: "Servido", variante: "secondary" },
  voided: { texto: "Anulado", variante: "destructive" },
}

/**
 * El control del renglón. `m2b` lo dibuja de 32 px; acá manda la densidad del
 * salón, que fija 52 px de objetivo táctil (`--control-min-h`) para todo lo
 * que se toca de pie y con el dedo. Entre parecerse a la maqueta y que el
 * dedo acierte, gana el dedo — y esos 52 px son los que obligaron a mover el
 * curso al renglón del nombre y a soltar el ícono de la pastilla.
 */
const CHICO = "shrink-0 rounded-[7px]"

function EstadoPastilla({ item }: { item: OrderItemOut }): React.JSX.Element | null {
  if (!item.status) return null
  const estado = ESTADO[item.status]
  if (!estado) return <Badge variant="outline">{item.status}</Badge>

  // «En cocina · 12 min» sólo cuando el servidor dijo cuándo salió. Sin
  // `sent_at` se muestra el estado a secas: inventar el minuto sería peor que
  // no decirlo, porque el mesero lo usa para contestar «¿cuánto falta?».
  const desde = item.status === "sent" ? item.sent_at : null

  // El ícono acompaña al estado SIN tiempo. Con «En cocina · 1 h 36 min» al
  // lado, la pastilla pasaba de 159 px y, más el control de 52, no quedaba en
  // los 217 px de la columna: cada renglón se partía en dos filas. La mesa que
  // lleva más de una hora es justo la que más renglones tiene.
  const Icono = desde ? null : item.status === "sent" ? Flame : item.status === "served" ? Check : null

  return (
    <Badge variant={estado.variante}>
      {Icono ? <Icono className="size-3 shrink-0" aria-hidden="true" /> : null}
      {desde ? `${estado.texto} · ${elapsedLabel(desde)}` : estado.texto}
    </Badge>
  )
}

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
    <ul>
      {items.map((item) => {
        const isPending = item.status === "pending"
        const isVoided = item.status === "voided"
        const isCourtesy = item.courtesy !== null && item.courtesy !== undefined
        const busy = busyItemId === item.id
        const nombre = item.name ?? "—"
        return (
          <li
            key={item.id}
            className={cn(
              "grid grid-cols-[38px_minmax(0,1fr)_auto] items-start gap-2.5 border-b py-2.5 last:border-b-0",
              // La sangría: el azul llega hasta el borde de la tarjeta (16 px
              // de `p-4`), no se queda en un rectángulo flotando adentro.
              isPending && "-mx-4 bg-accent px-4",
            )}
          >
            <span className="rounded-[7px] border border-input bg-muted py-0.5 text-center text-base font-bold tabular-nums">
              {item.qty ?? 1}
            </span>

            <span className="min-w-0">
              {/* El curso viaja con el NOMBRE, no con las pastillas de estado.
                  Al lado del estado no cabía: «En cocina · 1 h 35 min» más
                  «Fuerte» más el menú pasan de los 224 px que deja la columna
                  de 384 px, y la línea se partía en tres filas. Acá aprovecha
                  el espacio que el nombre deja libre y no cuesta ni un píxel
                  de alto. */}
              <span className="flex items-baseline gap-2">
                <span className={cn("min-w-0 text-[0.97rem] leading-snug [overflow-wrap:anywhere]", isVoided && "line-through")}>
                  {nombre}
                </span>
                {item.course ? (
                  <span className="ml-auto shrink-0 text-xs text-muted-foreground">{courseLabel(item.course)}</span>
                ) : null}
              </span>

              {item.note ? <span className="mt-0.5 block text-xs text-muted-foreground">Nota: {item.note}</span> : null}

              <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <EstadoPastilla item={item} />

                {/* **Cada modificador, su pastilla** (`m2b`: «1 sin
                    alcaparras», «arroz aparte», «sin azúcar»). Escritos en
                    una línea de texto chico debajo del nombre se leían como
                    un subtítulo y se perdían; el modificador es lo que hace
                    que el plato llegue como lo pidieron, y llega a cocina
                    impreso — verlo acá es cómo el mesero confirma que lo
                    mandó bien.

                    Salen de `modifiers`, la lista tipada, NO de partir
                    `modifiers_text` por la coma: un modificador puede
                    llamarse «Salsa, aparte» y la coma lo habría cortado en
                    dos pastillas que no existen. */}
                {(item.modifiers ?? []).map((m) => (
                  <Badge key={m.option_id} variant="outline" className="font-normal">
                    {m.name}
                  </Badge>
                ))}

                {item.seat !== null && item.seat !== undefined ? <Badge variant="outline">Asiento {item.seat}</Badge> : null}
                {isCourtesy ? <Badge variant="secondary">Cortesía</Badge> : null}

                {/* **Las acciones caben en el mismo renglón que las
                    pastillas.** Anular, cortesía y descuento van detrás de un
                    solo botón: sueltos, tres controles de 32 px partían cada
                    línea en tres filas, la línea pasaba de 60 a 155 px y en la
                    columna de 384 px de `m2b` cabía UNA. Una cuenta de seis
                    platos que sólo muestra uno no es una cuenta. */}
                {isPending ? (
                  <>
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      className={CHICO}
                      aria-label={`Restar una unidad de ${nombre}`}
                      disabled={busy || (item.qty ?? 1) <= 1}
                      onClick={() => onDecrement(item)}
                    >
                      <Minus className="size-4" aria-hidden="true" />
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      className={CHICO}
                      aria-label={`Sumar una unidad de ${nombre}`}
                      disabled={busy}
                      onClick={() => onIncrement(item)}
                    >
                      <Plus className="size-4" aria-hidden="true" />
                    </Button>
                  </>
                ) : null}

                {!isVoided ? (
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={
                        <Button
                          type="button"
                          variant="outline"
                          size="icon"
                          className={cn(CHICO, "text-muted-foreground")}
                          disabled={busy}
                          aria-label={`Más acciones de ${nombre}`}
                        >
                          <MoreHorizontal className="size-4" aria-hidden="true" />
                        </Button>
                      }
                    />
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => onVoid(item)}>
                        <XCircle className="size-4" aria-hidden="true" />
                        Anular {nombre}
                      </DropdownMenuItem>
                      {courtesyEnabled && !isCourtesy ? (
                        <DropdownMenuItem onClick={() => onCourtesy(item)}>
                          <Gift className="size-4" aria-hidden="true" />
                          Cortesía de {nombre}
                        </DropdownMenuItem>
                      ) : null}
                      {discountsEnabled ? (
                        <DropdownMenuItem onClick={() => onDiscount(item)}>
                          <Percent className="size-4" aria-hidden="true" />
                          Descuento de {nombre}
                        </DropdownMenuItem>
                      ) : null}
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : null}
              </span>

              {isVoided && item.void ? (
                <span className="mt-1 block text-xs text-destructive">
                  Anulado: {item.void.reason ? (VOID_REASON_LABEL[item.void.reason] ?? item.void.reason) : "—"}
                  {item.void.after_bill ? " · después de presentar cuenta" : ""}
                </span>
              ) : null}
            </span>

            <span className="text-right">
              <span className="block text-[0.97rem] font-bold whitespace-nowrap tabular-nums">{formatCOP(item.net)}</span>
              {item.discount ? (
                <span className="block text-xs whitespace-nowrap text-muted-foreground tabular-nums">
                  Descuento: {formatCOP(item.discount)}
                </span>
              ) : null}
            </span>
          </li>
        )
      })}
    </ul>
  )
}

export default OrderItemsList
