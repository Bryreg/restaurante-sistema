import { ShieldCheck } from "lucide-react"
import { useEffect, useState } from "react"

import type { VoidReason } from "@/api/orders"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"

import { VOID_NEEDS_PIN_TEXT, VOID_REASON_LABEL } from "./lib"

export interface VoidDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  onConfirm: (reason: VoidReason, note: string | undefined) => void
  pending?: boolean
  errorMessage?: string | null
  /**
   * Lo que se anula ya salió a cocina: el servidor va a pedir el PIN de un
   * supervisor. Se dice ANTES de elegir el motivo, con el texto exacto, para
   * que el mesero lo llame de una vez y no se entere por un error rojo.
   */
  needsAuthorizer?: boolean
}


/**
 * Motivo tipado (+ nota obligatoria si `other`) — reutilizado por anular ítem
 * y anular comanda. Los motivos son botones de 56 px, no una lista
 * desplegable: en la tablet se eligen de un toque.
 */
export function VoidDialog({
  open,
  onOpenChange,
  title,
  onConfirm,
  pending = false,
  errorMessage = null,
  needsAuthorizer = false,
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
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {needsAuthorizer ? (
            <DialogDescription className="flex items-center gap-2 font-medium text-foreground">
              <ShieldCheck className="size-4 shrink-0" aria-hidden="true" />
              {VOID_NEEDS_PIN_TEXT}
            </DialogDescription>
          ) : null}
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <p className="text-sm font-medium" id="void-reason-label">
              Motivo
            </p>
            <div role="radiogroup" aria-label="Elegí un motivo" className="grid grid-cols-2 gap-2">
              {Object.entries(VOID_REASON_LABEL).map(([value, label]) => {
                const active = reason === value
                return (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    className={cn(
                      "min-h-14 rounded-lg border px-3 py-2 text-left text-base font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring",
                      active ? "border-primary bg-primary text-primary-foreground" : "border-border bg-background hover:bg-muted",
                    )}
                    onClick={() => {
                      setReason(value as VoidReason)
                      setLocalError(null)
                    }}
                  >
                    {label}
                  </button>
                )
              })}
            </div>
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
          <Button type="button" variant="destructive" className="h-14 px-6 text-base" disabled={pending} onClick={handleConfirm}>
            {pending ? "Anulando…" : "Anular"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default VoidDialog
