/**
 * SVG/CSS propio, sin librería (SPEC-NEGOCIO §9.3: "no agregues una
 * librería de charts sin justificación — SVG/CSS propio primero"). Dos
 * formas nada más, elegidas por la pregunta que responden:
 *
 * - `CategoryBars`: comparación entre categorías (canal, medio, persona,
 *   hora del día, zona) → barras con eje desde cero.
 * - `TrendLine`: tendencia en el tiempo (día operativo, turno, una
 *   secuencia con orden propio) → línea.
 *
 * Los dos son puramente de presentación: reciben números YA calculados por
 * el backend y sólo los dibujan (ninguna suma/resta/multiplicación de
 * plata acá). El color es un solo token (`--primary`) referenciado por
 * variable CSS, nunca un hex/oklch hardcodeado, y nunca es la única señal:
 * cada barra/punto va acompañado del número exacto en texto, y la tabla de
 * la pantalla que los usa es la alternativa accesible completa (WCAG 2.1:
 * "tabla accesible como alternativa de todo gráfico") — el propio SVG lleva
 * `role="img"` con un `aria-label` que dice eso mismo.
 */

export interface CategoryBarDatum {
  key: string
  label: string
  value: number
}

export function CategoryBars({
  data,
  formatValue = (v: number) => String(v),
  emptyLabel = "Sin datos en este período",
}: {
  data: CategoryBarDatum[]
  formatValue?: (value: number) => string
  emptyLabel?: string
}): React.JSX.Element {
  if (data.length === 0) {
    return <p className="text-sm text-muted-foreground">{emptyLabel}</p>
  }
  const max = Math.max(1, ...data.map((d) => Math.abs(d.value)))
  return (
    <div
      className="space-y-2"
      role="img"
      aria-label="Comparación por categoría; el detalle exacto está en la tabla de abajo"
    >
      {data.map((d) => (
        <div key={d.key} className="flex items-center gap-2 text-sm">
          <span className="w-28 shrink-0 truncate text-muted-foreground" title={d.label}>
            {d.label}
          </span>
          <span className="h-4 min-w-8 flex-1 overflow-hidden rounded-sm bg-muted">
            <span
              className="block h-full rounded-sm bg-primary"
              style={{ width: `${Math.max(0, (Math.abs(d.value) / max) * 100)}%` }}
            />
          </span>
          <span className="w-24 shrink-0 text-right tabular-nums">{formatValue(d.value)}</span>
        </div>
      ))}
    </div>
  )
}

export interface TrendPoint {
  key: string
  label: string
  value: number
}

const TREND_WIDTH = 100
const TREND_HEIGHT = 40

export function TrendLine({
  data,
  formatValue = (v: number) => String(v),
  emptyLabel = "Sin datos en este período",
}: {
  data: TrendPoint[]
  formatValue?: (value: number) => string
  emptyLabel?: string
}): React.JSX.Element {
  if (data.length === 0) {
    return <p className="text-sm text-muted-foreground">{emptyLabel}</p>
  }
  if (data.length === 1) {
    const only = data[0]!
    return (
      <p className="text-sm">
        {only.label}: <span className="font-medium tabular-nums">{formatValue(only.value)}</span>
      </p>
    )
  }

  const values = data.map((d) => d.value)
  const max = Math.max(...values, 0)
  const min = Math.min(...values, 0)
  const span = max - min || 1
  const points = data
    .map((d, i) => {
      const x = (i / (data.length - 1)) * TREND_WIDTH
      const y = TREND_HEIGHT - ((d.value - min) / span) * TREND_HEIGHT
      return `${x},${y}`
    })
    .join(" ")
  const zeroY = TREND_HEIGHT - ((0 - min) / span) * TREND_HEIGHT
  const first = data[0]!
  const last = data[data.length - 1]!

  return (
    <div className="space-y-1">
      <svg
        viewBox={`0 0 ${TREND_WIDTH} ${TREND_HEIGHT}`}
        preserveAspectRatio="none"
        className="h-28 w-full"
        role="img"
        aria-label="Tendencia en el tiempo; el detalle exacto está en la tabla de abajo"
      >
        <line x1={0} y1={zeroY} x2={TREND_WIDTH} y2={zeroY} stroke="var(--border)" strokeWidth={0.5} />
        <polyline points={points} fill="none" stroke="var(--primary)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>
          {first.label}: <span className="tabular-nums">{formatValue(first.value)}</span>
        </span>
        <span>
          {last.label}: <span className="tabular-nums">{formatValue(last.value)}</span>
        </span>
      </div>
    </div>
  )
}
