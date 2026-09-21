import { formatInstant } from "@/lib/businessDate"

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * «hace 11 min», «hace 1 h 12», «hace 1 día». Presentación, no matemática de
 * negocio: no deriva saldos ni diferencias, sólo acorta un instante que el
 * servidor ya mandó.
 *
 * Por qué existe: la columna «Desde» de Inventario gastaba 130 px en un
 * minuto que a nadie le importa. El patrón la manda decir «hace 1 día» y
 * dejar la marca de tiempo completa en el `title`
 * (`docs/PATRONES-ADMIN.md`, «Sobre el defecto de a1»).
 */
export function formatTimeAgo(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return "—"
  const then = new Date(iso)
  if (Number.isNaN(then.getTime())) return "—"
  const elapsed = now.getTime() - then.getTime()
  if (elapsed < 0) return "recién"
  if (elapsed < MINUTE) return "recién"
  if (elapsed < HOUR) return `hace ${Math.floor(elapsed / MINUTE)} min`
  if (elapsed < DAY) {
    const hours = Math.floor(elapsed / HOUR)
    const minutes = Math.floor((elapsed % HOUR) / MINUTE)
    return minutes === 0 ? `hace ${hours} h` : `hace ${hours} h ${minutes}`
  }
  const days = Math.floor(elapsed / DAY)
  return days === 1 ? "hace 1 día" : `hace ${days} días`
}

export interface TimeAgoProps {
  iso: string | null | undefined
  /** Para tests: el «ahora» contra el que se mide. */
  now?: Date
  className?: string
}

/** Lo corto se ve; lo exacto vive en el `title`, a un hover de distancia. */
export function TimeAgo({ iso, now, className }: TimeAgoProps): React.JSX.Element {
  const short = formatTimeAgo(iso, now)
  const exact = formatInstant(iso)
  return (
    <span className={className} title={exact === "—" ? undefined : exact}>
      {short}
    </span>
  )
}

export default TimeAgo
