import { useEffect, useState } from "react"

import type { VoidReason } from "@/api/orders"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"

import { VOID_REASON_LABEL } from "./lib"

export interface VoidDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  onConfirm: (reason: VoidReason, note: string | undefined) => void
  pending?: boolean
  errorMessage?: string | null
}

/** Motivo tipado (+ nota obligatoria si `other`) — reutilizado por anular ítem y anular comanda. */
export function VoidDialog({
  open,
  onOpenChange,
  title,
  onConfirm,
  pending = false,
  errorMessage = null,
}: VoidDialogProps): React.JSX.Element {
  const [reason, setReason] = useState<VoidReason | "">("")
  const [note, setNote] = useState("")
  const [localError, setLocalError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setReason("")
    setNote("")
    setLocalError(null)
  }, [open])

  function handleConfirm() {
    if (reason === "") {
      setLocalError("Elegí un motivo.")
      return
    }
    if (reason === "other" && note.trim() === "") {
      setLocalError('El motivo "otro" necesita una nota.')
      return
    }
    setLocalError(null)
    onConfirm(reason, note.trim() === "" ? undefined : note.trim())
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1">
            <Label htmlFor="void-reason">Motivo</Label>
            <Select value={reason === "" ? undefined : reason} onValueChange={(value) => setReason(value as VoidReason)}>
              <SelectTrigger id="void-reason" className="h-11 w-full">
                <SelectValue placeholder="Elegí un motivo" />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(VOID_REASON_LABEL).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="void-note">Nota {reason === "other" ? "(obligatoria)" : "(opcional)"}</Label>
            <Textarea id="void-note" value={note} onChange={(event) => setNote(event.target.value)} />
          </div>
          {(localError ?? errorMessage) ? (
            <p role="alert" className="text-sm text-destructive">
              {localError ?? errorMessage}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button type="button" variant="destructive" className="h-11" disabled={pending} onClick={handleConfirm}>
            {pending ? "Anulando…" : "Anular"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default VoidDialog
