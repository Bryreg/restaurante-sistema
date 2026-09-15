import { ShoppingBag, Store, UtensilsCrossed, Users2 } from "lucide-react"
import { useState } from "react"
import { useNavigate } from "react-router-dom"

import { useSession } from "@/app/session"
import { createOrder, type OrderChannel } from "@/api/orders"
import { Button } from "@/components/ui/button"
import { EmptyState } from "@/components/EmptyState"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { errorMessage } from "@/lib/errors"
// `EmployeePicker` lo escribe `frontend-cobro` (CONTRATO-INTERNO-1b-1.md § 1,
// § 0): si todavía no existe cuando esto corre, queda declarado en `gaps` del
// entregable, tal como pide la misión.
import { EmployeePicker } from "@/components/EmployeePicker"

interface ChannelOption {
  channel: OrderChannel
  label: string
  icon: typeof Store
  feature: string
}

const CHANNEL_OPTIONS: ChannelOption[] = [
  { channel: "counter", label: "Mostrador", icon: Store, feature: "pos.counter" },
  { channel: "dine_in", label: "Mesa", icon: Users2, feature: "pos.tables" },
  { channel: "takeout", label: "Para llevar", icon: ShoppingBag, feature: "pos.takeout" },
  { channel: "staff_meal", label: "Consumo de personal", icon: UtensilsCrossed, feature: "pos.staff_meal" },
]

/**
 * Elige el canal de una comanda nueva (SPEC-NEGOCIO §3.3, CONTRATO-INTERNO
 * §6.2). `dine_in` no se abre acá: necesita mesa, así que sólo lleva a
 * `/pos/mesas`, donde `TablesPage` crea la comanda al abrir una mesa libre.
 */
export function NewOrderPage(): React.JSX.Element {
  const { hasFeature } = useSession()
  const navigate = useNavigate()

  const [channel, setChannel] = useState<OrderChannel | null>(null)
  const [note, setNote] = useState("")
  const [customerName, setCustomerName] = useState("")
  const [phone, setPhone] = useState("")
  const [promisedAt, setPromisedAt] = useState("")
  const [consumedBy, setConsumedBy] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  const available = CHANNEL_OPTIONS.filter((option) => hasFeature(option.feature))

  if (available.length === 0) {
    return (
      <EmptyState
        title="No hay ningún canal de venta habilitado"
        description="Activá al menos uno (Mostrador, Mesas, Para llevar o Consumo de personal) en Admin → Funciones."
      />
    )
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    if (!channel || channel === "dine_in") return
    setError(null)

    if (channel === "takeout" && customerName.trim() === "") {
      setError("Ingresá el nombre del cliente.")
      return
    }
    if (channel === "staff_meal" && consumedBy === null) {
      setError("Elegí quién consume.")
      return
    }

    setPending(true)
    try {
      const order = await createOrder({
        channel,
        note: note.trim() === "" ? undefined : note.trim(),
        takeout:
          channel === "takeout"
            ? {
                customer_name: customerName.trim(),
                phone: phone.trim() === "" ? undefined : phone.trim(),
                promised_at: promisedAt === "" ? undefined : new Date(promisedAt).toISOString(),
              }
            : undefined,
        consumed_by_employee_id: channel === "staff_meal" ? (consumedBy ?? undefined) : undefined,
      })
      navigate(`/pos/comanda/${order.id}`)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <h1 className="text-lg font-semibold">Nueva comanda</h1>

      <div role="radiogroup" aria-label="Canal de venta" className="grid grid-cols-2 gap-3">
        {available.map((option) => {
          const Icon = option.icon
          const selected = channel === option.channel
          return (
            <button
              key={option.channel}
              type="button"
              role="radio"
              aria-checked={selected}
              className={`flex min-h-[64px] flex-col items-center justify-center gap-1 rounded-lg border p-3 text-sm font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring ${
                selected ? "border-primary bg-primary/5" : "border-border"
              }`}
              onClick={() => {
                if (option.channel === "dine_in") {
                  navigate("/pos/mesas")
                  return
                }
                setChannel(option.channel)
                setError(null)
              }}
            >
              <Icon className="size-5" aria-hidden="true" />
              {option.label}
            </button>
          )
        })}
      </div>

      {channel && channel !== "dine_in" ? (
        <form className="space-y-4" onSubmit={(event) => void handleSubmit(event)}>
          {channel === "takeout" ? (
            <div className="space-y-4">
              <div className="space-y-1">
                <Label htmlFor="takeout-name">Nombre del cliente</Label>
                <Input
                  id="takeout-name"
                  className="h-11"
                  value={customerName}
                  onChange={(event) => setCustomerName(event.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="takeout-phone">Teléfono (opcional)</Label>
                <Input
                  id="takeout-phone"
                  className="h-11"
                  value={phone}
                  onChange={(event) => setPhone(event.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="takeout-promised">Hora prometida (opcional)</Label>
                <Input
                  id="takeout-promised"
                  type="datetime-local"
                  className="h-11"
                  value={promisedAt}
                  onChange={(event) => setPromisedAt(event.target.value)}
                />
              </div>
            </div>
          ) : null}

          {channel === "staff_meal" ? (
            <EmployeePicker value={consumedBy} onChange={(id) => setConsumedBy(id)} label="¿Quién consume?" />
          ) : null}

          <div className="space-y-1">
            <Label htmlFor="order-note">Nota (opcional)</Label>
            <Textarea id="order-note" value={note} onChange={(event) => setNote(event.target.value)} />
          </div>

          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}

          <Button type="submit" className="h-11 w-full" disabled={pending}>
            {pending ? "Creando…" : "Crear comanda"}
          </Button>
        </form>
      ) : null}
    </div>
  )
}

export default NewOrderPage
