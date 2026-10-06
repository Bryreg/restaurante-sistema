/**
 * Nómina › Horario de la semana (decisión del dueño, 2026-09-29): la vista
 * principal de Nómina. Eje horizontal = los siete días de la semana; eje
 * vertical = las horas del día, de arriba (6 a. m.) hacia abajo (cierre). Cada
 * día lleva una barra vertical **por persona, lado a lado** —nunca montadas—,
 * de la entrada a la salida; una pausa es el hueco entre dos tramos.
 *
 * Todo sale de `GET /admin/payroll/week-schedule` (el motor de nómina): los
 * tramos, sus minutos, el total de la semana por persona y qué está «en
 * curso» o «a revisar». Esta pantalla no suma ni resta horas: las ubica
 * (`./weekSchedule.ts`). La tabla de abajo es la misma información para
 * lectores de pantalla y para quien prefiera leerla.
 */
import { useQuery } from "@tanstack/react-query"
import { ChevronLeft, ChevronRight } from "lucide-react"
import { useState } from "react"

import { getWeekSchedule, weekScheduleCsvUrl, type WeekScheduleOut } from "@/api/payroll"
import { useStoreSelection } from "@/app/storeContext"
import { Cargando } from "@/components/Cargando"
import { CsvExportButton } from "@/components/CsvExportButton"
import { EmptyState } from "@/components/EmptyState"
import { Button } from "@/components/ui/button"
import { formatClockTime } from "@/lib/businessDate"
import { errorMessage } from "@/lib/errors"
import { formatFechaCorta } from "@/lib/format"
import { cn } from "@/lib/utils"

import { axisFor, axisHourCount, axisTicks, layoutWeek, personColor, shiftWeek, type Bar } from "./weekSchedule"

/** Alto de una hora en el eje. 18 h ≈ 540 px: la semana entra en una pantalla. */
const HOUR_PX = 30

const STATUS_WORD: Record<Bar["status"], string> = {
  closed: "",
  open: "en curso",
  review: "salida a revisar",
}

function barTitle(bar: Bar): string {
  const desde = formatClockTime(bar.start)
  if (bar.status === "review") return `${bar.name}: entró ${desde}, sin salida marcada (a revisar, no suma horas)`
  const hasta = bar.status === "open" ? "ahora (sigue trabajando)" : formatClockTime(bar.end)
  return `${bar.name}: ${desde} a ${hasta}${bar.hours ? ` · ${bar.hours} h` : ""}`
}

