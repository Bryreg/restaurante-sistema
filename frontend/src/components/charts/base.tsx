/**
 * Componentes comunes a todos los gráficos: el rayado de «sin dato» y el
 * globo de lectura. Lo que no es componente está en `./nucleo`.
 */
import type { ReactNode } from "react"

/** Patrón rayado para «sin dato» (mismo lenguaje que `.sin-dato`). */
export function Rayado({ id }: { id: string }): React.JSX.Element {
  return (
    <pattern id={id} width={6} height={6} patternUnits="userSpaceOnUse" patternTransform="rotate(135)">
      <line x1={0} y1={0} x2={0} y2={6} stroke="var(--muted-foreground)" strokeOpacity={0.3} strokeWidth={2} />
    </pattern>
  )
}

/**
 * Globo de lectura. El valor manda (fuerte), la etiqueta va después (la
 * jerarquía de la leyenda invertida). Se ancla al lado que tiene lugar para
 * no desbordar a 360 px. Es un refuerzo: todo valor está también en la tabla.
 */
export function Globo({
  x,
  y,
  ancho,
  children,
}: {
  x: number
  y: number
  ancho: number
  children: ReactNode
}): React.JSX.Element {
  const aLaDerecha = x < ancho / 2
  return (
    <div
      aria-hidden="true"
      data-chart-globo=""
      className="pointer-events-none absolute z-10 max-w-[12rem] -translate-y-full rounded-md border bg-popover px-2 py-1.5 text-xs text-popover-foreground shadow-sm"
      style={{
        top: Math.max(0, y - 8),
        ...(aLaDerecha ? { left: Math.max(0, x + 8) } : { right: Math.max(0, ancho - x + 8) }),
      }}
    >
      {children}
    </div>
  )
}

/** Renglón del globo: clave de línea corta, valor fuerte, etiqueta suave. */
export function RenglonGlobo({
  color,
  valor,
  etiqueta,
}: {
  color?: string
  valor: ReactNode
  etiqueta?: ReactNode
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-1.5 whitespace-nowrap">
      {color ? <span className="inline-block h-0.5 w-3 shrink-0 rounded-full" style={{ background: color }} /> : null}
      <span className="font-semibold">{valor}</span>
      {etiqueta ? <span className="text-muted-foreground">{etiqueta}</span> : null}
    </div>
  )
}

