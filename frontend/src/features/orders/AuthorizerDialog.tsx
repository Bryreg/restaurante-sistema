import { useQuery } from "@tanstack/react-query"

import { listDeviceEmployees } from "@/api/employees"
import { useSession } from "@/app/session"
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
  const { me, hasFeature } = useSession()
  // **Toda autorización nombra a quién pedírsela** (`docs/diseno/propuesta.html`
  // § Reglas): con la fila esperando, «un supervisor» obliga a salir a
  // buscar quién es. La lista es la misma del «¿quién opera?» del
  // dispositivo; el servidor sigue siendo el que valida el PIN. Todas las
  // acciones que abren este diálogo las puede autorizar un supervisor si la
  // función `roles.supervisor` está prendida (`SUPERVISOR_ACTIONS`); si no,
  // sólo un administrador.
  const employees = useQuery({
    queryKey: ["device", "employees"] as const,
    queryFn: listDeviceEmployees,
    enabled: open && me?.kind === "device",
  })
  const roles = hasFeature("roles.supervisor") ? ["admin", "supervisor"] : ["admin"]
  const quienes = (employees.data ?? []).filter((e) => roles.includes(e.role)).map((e) => e.name)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>PIN de supervisor o administrador</DialogTitle>
          <DialogDescription>
            {reason ?? "Esta acción necesita autorización."}
          </DialogDescription>
          {quienes.length > 0 ? (
            <p className="text-sm">
              Pedíselo a <b>{quienes.join(" · ")}</b>: que teclee su PIN acá.
            </p>
          ) : null}
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
