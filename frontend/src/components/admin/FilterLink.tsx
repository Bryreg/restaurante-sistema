import { ArrowRight } from "lucide-react"
import { Link } from "react-router-dom"

import { cn } from "@/lib/utils"

/**
 * **El enlace con filtro** (`docs/PATRONES-ADMIN.md` § 6). Las tarjetas y los
 * avisos de Hoy no llevan a una pantalla: llevan a una pestaña con filtros
 * puestos, y el enlace tiene que nombrar las tres cosas **en palabras**
 * —`Inventario › Stock` + pastilla `negativos`—, **nunca la consulta cruda**
 * (`?tab=stock&negative=1`): quien lee esto es el dueño de un restaurante, no
 * un programador.
 *
 * Por eso el destino y las palabras son props distintas: `to` es la URL y no
 * se dibuja nunca; `screen`, `tab` y `filter` son lo único que se ve. No hay
 * `children`: si el rótulo fuera libre, el primero que pase pegaría la query.
 *
 * Va **en par** con `OriginBar`: el que sale nombra el filtro, el que llega lo
 * reconoce y ofrece la salida. Sin `filter` no hay pastilla.
 */
export interface FilterLinkProps {
  /** La URL real, con su consulta. Es lo único que NO se muestra. */
  to: string
  /** La pantalla, en palabras: «Inventario». */
  screen: string
  /** La pestaña, en palabras: «Stock». */
  tab?: string
  /** El filtro, en palabras: «negativos». Sin filtro, no hay pastilla. */
  filter?: string
  className?: string
}

export function FilterLink({ to, screen, tab, filter, className }: FilterLinkProps): React.JSX.Element {
  const where = tab ? `${screen} › ${tab}` : screen
  return (
    <Link
      to={to}
      className={cn(
        "inline-flex flex-wrap items-center gap-1.5 text-xs font-bold text-primary hover:underline",
        className,
      )}
    >
      <span>{where}</span>
      {filter ? (
        <span className="rounded-full border border-dashed border-input bg-card px-2 py-px text-[0.95em] font-normal text-muted-foreground no-underline">
          {filter}
        </span>
      ) : null}
      <ArrowRight className="size-3.5 shrink-0" aria-hidden="true" />
    </Link>
  )
}

export default FilterLink
