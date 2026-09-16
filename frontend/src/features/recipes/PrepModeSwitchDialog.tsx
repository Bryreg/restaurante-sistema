import { useMutation, useQueryClient } from "@tanstack/react-query"
import { AlertTriangle } from "lucide-react"
import { useState } from "react"

import { switchPreparationMode, type PreparationAdminOut, type PrepMode } from "@/api/recipes"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { PinPad } from "@/components/PinPad"
import { errorMessage } from "@/lib/errors"

const MODE_LABEL: Record<PrepMode, string> = { batch: "Por lote", exploded: "Explotada" }

/**
 * `PATCH /admin/preparations/{id}/mode`: sólo administrador, con PIN (spec
 * §4.2 y §9.3 — "la pantalla avisa ANTES que salir de batch cierra los
 * lotes abiertos con un ajuste"). El PIN es lo único en este diálogo: no
 * conviven campos de texto libre con el teclado numérico, así que el
 * defecto conocido de `PinPad` (escucha `window` sin filtrar foco) no tiene
 * con qué colarse acá — a diferencia de la producción rápida del POS, que sí
 * lo mitiga explícitamente (ver `QuickProductionPage.tsx`).
 */
export function PrepModeSwitchDialog({
  preparation,
  open,
  onOpenChange,
}: {
  preparation: PreparationAdminOut
  open: boolean
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  const queryClient = useQueryClient()
  const targetMode: PrepMode = preparation.mode === "batch" ? "exploded" : "batch"
  const [error, setError] = useState<string | null>(null)

  const mutation = useMutation({
    mutationFn: (pin: string) => switchPreparationMode(preparation.id, { mode: targetMode, authorizer_pin: pin }),
    onSuccess: () => {
      setError(null)
      onOpenChange(false)
      void queryClient.invalidateQueries({ queryKey: ["recipes", "preparations"] })
      void queryClient.invalidateQueries({ queryKey: ["recipes", "prep-batches", preparation.id] })
    },
    onError: (err) => setError(errorMessage(err)),
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Cambiar «{preparation.name}» de {MODE_LABEL[preparation.mode]} a {MODE_LABEL[targetMode]}
          </DialogTitle>
        </DialogHeader>

        {preparation.mode === "batch" ? (
          <Alert variant="destructive">
            <AlertTriangle />
            <AlertTitle>Esto cierra los lotes abiertos</AlertTitle>
            <AlertDescription>
              Salir de «por lote» cierra cualquier lote abierto de esta preparación con un ajuste de conteo
              (`count_adjustment`): el stock que quedara pendiente se da de baja y no se puede deshacer solo. A partir
              de acá, enviar un plato que la usa descuenta los insumos directamente, sin pasar por producción.
            </AlertDescription>
          </Alert>
        ) : (
          <Alert>
            <AlertTriangle />
            <AlertTitle>Vas a necesitar producirla</AlertTitle>
            <AlertDescription>
              En modo «por lote» esta preparación deja de descontarse sola al enviar un plato: alguien tiene que
              producirla (POS/cocina → Producir) para que tenga stock. Si nadie la produce, queda en negativo y sus
              insumos se ven sobrevalorados.
            </AlertDescription>
          </Alert>
        )}

        <div className="flex flex-col items-center gap-3 pt-2">
          <p className="text-sm text-muted-foreground">PIN de administrador para confirmar</p>
          <PinPad
            length={4}
            label="PIN de administrador"
            disabled={mutation.isPending}
            errorMessage={error}
            onSubmit={(pin) => {
              setError(null)
              mutation.mutate(pin)
            }}
          />
        </div>
      </DialogContent>
    </Dialog>
  )
}
