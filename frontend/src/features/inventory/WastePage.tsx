import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { AlertTriangle } from "lucide-react"
import { useRef, useState } from "react"
import { toast } from "sonner"

import { useSession } from "@/app/session"
import { ApiError, newIdempotencyKey } from "@/api/client"
import { listDeviceEmployees } from "@/api/employees"
import { listDeviceIngredients, listTransferStores, postWaste, type WasteType } from "@/api/inventory"
import { listDevicePreparations } from "@/api/recipes"
import { EmptyState } from "@/components/EmptyState"
import { PhotoCaptureField } from "@/components/PhotoCaptureField"
import { PinPad } from "@/components/PinPad"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Textarea } from "@/components/ui/textarea"
import { errorMessage } from "@/lib/errors"

import { WASTE_TYPE_LABEL } from "./lib"

type Kind = "ingredient" | "preparation"

/** En «¿Quién?» del consumo interno: una persona del equipo o un texto. */
const OTHER_CONSUMER = "other"

/**
 * POS/cocina → Registrar merma (`POST /waste`, SPEC-NEGOCIO §5.5). Ruta de
 * DISPOSITIVO: ni esta pantalla ni `WasteOut` muestran costo o margen — el
 * operador no los recibe (AGENTS.md, checklist de 2a: "ninguna respuesta de
 * sesión de dispositivo contiene `cost` ni `margin`"). "Consumo de
 * personal" NO está en el selector de tipo: eso es una comanda
 * `staff_meal`, nunca una merma (SPEC-NEGOCIO §5.5).
 *
 * `Idempotency-Key` nueva por intento, salvo cuando el error es `409` (la
 * misma clave sigue en vuelo: cambiarla ahí dejaría que un reintento
 * duplique la merma) — mismo patrón que `QuickProductionPage.tsx`
 * (territorio de `frontend-recetas`).
 *
 * Rutina del turno (2026-09-25): dos salidas que NO son pérdida pasan por
 * esta misma pantalla — «Consumo interno» (pide quién: una persona del equipo
 * o un texto como «dueño») y «Traslado a otra sede» (pide la sede destino;
 * sólo de insumos, y la opción no aparece si la organización tiene una sola
 * sede). Qué es pérdida y qué no lo decide el backend.
 */
