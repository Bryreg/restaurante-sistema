import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { AlertTriangle, ChefHat } from "lucide-react"
import { useRef, useState } from "react"
import { toast } from "sonner"

import { useSession } from "@/app/session"
import { ApiError, newIdempotencyKey } from "@/api/client"
import { listDevicePreparations, producePreparation, type PreparationDeviceOut } from "@/api/recipes"
import { EmptyState } from "@/components/EmptyState"
import { PinPad } from "@/components/PinPad"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import { errorMessage } from "@/lib/errors"
import { cn } from "@/lib/utils"

/**
 * Producción rápida en DOS TOQUES (spec §4.2, la línea que decide si el
 * módulo se usa o se abandona): TOQUE 1 = tocar la preparación (la cantidad
 * ya viene precargada en el rendimiento estándar); TOQUE 2 = el cuarto
 * dígito del PIN, que auto-envía — no hay una tercera pantalla ni un botón
 * "Confirmar" aparte. Sólo se ofrecen preparaciones en modo `batch`: las
 * `exploded` no se producen (`400 PREP_NOT_BATCH`), se descuentan solas al
 * enviar el plato, así que ni aparecen acá.
 *
 * Ruta de dispositivo: nunca pinta costo ni margen (ni `PreparationDeviceOut`
 * ni `ProduceOut` los tienen — el operador no los recibe, AGENTS.md).
 */
