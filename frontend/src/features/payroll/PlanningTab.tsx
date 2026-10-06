/**
 * Nómina › Planeación (auditoría e1): el administrador planea, por persona y
 * por día, de qué hora a qué hora trabaja cada quien, y copia la semana
 * anterior de un toque. Cada día dice además cómo le fue contra lo real
 * (a tiempo, tarde con sus minutos, no ha llegado, no vino, con novedad):
 * **esa comparación la hace el servidor** (`GET /admin/payroll/schedule`);
 * esta pantalla sólo la escribe. Cambiar o quitar un turno lo anula en el
 * servidor, nunca lo borra. La nota del turno sirve para dejar dicho un
 * cambio de turno acordado («cubre a Ana»).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ChevronLeft, ChevronRight, Copy } from "lucide-react"
import { useState } from "react"

import { newIdempotencyKey } from "@/api/client"
import {
  copyPreviousWeek,
  getSchedule,
  putPlannedShift,
  voidPlannedShift,
  type ScheduleDayOut,
  type SchedulePersonOut,
  type ScheduleStatus,
  type ScheduleWeekOut,
} from "@/api/payroll"
import { Cargando } from "@/components/Cargando"
import { EmptyState } from "@/components/EmptyState"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { formatClockTime } from "@/lib/businessDate"
import { errorMessage } from "@/lib/errors"
import { formatDuracion, formatFechaCorta } from "@/lib/format"
import { cn } from "@/lib/utils"

import { shiftWeek } from "./weekSchedule"

const WEEKDAY = ["lun", "mar", "mié", "jue", "vie", "sáb", "dom"] as const

/** Lo que el servidor decidió, en palabras. */
const STATUS_LABEL: Record<ScheduleStatus, string> = {
  on_time: "A tiempo",
  late: "Tarde",
  missing: "No ha llegado",
  no_show: "No vino",
  excused: "Con novedad",
  upcoming: "Por empezar",
  unplanned: "Sin turno planeado",
}

const STATUS_CLASS: Record<ScheduleStatus, string> = {
  on_time: "bg-success/15 text-success",
  late: "bg-warning/15 text-warning",
  missing: "bg-warning/15 text-warning",
  no_show: "bg-destructive/15 text-destructive",
  excused: "bg-muted text-muted-foreground",
  upcoming: "bg-muted text-muted-foreground",
  unplanned: "bg-muted text-muted-foreground",
}

function statusText(day: ScheduleDayOut): string | null {
  if (day.status === null) return null
  if (day.status === "late" && day.late_minutes !== null) return `Tarde ${day.late_minutes} min`
  return STATUS_LABEL[day.status]
}

interface Editing {
  person: SchedulePersonOut
  day: ScheduleDayOut
}

/** Lo que se propone al planear un día vacío: el turno más reciente de la persona en la semana. */
function suggestedHours(person: SchedulePersonOut): { start: string; end: string } {
  const planned = person.days.filter((d) => d.planned !== null)
  const last = planned[planned.length - 1]?.planned
  return last ? { start: last.start, end: last.end } : { start: "07:00", end: "15:00" }
}

