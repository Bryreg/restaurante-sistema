import { useId } from "react"

import { cn } from "@/lib/utils"

export interface GroupLabelProps {
  /** El rótulo, corto y en versalitas: «Del día», «Ahora mismo». */
  label: string
  /**
   * **Qué quiere decir el grupo**, obligatorio: «cerrado, ya no cambia» /
   * «vivo, todavía puede cambiar o salir mal». Sin esta frase el rótulo es
   * decoración y la grilla vuelve a aplanar cosas de naturaleza distinta
   * (`docs/PATRONES-ADMIN.md` § 3).
   */
  says: string
  children?: React.ReactNode
  className?: string
}

/**
 * **Rótulo de grupo** (`docs/PATRONES-ADMIN.md` § 3). Una grilla uniforme
 * aplana cosas de naturaleza distinta: «ticket promedio» y «comandas
 * abiertas» no son el mismo tipo de número. El filete parte la grilla y la
 * frase dice de qué tipo es cada mitad.
 *
 * Aplica a Dinero, Turnos, Banco, Nómina y Analítica: toda pantalla que
 * mezcle cierre y curso.
 */
export function GroupLabel({ label, says, children, className }: GroupLabelProps): React.JSX.Element {
  const id = useId()
  return (
    <section aria-labelledby={id} className={cn("min-w-0", className)}>
      <div className="mb-2 flex items-baseline gap-2.5">
        <h2 id={id} className="text-xs font-bold tracking-wider whitespace-nowrap uppercase">
          {label}
        </h2>
        <span className="min-w-0 text-xs text-muted-foreground">{says}</span>
        <span aria-hidden="true" className="h-px min-w-3 flex-1 self-center bg-border" />
      </div>
      {children}
    </section>
  )
}

export default GroupLabel
