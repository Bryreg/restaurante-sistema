/**
 * El reparto del horario de la semana (decisión del dueño, 2026-09-29): en
 * qué carril va la barra de cada persona cada día, qué color le toca y qué
 * ventana de horas muestra el eje. **No calcula horas ni plata**: los tramos,
 * sus minutos y los totales llegan hechos del servidor
 * (`GET /admin/payroll/week-schedule`, el motor de nómina); acá sólo se
 * ubican en el dibujo.
 */
import type { WeekScheduleOut, WeekSegmentStatus } from "@/api/payroll"
import { etiquetaHora } from "@/components/charts/referencia"

/**
 * Colores de persona, en orden fijo: los cinco categóricos del sistema
 * (`--data-1..5`) y cinco más de la misma familia. Con más de diez personas
 * el color se repite, y lo que las distingue es la leyenda y el orden del
 * carril (la tabla gemela nombra a cada una).
 */
export const PERSON_COLORS = [
  "var(--data-1)",
  "var(--data-2)",
  "var(--data-3)",
  "var(--data-4)",
  "var(--data-5)",
  "#2f6f5e",
  "#b8860b",
  "#5b6bd6",
  "#a2453d",
  "#4d7f2a",
] as const

export function personColor(index: number): string {
  return PERSON_COLORS[((index % PERSON_COLORS.length) + PERSON_COLORS.length) % PERSON_COLORS.length]
}

/**
 * Cuánto se dibuja de un tramo «a revisar» (salida olvidada): no tiene
 * salida, así que no hay alto verdadero. Es una marca, no una duración: no
 * suma horas en ningún lado.
 */
export const REVIEW_STUB_MIN = 60

/**
 * Minutos por hora **del eje** (posición en el dibujo, no horas de
 * nómina: ésas llegan como texto del servidor, `app/core/hours.py`).
 */
const AXIS_MIN_PER_HOUR = 60
const DAY_MIN = 24 * AXIS_MIN_PER_HOUR

/** Minutos desde el comienzo del día operativo hasta una hora de reloj. */
function offsetOfClockHour(clockHour: number, dayStartHour: number): number {
  return ((((clockHour - dayStartHour) % 24) + 24) % 24) * AXIS_MIN_PER_HOUR
}

export interface Axis {
  /** Primer minuto del día operativo que se ve (múltiplo de 60). */
  fromMin: number
  /** Último minuto que se ve (múltiplo de 60). */
  toMin: number
}

/**
 * La ventana del eje: de 6 a. m. a 12 a. m. (el día de un restaurante), y
 * más si algún tramo se sale de ella (alguien entró a las 5 o cerró a la
 * 1). Siempre en horas enteras.
 */
export function axisFor(schedule: Pick<WeekScheduleOut, "day_start_hour" | "people">): Axis {
  const start = schedule.day_start_hour
  let fromMin = offsetOfClockHour(6, start)
  let toMin = offsetOfClockHour(0, start) || DAY_MIN
  if (toMin <= fromMin) toMin = DAY_MIN
  for (const person of schedule.people) {
    for (const day of person.days) {
      for (const s of day.segments) {
        const end = s.end_offset_min ?? s.start_offset_min + REVIEW_STUB_MIN
        fromMin = Math.min(fromMin, s.start_offset_min - (s.start_offset_min % AXIS_MIN_PER_HOUR))
        toMin = Math.max(toMin, end % AXIS_MIN_PER_HOUR === 0 ? end : end - (end % AXIS_MIN_PER_HOUR) + AXIS_MIN_PER_HOUR)
      }
    }
  }
  return { fromMin: Math.max(0, fromMin), toMin: Math.min(DAY_MIN, toMin) }
}

/** Cuántas horas enteras cubre el eje (para su alto en píxeles). */
export function axisHourCount(axis: Axis): number {
  return (axis.toMin - axis.fromMin) / AXIS_MIN_PER_HOUR
}

/** Las marcas del eje: una por hora, con la hora de reloj escrita. */
export function axisTicks(axis: Axis, dayStartHour: number): { offsetMin: number; label: string }[] {
  const ticks: { offsetMin: number; label: string }[] = []
  for (let m = axis.fromMin, h = dayStartHour + axis.fromMin / AXIS_MIN_PER_HOUR; m <= axis.toMin; m += AXIS_MIN_PER_HOUR, h += 1) {
    ticks.push({ offsetMin: m, label: etiquetaHora(h) })
  }
  return ticks
}

export interface Bar {
  employeeId: number
  name: string
  color: string
  /** Carril dentro del día (0 = el primero a la izquierda). */
  lane: number
  /** Cuántos carriles tiene ese día: uno por persona que trabajó. */
  lanes: number
  startMin: number
  endMin: number
  status: WeekSegmentStatus
  start: string
  end: string | null
  hours: string | null
}

export interface DayColumn {
  date: string
  isToday: boolean
  bars: Bar[]
}

/**
 * Una columna por día y, adentro, **un carril por persona que trabajó ese
 * día**, lado a lado y en el mismo orden que la leyenda: dos personas nunca
 * se montan una sobre otra aunque se crucen de hora. Los tramos de una misma
 * persona (antes y después de una pausa) van en su carril, uno debajo del
 * otro, con el hueco de la pausa entre los dos.
 */
export function layoutWeek(schedule: WeekScheduleOut): DayColumn[] {
  const colorOf = new Map(schedule.people.map((p, i) => [p.employee_id, personColor(i)]))
  return schedule.days.map((date) => {
    const present = schedule.people.filter((p) => p.days.some((d) => d.business_date === date && d.segments.length > 0))
    const bars: Bar[] = []
    present.forEach((person, lane) => {
      const day = person.days.find((d) => d.business_date === date)
      for (const s of day?.segments ?? []) {
        bars.push({
          employeeId: person.employee_id,
          name: person.employee_name,
          color: colorOf.get(person.employee_id) ?? personColor(0),
          lane,
          lanes: present.length,
          startMin: s.start_offset_min,
          endMin: s.end_offset_min ?? s.start_offset_min + REVIEW_STUB_MIN,
          status: s.status,
          start: s.start,
          end: s.end,
          hours: s.hours,
        })
      }
    })
    return { date, isToday: date === schedule.today, bars }
  })
}

/** Lunes ± `weeks` semanas, como fecha ISO. Es aritmética de calendario, no de plata. */
export function shiftWeek(weekStartIso: string, weeks: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(weekStartIso)
  if (!m) return weekStartIso
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + weeks * 7))
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}
