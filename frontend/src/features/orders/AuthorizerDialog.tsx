import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { PinPad } from "@/components/PinPad"

export interface AuthorizerDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (pin: string) => void
  pending?: boolean
  errorMessage?: string | null
  /** Motivo por el que se pide el PIN — CONTRATO-INTERNO §6.3: siempre se explica. */
  reason?: string
}

/**
 * Diálogo único para los tres códigos que exigen autorizador
 * (`AUTHORIZATION_REQUIRED`, `DISCOUNT_LIMIT_EXCEEDED`,
 * `BILL_PRESENTED_NEEDS_AUTH`) — CONTRATO-INTERNO-1b-1.md §6.3. Quien lo usa
 * reintenta la MISMA acción con `authorizer_pin` y una `Idempotency-Key`
 * nueva cuando corresponda.
 */
export function AuthorizerDialog({
  open,
  onOpenChange,
  onSubmit,
  pending = false,
  errorMessage = null,
  reason,
}: AuthorizerDialogProps): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>PIN de supervisor o administrador</DialogTitle>
          <DialogDescription>
            {reason ?? "Esta acción necesita autorización."}
          </DialogDescription>
        </DialogHeader>
        <PinPad
          length={4}
          label="PIN de supervisor o administrador"
          disabled={pending}
          onSubmit={onSubmit}
          errorMessage={errorMessage}
        />
      </DialogContent>
    </Dialog>
  )
}
