import { Flag, Lock, MoveRight } from "lucide-react"
import { Link } from "react-router-dom"

import { cn } from "@/lib/utils"

export interface ScopeAffects {
  /** A dónde llega, en palabras: «Salón › Cierre de turno, paso 3». */
  screen: string
  /** Qué le hace: «Enciende el campo en», «Cambia», «Frena». */
  verb?: string
}

export interface ScopeMarksProps {
  /** Qué función lo enciende: `cash.reserve`. Se dibuja como clave, en monoespaciada. */
  flag?: string
  /** Qué otra pantalla cambia. */
  affects?: readonly ScopeAffects[]
  /** Qué se le va a pedir: «PIN de administrador». */
  requires?: string
  className?: string
}

/**
 * **Hasta tres chips.** El patrón lo dice y el componente lo corta: 124 de los
 * 275 controles están detrás de una condición, y una fila de ocho pastillas
 * debajo de un campo no se lee —vuelve a ser ruido, que es de donde venimos—.
 * El orden es el del patrón: qué lo enciende, a dónde llega, qué pide.
 */
const MAX_MARKS = 3

/**
 * **Marca de alcance** (`docs/PATRONES-ADMIN.md` § 10). El alcance no se
 * recuerda: se dibuja. Chips bajo el campo.
 *
 * Aplica a Ajustes, Funciones, Fiscal, Sedes y Empleados.
 */
export function ScopeMarks({ flag, affects, requires, className }: ScopeMarksProps): React.JSX.Element | null {
  const marks: React.ReactNode[] = []

  if (flag) {
    marks.push(
      <span
        key="flag"
        className="inline-flex items-center gap-1.5 rounded border bg-muted px-1.5 py-px font-mono text-[0.7rem] whitespace-nowrap text-muted-foreground"
      >
        <Flag className="size-3 shrink-0" aria-hidden="true" />
        {flag}
      </span>,
    )
  }

  for (const [i, target] of (affects ?? []).entries()) {
    marks.push(
      <span
        key={`affects-${i}`}
        className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-input bg-card px-2 py-px text-[0.72rem] text-muted-foreground"
      >
        <MoveRight className="size-3 shrink-0" aria-hidden="true" />
        {target.verb ? `${target.verb} ` : "Afecta: "}
        <b className="font-bold text-foreground">{target.screen}</b>
      </span>,
    )
  }

  if (requires) {
    marks.push(
      <span
        key="requires"
        className="inline-flex items-center gap-1.5 text-[0.72rem] whitespace-nowrap text-muted-foreground"
      >
        <Lock className="size-3 shrink-0" aria-hidden="true" />
        {requires}
      </span>,
    )
  }

  if (marks.length === 0) return null

  return (
    <div className={cn("mt-1.5 flex flex-wrap items-center gap-1.5", className)}>
      {marks.slice(0, MAX_MARKS)}
    </div>
  )
}

export interface ScopeDestination {
  /** La pantalla, en palabras: «Dinero › Abrir turno». */
  screen: string
  /** Qué llega ahí: «Base fija y reserva por defecto». Obligatorio. */
  what: string
  to?: string
}

export interface ScopeDestinationsProps {
  title?: string
  /**
   * A dónde llega la pestaña. Al menos uno: una tarjeta «A dónde llega esta
   * pestaña» vacía es peor que no ponerla, porque promete un inventario que
   * no tiene.
   */
  destinations: readonly [ScopeDestination, ...ScopeDestination[]]
  className?: string
}

/**
 * **El reverso de las marcas** (`docs/PATRONES-ADMIN.md` § 10): los chips
 * contestan «este campo a dónde va» y no «esta pantalla a dónde llega». Esta
 * tarjeta contesta lo segundo.
 */
export function ScopeDestinations({
  title = "A dónde llega esta pestaña",
  destinations,
  className,
}: ScopeDestinationsProps): React.JSX.Element {
  return (
    <section className={cn("rounded-lg border bg-card", className)}>
      <div className="flex items-center gap-2 border-b bg-muted px-3 py-2">
        <h3 className="text-xs tracking-wider text-muted-foreground uppercase">{title}</h3>
        <span className="ml-auto text-xs text-muted-foreground tabular-nums">
          {destinations.length} {destinations.length === 1 ? "destino" : "destinos"}
        </span>
      </div>
      <ul className="px-3">
        {destinations.map((destination, i) => (
          <li key={i} className="border-b py-2 text-sm last:border-b-0">
            {destination.to ? (
              <Link to={destination.to} className="font-bold text-primary hover:underline">
                {destination.screen}
              </Link>
            ) : (
              <span className="font-bold">{destination.screen}</span>
            )}
            <p className="mt-0.5 text-xs text-muted-foreground">{destination.what}</p>
          </li>
        ))}
      </ul>
    </section>
  )
}

export default ScopeMarks
