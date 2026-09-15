import { useEffect, useState } from "react"

import type { DiscountKind, DiscountReason } from "@/api/orders"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"

import { DISCOUNT_REASON_LABEL } from "./lib"

export interface DiscountDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  onConfirm: (kind: DiscountKind, value: number, reason: DiscountReason, note: string | undefined) => void
  pending?: boolean
  errorMessage?: string | null
}

/**
 * Descuento por ítem o por comanda (`pos.discounts`): motivo tipado, monto o
 * porcentaje. El PIN de autorizador (si `DISCOUNT_LIMIT_EXCEEDED`) lo pide
 * `AuthorizerDialog` afuera, reintentando la misma acción — este diálogo
 * nunca calcula el descuento resultante, sólo junta lo que la persona eligió.
 */
export function DiscountDialog({
  open,
  onOpenChange,
  title,
  onConfirm,
  pending = false,
  errorMessage = null,
}: DiscountDialogProps): React.JSX.Element {
  const [kind, setKind] = useState<DiscountKind>("percent")
  const [value, setValue] = useState("")
  const [reason, setReason] = useState<DiscountReason | "">("")
  const [note, setNote] = useState("")
  const [localError, setLocalError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setKind("percent")
    setValue("")
    setReason("")
    setNote("")
    setLocalError(null)
  }, [open])

  function handleConfirm() {
    const numericValue = Number(value)
    if (value.trim() === "" || Number.isNaN(numericValue) || numericValue <= 0) {
      setLocalError("Ingresá un valor mayor a cero.")
      return
    }
    // O-1 (auditor-venta, `features/fase-1b-venta/outputs-1b-1/auditor-venta.md
    // § 3`): un `Math.round` silencioso mandaba "10,6 %" como "11 %" sin que el
    // operador viera que su número cambió. El backend espera un entero
    // (`value: int`) — se lo pedimos explícito acá en vez de redondearlo solos.
    if (!Number.isInteger(numericValue)) {
      setLocalError(
        kind === "percent"
          ? "Ingresá un porcentaje entero, sin decimales (por ejemplo 10, no 10,6)."
          : "Ingresá un monto entero, sin decimales.",
      )
      return
    }
    if (reason === "") {
      setLocalError("Elegí un motivo.")
      return
    }
    setLocalError(null)
    onConfirm(kind, numericValue, reason, note.trim() === "" ? undefined : note.trim())
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1">
            <Label htmlFor="discount-kind">Tipo</Label>
            <Select value={kind} onValueChange={(value) => setKind(value as DiscountKind)}>
              <SelectTrigger id="discount-kind" className="h-11 w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="percent">Porcentaje</SelectItem>
                <SelectItem value="amount">Monto fijo</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="discount-value">{kind === "percent" ? "Porcentaje (%)" : "Monto ($)"}</Label>
            <Input
              id="discount-value"
              type="number"
              min={1}
              step={1}
              className="h-11"
              inputMode="numeric"
              aria-describedby={localError ?? errorMessage ? "discount-value-error" : undefined}
              value={value}
              onChange={(event) => setValue(event.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="discount-reason">Motivo</Label>
            <Select value={reason === "" ? undefined : reason} onValueChange={(value) => setReason(value as DiscountReason)}>
              <SelectTrigger id="discount-reason" className="h-11 w-full">
                <SelectValue placeholder="Elegí un motivo" />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(DISCOUNT_REASON_LABEL).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="discount-note">Nota (opcional)</Label>
            <Textarea id="discount-note" value={note} onChange={(event) => setNote(event.target.value)} />
          </div>
          {(localError ?? errorMessage) ? (
            <p id="discount-value-error" role="alert" className="text-sm text-destructive">
              {localError ?? errorMessage}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button type="button" className="h-11" disabled={pending} onClick={handleConfirm}>
            {pending ? "Aplicando…" : "Aplicar descuento"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default DiscountDialog
