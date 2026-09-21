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
    "flex h-auto w-full items-center justify-start gap-2 rounded-md px-2 py-1.5 text-left text-sm font-medium transition-colors",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
    // El rail del escritorio va a la densidad `.oficina`; el mismo rail dentro
    // del cajón del móvil necesita el objetivo táctil, que es otro usuario y
    // otra mano (`docs/DISENO.md` § "Las dos densidades").
    touch ? "min-h-11" : "min-h-8",
    active
      ? // La maqueta `a2` marca la entrada activa con la marca **llena**
        // (`.nav-i[aria-current="page"]{background:var(--brand);color:#fff}`)
        // y no con el `accent` suave que `docs/DISENO.md` le asignaba a "la
        // fila activa". El dueño eligió a2 mirándola, y la regla dura del
        // color sigue intacta: la marca no está diciendo un estado —verde,
        // ámbar y rojo siguen siendo los únicos que dicen cómo está algo—,
        // está marcando el enlace en el que estás parado, que es de la misma
        // familia de lo que se toca.
        "bg-primary font-semibold text-primary-foreground"
      : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
    className,
  )
}

/** El cuerpo de una fila: ícono, rótulo que se recorta, recuento a la derecha. */
export function RailItemContent({ icon: Icon, label, count }: RailItemContentProps): React.JSX.Element {
  return (
    <>
      <Icon className="size-4 shrink-0" aria-hidden="true" />
      {/* `truncate` y no envolver: una entrada que crece a dos líneas mueve
          las diecinueve de abajo y el rail deja de ser una columna. */}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count != null && count > 0 ? (
        <span
          aria-hidden="true"
          // Sin color propio: hereda el de la fila y se apaga con opacidad.
          // Un `text-muted-foreground` fijo desaparecía sobre el azul lleno
          // de la entrada activa (a2 lo resuelve igual, con un azul claro).
          className="shrink-0 text-xs font-normal tabular-nums opacity-70"
        >
          {count}
        </span>
      ) : null}
    </>
  )
}
