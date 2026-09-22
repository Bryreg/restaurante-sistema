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

import { cortesDeEje, rotuloDeCorte } from "./escalaEje"

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

// ---------------------------------------------------------------------------
// Columnas por hora (`a2`)
// ---------------------------------------------------------------------------

export interface HourColumnDatum {
  hour: number
  /** Neto de la hora, hoy. */
  value: number
  /** El mismo día de la semana pasada a la misma hora. `null` ≠ 0. */
  reference?: number | null
  /** La hora que todavía está corriendo: su barra no está completa. */
  inProgress?: boolean
}

/**
 * **Las ventas por hora de `a2`**: columnas verticales, la hora en curso
 * marcada como un tocón hueco, y una raya gris por hora con lo que vendió el
 * mismo día de la semana pasada.
 *
 * La forma no es capricho. Las barras horizontales que había antes comparaban
 * horas entre sí, que es lo que la forma horizontal hace bien; pero la
 * pregunta de esta pantalla es **la forma del día** —dónde está el almuerzo,
 * dónde el bache de la tarde, si la noche arrancó— y eso es una curva. En
 * vertical, con el tiempo corriendo de izquierda a derecha, la curva se ve.
 *
 * **La hora en curso se dibuja como un tocón de 6 px y no como una barra
 * corta.** Una barra a media altura a las 8 p. m. se lee como «la noche va
 * floja»; el tocón se lee como «esta hora todavía no terminó», que es lo que
 * pasa. Es la misma distinción que `null` ≠ 0 en todo el producto.
 *
 * Nada de esto calcula plata: `value` y `reference` llegan del servidor
 * (`sales_by_hour[].net` y `.net_last_week`). Acá sólo se eligen escalas.
 */
export function HourColumns({
  data,
  referenceLabel,
  formatValue = (v: number) => String(v),
  emptyLabel = "Sin ventas todavía",
  description,
  caption,
}: {
  data: HourColumnDatum[]
  /** Cómo se llama la serie gris («El lunes pasado»). */
  referenceLabel: string
  formatValue?: (value: number) => string
  emptyLabel?: string
  /** El `aria-label` del SVG: qué dice la gráfica, en palabras. */
  description: string
  /**
   * El renglón que va DEBAJO del eje (`a2`: «Hora de apertura del cajón a
   * las 10:00 · la de las 23:00 va en curso»). Lo arma la pantalla, que es
   * la que sabe de turnos; la gráfica sólo lo dibuja donde va.
   */
  caption?: string
}): React.JSX.Element {
  if (data.length === 0) {
    return <p className="text-sm text-muted-foreground">{emptyLabel}</p>
  }

  const L = 58
  const R = 688
  const T = 16
  const B = 190
  const valores = data.flatMap((d) => [d.value, d.reference ?? 0])
  const lineas = cortesDeEje(Math.max(1, ...valores))
  const max = lineas[lineas.length - 1] ?? 1
  const slot = (R - L) / data.length
  const ancho = slot * 0.6
  const y = (v: number) => B - (v / max) * (B - T)

  /**
   * **Dos picos rotulados, no uno** (`a2`). Un día de restaurante tiene dos
   * jorobas —el almuerzo y la noche— y rotular sólo la más alta esconde la
   * otra, que es justamente la que el dueño compara. El corte va en la
   * misma hora que separa los dos servicios en la operación (17:00).
   */
  const mayorDe = (desde: number, hasta: number) =>
    data.reduce<HourColumnDatum | null>(
      (best, d) =>
        !d.inProgress && d.value > 0 && d.hour >= desde && d.hour < hasta &&
        (best === null || d.value > best.value)
          ? d
          : best,
      null,
    )
  const HORA_CENA = 17
  const picos = [mayorDe(0, HORA_CENA), mayorDe(HORA_CENA, 24)].filter(
    (d): d is HourColumnDatum => d !== null,
  )
  const hayReferencia = data.some((d) => d.reference != null)

  return (
    <div className="space-y-2">
      <svg viewBox="0 0 700 226" className="block h-auto w-full" role="img" aria-label={description}>
        {lineas.map((v) => (
          <g key={v}>
            <line
              x1={L}
              y1={y(v)}
              x2={R}
              y2={y(v)}
              className="stroke-border"
              strokeWidth={1}
              strokeDasharray="3 3"
            />
            <text x={L - 8} y={y(v) + 4} textAnchor="end" className="fill-muted-foreground text-[11px]">
              {rotuloDeCorte(v)}
            </text>
          </g>
        ))}

        {data.map((d, i) => {
          const x = L + i * slot
          const bx = x + (slot - ancho) / 2
          const alto = Math.max(B - y(d.value), 1)
          return (
            <g key={d.hour}>
              {d.inProgress ? (
                <rect
                  x={bx}
                  y={B - 6}
                  width={ancho}
                  height={6}
                  rx={2}
                  className="fill-accent stroke-primary/40"
                  strokeWidth={1}
                />
              ) : d.value > 0 ? (
                <rect x={bx} y={y(d.value)} width={ancho} height={alto} rx={2} className="fill-primary" />
              ) : null}
              {d.reference != null && d.reference > 0 ? (
                <line
                  x1={bx - 2}
                  y1={y(d.reference)}
                  x2={bx + ancho + 2}
                  y2={y(d.reference)}
                  className="stroke-muted-foreground"
                  strokeWidth={2}
                  strokeLinecap="round"
                />
              ) : null}
              {i % 2 === 0 ? (
                <text x={x + slot / 2} y={B + 15} textAnchor="middle" className="fill-muted-foreground text-[11px]">
                  {d.hour}:00
                </text>
              ) : null}
              {picos.some((pk) => pk.hour === d.hour) ? (
                <text
                  x={x + slot / 2}
                  y={y(d.value) - 6}
                  textAnchor="middle"
                  className="fill-foreground text-[11px] font-bold"
                >
                  {formatValue(d.value)}
                </text>
              ) : null}
            </g>
          )
        })}

        <line x1={L} y1={B} x2={R} y2={B} className="stroke-input" strokeWidth={1} />

        {/* El renglón de abajo, adentro del SVG como en `a2`: pertenece al
            eje —dice qué franja se está mirando— y separado quedaría como
            una nota al pie cualquiera. */}
        {caption ? (
          <text
            x={L + (R - L) / 2}
            y={B + 34}
            textAnchor="middle"
            className="fill-muted-foreground text-[11px]"
          >
            {caption}
          </text>
        ) : null}
      </svg>

      {/* La leyenda con texto, nunca sólo color (WCAG 1.4.1). */}
      <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <svg width="13" height="13" aria-hidden="true">
            <rect width="13" height="13" rx="2" className="fill-primary" />
          </svg>
          Hoy
        </span>
        {hayReferencia ? (
          <span className="flex items-center gap-1.5">
            <svg width="15" height="13" aria-hidden="true">
              <line x1="0" y1="6.5" x2="15" y2="6.5" className="stroke-muted-foreground" strokeWidth={2} />
            </svg>
            {referenceLabel}
          </span>
        ) : null}
        {data.some((d) => d.inProgress) ? (
          <span className="flex items-center gap-1.5">
            <svg width="13" height="13" aria-hidden="true">
              <rect width="13" height="13" rx="2" className="fill-accent stroke-primary/40" strokeWidth={1} />
            </svg>
            Hora en curso
          </span>
        ) : null}
      </div>
    </div>
  )
}
