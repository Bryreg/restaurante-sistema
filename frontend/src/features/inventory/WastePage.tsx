import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { AlertTriangle } from "lucide-react"
import { useRef, useState } from "react"
import { toast } from "sonner"

import { useSession } from "@/app/session"
import { ApiError, newIdempotencyKey } from "@/api/client"
import { listDeviceIngredients, postWaste, type WasteType } from "@/api/inventory"
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
        },
        idempotencyKeyRef.current,
      ),
    onSuccess: () => {
      toast.success("Merma registrada.")
      setError(null)
      setTargetId(null)
      setQty("")
      setType("")
      setNote("")
      setPhoto(null)
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
  const canConfirm = targetId !== null && qty.trim() !== "" && type !== ""

  return (
    <div className="mx-auto max-w-md space-y-5">
      <div>
        <h1 className="text-lg font-semibold">Registrar merma</h1>
        <p className="text-sm text-muted-foreground">
          Vencido, sobreproducción, error de cocina, rotura, devolución, degustación, cortesía sin plato o sin
          identificar. El consumo de personal no es una merma: usá una comanda de consumo de personal.
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
            <SelectItem value="preparation">Una preparación</SelectItem>
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
        <Select value={type} onValueChange={(value) => setType(value as WasteType)}>
          <SelectTrigger id="waste-type" className="h-11 w-full">
            <SelectValue placeholder="Elegí un tipo" />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(WASTE_TYPE_LABEL).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

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
