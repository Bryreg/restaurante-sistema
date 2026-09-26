import { Bike, ShoppingBag, Smartphone, Store, UtensilsCrossed, Users2 } from "lucide-react"
import { useState } from "react"
import { useNavigate } from "react-router-dom"
import { useQuery } from "@tanstack/react-query"

import { useSession } from "@/app/session"
import { createOrder, type OrderChannel } from "@/api/orders"
import { Cargando } from "@/components/Cargando"
import { Button } from "@/components/ui/button"
import { EmptyState } from "@/components/EmptyState"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { errorMessage } from "@/lib/errors"
// `EmployeePicker` lo escribe `frontend-cobro` (CONTRATO-INTERNO-1b-1.md § 1,
// § 0): si todavía no existe cuando esto corre, queda declarado en `gaps` del
// entregable, tal como pide la misión.
import { EmployeePicker } from "@/components/EmployeePicker"
// CONTRATO C7 (spec de este pedido, 2c): la lista de plataformas activas de
// la sede NO es de este agente — la publica `frontend-kds-config` en
// `@/api/channels`. Se IMPORTA acá, no se copia el tipo ni el fetch. Si ese
// archivo no existe todavía cuando esto corre, el typecheck y este import
// lo cobran — declarado en el entregable ("qué asumí de C7"), a propósito.
import { listDevicePlatforms, type DevicePlatformOut } from "@/api/channels"

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
  { channel: "delivery", label: "Domicilio", icon: Bike, feature: "pos.delivery" },
  { channel: "platform", label: "Plataforma", icon: Smartphone, feature: "pos.platforms" },
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
  const [deliveryAddress, setDeliveryAddress] = useState("")
  const [deliveryPhone, setDeliveryPhone] = useState("")
  const [courierId, setCourierId] = useState<number | null>(null)
  const [platformId, setPlatformId] = useState<number | null>(null)
  const [externalId, setExternalId] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  const platformsQuery = useQuery({
    queryKey: ["device", "platforms"] as const,
    queryFn: listDevicePlatforms,
    enabled: channel === "platform",
  })
  const platforms: DevicePlatformOut[] = platformsQuery.data ?? []

  const available = CHANNEL_OPTIONS.filter((option) => hasFeature(option.feature))

  if (available.length === 0) {
    return (
      <EmptyState
        title="No hay ningún canal de venta habilitado"
        description="Activá al menos uno (Mostrador, Mesas, Para llevar, Domicilio, Plataforma o Consumo de personal) en Admin → Funciones."
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
    if (channel === "delivery") {
      if (deliveryAddress.trim() === "" || deliveryPhone.trim() === "") {
        setError("Ingresá la dirección y el teléfono del domicilio.")
        return
      }
      if (courierId === null) {
        setError("Elegí quién reparte este domicilio.")
        return
      }
    }
    if (channel === "platform") {
      if (platformId === null) {
        setError("Elegí la plataforma.")
        return
      }
      if (externalId.trim() === "") {
        setError("Ingresá el número del pedido en la plataforma.")
        return
      }
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
                // Se manda TAL COMO la entrega el input (sin zona), nunca
                // `new Date(...).toISOString()`: eso interpreta la hora de
                // pared con la zona del NAVEGADOR, que en un dispositivo mal
                // configurado no es Bogotá. El servidor la interpreta con
                // `app/core/tz.py::from_bogota_wall_clock` (AGENTS.md, "toda
                // fecha de negocio... nunca del navegador").
                promised_at: promisedAt === "" ? undefined : promisedAt,
              }
            : undefined,
        delivery:
          channel === "delivery"
            ? {
                address: deliveryAddress.trim(),
                phone: deliveryPhone.trim(),
                // Validado arriba: `courierId` no es `null` en esta rama.
                courier_employee_id: courierId as number,
              }
            : undefined,
        platform:
          channel === "platform"
            ? {
                // Validado arriba: `platformId` no es `null` en esta rama.
                platform_id: platformId as number,
                external_id: externalId.trim(),
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
      <h1 className="text-lg font-semibold">Nuevo pedido</h1>

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

          {channel === "delivery" ? (
            <div className="space-y-4">
              <div className="space-y-1">
                <Label htmlFor="delivery-address">Dirección</Label>
                <Input
                  id="delivery-address"
                  className="h-11"
                  value={deliveryAddress}
                  onChange={(event) => setDeliveryAddress(event.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="delivery-phone">Teléfono</Label>
                <Input
                  id="delivery-phone"
                  className="h-11"
                  value={deliveryPhone}
                  onChange={(event) => setDeliveryPhone(event.target.value)}
                />
              </div>
              <EmployeePicker value={courierId} onChange={(id) => setCourierId(id)} label="Domiciliario" />
              <p className="text-xs text-muted-foreground">
                El cargo de domicilio se agrega solo, como un ítem más de la comanda, con su impuesto ya
                calculado.
              </p>
            </div>
          ) : null}

          {channel === "platform" ? (
            <div className="space-y-4">
              <div className="space-y-1">
                <Label htmlFor="platform-select">Plataforma</Label>
                {platformsQuery.isLoading ? (
                  <Cargando texto="Cargando plataformas…" />
                ) : platformsQuery.isError ? (
                  <EmptyState
                    role="alert"
                    title="No se pudieron cargar las plataformas"
                    description={errorMessage(platformsQuery.error)}
                    action={{ label: "Reintentar", onClick: () => void platformsQuery.refetch() }}
                  />
                ) : platforms.length === 0 ? (
                  <EmptyState
                    title="Esta sede no tiene plataformas activas"
                    description="Configurá al menos una plataforma en Admin → Configuración antes de cargar un pedido."
                  />
                ) : (
                  <Select
                    value={platformId === null ? undefined : String(platformId)}
                    onValueChange={(value) => setPlatformId(value ? Number(value) : null)}
                  >
                    <SelectTrigger id="platform-select" className="h-11 w-full">
                      <SelectValue placeholder="Elegí la plataforma" />
                    </SelectTrigger>
                    <SelectContent>
                      {platforms.map((platform) => (
                        <SelectItem key={platform.id} value={String(platform.id)}>
                          {platform.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>
              <div className="space-y-1">
                <Label htmlFor="platform-external-id">Número de pedido en la plataforma</Label>
                <Input
                  id="platform-external-id"
                  className="h-11"
                  value={externalId}
                  onChange={(event) => setExternalId(event.target.value)}
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
