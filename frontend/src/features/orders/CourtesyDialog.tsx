import { useEffect, useState } from "react"

import type { CourtesyReason } from "@/api/orders"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { PinPad } from "@/components/PinPad"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"

import { COURTESY_REASON_LABEL } from "./lib"

export interface CourtesyDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: (reason: CourtesyReason, note: string | undefined, pin: string) => void
  pending?: boolean
  errorMessage?: string | null
}

/**
 * Cortesía (`pos.courtesies`): motivo + PIN de autorizador, los dos
 * obligatorios desde el propio diálogo (`CourtesyItemIn.authorizer_pin` no es
 * opcional en el backend — CONTRATO-INTERNO §2.4).
 */
export function CourtesyDialog({
  open,
  onOpenChange,
  onConfirm,
  pending = false,
  errorMessage = null,
}: CourtesyDialogProps): React.JSX.Element {
  const [reason, setReason] = useState<CourtesyReason | "">("")
  const [note, setNote] = useState("")
  const [localError, setLocalError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setReason("")
    setNote("")
    setLocalError(null)
  }, [open])

  function handlePin(pin: string) {
    if (reason === "") {
      setLocalError("Elegí un motivo antes del PIN.")
      return
    }
    setLocalError(null)
    onConfirm(reason, note.trim() === "" ? undefined : note.trim(), pin)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Cortesía</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1">
            <Label htmlFor="courtesy-reason">Motivo</Label>
            <Select value={reason === "" ? undefined : reason} onValueChange={(value) => setReason(value as CourtesyReason)}>
              <SelectTrigger id="courtesy-reason" className="h-11 w-full">
                <SelectValue placeholder="Elegí un motivo" />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(COURTESY_REASON_LABEL).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="courtesy-note">Nota (opcional)</Label>
            <Textarea id="courtesy-note" value={note} onChange={(event) => setNote(event.target.value)} />
          </div>
          <PinPad
            length={4}
            label="PIN de autorizador"
            disabled={pending}
            onSubmit={handlePin}
            errorMessage={localError ?? errorMessage}
          />
        </div>
      </DialogContent>
    </Dialog>
  )
}

export default CourtesyDialog