function WeekChart({ data }: { data: WeekScheduleOut }): React.JSX.Element {
  const axis = axisFor(data)
  const ticks = axisTicks(axis, data.day_start_hour)
  const span = axis.toMin - axis.fromMin
  const height = axisHourCount(axis) * HOUR_PX
  const columns = layoutWeek(data)
  const pct = (min: number) => ((min - axis.fromMin) / span) * 100

  return (
    <div className="min-w-0 overflow-x-auto pb-3" aria-hidden="true" data-slot="horario-semana-grafico">
      <div className="grid min-w-[44rem] grid-cols-[3.75rem_repeat(7,minmax(0,1fr))] gap-x-1.5">
        <div />
        {columns.map((col) => (
          <div
            key={col.date}
            className={cn(
              "pb-1.5 text-center text-xs font-semibold",
              col.isToday ? "text-primary" : "text-muted-foreground",
            )}
          >
            {formatFechaCorta(col.date)}
            {col.isToday ? <span className="block text-[0.6875rem] font-normal">hoy</span> : null}
          </div>
        ))}

        {/* Eje de horas, de arriba hacia abajo. */}
        <div className="relative" style={{ height }}>
          {ticks.map((t) => (
            <span
              key={t.offsetMin}
              className="absolute right-1 -translate-y-1/2 text-[0.6875rem] whitespace-nowrap text-muted-foreground tabular-nums"
              style={{ top: `${pct(t.offsetMin)}%` }}
            >
              {t.label}
            </span>
          ))}
        </div>

        {columns.map((col) => (
          <div
            key={col.date}
            data-day={col.date}
            className={cn("relative rounded-md border", col.isToday ? "border-primary/40 bg-primary/5" : "bg-card")}
            style={{ height }}
          >
            {ticks.map((t) => (
              <div
                key={t.offsetMin}
                className="absolute inset-x-0 border-t border-border/50"
                style={{ top: `${pct(t.offsetMin)}%` }}
              />
            ))}
            {col.bars.map((bar, i) => {
              const top = pct(bar.startMin)
              const bottom = pct(bar.endMin)
              const width = 100 / bar.lanes
              return (
                <div
                  key={`${bar.employeeId}-${i}`}
                  data-bar=""
                  data-employee={bar.employeeId}
                  data-lane={bar.lane}
                  data-lanes={bar.lanes}
                  data-status={bar.status}
                  title={barTitle(bar)}
                  className={cn("absolute px-[1.5px]", bar.status === "review" && "z-[1]")}
                  style={{ top: `${top}%`, height: `${Math.max(bottom - top, 1)}%`, left: `${bar.lane * width}%`, width: `${width}%` }}
                >
                  <div
                    className={cn(
                      "relative h-full w-full rounded-sm",
                      bar.status === "review" && "z-[1] border-2 border-dashed",
                    )}
                    style={
                      bar.status === "review"
                        ? {
                            // Fondo de tarjeta debajo del rayado: si el roster
                            // ya dibuja un tramo de esa persona a esa hora, la
                            // marca «a revisar» se ve encima y no se confunde.
                            borderColor: "var(--warning)",
                            backgroundColor: "var(--card)",
                            backgroundImage: `repeating-linear-gradient(135deg, ${bar.color} 0 3px, transparent 3px 7px)`,
                          }
                        : { background: bar.color }
                    }
                  >
                    {bar.status === "open" ? (
                      // Sigue trabajando: la barra llega hasta ahora y termina en flecha.
                      <span
                        className="absolute -bottom-1.5 left-1/2 size-0 -translate-x-1/2 border-x-[5px] border-t-[6px] border-x-transparent"
                        style={{ borderTopColor: bar.color }}
                        data-marca="en-curso"
                      />
                    ) : null}
                    {bar.status === "review" ? (
                      <span
                        className="absolute -bottom-2 left-1/2 flex size-3.5 -translate-x-1/2 items-center justify-center rounded-full bg-warning text-[0.625rem] leading-none font-bold text-warning-foreground"
                        data-marca="a-revisar"
                      >
                        !
                      </span>
                    ) : null}
                  </div>
                </div>
              )
            })}
          </div>
        ))}
      </div>
    </div>
  )
}

