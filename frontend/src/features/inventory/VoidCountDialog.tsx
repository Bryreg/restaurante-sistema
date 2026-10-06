import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useRef, useState } from "react"
import { toast } from "sonner"

import { ApiError, newIdempotencyKey } from "@/api/client"
import { voidCount, type CountOut } from "@/api/inventory"
import { PinPad } from "@/components/PinPad"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { errorMessage } from "@/lib/errors"

/**
 * **Anular un conteo** (`POST /admin/counts/{id}/void`). No borra nada: cada
 * ajuste que el conteo escribió en el libro recibe su movimiento contrario, y
 * el conteo queda marcado como anulado con quién, cuándo y por qué. Pide
 * motivo y el PIN del administrador, igual que aplicarlo.
 */
export function VoidCountDialog({
  storeId,
  count,
  onClose,
}: {
  storeId: number
  count: CountOut | null
  onClose: () => void
}): React.JSX.Element {
  const [reason, setReason] = useState("")
  const keyRef = useRef(newIdempotencyKey())
  const queryClient = useQueryClient()

  const mutation = useMutation({
    mutationFn: (pin: string) => {
      if (!count) throw new Error("Elegí un conteo")
      return voidCount(count.id, storeId, { reason: reason.trim(), authorizer_pin: pin }, keyRef.current)
    },
    onSuccess: () => {
      toast.success(`Conteo #${count?.id} anulado. Sus ajustes se revirtieron en el libro.`)
      setReason("")
      keyRef.current = newIdempotencyKey()
      void queryClient.invalidateQueries({ queryKey: ["inventory"] })
      onClose()
    },
    onError: (err) => {
      if (!(err instanceof ApiError) || err.status !== 409) keyRef.current = newIdempotencyKey()
    },
  })

  const aplicado = count?.status === "applied"
  return (
    <Dialog
      open={count !== null}
      onOpenChange={(next) => {
        if (!next) {
          mutation.reset()
          onClose()
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Anular el conteo #{count?.id}</DialogTitle>
          <DialogDescription>
            {aplicado
              ? "Cada ajuste que este conteo hizo en el libro se revierte con un movimiento contrario: el stock vuelve a lo que decía sin él. Nada se borra; el conteo queda marcado como anulado."
              : "El conteo todavía no movió el stock: se marca como anulado y no se puede seguir capturando."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1">
            <Label htmlFor="void-count-reason">Motivo</Label>
            <Textarea
              id="void-count-reason"
              required
              value={reason}
              placeholder="Ej.: conteo cargado dos veces"
              onChange={(event) => setReason(event.target.value)}
            />
          </div>
          {mutation.isError ? (
            <p role="alert" className="text-sm text-destructive">
              {errorMessage(mutation.error)}
            </p>
          ) : null}
          <PinPad
            length={4}
            label="Tu PIN de administrador"
            disabled={mutation.isPending || reason.trim().length < 5}
            onSubmit={(pin) => mutation.mutate(pin)}
          />
        </div>
      </DialogContent>
    </Dialog>
  )
}

export default VoidCountDialog
