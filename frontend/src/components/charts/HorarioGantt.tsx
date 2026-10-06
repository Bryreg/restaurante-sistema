/**
 * Barras de horario (gantt), `docs/diseno/handoff-pos-y-panel/README.md` §
 * «Barras de horario»: una fila de 30 px por persona sobre un eje de 6 a. m.
 * a 12 a. m. con marcas cada hora — quién estuvo en un turno (ficha de
 * turno). La barra en `--data-1` va de la entrada a la salida; el relevo es
 * una línea vertical punteada de 2 px.
 *
 * El horario de Equipo (la semana de todo el equipo) no es este componente:
 * vive en Nómina › Horario de la semana (`features/payroll/WeekScheduleTab`).
 * La variante «persona» de 12 días que tenía la ficha de persona se quitó
 * para que haya un solo gráfico de horario en Equipo.
 *
 * Los instantes llegan del backend (ISO UTC) y se ubican en la hora de
 * reloj de Bogotá —la zona la pone el sistema, nunca el navegador—.
 */
import type { ReactNode } from "react"
import { Link } from "react-router-dom"

import { cn } from "@/lib/utils"

import { etiquetaHora, minutosBogota } from "./referencia"

export interface TramoHorario {
  /** Instante ISO de la entrada. */
  entrada: string
  /** Instante ISO de la salida; `null` = sigue adentro (se dibuja hasta `ahora`). */
  salida: string | null
}

export interface FilaHorario {
  key: string
  etiqueta: string
  /** Renglón chico bajo la etiqueta (puesto, duración…). */
  detalle?: string
  href?: string
  tramos: TramoHorario[]
}

export interface MarcaRelevo {
  /** Instante ISO del relevo. */
  hora: string
  etiqueta: string
}

export interface HorarioGanttProps {
  filas: FilaHorario[]
  relevos?: MarcaRelevo[]
  /** Instante ISO de «ahora»: hasta dónde llega un tramo abierto. */
  ahora?: string
  /** Primera y última hora del eje (reloj de 24 h). 6 y 24 por defecto. */
  desdeHora?: number
  hastaHora?: number
  /** Título (la pregunta) opcional. */
  titulo?: ReactNode
  className?: string
}

const HORA_TEXTO = new Intl.DateTimeFormat("es-CO", {
  timeZone: "America/Bogota",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
})

function horaTexto(iso: string | null): string {
  if (!iso) return "sin salida"
  const t = Date.parse(iso)
  return Number.isFinite(t) ? HORA_TEXTO.format(new Date(t)) : "—"
}

interface Segmento {
  izq: number
  ancho: number
}

/**
 * Lleva un tramo a porcentajes del eje. Una salida en la madrugada (antes
 * del inicio del eje) es del día siguiente y se corta en el final del eje.
 */
function segmento(tramo: TramoHorario, desde: number, hasta: number, ahora?: string): Segmento | null {
  const ini = minutosBogota(tramo.entrada)
  const finIso = tramo.salida ?? ahora ?? null
  let fin = finIso ? minutosBogota(finIso) : hasta
  if (ini === null || fin === null) return null
  if (fin < ini) fin += 24 * 60
  const a = Math.max(ini, desde)
  const b = Math.min(fin, hasta)
  if (b <= a) return null
  const total = hasta - desde
  return { izq: ((a - desde) / total) * 100, ancho: ((b - a) / total) * 100 }
}

function posicion(iso: string, desde: number, hasta: number): number | null {
  const m = minutosBogota(iso)
  if (m === null || m < desde || m > hasta) return null
  return ((m - desde) / (hasta - desde)) * 100
}

