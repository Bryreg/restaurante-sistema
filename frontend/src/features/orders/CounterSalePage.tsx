import { useEffect, useRef, useState } from "react"
import { useNavigate } from "react-router-dom"

import { useSession } from "@/app/session"
import { createOrder, listOrders, type OrderOut } from "@/api/orders"
import { Cargando } from "@/components/Cargando"
import { EmptyState } from "@/components/EmptyState"
import { errorMessage } from "@/lib/errors"

/**
 * «Mostrador» en la barra del salón: una venta de mostrador de una, sin
 * pasar por el selector de canal (los otros canales siguen en «Nuevo
 * pedido»). Crea la comanda `counter` y aterriza en ella.
 *
 * Si quien toca ya tiene una comanda de mostrador abierta y VACÍA (tocó
 * «Mostrador», no cargó nada y volvió a tocar), la reusa: sin esto cada
 * toque dejaba una comanda vacía abierta que después alguien tiene que
 * anular para cerrar el turno. Una comanda con algo cargado nunca se reusa.
 */
export function CounterSalePage(): React.JSX.Element {
  const { hasFeature, me } = useSession()
  const navigate = useNavigate()
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  // Un intento por montaje (y por «Reintentar»): el doble efecto del modo
  // estricto no puede abrir dos comandas.
  const started = useRef<number | null>(null)
  const enabled = hasFeature("pos.counter")
  const myId = me?.employee?.id ?? null

  useEffect(() => {
    if (!enabled || started.current === attempt) return
    started.current = attempt
    // Sin bandera de «cancelado»: en modo estricto el primer efecto se
    // limpia y el segundo no corre (la guarda de arriba), así que es ESTE
    // intento el que tiene que terminar navegando.
    async function openCounterSale() {
      setError(null)
      try {
        const openOrders = await listOrders({ status: "open", channel: "counter" })
        const reusable = openOrders.find(
          (order: OrderOut) =>
            myId !== null &&
            order.opened_by?.id === myId &&
            (order.items ?? []).length === 0,
        )
        const order = reusable ?? (await createOrder({ channel: "counter" }))
        navigate(`/pos/comanda/${order.id}`, { replace: true })
      } catch (err) {
        setError(errorMessage(err))
      }
    }
    void openCounterSale()
  }, [enabled, attempt, myId, navigate])

  if (!enabled) {
    return (
      <EmptyState
        title="La venta de mostrador no está habilitada"
        description="Activá «Mostrador» en Admin → Funciones, o usá «Nuevo pedido» para otro canal."
        action={{ label: "Nuevo pedido", onClick: () => navigate("/pos/comanda/nueva") }}
      />
    )
  }

  if (error) {
    return (
      <EmptyState
        role="alert"
        title="No se pudo abrir la venta de mostrador"
        description={error}
        action={{ label: "Reintentar", onClick: () => setAttempt((n) => n + 1) }}
      />
    )
  }

  return <Cargando texto="Abriendo venta de mostrador…" />
}

export default CounterSalePage
