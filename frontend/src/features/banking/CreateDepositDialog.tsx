/**
 * Registrar una consignación (T1, spec.md § contrato de API mínimo:
 * `POST /admin/deposits`). Se abre desde "Consignaciones" (sin turnos
 * preseleccionados) o desde una fila de "Por consignar" (con el turno de esa
 * fila ya puesto) — ver `DepositsTab`/`PendingDepositsTab`.
 *
 * Campos verificados por lectura directa de `backend/app/banking/schemas.py::
 * DepositIn` (no adivinados): `amount` es un campo PROPIO — el monto del
 * comprobante del banco, el que la persona tipea mirando el papel — y
 * `allocations` (`[{shift_id, amount}]`, `default_factory=list`) es
 * OPCIONAL: imputa parte (o nada) de esa consignación a turnos cerrados
 * concretos. **El monto NUNCA sale de sumar las imputaciones** (era el
 * defecto de C5/H-6: con `allocations: []` obligatorias, la plata que la
 * mano del dueño retira, guarda y consigna días después —sin turno al que
 * imputarla todavía— no se podía registrar). El comprobante
 * (`receipt_photo`) es OBLIGATORIO: el servidor rechaza una consignación sin
 * foto.
 *
 * El monto de cada turno imputado también lo tipea la persona — nunca se
 * autocompleta con `to_deposit` ni con el total, para no confundir "lo que
 * el sistema espera" con "lo que efectivamente se llevó al banco".
 */
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useRef, useState } from "react"

import { newIdempotencyKey } from "@/api/client"
import { createDeposit, type DepositOut } from "@/api/banking"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { DesdeHacia } from "@/components/DesdeHacia"
import { MoneyInput } from "@/components/MoneyInput"
import { PhotoCaptureField } from "@/components/PhotoCaptureField"
import { errorMessage } from "@/lib/errors"
import { formatCOP } from "@/lib/money"

import { todayLocal } from "./lib"

type TriggerVariant = "default" | "outline" | "secondary" | "ghost" | "destructive" | "link"

interface AllocationDraft {
  shiftId: string
  amount: number | null
}

function emptyAllocation(shiftId = ""): AllocationDraft {
  return { shiftId, amount: null }
}

/** De dónde sale la plata consignada, en palabras: los turnos nombrados, o la mano del dueño. */
function desdeConsignacion(turnos: string[]): string {
  if (turnos.length === 0) return "La mano del dueño"
  if (turnos.length === 1) return `El efectivo del turno ${turnos[0]}`
  return `El efectivo de los turnos ${turnos.join(", ")}`
}

