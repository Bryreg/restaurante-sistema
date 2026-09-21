import type { LucideIcon } from "lucide-react"

import { FilterLink, type FilterLinkProps } from "@/components/admin/FilterLink"
import { cn } from "@/lib/utils"

export type StatTileTone = "default" | "warning" | "critical"

interface StatTileBase {
  label: string
  hint?: string
  tone?: StatTileTone
  icon?: LucideIcon
  /**
   * A dónde lleva la tarjeta (`docs/PATRONES-ADMIN.md` § 5 y § 6). La regla
   * dura del patrón: **una tarjeta con tono es una tarjeta que lleva a algún
   * lado** —si no, el color es decoración—. No se puede exigir por tipos sin
   * romper las setenta y cuatro tarjetas ya escritas, así que la regla queda
   * acá y en el catálogo; lo que sí impide el tipo es el otro error, que es
   * el enlace que muestra la consulta cruda: `FilterLink` recibe el destino y
   * las palabras por separado y sólo dibuja las palabras.
   */
  link?: FilterLinkProps
}

export type StatTileProps =
  | (StatTileBase & {
      /** Ya formateado (`formatCOP`, un entero, un porcentaje) — este componente nunca calcula. */
      value: string
      nullNote?: never
    })
  | (StatTileBase & {
      /**
       * `null` NO es `0` (AGENTS.md; `docs/PATRONES-ADMIN.md` § 5). Se dibuja
       * `—`, apagado y **nunca en rojo**: no saber no es estar mal.
       */
      value: null
      /**
       * Por qué no se sabe, obligatorio: «222 contados, sin registrar en 31
       * comandas de mostrador. No es cero: es que nadie lo contó». Un `—`
       * sin esta frase es el bug que el patrón vino a matar.
       */
      nullNote: string
    })

/**
 * El teñido del cuerpo. `warning` era gris (`bg-secondary/50`), que es el
 * color de «zona quieta» y no el de «mirá esto»: la maqueta `a2` tiñe la
 * tarjeta de ámbar (`.kpi.warn{border-color:var(--warn-line);background:
 * var(--warn-soft)}`) igual que tiñe de rojo la crítica. No rompe la regla
 * del color de `docs/DISENO.md` —la endereza—: ámbar acá está diciendo
 * **cómo está algo**, que es exactamente para lo que existe, y no viste
 * ningún botón (el enlace de adentro sigue siendo azul).
 */
const TONE_CONTAINER: Record<StatTileTone, string> = {
  default: "border-border",
  warning: "border-warning/45 bg-warning/10",
  critical: "border-destructive/30 bg-destructive/5",
}

/**
 * La franja de estado de 3 px a la izquierda (`docs/PATRONES-ADMIN.md` § 5).
 * Va en el borde y no en el fondo: el teñido del cuerpo ya lo decide
 * `TONE_CONTAINER`, y ese se dejó **exactamente como estaba** para que las
 * tarjetas ya escritas no cambien de color de un día para el otro.
 */
const TONE_STRIPE: Record<StatTileTone, string> = {
  default: "border-l-border",
  warning: "border-l-warning",
  critical: "border-l-destructive",
}

const TONE_VALUE: Record<StatTileTone, string> = {
  default: "text-foreground",
  // `a2` colorea también la cifra de la tarjeta en ámbar
  // (`.kpi.warn .cifra{color:var(--warn)}`), simétrico a la crítica.
  warning: "text-warning",
  critical: "text-destructive",
}

/**
 * "Un KPI que decide → stat tile con su contexto" (SPEC-NEGOCIO §9.3), más el
 * pie que dice **de qué está hecha** la cifra (`docs/PATRONES-ADMIN.md` § 5):
 * «96 en mesa · 31 mostrador · 21 domicilio». Máximo un nivel de énfasis por
 * tarjeta: sólo `value` es grande. El color de `tone` nunca es la única señal
 * — el texto de `label`/`hint` ya dice lo mismo que el tono, y `icon` es una
 * segunda pista visual.
 */
export function StatTile(props: StatTileProps): React.JSX.Element {
  const { label, hint, tone = "default", icon: Icon, link, value } = props
  const isNull = value === null
  return (
    <div
      className={cn("rounded-lg border border-l-[3px] p-4", TONE_CONTAINER[tone], TONE_STRIPE[tone])}
    >
      {/* El ícono va **antes** del rótulo, como en `a2` (`.kpi .rotulo`), y
          no empujado al borde derecho: pegado al rótulo se lee como parte de
          él; suelto a la derecha, la fila de tarjetas queda con una columna
          de íconos flotando que no pertenece a nada. */}
      <div className="flex items-center gap-1.5">
        {Icon ? <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" /> : null}
        <p className="min-w-0 text-sm text-muted-foreground">{label}</p>
      </div>
      <p
        className={cn(
          "mt-1 text-2xl font-semibold tabular-nums",
          // `—` se dibuja apagado, NUNCA en rojo, aunque el tono sea crítico:
          // no saber no es estar mal.
          isNull ? "font-normal text-muted-foreground" : TONE_VALUE[tone],
        )}
      >
        {isNull ? "—" : value}
      </p>
      {props.value === null ? (
        <p className="mt-1 text-xs text-muted-foreground">{props.nullNote}</p>
      ) : null}
      {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
      {link ? <FilterLink {...link} className="mt-2" /> : null}
    </div>
  )
}

export default StatTile
