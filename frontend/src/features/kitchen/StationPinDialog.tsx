import { useCallback, useState } from "react"

import { deviceIdentify } from "@/api/auth"
import type { DeviceEmployee } from "@/api/employees"
import { EmployeePicker } from "@/components/EmployeePicker"
import { PinPad } from "@/components/PinPad"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { errorMessage } from "@/lib/errors"

import type { StationPerson } from "./lib"

/**
 * El PIN rápido de la pantalla de cocina. Mirar el KDS no exige a nadie
 * identificado (manos sucias, guantes); marcar «Listo» o expedir sí, porque
 * queda a nombre de alguien. Si la persona venció, este teclado aparece con
 * quien usó la estación por última vez ya elegido: cuatro dígitos y la
 * acción sigue. Verifica con el mismo `POST /auth/device/identify` de
 * «Quién opera» — no hay otro camino de identidad.
 */
export function StationPinDialog({
  open,
  lastPerson,
  actionLabel,
  onIdentified,
  onCancel,
}: {
  open: boolean
  lastPerson: StationPerson | null
  /** Qué se va a hacer apenas se identifique, dicho para la persona («Marcar listo: Bandeja»). */
  actionLabel: string
  onIdentified: (person: StationPerson) => Promise<void>
  onCancel: () => void
}): React.JSX.Element {
  const [person, setPerson] = useState<StationPerson | null>(lastPerson)
  const [choosing, setChoosing] = useState(lastPerson === null)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const handlePin = useCallback(
    async (pin: string) => {
      if (!person) {
        setError("Elegí quién sos antes del PIN.")
        return
      }
      setSubmitting(true)
      setError(null)
      try {
        const out = await deviceIdentify({ employee_id: person.id, pin })
        await onIdentified({ id: out.employee.id, name: out.employee.name })
      } catch (err) {
        setError(errorMessage(err))
      } finally {
        setSubmitting(false)
      }
    },
    [person, onIdentified],
  )

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !submitting) onCancel()
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{person && !choosing ? `PIN de ${person.name}` : "¿Quién marca?"}</DialogTitle>
          <DialogDescription>{actionLabel} queda a tu nombre.</DialogDescription>
        </DialogHeader>

        {choosing ? (
          <EmployeePicker
            value={person?.id ?? null}
            label="Quién marca"
            disabled={submitting}
            onChange={(_id, next: DeviceEmployee) => {
              setPerson({ id: next.id, name: next.name })
              setChoosing(false)
              setError(null)
            }}
          />
        ) : (
          <>
            <PinPad
              length={4}
              label={person ? `PIN de ${person.name}` : "PIN personal"}
              onSubmit={(pin) => void handlePin(pin)}
              disabled={submitting || !person}
              errorMessage={error}
            />
            <Button
              type="button"
              variant="ghost"
              className="h-11"
              disabled={submitting}
              onClick={() => {
                setChoosing(true)
                setError(null)
              }}
            >
              {person ? `No soy ${person.name}` : "Elegir persona"}
            </Button>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