export function CreateDepositDialog({
  storeId,
  triggerLabel = "Registrar consignación",
  triggerVariant = "default",
  initialShiftIds,
  onCreated,
}: {
  storeId: number
  triggerLabel?: string
  triggerVariant?: TriggerVariant
  initialShiftIds?: number[]
  onCreated?: (deposit: DepositOut) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [businessDate, setBusinessDate] = useState(todayLocal())
  const [bankName, setBankName] = useState("")
  const [bankReference, setBankReference] = useState("")
  const [amount, setAmount] = useState<number | null>(null)
  const [allocations, setAllocations] = useState<AllocationDraft[]>(
    (initialShiftIds ?? []).length > 0 ? (initialShiftIds ?? []).map((id) => emptyAllocation(String(id))) : [emptyAllocation()],
  )
  const [photo, setPhoto] = useState<string | null>(null)
  const idempotencyKeyRef = useRef(newIdempotencyKey())
  const queryClient = useQueryClient()

  // Filas con id de turno vacío (o monto sin tipear) se descartan en
  // silencio: son imputaciones a medio llenar, no un error — la fila que
  // vino de "Consignar" desde un turno concreto sigue siendo la única
  // obligatoria de facto, y ni siquiera ésa bloquea si la persona la borra.
  const validAllocations = allocations
    .map((a) => ({ shift_id: Number(a.shiftId), amount: a.amount }))
    .filter((a) => Number.isInteger(a.shift_id) && a.shift_id > 0 && a.amount !== null && a.amount > 0) as {
    shift_id: number
    amount: number
  }[]
  // Acá NO se calcula ningún remanente. Se intentó como "ayuda de captura,
  // no es una cifra del sistema", y un invariante lo marcó con razón: una
  // diferencia de plata restada en el cliente es una segunda matemática por
  // más que se la rotule (AGENTS.md § "una sola matemática, en el backend").
  // Quien manda es el servidor: rechaza con `ALLOCATION_EXCEEDS_DEPOSIT`
  // nombrando las dos cifras, y publica `unallocated_amount` en `DepositOut`
  // una vez creada la consignación.

  const mutation = useMutation({
    mutationFn: () =>
      createDeposit(
        storeId,
        {
          amount: amount as number,
          business_date: businessDate,
          bank_name: bankName.trim() === "" ? null : bankName.trim(),
          bank_reference: bankReference.trim() === "" ? null : bankReference.trim(),
          receipt_photo: photo as string,
          allocations: validAllocations,
        },
        idempotencyKeyRef.current,
      ),
    onSuccess: (deposit) => {
      idempotencyKeyRef.current = newIdempotencyKey()
      void queryClient.invalidateQueries({ queryKey: ["banking", "deposits"] })
      void queryClient.invalidateQueries({ queryKey: ["banking", "deposits-pending"] })
      void queryClient.invalidateQueries({ queryKey: ["banking", "owner-hand"] })
      setBankReference("")
      setAmount(null)
      setAllocations([emptyAllocation()])
      setPhoto(null)
      setOpen(false)
      onCreated?.(deposit)
    },
  })

  // Las imputaciones son OPCIONALES (`allocations: []` es el caso de la mano
  // del dueño: retira, guarda, y consigna sin turno al que imputarla
  // todavía). Sólo el monto tipeado, el comprobante y la fecha son
  // obligatorios; si Σ imputaciones > monto, se bloquea el envío con
  // mensaje propio — el servidor sigue siendo la autoridad
  // (`ALLOCATION_EXCEEDS_DEPOSIT`/`DEPOSIT_EXCEEDS_PENDING` via `errorMessage`).
  const canSubmit = amount !== null && amount > 0 && photo !== null && businessDate.trim() !== ""

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant={triggerVariant} className="h-11 gap-2" />}>{triggerLabel}</DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Registrar consignación</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="deposit-date">Fecha de negocio</Label>
              <Input
                id="deposit-date"
                type="date"
                className="h-11"
                value={businessDate}
                onChange={(event) => setBusinessDate(event.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="deposit-bank-name">Banco (opcional)</Label>
              <Input id="deposit-bank-name" className="h-11" value={bankName} onChange={(event) => setBankName(event.target.value)} />
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="deposit-bank-reference">Referencia del banco (opcional)</Label>
            <Input id="deposit-bank-reference" className="h-11" value={bankReference} onChange={(event) => setBankReference(event.target.value)} />
          </div>

          <div className="space-y-1">
            <Label htmlFor="deposit-amount">Monto consignado (el que dice el comprobante del banco)</Label>
            <MoneyInput id="deposit-amount" value={amount} onChange={setAmount} />
          </div>

          <div className="space-y-2">
            <p className="text-sm font-medium">Turnos que cubre esta consignación (opcional)</p>
            <p className="text-xs text-muted-foreground">
              Dejá esto vacío para registrar la mano del dueño: plata que se retiró, se guardó y ahora se consigna
              sin un turno concreto al que imputarla todavía.
            </p>
            {allocations.map((allocation, index) => (
              <div key={index} className="flex items-end gap-2">
                <div className="flex-1 space-y-1">
                  <Label htmlFor={`deposit-shift-${index}`}>Id de turno</Label>
                  <Input
                    id={`deposit-shift-${index}`}
                    className="h-11"
                    inputMode="numeric"
                    value={allocation.shiftId}
                    onChange={(event) => {
                      const value = event.target.value.replace(/\D/g, "")
                      setAllocations((prev) => prev.map((a, i) => (i === index ? { ...a, shiftId: value } : a)))
                    }}
                  />
                </div>
                <div className="flex-1 space-y-1">
                  <Label htmlFor={`deposit-amount-${index}`}>Monto de este turno</Label>
                  <MoneyInput
                    id={`deposit-amount-${index}`}
                    value={allocation.amount}
                    onChange={(value) => setAllocations((prev) => prev.map((a, i) => (i === index ? { ...a, amount: value } : a)))}
                  />
                </div>
                {allocations.length > 1 ? (
                  <Button type="button" variant="ghost" size="icon" aria-label="Quitar turno" onClick={() => setAllocations((prev) => prev.filter((_, i) => i !== index))}>
                    ×
                  </Button>
                ) : null}
              </div>
            ))}
            <Button type="button" variant="outline" size="sm" onClick={() => setAllocations((prev) => [...prev, emptyAllocation()])}>
              Agregar otro turno
            </Button>
            <p className="text-xs text-muted-foreground">
              Cada turno consignado no puede volver a aparecer «en la mano»: es la llave anti doble conteo de este
              territorio (spec.md § T1).
            </p>
            <p className="text-xs text-muted-foreground">
              Podés dejar turnos sin imputar: el servidor publica cuánto quedó sin imputar cuando se guarda. Si las
              imputaciones suman más que el monto consignado, lo rechaza y te lo dice.
            </p>
          </div>

          <PhotoCaptureField value={photo} onChange={setPhoto} label="Foto del comprobante (obligatoria)" required />
          {mutation.isError ? (
            <p role="alert" className="text-sm text-destructive">
              {errorMessage(mutation.error)}
            </p>
          ) : null}
          <DesdeHacia
            desde={desdeConsignacion(allocations.map((a) => a.shiftId).filter((id) => id.trim() !== ""))}
            hacia={bankName.trim() === "" ? "El banco" : bankName.trim()}
            monto={amount}
            verbo="Se consigna"
          />
          {/* El botón repite el monto: la confirmación es el número. */}
          <Button type="button" className="w-full" disabled={!canSubmit || mutation.isPending} onClick={() => mutation.mutate()}>
            {amount !== null && amount > 0 ? `Consignar ${formatCOP(amount)}` : "Registrar consignación"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export default CreateDepositDialog
