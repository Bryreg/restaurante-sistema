import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"

import { switchPreparationMode, type PreparationAdminOut, type PrepMode } from "@/api/recipes"
import { ConsequenceZone } from "@/components/admin"
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
 *
 * **Las dos direcciones no son el mismo peligro** (patrón 11, y es el
 * ejemplo que el patrón usa para justificar que haya dos niveles):
 * - salir de «por lote» **cierra los lotes abiertos con un ajuste de conteo
 *   y no se deshace solo** → zona ROJA;
 * - entrar a «por lote» no pierde nada: a partir de ahí hay que producirla,
 *   y si nadie lo hace queda en negativo → zona ÁMBAR.
 *
 * Con las dos en rojo —como estaban, las dos en un `Alert` destructivo— el
 * rojo deja de querer decir «esto no se deshace». El peligro va en el marco;
 * lo que se toca acá es el PIN.
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
  const leavingBatch = preparation.mode === "batch"
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

        <ConsequenceZone
          level={leavingBatch ? "irreversible" : "reversible"}
          title={leavingBatch ? "Esto cierra los lotes abiertos" : "Vas a necesitar producirla"}
          scope={preparation.name}
          explanation={
            leavingBatch ? (
              <>
                Salir de «por lote» cierra cualquier lote abierto de esta preparación con un ajuste de conteo
                (<code>count_adjustment</code>): el stock que quedara pendiente se da de baja y{" "}
                <b>no se puede deshacer solo</b>. A partir de acá, enviar un plato que la usa descuenta los
                insumos directamente, sin pasar por producción.
              </>
            ) : (
              <>
                En modo «por lote» esta preparación deja de descontarse sola al enviar un plato:{" "}
                <b>alguien tiene que producirla</b> (Salón › Producir) para que tenga stock. Si nadie la
                produce, queda en negativo y sus insumos se ven sobrevalorados. No se pierde nada: volver a
                «explotada» es otro cambio de modo.
              </>
            )
          }
        >
          <div className="flex flex-col items-center gap-3">
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
        </ConsequenceZone>
      </DialogContent>
    </Dialog>
  )
}