export function WastePage(): React.JSX.Element {
  const { hasFeature } = useSession()
  const queryClient = useQueryClient()
  const enabled = hasFeature("inventory.waste")

  const [kind, setKind] = useState<Kind>("ingredient")
  const [targetId, setTargetId] = useState<number | null>(null)
  const [qty, setQty] = useState("")
  const [type, setType] = useState<WasteType | "">("")
  const [note, setNote] = useState("")
  const [photo, setPhoto] = useState<string | null>(null)
  const [consumer, setConsumer] = useState<string>("")
  const [consumerName, setConsumerName] = useState("")
  const [destinationId, setDestinationId] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const idempotencyKeyRef = useRef(newIdempotencyKey())

  const ingredientsQuery = useQuery({
    queryKey: ["device", "ingredients"],
    queryFn: listDeviceIngredients,
    enabled,
  })
  const preparationsQuery = useQuery({
    queryKey: ["device", "preparations"],
    queryFn: listDevicePreparations,
    enabled,
  })

  // Sin otras sedes (o si la lista no carga) simplemente no se ofrece el
  // traslado: el resto del formulario sigue funcionando.
  const transferStoresQuery = useQuery({
    queryKey: ["device", "waste-transfer-stores"],
    queryFn: listTransferStores,
    enabled,
  })
  const transferStores = transferStoresQuery.data ?? []
  const canTransfer = transferStores.length > 0

  const employeesQuery = useQuery({
    queryKey: ["device", "employees"],
    queryFn: listDeviceEmployees,
    enabled: enabled && type === "internal_use",
  })

  const mutation = useMutation({
    mutationFn: (pin: string) =>
      postWaste(
        {
          ingredient_id: kind === "ingredient" ? targetId : null,
          preparation_id: kind === "preparation" ? targetId : null,
          qty: qty.trim(),
          type: type as WasteType,
          note: note.trim() === "" ? undefined : note.trim(),
          employee_pin: pin,
          photo: photo ?? undefined,
          ...(type === "internal_use"
            ? consumer === OTHER_CONSUMER
              ? { consumer_name: consumerName.trim() }
              : { consumer_employee_id: Number(consumer) }
            : {}),
          ...(type === "transfer_out" ? { destination_store_id: destinationId } : {}),
        },
        idempotencyKeyRef.current,
      ),
    onSuccess: () => {
      toast.success(
        type === "internal_use"
          ? "Consumo interno registrado."
          : type === "transfer_out"
            ? "Traslado registrado: la otra sede lo recibe."
            : "Merma registrada.",
      )
      setError(null)
      setTargetId(null)
      setQty("")
      setType("")
      setNote("")
      setPhoto(null)
      setConsumer("")
      setConsumerName("")
      setDestinationId(null)
      idempotencyKeyRef.current = newIdempotencyKey()
      void queryClient.invalidateQueries({ queryKey: ["device", "ingredients"] })
    },
    onError: (err) => {
      // `409` = la misma clave sigue en vuelo (doble toque): se mantiene a
      // propósito para no duplicar la merma con una clave nueva.
      if (!(err instanceof ApiError) || err.status !== 409) {
        idempotencyKeyRef.current = newIdempotencyKey()
      }
      setError(errorMessage(err))
    },
  })

  if (!enabled) {
    return (
      <EmptyState
        title="Registro de mermas no está habilitado"
        description="Activá «Registro de mermas» en Admin → Funciones."
      />
    )
  }

  if (ingredientsQuery.isLoading || preparationsQuery.isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-11 w-full" />
        <Skeleton className="h-11 w-full" />
        <Skeleton className="h-11 w-full" />
      </div>
    )
  }
  if (ingredientsQuery.isError) {
    return (
      <EmptyState
        role="alert"
        icon={AlertTriangle}
        title="No se pudo cargar la lista de insumos"
        description={errorMessage(ingredientsQuery.error)}
        action={{ label: "Reintentar", onClick: () => void ingredientsQuery.refetch() }}
      />
    )
  }

  const ingredients = ingredientsQuery.data ?? []
  const preparations = preparationsQuery.data ?? []
  const options = kind === "ingredient" ? ingredients : preparations
  const typeOptions = (Object.entries(WASTE_TYPE_LABEL) as [WasteType, string][]).filter(
    ([value]) => value !== "transfer_out" || canTransfer,
  )
  const consumerReady =
    type !== "internal_use" || (consumer === OTHER_CONSUMER ? consumerName.trim() !== "" : consumer !== "")
  const destinationReady = type !== "transfer_out" || destinationId !== null
  const canConfirm = targetId !== null && qty.trim() !== "" && type !== "" && consumerReady && destinationReady

  return (
    <div className="mx-auto max-w-md space-y-5">
      <div>
        <h1 className="text-lg font-semibold">Registrar merma</h1>
        <p className="text-sm text-muted-foreground">
          Vencido, sobreproducción, error de cocina, rotura, devolución, degustación, cortesía sin plato o sin
          identificar. El consumo de personal no es una merma: usá una comanda de consumo de personal. Lo que se
          lleva el dueño o se usa en una reunión va como «Consumo interno»
          {canTransfer ? ", y lo que se manda a otra sede, como «Traslado a otra sede»" : ""}: quedan registrados
          sin contarse como pérdida.
        </p>
      </div>

      <div className="space-y-1">
        <Label htmlFor="waste-kind">Qué se perdió</Label>
        <Select
          value={kind}
          onValueChange={(value) => {
            setKind(value as Kind)
            setTargetId(null)
          }}
        >
          <SelectTrigger id="waste-kind" className="h-11 w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ingredient">Un insumo</SelectItem>
            {type === "transfer_out" ? null : <SelectItem value="preparation">Una preparación</SelectItem>}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1">
        <Label htmlFor="waste-target">{kind === "ingredient" ? "Insumo" : "Preparación"}</Label>
        <Select value={targetId === null ? undefined : String(targetId)} onValueChange={(value) => setTargetId(Number(value))}>
          <SelectTrigger id="waste-target" className="h-11 w-full">
            <SelectValue placeholder="Elegí una opción" />
          </SelectTrigger>
          <SelectContent>
            {options.map((option) => (
              <SelectItem key={option.id} value={String(option.id)}>
                {option.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {options.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {kind === "ingredient" ? "No hay insumos activos." : "No hay preparaciones activas."}
          </p>
        ) : null}
      </div>

      <div className="space-y-1">
        <Label htmlFor="waste-qty">Cantidad</Label>
        <Input id="waste-qty" inputMode="decimal" className="h-11" value={qty} onChange={(event) => setQty(event.target.value)} />
      </div>

      <div className="space-y-1">
        <Label htmlFor="waste-type">Tipo</Label>
        <Select
          value={type}
          onValueChange={(value) => {
            const next = value as WasteType
            setType(next)
            // Un traslado es sólo de insumos: las preparaciones son de cada sede.
            if (next === "transfer_out" && kind === "preparation") {
              setKind("ingredient")
              setTargetId(null)
            }
          }}
        >
          <SelectTrigger id="waste-type" className="h-11 w-full">
            <SelectValue placeholder="Elegí un tipo" />
          </SelectTrigger>
          <SelectContent>
            {typeOptions.map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {type === "internal_use" ? (
        <div className="space-y-2">
          <div className="space-y-1">
            <Label htmlFor="waste-consumer">¿Quién?</Label>
            <Select value={consumer === "" ? undefined : consumer} onValueChange={(value) => setConsumer(String(value))}>
              <SelectTrigger id="waste-consumer" className="h-11 w-full">
                <SelectValue placeholder="Elegí quién" />
              </SelectTrigger>
              <SelectContent>
                {(employeesQuery.data ?? []).map((employee) => (
                  <SelectItem key={employee.id} value={String(employee.id)}>
                    {employee.name}
                  </SelectItem>
                ))}
                <SelectItem value={OTHER_CONSUMER}>Otra persona (escribir)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {consumer === OTHER_CONSUMER ? (
            <div className="space-y-1">
              <Label htmlFor="waste-consumer-name">Nombre o motivo</Label>
              <Input
                id="waste-consumer-name"
                className="h-11"
                placeholder="Dueño, reunión de socios…"
                value={consumerName}
                onChange={(event) => setConsumerName(event.target.value)}
              />
            </div>
          ) : null}
        </div>
      ) : null}

      {type === "transfer_out" ? (
        <div className="space-y-1">
          <Label htmlFor="waste-destination">Sede destino</Label>
          <Select
            value={destinationId === null ? undefined : String(destinationId)}
            onValueChange={(value) => setDestinationId(Number(value))}
          >
            <SelectTrigger id="waste-destination" className="h-11 w-full">
              <SelectValue placeholder="Elegí la sede" />
            </SelectTrigger>
            <SelectContent>
              {transferStores.map((store) => (
                <SelectItem key={store.id} value={String(store.id)}>
                  {store.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">Sale de esta sede ahora; la otra sede lo recibe en su inventario.</p>
        </div>
      ) : null}

      <div className="space-y-1">
        <Label htmlFor="waste-note">Nota (opcional)</Label>
        <Textarea id="waste-note" value={note} onChange={(event) => setNote(event.target.value)} />
      </div>

      <PhotoCaptureField value={photo} onChange={setPhoto} label="Foto (opcional)" disabled={mutation.isPending} />

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <div className="flex flex-col items-center gap-3 border-t pt-4">
        <p className="text-sm text-muted-foreground">Tu PIN confirma el registro</p>
        <PinPad
          length={4}
          label="Tu PIN para confirmar la merma"
          disabled={mutation.isPending || !canConfirm}
          onSubmit={(pin) => mutation.mutate(pin)}
        />
      </div>
    </div>
  )
}

export default WastePage