export function HorarioGantt({
  filas,
  relevos = [],
  ahora,
  desdeHora = 6,
  hastaHora = 24,
  titulo,
  className,
}: HorarioGanttProps): React.JSX.Element {
  const desde = desdeHora * 60
  const hasta = hastaHora * 60
  const horas: number[] = []
  for (let h = desdeHora; h <= hastaHora; h++) horas.push(h)
  const pctHora = (h: number) => ((h * 60 - desde) / (hasta - desde)) * 100
  const ahoraPct = ahora ? posicion(ahora, desde, hasta) : null

  return (
    <section
      aria-label={typeof titulo === "string" ? titulo : "Horario"}
      data-slot="horario-gantt"
      className={cn("flex min-w-0 flex-col gap-2", className)}
    >
      {titulo ? <h3 className="m-0 text-[15px] leading-snug font-bold">{titulo}</h3> : null}
      <ul aria-hidden="true" className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 text-xs text-muted-foreground">
        <li className="inline-flex items-center gap-1.5">
          <span className="inline-block size-3 rounded-[2px] bg-(--data-1)" />
          Entrada a salida
        </li>
        {relevos.length ? (
          <li className="inline-flex items-center gap-1.5">
            <span className="inline-block h-3.5 w-0 border-l-2 border-dashed border-foreground" />
            Relevo
          </li>
        ) : null}
      </ul>

      <ul className="m-0 flex list-none flex-col p-0">
        {filas.map((f) => {
          const tramos = f.tramos
            .map((t) => ({ t, s: segmento(t, desde, hasta, ahora) }))
            .filter((x): x is { t: TramoHorario; s: Segmento } => x.s !== null)
          const lectura = [
            f.etiqueta,
            ...f.tramos.map((t) => `entrada ${horaTexto(t.entrada)}, salida ${t.salida ? horaTexto(t.salida) : "sigue adentro"}`),
            f.tramos.length === 0 ? "sin asistencia" : null,
            f.detalle ?? null,
          ]
            .filter(Boolean)
            .join(" · ")
          const etiqueta = (
            <span className="flex min-w-0 flex-col leading-tight">
              <span className="truncate text-sm font-medium">{f.etiqueta}</span>
              {f.detalle ? <span className="truncate text-[11px] text-muted-foreground">{f.detalle}</span> : null}
            </span>
          )
          return (
            <li
              key={f.key}
              data-fila={f.key}
              className="grid grid-cols-[minmax(5.5rem,9rem)_minmax(0,1fr)] items-center gap-3"
            >
              <span className="sr-only">{lectura}</span>
              {f.href ? (
                <Link
                  to={f.href}
                  aria-label={lectura}
                  className="min-w-0 rounded-sm text-inherit no-underline outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/50"
                >
                  {etiqueta}
                </Link>
              ) : (
                <span aria-hidden="true" className="min-w-0">
                  {etiqueta}
                </span>
              )}
              <span aria-hidden="true" title={lectura} className="relative block h-[30px] border-b border-border/60">
                {horas.map((h) => (
                  <span
                    key={h}
                    className="absolute inset-y-0 w-px bg-border/70"
                    style={{ left: `${pctHora(h)}%` }}
                  />
                ))}
                {tramos.map(({ t, s }, i) => (
                  <span
                    key={i}
                    data-tramo=""
                    data-abierto={t.salida === null ? "" : undefined}
                    className={cn(
                      "absolute inset-y-[7px] rounded-[3px] bg-(--data-1)",
                      t.salida === null && "rounded-r-none",
                    )}
                    style={{ left: `${s.izq}%`, width: `${s.ancho}%` }}
                  />
                ))}
                {relevos.map((r, i) => {
                  const x = posicion(r.hora, desde, hasta)
                  return x === null ? null : (
                    <span
                      key={i}
                      data-relevo=""
                      className="absolute -inset-y-px w-0 border-l-2 border-dashed border-foreground"
                      style={{ left: `${x}%` }}
                    />
                  )
                })}
                {ahoraPct !== null ? (
                  <span className="absolute inset-y-0 w-0 border-l border-foreground/60" style={{ left: `${ahoraPct}%` }} />
                ) : null}
              </span>
            </li>
          )
        })}
      </ul>

      <div aria-hidden="true" className="grid grid-cols-[minmax(5.5rem,9rem)_minmax(0,1fr)] gap-3">
        <span />
        <span className="relative block h-4 text-[11px] text-muted-foreground tabular-nums">
          {horas.map((h, i) =>
            i % 2 === 0 ? (
              <span
                key={h}
                className={cn(
                  "absolute whitespace-nowrap",
                  i === 0 ? "translate-x-0" : i === horas.length - 1 ? "-translate-x-full" : "-translate-x-1/2",
                )}
                style={{ left: `${pctHora(h)}%` }}
              >
                {etiquetaHora(h)}
              </span>
            ) : null,
          )}
        </span>
      </div>
      {relevos.length ? (
        <p className="sr-only">
          {relevos.map((r) => `${r.etiqueta}: ${horaTexto(r.hora)}`).join(". ")}
        </p>
      ) : null}
    </section>
  )
}
