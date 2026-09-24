import { cn } from "@/lib/utils"

/**
 * **La explicación, plegada** (mapa de pantallas de «Orden y aire», regla 2:
 * «la explicación va en ¿Qué es esto?, no en la pantalla»). El pie de una
 * tarjeta, el método de un gráfico, el porqué de un aviso: se leen una vez,
 * y a la vista eran ruido en cada vistazo. Siguen en el árbol —`<details>`
 * cerrado—, así que la pantalla no cambia de qué dice, sólo de qué muestra.
 *
 * Lo que **no** se pliega nunca es el motivo de un «sin dato» (`null` no es
 * `0`): ése va a la vista, al lado de la cifra que falta.
 */
export function Plegable({
  resumen,
  children,
  className,
}: {
  /** El rótulo del plegable: «Cómo leer esto», «Cómo leer estos indicadores». */
  resumen: string
  children: React.ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <details className={cn("text-xs text-muted-foreground", className)}>
      <summary className="w-fit cursor-pointer rounded-md py-1 font-medium select-none hover:text-foreground">
        {resumen}
      </summary>
      <div className="pt-1 pb-2">{children}</div>
    </details>
  )
}

export interface Definicion {
  term: string
  meaning: React.ReactNode
}

/**
 * Términos y lo que quieren decir, dentro de un `Plegable`. «Rótulo:» lleva
 * los dos puntos adentro del término: así no repite, letra por letra, el
 * rótulo de la tarjeta que explica.
 */
export function Definiciones({
  items,
  className,
}: {
  items: readonly Definicion[]
  className?: string
}): React.JSX.Element {
  return (
    <dl className={cn("grid gap-x-5 gap-y-1", className)}>
      {items.map((e) => (
        <div key={e.term} className="min-w-0">
          <dt className="inline font-bold text-foreground">{e.term}:</dt> <dd className="inline">{e.meaning}</dd>
        </div>
      ))}
    </dl>
  )
}