function ShiftDialog({
  storeId,
  editing,
  onClose,
}: {
  storeId: number
  editing: Editing
  onClose: () => void
}): React.JSX.Element {
  const queryClient = useQueryClient()
  const planned = editing.day.planned
  const initial = planned ? { start: planned.start, end: planned.end } : suggestedHours(editing.person)
  const [start, setStart] = useState(initial.start)
  const [end, setEnd] = useState(initial.end)
  const [note, setNote] = useState(planned?.note ?? "")
  const [error, setError] = useState<string | null>(null)

  const save = useMutation({
    mutationFn: () =>
      putPlannedShift(
        storeId,
        { employee_id: editing.person.employee_id, business_date: editing.day.business_date, start, end, note: note.trim() || null },
        newIdempotencyKey(),
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["payroll", "schedule"] })
      onClose()
    },
    onError: (err) => setError(errorMessage(err)),
  })
  const remove = useMutation({
    mutationFn: () => voidPlannedShift(storeId, planned!.id, newIdempotencyKey()),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["payroll", "schedule"] })
      onClose()
    },
    onError: (err) => setError(errorMessage(err)),
  })
  const pending = save.isPending || remove.isPending

  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {editing.person.employee_name} · {formatFechaCorta(editing.day.business_date)}
          </DialogTitle>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault()
            setError(null)
            save.mutate()
          }}
        >
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="turno-entrada">Entrada</Label>
              <Input id="turno-entrada" type="time" className="h-11" required value={start} onChange={(e) => setStart(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="turno-salida">Salida</Label>
              <Input id="turno-salida" type="time" className="h-11" required value={end} onChange={(e) => setEnd(e.target.value)} />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Una salida antes de la entrada es del día siguiente (turno de noche). Las horas son de Bogotá.
          </p>
          <div className="space-y-1">
            <Label htmlFor="turno-nota">Nota (opcional)</Label>
            <Input
              id="turno-nota"
              className="h-11"
              maxLength={300}
              placeholder="Ej.: cubre a Ana, cambio acordado"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <DialogFooter className="flex-wrap gap-2">
            {planned ? (
              <Button type="button" variant="outline" className="h-11" disabled={pending} onClick={() => remove.mutate()}>
                Quitar turno
              </Button>
            ) : null}
            <Button type="submit" className="h-11" disabled={pending || !start || !end}>
              {save.isPending ? "Guardando…" : "Guardar turno"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function DayCell({
  person,
  day,
  isToday,
  onEdit,
}: {
  person: SchedulePersonOut
  day: ScheduleDayOut
  isToday: boolean
  onEdit: () => void
}): React.JSX.Element {
  const status = statusText(day)
  const label = day.planned
    ? `${person.employee_name}, ${formatFechaCorta(day.business_date)}: ${day.planned.start} a ${day.planned.end}${status ? `, ${status}` : ""}. Cambiar turno`
    : `${person.employee_name}, ${formatFechaCorta(day.business_date)}: sin turno${status ? `, ${status}` : ""}. Planear turno`
  return (
    <td className={cn("border-b p-1 align-top", isToday && "bg-accent/40")}>
      <button
        type="button"
        aria-label={label}
        onClick={onEdit}
        className="flex min-h-11 w-full flex-col items-start gap-1 rounded-md border border-transparent px-2 py-1.5 text-left text-xs hover:border-border hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        {day.planned ? (
          <span className="font-semibold tabular-nums text-foreground">
            {day.planned.start}–{day.planned.end}
          </span>
        ) : (
          <span className="text-muted-foreground">+ Planear</span>
        )}
        {day.status ? (
          <span className={cn("rounded px-1.5 py-0.5 font-medium", STATUS_CLASS[day.status])}>{status}</span>
        ) : null}
        {day.actual_in_at ? <span className="text-muted-foreground">Entró {formatClockTime(day.actual_in_at)}</span> : null}
        {day.planned?.note ? <span className="text-muted-foreground italic">{day.planned.note}</span> : null}
      </button>
    </td>
  )
}

function Grid({ data, onEdit }: { data: ScheduleWeekOut; onEdit: (e: Editing) => void }): React.JSX.Element {
  const days = data.people[0]?.days.map((d) => d.business_date) ?? []
  return (
    <div className="min-w-0 overflow-x-auto rounded-lg border bg-card">
      <table className="w-full min-w-[52rem] text-sm">
        <caption className="sr-only">
          Turnos planeados del {formatFechaCorta(data.week_start)} al {formatFechaCorta(data.week_end)}, por persona y día, con lo
          que pasó en realidad
        </caption>
        <thead>
          <tr className="border-b text-left text-muted-foreground">
            <th scope="col" className="px-2 py-2 font-medium">
              Persona
            </th>
            {days.map((d, i) => (
              <th key={d} scope="col" className={cn("px-2 py-2 font-medium", d === data.today && "text-foreground")}>
                {WEEKDAY[i]} {formatFechaCorta(d)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.people.map((person) => (
            <tr key={person.employee_id}>
              <th scope="row" className="border-b px-2 py-2 text-left align-top font-medium">
                {person.employee_name}
                <span className="block text-xs font-normal text-muted-foreground tabular-nums">
                  {person.planned_minutes > 0 ? `${formatDuracion(person.planned_minutes)} planeadas` : "Sin turnos"}
                </span>
              </th>
              {person.days.map((day) => (
                <DayCell
                  key={day.business_date}
                  person={person}
                  day={day}
                  isToday={day.business_date === data.today}
                  onEdit={() => onEdit({ person, day })}
                />
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function PlanningTab({ storeId }: { storeId: number }): React.JSX.Element {
  const queryClient = useQueryClient()
  const [weekOf, setWeekOf] = useState<string | null>(null)
  const [editing, setEditing] = useState<Editing | null>(null)
  const [copyResult, setCopyResult] = useState<string | null>(null)
  const [copyError, setCopyError] = useState<string | null>(null)

  const query = useQuery({
    queryKey: ["payroll", "schedule", storeId, weekOf],
    queryFn: () => getSchedule({ storeId, weekOf }),
  })
  const data = query.data
  const weekStart = data?.week_start ?? null
  const isCurrentWeek = data ? data.today >= data.week_start && data.today <= data.week_end : weekOf === null

  const copy = useMutation({
    mutationFn: () => copyPreviousWeek(storeId, weekStart!, newIdempotencyKey()),
    onSuccess: (result) => {
      setCopyError(null)
      setCopyResult(
        result.copied === 0 && result.skipped === 0
          ? "La semana anterior no tenía turnos planeados."
          : `Se copiaron ${result.copied} ${result.copied === 1 ? "turno" : "turnos"}${
              result.skipped > 0 ? `; ${result.skipped} no se copiaron porque ese día ya estaba planeado o la persona ya no está` : ""
            }.`,
      )
      void queryClient.invalidateQueries({ queryKey: ["payroll", "schedule"] })
    },
    onError: (err) => {
      setCopyResult(null)
      setCopyError(errorMessage(err))
    },
  })

  return (
    <section className="space-y-4" aria-labelledby="planeacion-titulo">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 id="planeacion-titulo" className="text-base font-semibold">
            {data ? `Turnos del ${formatFechaCorta(data.week_start)} al ${formatFechaCorta(data.week_end)}` : "Planeación de turnos"}
          </h2>
          <p className="text-sm text-muted-foreground">
            Planeá de qué hora a qué hora trabaja cada persona. Con la entrada real se ve quién llegó tarde
            {data ? ` (más de ${data.grace_minutes} min)` : ""} y quién no vino.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1" role="group" aria-label="Elegir semana">
            <Button
              variant="outline"
              size="icon"
              className="size-11"
              aria-label="Semana anterior"
              title="Semana anterior"
              disabled={!weekStart}
              onClick={() => weekStart && setWeekOf(shiftWeek(weekStart, -1))}
            >
              <ChevronLeft className="size-4" aria-hidden="true" />
            </Button>
            <Button variant="outline" className="h-11" disabled={isCurrentWeek} onClick={() => setWeekOf(null)}>
              Esta semana
            </Button>
            <Button
              variant="outline"
              size="icon"
              className="size-11"
              aria-label="Semana siguiente"
              title="Semana siguiente"
              disabled={!weekStart}
              onClick={() => weekStart && setWeekOf(shiftWeek(weekStart, 1))}
            >
              <ChevronRight className="size-4" aria-hidden="true" />
            </Button>
          </div>
          <Button variant="outline" className="h-11" disabled={!weekStart || copy.isPending} onClick={() => copy.mutate()}>
            <Copy className="size-4" aria-hidden="true" />
            {copy.isPending ? "Copiando…" : "Copiar la semana anterior"}
          </Button>
        </div>
      </div>

      {copyResult ? (
        <p role="status" className="text-sm">
          {copyResult}
        </p>
      ) : null}
      {copyError ? (
        <p role="alert" className="text-sm text-destructive">
          {copyError}
        </p>
      ) : null}

      {query.isLoading ? (
        <Cargando texto="Cargando los turnos…" />
      ) : query.isError ? (
        <EmptyState
          reason="error"
          title="No se pudieron cargar los turnos"
          description={errorMessage(query.error)}
          action={{ label: "Reintentar", onClick: () => void query.refetch() }}
        />
      ) : !data || data.people.length === 0 ? (
        <EmptyState
          title="Todavía no hay equipo en esta sede"
          description="Creá a las personas en Ajustes › Empleados y acá les planeás los turnos."
        />
      ) : (
        <>
          <p className="text-sm" aria-live="polite">
            Esta semana: <b>{data.late_count}</b> {data.late_count === 1 ? "llegada tarde" : "llegadas tarde"} ·{" "}
            <b>{data.no_show_count}</b> {data.no_show_count === 1 ? "turno sin venir" : "turnos sin venir"}
          </p>
          <Grid data={data} onEdit={setEditing} />
        </>
      )}

      {editing ? <ShiftDialog storeId={storeId} editing={editing} onClose={() => setEditing(null)} /> : null}
    </section>
  )
}

export default PlanningTab
