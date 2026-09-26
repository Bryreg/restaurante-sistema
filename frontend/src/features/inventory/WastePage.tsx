import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { AlertTriangle } from "lucide-react"
import { useId, useRef, useState } from "react"
import { toast } from "sonner"

import { useSession } from "@/app/session"
import { ApiError, newIdempotencyKey } from "@/api/client"
import { listDeviceEmployees } from "@/api/employees"
import { listDeviceIngredients, listTransferStores, postWaste, type WasteType } from "@/api/inventory"
import { listDevicePreparations } from "@/api/recipes"
import { EmptyState } from "@/components/EmptyState"
import { PhotoCaptureField } from "@/components/PhotoCaptureField"
import { PinPad } from "@/components/PinPad"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Textarea } from "@/components/ui/textarea"
import { errorMessage } from "@/lib/errors"
import { cn } from "@/lib/utils"

import { unidadEnPlural } from "./areaCountLib"
import { WASTE_TYPE_LABEL } from "./lib"

type Kind = "ingredient" | "preparation"

/** En «¿Quién?» del consumo interno: una persona del equipo o un texto. */
const OTHER_CONSUMER = "other"

/** Una opción del buscador: insumo o preparación, con la unidad en que se teclea. */
interface Target {
  id: number
  name: string
  /** Lo que se escribe junto al campo: «kg», «botellas», «L», «unidades», «g». */
  unitLabel: string
  /** `entry_unit` del insumo: viaja con la cantidad y el servidor convierte. */
  entryUnit: string | undefined
}

/** Unidad base de una preparación, tal cual la guarda el servidor. */
const PREP_UNIT_LABEL: Record<string, string> = { g: "g", ml: "ml", unit: "unidades" }

/** Cuántos resultados muestra el buscador a la vez. */
const MAX_RESULTS = 8
const MAX_RECENT = 5
/**
 * Los últimos insumos/preparaciones elegidos en esta pantalla, en memoria:
 * duran lo que dura la app abierta en la tablet. No van a `localStorage`
 * (sólo el tema vive ahí, `lib/__tests__/noRawStorage.test.ts`).
 */
let recentKeys: string[] = []

function readRecent(): string[] {
  return recentKeys
}

function saveRecent(key: string): void {
  recentKeys = [key, ...recentKeys.filter((k) => k !== key)].slice(0, MAX_RECENT)
}

/** «Limón» se encuentra escribiendo «limon». */
function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
}

/**
 * Buscador de insumo o preparación: un campo de búsqueda, los recientes de
 * esta tablet y botones grandes. Reemplaza la lista desplegable de 58
 * insumos, que en la tablet obligaba a deslizar hasta encontrarlo.
 */