export function QuickProductionPage(): React.JSX.Element {
  const { hasFeature, me } = useSession()
  const queryClient = useQueryClient()
  const enabled = hasFeature("catalog.preps")

  const [selected, setSelected] = useState<PreparationDeviceOut | null>(null)
  const [qtyReal, setQtyReal] = useState("")
  const [qtyFocused, setQtyFocused] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const idempotencyKeyRef = useRef(newIdempotencyKey())

  const preparationsQuery = useQuery({
    queryKey: ["device", "preparations"],
    queryFn: listDevicePreparations,
    enabled,
    refetchInterval: 8_000,
  })

  const mutation = useMutation({
    mutationFn: (pin: string) => {
      if (selected === null) throw new Error("Elegí una preparación primero")
      return producePreparation(
        selected.id,
        { qty_expected: selected.prefilled_qty, qty_real: qtyReal.trim(), employee_pin: pin },
        idempotencyKeyRef.current,
      )
    },
    onSuccess: (out) => {
      setError(null)
      if (out.variance_alert) {
        toast.warning(
          `Producido, pero el real (${out.qty_real} ${out.unit}) se aparta más de 15 % del esperado (${out.qty_expected} ${out.unit}).`,
        )
      } else {
        toast.success(`«${selected?.name}» producido: ${out.qty_real} ${out.unit}.`)
      }
      setSelected(null)
      setQtyReal("")
      idempotencyKeyRef.current = newIdempotencyKey()
      void queryClient.invalidateQueries({ queryKey: ["device", "preparations"] })
    },
    onError: (err) => {
      // `409 IDEMPOTENCY_IN_PROGRESS` (doble toque, misma clave en vuelo):
      // la clave se mantiene a propósito — cambiarla acá dejaría que un
      // reintento accidental duplique el lote en vez de esperar la réplica
      // de la primera request. Cualquier otro error es terminal para este
      // intento: clave nueva para el próximo, si no un reintento con un PIN
      // distinto pisa el mismo cuerpo y el servidor lo rechaza con
      // `IDEMPOTENCY_MISMATCH` en vez de con el error real.
      if (!(err instanceof ApiError) || err.status !== 409) {
        idempotencyKeyRef.current = newIdempotencyKey()
      }
      setError(errorMessage(err))
    },
  })

  if (!enabled) {
    return (
      <EmptyState
        title="Producción de preparaciones no está habilitada"
        description="Activá «Preparaciones en dos modos» en Admin → Funciones."
      />
    )
  }

  if (preparationsQuery.isLoading) {
    return (
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {Array.from({ length: 6 }).map((_, index) => (
          <Skeleton key={index} className="h-24 w-full rounded-md" />
        ))}
      </div>
    )
  }
  if (preparationsQuery.isError) {
    return (
      <EmptyState
        role="alert"
        icon={AlertTriangle}
        title="No se pudo cargar la lista"
        description={errorMessage(preparationsQuery.error)}
        action={{ label: "Reintentar", onClick: () => void preparationsQuery.refetch() }}
      />
    )
  }

  const producible = (preparationsQuery.data ?? []).filter((p) => p.mode === "batch")

  if (selected === null) {
    if (producible.length === 0) {
      return (
        <EmptyState
          icon={ChefHat}
          title="No hay preparaciones en modo lote"
          description="Sólo las preparaciones «por lote» se producen acá; las «explotadas» se descuentan solas al enviar el plato."
        />
      )
    }
    return (
      <div className="space-y-3">
        <h1 className="text-lg font-semibold">Producir</h1>
        <p className="text-sm text-muted-foreground">Tocá una preparación para producirla (toque 1 de 2).</p>
        <div role="radiogroup" aria-label="Preparaciones" className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {producible.map((prep) => (
            <button
              key={prep.id}
              type="button"
              className={cn(
                "flex min-h-24 flex-col items-center justify-center gap-1 rounded-md border p-3 text-center transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                "border-border bg-background hover:bg-muted",
              )}
              onClick={() => {
                setSelected(prep)
                setQtyReal(prep.prefilled_qty)
                setError(null)
              }}
            >
              <ChefHat className="size-6 text-muted-foreground" aria-hidden="true" />
              <span className="font-medium">{prep.name}</span>
              <span className="text-xs text-muted-foreground">
                Rinde {prep.prefilled_qty} {prep.standard_yield_unit}
              </span>
            </button>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="mx-auto flex max-w-sm flex-col items-center gap-5">
      <div className="w-full">
        <Button type="button" variant="ghost" size="sm" onClick={() => setSelected(null)} disabled={mutation.isPending}>
          ← Elegir otra
        </Button>
      </div>

      <div className="text-center">
        <h1 className="text-lg font-semibold">{selected.name}</h1>
        <p className="text-sm text-muted-foreground">{me?.employee?.name} está produciendo</p>
      </div>

      <div className="w-full space-y-1">
        <Label htmlFor="qty-real">Cantidad real obtenida</Label>
        <Input
          id="qty-real"
          inputMode="decimal"
          className="h-12 text-center text-lg"
          value={qtyReal}
          disabled={mutation.isPending}
          /*
           * Único campo de texto libre que convive con el `PinPad` en esta
           * pantalla: se precarga con el rendimiento estándar y sólo hace
           * falta tocarlo si la producción real dio otra cosa. El `PinPad`
           * (defecto conocido, ajeno: escucha `window` sin filtrar foco)
           * queda `disabled` mientras este campo tiene el foco, para que un
           * dígito tecleado acá no se cuele como dígito de PIN — la misma
           * mitigación que usó `frontend-cobro` en 1b-1
           * (`PaymentSplitsForm.tsx`), adaptada: acá el campo puede estar
           * vacío (no hay un "completo" que lo cierre solo), así que se
           * gobierna con el foco en vez de con un estado derivado.
           */
          onFocus={() => setQtyFocused(true)}
          onBlur={() => setQtyFocused(false)}
          onChange={(event) => setQtyReal(event.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          Precargada en el rendimiento estándar ({selected.prefilled_qty} {selected.standard_yield_unit}). Editala
          sólo si lo que salió de verdad fue distinto.
        </p>
      </div>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <div className="flex flex-col items-center gap-3 border-t pt-4">
        <p className="text-sm text-muted-foreground">Tu PIN confirma la producción (toque 2 de 2)</p>
        <PinPad
          length={4}
          label="Tu PIN para confirmar la producción"
          disabled={mutation.isPending || qtyFocused || qtyReal.trim() === ""}
          onSubmit={(pin) => mutation.mutate(pin)}
        />
      </div>
    </div>
  )
}