function Legend({ data }: { data: WeekScheduleOut }): React.JSX.Element {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-2 text-sm" aria-label="Personas de la semana y sus horas">
      {data.people.map((p, i) => (
        <li key={p.employee_id} className="flex items-center gap-2">
          <span className="inline-block size-3 shrink-0 rounded-sm" style={{ background: personColor(i) }} aria-hidden="true" />
          <span className="font-medium">{p.employee_name}</span>
          <span className="text-muted-foreground tabular-nums">{p.total_hours} h</span>
          {p.review_count > 0 ? (
            <span className="rounded bg-warning/15 px-1.5 text-xs font-medium text-warning">
              {p.review_count} salida{p.review_count === 1 ? "" : "s"} a revisar
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  )
}

/** La misma semana en una tabla: persona, día, entrada, salida, horas y estado. */
function WeekTable({ data, visible }: { data: WeekScheduleOut; visible: boolean }): React.JSX.Element {
  const rows = data.people.flatMap((p) =>
    p.days.flatMap((d) =>
      d.segments.map((s, i) => ({ key: `${p.employee_id}-${d.business_date}-${i}`, person: p.employee_name, day: d.business_date, s })),
    ),
  )
  return (
    <div className={cn(visible ? "min-w-0 overflow-x-auto" : "sr-only")}>
      <table className="w-full text-sm">
        <caption className={visible ? "pb-2 text-left text-xs text-muted-foreground" : undefined}>
          Horario de la semana del {formatFechaCorta(data.week_start)} al {formatFechaCorta(data.week_end)}, por persona y día
        </caption>
        <thead>
          <tr className="border-b text-left text-muted-foreground">
            <th scope="col" className="px-2 py-1.5 font-medium">Persona</th>
            <th scope="col" className="px-2 py-1.5 font-medium">Día</th>
            <th scope="col" className="px-2 py-1.5 font-medium">Entrada</th>
            <th scope="col" className="px-2 py-1.5 font-medium">Salida</th>
            <th scope="col" className="px-2 py-1.5 text-right font-medium">Horas</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ key, person, day, s }) => (
            <tr key={key} className="border-b last:border-0">
              <td className="px-2 py-1.5">{person}</td>
              <td className="px-2 py-1.5">{formatFechaCorta(day)}</td>
              <td className="px-2 py-1.5 tabular-nums">{formatClockTime(s.start)}</td>
              <td className="px-2 py-1.5 tabular-nums">
                {s.status === "closed" ? formatClockTime(s.end) : STATUS_WORD[s.status]}
              </td>
              <td className="px-2 py-1.5 text-right tabular-nums">{s.hours ?? "no suma"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function WeekScheduleTab({ storeId }: { storeId: number }): React.JSX.Element {
  const [weekOf, setWeekOf] = useState<string | null>(null)
  const [verTabla, setVerTabla] = useState(false)
  const { stores, setActiveStoreId } = useStoreSelection()

  const query = useQuery({
    queryKey: ["payroll", "week-schedule", storeId, weekOf],
    queryFn: () => getWeekSchedule({ storeId, weekOf }),
  })
  const data = query.data
  const weekStart = data?.week_start ?? null
  const isCurrentWeek = data ? data.today >= data.week_start && data.today <= data.week_end : weekOf === null
  const reviewTotal = data?.people.reduce((n, p) => n + p.review_count, 0) ?? 0
  const openNow = data?.people.some((p) => p.days.some((d) => d.segments.some((s) => s.status === "open"))) ?? false

  return (
    <section className="space-y-4" aria-labelledby="horario-semana-titulo">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 id="horario-semana-titulo" className="text-base font-semibold">
            {data ? `Semana del ${formatFechaCorta(data.week_start)} al ${formatFechaCorta(data.week_end)}` : "Horario de la semana"}
          </h2>
          <p className="text-sm text-muted-foreground">
            Quién estuvo y de qué hora a qué hora, cada día. Las horas son las del motor de nómina: sin pausas y sin salidas
            olvidadas.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {stores.length > 1 ? (
            <label className="flex items-center gap-1.5 text-sm">
              <span className="text-muted-foreground">Sede</span>
              <select
                className="h-11 rounded-md border bg-card px-2 text-sm"
                value={storeId}
                onChange={(e) => setActiveStoreId(Number(e.target.value))}
              >
                {stores.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
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
            <Button
              variant="outline"
              className="h-11"
              disabled={isCurrentWeek}
              onClick={() => setWeekOf(null)}
            >
              Esta semana
            </Button>
            <Button
              variant="outline"
              size="icon"
              className="size-11"
              aria-label="Semana siguiente"
              title="Semana siguiente"
              disabled={!weekStart || isCurrentWeek}
              onClick={() => weekStart && setWeekOf(shiftWeek(weekStart, 1))}
            >
              <ChevronRight className="size-4" aria-hidden="true" />
            </Button>
          </div>
          {weekStart ? (
            <CsvExportButton href={weekScheduleCsvUrl({ storeId, weekOf: weekStart })} label="Descargar la semana (CSV)" />
          ) : null}
        </div>
      </div>

      {query.isLoading ? (
        <Cargando texto="Cargando el horario de la semana…" />
      ) : query.isError ? (
        <EmptyState
          reason="error"
          title="No se pudo cargar el horario de la semana"
          description={errorMessage(query.error)}
          action={{ label: "Reintentar", onClick: () => void query.refetch() }}
        />
      ) : !data || data.people.length === 0 ? (
        <EmptyState
          title="Nadie marcó entrada esta semana"
          description="Cuando alguien marque entrada en el salón, su barra aparece en el día que trabajó."
        />
      ) : (
        <div className="space-y-4 rounded-lg border bg-card p-4">
          <Legend data={data} />
          {openNow || reviewTotal > 0 ? (
            <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
              {openNow ? <span>▼ La barra que termina en flecha sigue trabajando: llega hasta ahora.</span> : null}
              {reviewTotal > 0 ? (
                <span>
                  ! Rayada con borde ámbar: entrada sin salida marcada (salida olvidada, a revisar). No suma horas hasta corregirla en «Más › Horas».
                </span>
              ) : null}
            </p>
          ) : null}
          {verTabla ? null : <WeekChart data={data} />}
          <WeekTable data={data} visible={verTabla} />
          <button
            type="button"
            aria-pressed={verTabla}
            onClick={() => setVerTabla((v) => !v)}
            className="rounded-md px-1.5 py-1 text-xs font-medium text-muted-foreground underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            {verTabla ? "Ver gráfico" : "Ver tabla"}
          </button>
        </div>
      )}
    </section>
  )
}

export default WeekScheduleTab
