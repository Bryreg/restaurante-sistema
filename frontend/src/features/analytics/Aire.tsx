/**
 * Las dos piezas de «Orden y aire» que repiten las cuatro pestañas de
 * Analítica (mapa de pantallas, reglas 1 y 2): la cifra que manda en la
 * pantalla y el plegable donde va lo que explica en vez de dar un dato.
 * Ninguna calcula nada: la cifra llega ya formateada.
 */
import { cn } from "@/lib/utils"

/** Verde venta, rojo faltante, ámbar pendiente; neutro cuando no hay nada que señalar. */
export type TonoCifra = "neutral" | "success" | "warning" | "critical"

const TONO: Record<TonoCifra, string> = {
  neutral: "text-foreground",
  success: "text-success",
  warning: "text-warning",
  critical: "text-destructive",
}

/**
 * **Una cifra protagonista por pantalla** (regla 1): grande, con
 * `tabular-nums` y el color de lo que significa. El rótulo va al lado y en
 * palabras —el color nunca es la única señal—.
 */
export function CifraProtagonista({
  valor,
  rotulo,
  tono = "neutral",
  nota,
  testId,
}: {
  valor: string
  rotulo: string
  tono?: TonoCifra
  nota?: React.ReactNode
  testId?: string
}): React.JSX.Element {
  return (
    <div data-testid={testId}>
      <p className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <span className={cn("text-4xl leading-none font-bold tracking-tight whitespace-nowrap tabular-nums", TONO[tono])}>
          {valor}
        </span>
        <span className="text-base font-medium">{rotulo}</span>
      </p>
      {nota ? <div className="mt-1.5 text-sm text-muted-foreground">{nota}</div> : null}
    </div>
  )
}

/**
 * **La explicación, plegada** (regla 2): el método, cómo se calcula, por
 * qué algo no entra. Sigue en el árbol —un `<details>` cerrado no saca su
 * contenido del DOM—, así que la pantalla no cambia de qué dice, sólo de
 * qué muestra de entrada. El motivo de un «sin dato» NO va acá: ése queda a
 * la vista.
 */
export function ComoLeer({
  resumen = "Cómo leer esto",
  children,
  className,
  testId,
}: {
  resumen?: React.ReactNode
  children: React.ReactNode
  className?: string
  testId?: string
}): React.JSX.Element {
  return (
    <details className={cn("text-sm text-muted-foreground", className)} data-testid={testId}>
      <summary className="w-fit cursor-pointer rounded-md py-0.5 font-medium select-none hover:text-foreground">
        {resumen}
      </summary>
      <div className="mt-1 max-w-[80ch] space-y-1.5">{children}</div>
    </details>
  )
}
