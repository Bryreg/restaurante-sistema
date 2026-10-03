import type { LucideIcon } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * **La fila del rail** (`docs/PATRONES-ADMIN.md` § 1). El armazón lo reparte
 * el layout —esta es la única pieza que se repite— y por eso vive acá y no
 * en `AdminLayout.tsx`: la usan las veinticinco entradas de navegación y
 * **también los tres controles del pie** (campana, tema, salir), que bajaron
 * de la barra superior cuando la barra superior dejó de existir. Si la clase
 * viviera en el layout, la campana y el tema tendrían que copiarla, y el pie
 * se vería distinto del cuerpo del rail el día que una de las dos cambie.
 *
 * Es deliberadamente una clase y un cuerpo, no un componente cerrado: las
 * entradas son `NavLink`, la campana es el disparador de un `DropdownMenu` y
 * el tema y la salida son `button`. Un componente que tuviera que envolver a
 * los cuatro terminaría recibiendo un `render`, y **un rótulo dentro de un
 * atributo `render={…}` es invisible para `src/audit/censo-controles.test.ts`**:
 * el censo lee el código, no el DOM.
 */
export interface RailItemContentProps {
  /** El ícono propio de la entrada. Nunca uno genérico repetido: una columna
   * de íconos idénticos no dice nada y cuesta lo mismo que uno que sí dice. */
  icon: LucideIcon
  /** El texto visible, corto: es lo que tiene que entrar en 222 px sin truncar. */
  label: string
  /**
   * El recuento, si la entrada tiene uno. `undefined` = todavía no se sabe
   * (la consulta no cargó, o la sede no está elegida) y `0` = no hay nada
   * pendiente: **ninguno de los dos se dibuja**. Una insignia en `0` es ruido
   * permanente, y un `0` inventado mientras carga miente.
   */
  count?: number | null
}

/** Las clases de una fila del rail. `active` es la entrada en la que estás. */
export function railItemClass(
  options: { active?: boolean; touch?: boolean; className?: string } = {},
): string {
  const { active = false, touch = false, className } = options
  return cn(
    // `justify-start` y `h-auto` no son decoración: el pie usa `Button` para
    // la campana (es el disparador del menú y trae su `aria-expanded`), y
    // `Button` viene centrado y con alto fijo. Puestos acá, `cn`
    // (tailwind-merge) los gana y la campana queda igual que las demás filas.
    "flex h-auto w-full items-center justify-start gap-2.5 rounded-[11px] px-2.5 py-1.5 text-left text-sm transition-colors",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
    // El rail del escritorio va a la densidad `.oficina` (40 px, handoff
    // «Burbujas»); el mismo rail dentro del cajón del móvil necesita el
    // objetivo táctil, que es otro usuario y otra mano.
    touch ? "min-h-11" : "min-h-10",
    active
      ? // «Burbujas»: la entrada en la que estás va en TINTA, no en cobalto.
        // El cobalto queda sólo para las acciones; marcar dónde estás no es
        // una acción. El recuento de la activa pasa a pastilla roja.
        "bg-foreground font-semibold text-card [&_[data-slot=rail-count]]:bg-destructive [&_[data-slot=rail-count]]:text-destructive-foreground [&_[data-slot=rail-count]]:opacity-100"
      : "font-medium text-foreground hover:bg-muted",
    className,
  )
}

/** El cuerpo de una fila: ícono, rótulo que se recorta, recuento a la derecha. */
export function RailItemContent({ icon: Icon, label, count }: RailItemContentProps): React.JSX.Element {
  return (
    <>
      <Icon className="size-[17px] shrink-0" aria-hidden="true" />
      {/* `truncate` y no envolver: una entrada que crece a dos líneas mueve
          las diecinueve de abajo y el rail deja de ser una columna. */}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count != null && count > 0 ? (
        <span
          aria-hidden="true"
          // Pastilla neutra; en la entrada activa (tinta) pasa a roja desde
          // `railItemClass`, que es quien sabe cuál está activa.
          data-slot="rail-count"
          className="grid h-5 min-w-5 shrink-0 place-items-center rounded-full bg-muted px-1.5 text-xs font-semibold tabular-nums"
        >
          {count}
        </span>
      ) : null}
    </>
  )
}
