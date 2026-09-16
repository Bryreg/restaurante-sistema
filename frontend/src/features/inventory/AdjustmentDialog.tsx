import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useRef, useState } from "react"
import { toast } from "sonner"

import { ApiError, newIdempotencyKey } from "@/api/client"
import { postInventoryAdjustment, type IngredientOut } from "@/api/inventory"
import { PinPad } from "@/components/PinPad"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { errorMessage } from "@/lib/errors"

/**
 * Ajuste manual de inventario (`POST /admin/inventory/adjustments`,
 * SPEC-NEGOCIO §5.1: `cause = manual_adjustment`). Exige PIN de
 * administrador (el mismo que ya inició sesión — el servicio re-confirma su
 * identidad, no la de otra persona) y `Idempotency-Key`, renovada en cada
 * intento salvo cuando el error es `409` (misma clave en vuelo: cambiarla
 * ahí dejaría que un reintento duplique el ajuste — mismo patrón que
 * `QuickProductionPage.tsx`, territorio de `frontend-recetas`).
 */
export function AdjustmentDialog({ storeId, ingredients }: { storeId: number; ingredients: IngredientOut[] }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [ingredientId, setIngredientId] = useState<number | null>(null)
  const [qtyDelta, setQtyDelta] = useState("")
  const [reason, setReason] = useState("")
  const idempotencyKeyRef = useRef(newIdempotencyKey())
  const queryClient = useQueryClient()

  const mutation = useMutation({
    mutationFn: (pin: string) => {
      if (ingredientId === null) throw new Error("Elegí un insumo primero")
      return postInventoryAdjustment(
        storeId,
        { ingredient_id: ingredientId, qty_delta: qtyDelta.trim(), reason: reason.trim(), authorizer_pin: pin },
        idempotencyKeyRef.current,
      )
    },
    onSuccess: () => {
      toast.success("Ajuste registrado.")
      setOpen(false)
      setIngredientId(null)
      setQtyDelta("")
      setReason("")
      idempotencyKeyRef.current = newIdempotencyKey()
      void queryClient.invalidateQueries({ queryKey: ["inventory", "stock"] })
      void queryClient.invalidateQueries({ queryKey: ["inventory", "movements"] })
    },
    onError: (err) => {
      if (!(err instanceof ApiError) || err.status !== 409) {
        idempotencyKeyRef.current = newIdempotencyKey()
      }
    },
  })

  const canConfirm = ingredientId !== null && qtyDelta.trim() !== "" && reason.trim() !== ""

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) mutation.reset()
      }}
    >
      <DialogTrigger render={<Button variant="outline" />}>Ajuste manual</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Ajuste manual de inventario</DialogTitle>
          <DialogDescription>
            Queda registrado como movimiento con causa «Ajuste manual» y tu PIN de administrador como autorizador.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1">
            <Label htmlFor="adj-ingredient">Insumo</Label>
            <Select value={ingredientId === null ? undefined : String(ingredientId)} onValueChange={(v) => setIngredientId(Number(v))}>
              <SelectTrigger id="adj-ingredient" className="w-full">
                <SelectValue placeholder="Elegí un insumo" />
              </SelectTrigger>
              <SelectContent>
                {ingredients.map((ingredient) => (
                  <SelectItem key={ingredient.id} value={String(ingredient.id)}>
                    {ingredient.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="adj-qty-delta">Cantidad (con signo)</Label>
            <Input
              id="adj-qty-delta"
              inputMode="decimal"
              placeholder="-500 sale, 500 entra"
              value={qtyDelta}
              onChange={(event) => setQtyDelta(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">Positivo entra, negativo sale — en la unidad de uso del insumo.</p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="adj-reason">Motivo</Label>
            <Textarea id="adj-reason" required value={reason} onChange={(event) => setReason(event.target.value)} />
          </div>

          {mutation.isError ? (
            <p role="alert" className="text-sm text-destructive">
              {errorMessage(mutation.error)}
            </p>
          ) : null}

          <PinPad
            length={4}
            label="Tu PIN de administrador"
            disabled={mutation.isPending || !canConfirm}
            onSubmit={(pin) => mutation.mutate(pin)}
          />
        </div>
      </DialogContent>
    </Dialog>
  )
}

export default AdjustmentDialog
