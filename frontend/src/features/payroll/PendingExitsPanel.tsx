/**
 * Salidas olvidadas, «a revisar» (asistencia del día, separada del turno de
 * caja): la persona marcó entrada y el día operativo terminó sin salida.
 * Sus horas **no** entran a la jornada hasta que el administrador escriba la
 * hora de salida, con motivo — el servidor no la inventa (contarla hasta
 * ahora era el defecto que el roster ya tuvo). Nada se borra: la corrección
 * queda auditada con quién y por qué.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { toast } from "sonner"

import { fixAttendanceExit, getAdminAttendance, type AttendanceEntryOut } from "@/api/attendance"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { formatBusinessDate, formatClockTime } from "@/lib/businessDate"
import { errorMessage } from "@/lib/errors"

export function PendingExitsPanel({ storeId }: { storeId: number }): React.JSX.Element | null {
  const queryClient = useQueryClient()
  const [corrigiendo, setCorrigiendo] = useState<AttendanceEntryOut | null>(null)
  const [outAt, setOutAt] = useState("")
  const [reason, setReason] = useState("")
  const [error, setError] = useState<string | null>(null)

  const query = useQuery({
    queryKey: ["attendance", "admin", storeId],
    queryFn: () => getAdminAttendance({ storeId }),
  })

  const fix = useMutation({
    mutationFn: (entry: AttendanceEntryOut) =>
      fixAttendanceExit(entry.id, { store_id: storeId, out_at: outAt, reason }),
    onSuccess: (entry) => {
      toast.success(`Salida de ${entry.employee_name} corregida.`)
      setCorrigiendo(null)
      void queryClient.invalidateQueries({ queryKey: ["attendance", "admin", storeId] })
      void queryClient.invalidateQueries({ queryKey: ["payroll", "hours"] })
    },
    onError: (err) => setError(errorMessage(err)),
  })

  const pendientes = (query.data?.entries ?? []).filter((e) => e.status === "review")
  if (pendientes.length === 0) return null

  return (
    <section
      aria-labelledby="salidas-a-revisar"
      className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3"
    >
      <h3 id="salidas-a-revisar" className="text-sm font-semibold">
        Salidas a revisar ({pendientes.length})
      </h3>
      <p className="text-xs text-muted-foreground">
        Marcaron entrada y el día terminó sin salida. Sus horas no están en la jornada hasta que escribas la
        hora en que salieron.
      </p>
      <ul className="space-y-1">
        {pendientes.map((entry) => (
          <li key={entry.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span>
              <b className="font-semibold">{entry.employee_name}</b> · {formatBusinessDate(entry.business_date)} ·
              entró {formatClockTime(entry.in_at)}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setCorrigiendo(entry)
                setOutAt("")
                setReason("")
                setError(null)
              }}
            >
              Corregir salida
            </Button>
          </li>
        ))}
      </ul>

      <Dialog open={corrigiendo !== null} onOpenChange={(open) => (open ? null : setCorrigiendo(null))}>
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              Corregir la salida{corrigiendo ? ` de ${corrigiendo.employee_name}` : ""}
            </DialogTitle>
          </DialogHeader>
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault()
              if (corrigiendo) fix.mutate(corrigiendo)
            }}
          >
            <div className="space-y-1">
              <Label htmlFor="attendance-fix-out-at">Hora de salida</Label>
              <Input
                id="attendance-fix-out-at"
                type="datetime-local"
                className="h-11"
                value={outAt}
                onChange={(event) => setOutAt(event.target.value)}
                required
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="attendance-fix-reason">Motivo</Label>
              <Textarea
                id="attendance-fix-reason"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                maxLength={300}
                required
              />
            </div>
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
            <Button type="submit" className="h-11 w-full" disabled={fix.isPending || !outAt || !reason.trim()}>
              Guardar salida
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  )
}

export default PendingExitsPanel
