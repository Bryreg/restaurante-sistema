import { CornerDownRight } from "lucide-react"
import { Link } from "react-router-dom"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export interface OriginBarProps {
  /** De dónde venís, en palabras: «Venís de Hoy › 5 insumos en negativo». */
  from: string
  /**
   * Qué se aplicó al llegar, en palabras: «negativos», «bajo mínimo». Al
   * menos uno — una barra de procedencia que no nombra el filtro no le dice
   * nada a nadie, y por eso el tipo pide una tupla no vacía.
   */
  applied: readonly [string, ...string[]]
  /**
   * **La salida.** Obligatoria: «Quitar el filtro y ver los 47». Sin esto el
   * dueño aterriza en una tabla corta y no sabe que le esconden filas
   * (`docs/PATRONES-ADMIN.md` § 6).
   */
  exit: { label: string; onClick: () => void }
  /** Volver a de dónde vino, si se puede. */
  back?: { label: string; to: string }
  className?: string
}

/**
 * **Barra de procedencia** (`docs/PATRONES-ADMIN.md` § 6): el reverso de
 * `FilterLink`. Van en par —el que sale nombra el filtro, el que llega lo
 * reconoce—: de dónde venís, qué se aplicó y **la salida**.
 *
 * Aplica a Inventario, Compras, Pedidos, Carta, Dinero y Preparaciones como
 * destinos de los 14 avisos de Hoy.
 */
export function OriginBar({ from, applied, exit, back, className }: OriginBarProps): React.JSX.Element {
  return (
    <div
      role="status"
      className={cn(
        "flex flex-wrap items-center gap-2 rounded-lg border border-primary/30 bg-accent px-3 py-2 text-sm",
        className,
      )}
    >
      <CornerDownRight className="size-4 shrink-0 text-primary" aria-hidden="true" />
      <p className="min-w-0">
        {from}
        <span className="sr-only">. Filtros aplicados: </span>
      </p>
      <span className="flex flex-wrap items-center gap-1.5">
        {applied.map((filter) => (
          <span
            key={filter}
            className="rounded-full border border-primary/30 bg-card px-2 py-px text-xs text-foreground"
          >
            {filter}
          </span>
        ))}
      </span>
      <span className="ml-auto flex flex-wrap items-center gap-2">
        {back ? (
          <Button variant="ghost" size="sm" render={<Link to={back.to} />}>
            {back.label}
          </Button>
        ) : null}
        <Button type="button" variant="outline" size="sm" onClick={exit.onClick}>
          {exit.label}
        </Button>
      </span>
    </div>
  )
}

export default OriginBar