function TargetPicker({
  kind,
  options,
  selected,
  onSelect,
  disabled,
}: {
  kind: Kind
  options: Target[]
  selected: Target | null
  onSelect: (target: Target | null) => void
  disabled: boolean
}): React.JSX.Element {
  const searchId = useId()
  const [query, setQuery] = useState("")
  const title = kind === "ingredient" ? "Insumo" : "Preparación"

  if (selected !== null) {
    return (
      <div className="space-y-1">
        <p className="text-sm font-medium">{title}</p>
        <div className="flex items-center justify-between gap-3 rounded-md border bg-card px-3 py-2">
          <span className="text-base font-semibold">{selected.name}</span>
          <Button
            type="button"
            variant="outline"
            className="h-11"
            disabled={disabled}
            onClick={() => {
              setQuery("")
              onSelect(null)
            }}
          >
            Cambiar
          </Button>
        </div>
      </div>
    )
  }

  const q = normalize(query)
  const recent = readRecent()
    .map((key) => options.find((o) => `${kind}:${o.id}` === key))
    .filter((o): o is Target => o !== undefined)
  const matches = q === "" ? [] : options.filter((o) => normalize(o.name).includes(q))
  // Sin búsqueda, lo reciente no se repite en la lista de abajo.
  const shown =
    q === ""
      ? options.filter((o) => !recent.includes(o)).slice(0, MAX_RESULTS)
      : matches.slice(0, MAX_RESULTS)
  const optionButton = (o: Target) => (
    <Button
      key={o.id}
      type="button"
      variant="outline"
      className="h-12 justify-start px-3 text-left text-base"
      disabled={disabled}
      onClick={() => {
        saveRecent(`${kind}:${o.id}`)
        onSelect(o)
      }}
    >
      {o.name}
    </Button>
  )

  return (
    <div className="space-y-2">
      <Label htmlFor={searchId}>{kind === "ingredient" ? "Buscar insumo" : "Buscar preparación"}</Label>
      <Input
        id={searchId}
        type="search"
        className="h-11"
        placeholder="Escribí parte del nombre"
        autoComplete="off"
        value={query}
        disabled={disabled}
        onChange={(event) => setQuery(event.target.value)}
      />
      {q === "" && recent.length > 0 ? (
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">Recientes</p>
          <div className="grid grid-cols-2 gap-2">{recent.map(optionButton)}</div>
        </div>
      ) : null}
      {options.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {kind === "ingredient" ? "No hay insumos activos." : "No hay preparaciones activas."}
        </p>
      ) : q !== "" && matches.length === 0 ? (
        <p className="text-sm text-muted-foreground">Ninguno coincide con «{query.trim()}».</p>
      ) : shown.length === 0 ? null : (
        <div className="space-y-1">
          {q === "" ? (
            <p className="text-xs text-muted-foreground">
              {options.length > MAX_RESULTS
                ? `Los primeros ${MAX_RESULTS} de ${options.length}: escribí para buscar el resto.`
                : "Tocá uno:"}
            </p>
          ) : matches.length > MAX_RESULTS ? (
            <p className="text-xs text-muted-foreground">
              {matches.length} coinciden: escribí un poco más para acotar.
            </p>
          ) : null}
          <div className="grid grid-cols-2 gap-2">{shown.map(optionButton)}</div>
        </div>
      )}
    </div>
  )
}

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
  const [target, setTarget] = useState<Target | null>(null)
  const [qty, setQty] = useState("")
  const [type, setType] = useState<WasteType | "">("")
  const [note, setNote] = useState("")
  const [photo, setPhoto] = useState<string | null>(null)
  // Mientras la foto se achica no se confirma: saldría sin la foto elegida.
  const [photoProcessing, setPhotoProcessing] = useState(false)
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
          ingredient_id: kind === "ingredient" ? (target?.id ?? null) : null,
          preparation_id: kind === "preparation" ? (target?.id ?? null) : null,
          // La cantidad va tal cual, en la unidad que se ve junto al campo;
          // la conversión a la unidad base la hace el servidor.
          qty: qty.trim(),
          ...(kind === "ingredient" && target?.entryUnit ? { entry_unit: target.entryUnit } : {}),
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
      setTarget(null)
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
  const options: Target[] =
    kind === "ingredient"
      ? ingredients.map((i) => ({
          id: i.id,
          name: i.name,
          unitLabel: unidadEnPlural(i.entry_unit),
          entryUnit: i.entry_unit,
        }))
      : preparations.map((p) => ({
          id: p.id,
          name: p.name,
          unitLabel: PREP_UNIT_LABEL[p.standard_yield_unit] ?? p.standard_yield_unit,
          entryUnit: undefined,
        }))
  const typeOptions = (Object.entries(WASTE_TYPE_LABEL) as [WasteType, string][]).filter(
    ([value]) => value !== "transfer_out" || canTransfer,
  )
  const consumerReady =
    type !== "internal_use" || (consumer === OTHER_CONSUMER ? consumerName.trim() !== "" : consumer !== "")
  const destinationReady = type !== "transfer_out" || destinationId !== null
  const canConfirm =
    target !== null && qty.trim() !== "" && type !== "" && consumerReady && destinationReady && !photoProcessing

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
            setTarget(null)
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

      <TargetPicker
        key={kind}
        kind={kind}
        options={options}
        selected={target}
        onSelect={setTarget}
        disabled={mutation.isPending}
      />

      <div className="space-y-1">
        <Label htmlFor="waste-qty">Cantidad</Label>
        <div className="flex items-center gap-2">
          <Input
            id="waste-qty"
            inputMode="decimal"
            className="h-11 w-40 text-lg tabular-nums"
            value={qty}
            aria-describedby={target ? "waste-qty-unit" : undefined}
            onChange={(event) => setQty(event.target.value)}
          />
          {target ? (
            <span id="waste-qty-unit" className="text-base font-medium">
              {target.unitLabel}
            </span>
          ) : null}
        </div>
        {target === null ? (
          <p className="text-xs text-muted-foreground">Elegí primero qué se perdió: la unidad aparece acá.</p>
        ) : null}
      </div>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Tipo</legend>
        <div className="grid grid-cols-2 gap-2">
          {typeOptions.map(([value, label]) => (
            <Button
              key={value}
              type="button"
              variant={type === value ? "default" : "outline"}
              aria-pressed={type === value}
              className={cn("h-auto min-h-14 whitespace-normal px-3 text-base")}
              disabled={mutation.isPending}
              onClick={() => {
                setType(value)
                // Un traslado es sólo de insumos: las preparaciones son de cada sede.
                if (value === "transfer_out" && kind === "preparation") {
                  setKind("ingredient")
                  setTarget(null)
                }
              }}
            >
              {label}
            </Button>
          ))}
        </div>
      </fieldset>

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

      <PhotoCaptureField
        value={photo}
        onChange={setPhoto}
        label="Foto (opcional)"
        disabled={mutation.isPending}
        onProcessingChange={setPhotoProcessing}
      />

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
