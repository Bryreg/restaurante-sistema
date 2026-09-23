/**
 * Lo común a todos los gráficos que no es un componente: medir el ancho,
 * ticks redondos, la barra con el extremo de dato redondeado y el recorrido
 * con teclado (los componentes comunes están en `./base`). Nada de esto calcula una cifra de
 * negocio: sólo lleva valores ya calculados por el backend a píxeles.
 */
import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react"

/** Tipografía de ejes y etiquetas (px). */
export const TEXTO_PX = 12
/** Grosor máximo de una barra/columna (guía: ≤ 24 px, el resto es aire). */
export const BARRA_MAX = 24
/** Radio del extremo de dato; la base queda cuadrada. */
export const RADIO = 4
/** Separación de superficie entre marcas que se tocan. */
export const SEPARACION = 2

/** Tinta de texto y de mueble del gráfico: nunca el color de la serie. */
export const TINTA = {
  texto: "var(--foreground)",
  secundario: "var(--muted-foreground)",
  grilla: "var(--border)",
  base: "color-mix(in oklab, var(--muted-foreground) 55%, transparent)",
  superficie: "var(--card)",
} as const

/**
 * Ancho real del contenedor (ResizeObserver). Mientras no hay medida (o en
 * jsdom, que no mide) se usa `defecto`; el SVG va con `width="100%"` y un
 * `viewBox` del ancho medido, así que nunca se deforma ni desborda.
 */
export function useAncho<T extends HTMLElement>(defecto = 480) {
  const ref = useRef<T>(null)
  const [ancho, setAncho] = useState(defecto)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const medir = () => {
      const w = el.getBoundingClientRect().width
      if (w > 0) setAncho(Math.round(w))
    }
    medir()
    if (typeof ResizeObserver === "undefined") return
    const ro = new ResizeObserver(medir)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, ancho] as const
}

/** Ancho aproximado de un texto a `px` (sin medir el DOM). */
export function anchoTexto(texto: string, px = TEXTO_PX): number {
  return texto.length * px * 0.58
}

function pasoRedondo(bruto: number): number {
  const exp = Math.pow(10, Math.floor(Math.log10(bruto)))
  const f = bruto / exp
  const n = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10
  return n * exp
}

export interface Escala {
  min: number
  max: number
  ticks: number[]
}

/**
 * Dominio con ticks redondos (0 / 500.000 / 1.000.000 …), 3 o 4 intervalos.
 * `incluirCero` ancla el eje en 0 (columnas y barras: siempre).
 */
export function escalaRedonda(
  valores: number[],
  { incluirCero = true, intervalos = 3 }: { incluirCero?: boolean; intervalos?: number } = {},
): Escala {
  const finitos = valores.filter((v) => Number.isFinite(v))
  let lo = finitos.length ? Math.min(...finitos) : 0
  let hi = finitos.length ? Math.max(...finitos) : 0
  if (incluirCero) {
    lo = Math.min(lo, 0)
    hi = Math.max(hi, 0)
  }
  if (lo === hi) {
    const pad = lo === 0 ? 1 : Math.abs(lo) * 0.1
    if (incluirCero && lo >= 0) hi = lo + pad
    else if (incluirCero) lo = hi - pad
    else {
      lo -= pad
      hi += pad
    }
  }
  const paso = pasoRedondo((hi - lo) / intervalos)
  const min = Math.floor(lo / paso + 1e-9) * paso
  const max = Math.ceil(hi / paso - 1e-9) * paso
  const ticks: number[] = []
  for (let v = min; v <= max + paso / 2; v += paso) ticks.push(Number(v.toPrecision(12)))
  return { min, max, ticks }
}

/** Lleva un valor del dominio a una coordenada del rango (lineal). */
export function lineal(dominio: [number, number], rango: [number, number]) {
  const [d0, d1] = dominio
  const [r0, r1] = rango
  const span = d1 - d0 || 1
  return (v: number) => r0 + ((v - d0) / span) * (r1 - r0)
}

/**
 * Columna vertical con el extremo de dato redondeado y la base cuadrada.
 * `yDato` puede quedar arriba (valor positivo) o abajo (negativo) de `yBase`.
 */
export function barraV(x: number, w: number, yBase: number, yDato: number, r = RADIO): string {
  const alto = Math.abs(yBase - yDato)
  if (alto < 0.5) return ""
  const rr = Math.min(r, w / 2, alto)
  if (yDato < yBase) {
    return `M${x},${yBase}V${yDato + rr}Q${x},${yDato} ${x + rr},${yDato}H${x + w - rr}Q${x + w},${yDato} ${x + w},${yDato + rr}V${yBase}Z`
  }
  return `M${x},${yBase}V${yDato - rr}Q${x},${yDato} ${x + rr},${yDato}H${x + w - rr}Q${x + w},${yDato} ${x + w},${yDato - rr}V${yBase}Z`
}

/** Id seguro para usar en `url(#…)` (useId trae «:»). */
export function idSeguro(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "")
}

/**
 * Índice activo (hover, foco y flechas). Un solo punto de tabulación por
 * gráfico: el contenedor. ← → recorren, Inicio/Fin saltan, Esc suelta.
 */
export function useRecorrido(n: number) {
  const [activo, setActivo] = useState<number | null>(null)
  const onKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (n === 0) return
      const actual = activo ?? -1
      let siguiente: number | null = null
      if (e.key === "ArrowRight" || e.key === "ArrowDown") siguiente = Math.min(n - 1, actual + 1)
      else if (e.key === "ArrowLeft" || e.key === "ArrowUp") siguiente = Math.max(0, actual < 0 ? n - 1 : actual - 1)
      else if (e.key === "Home") siguiente = 0
      else if (e.key === "End") siguiente = n - 1
      else if (e.key === "Escape") {
        setActivo(null)
        return
      } else return
      e.preventDefault()
      setActivo(siguiente)
    },
    [activo, n],
  )
  const soltar = useCallback(() => setActivo(null), [])
  return { activo, setActivo, onKeyDown, soltar }
}

/** Lo que `ChartFrame` ofrece a los gráficos de adentro (p. ej. «y N más»). */
export interface MarcoGrafico {
  verTabla: () => void
}

export const MarcoContext = createContext<MarcoGrafico | null>(null)

export function useMarco(): MarcoGrafico | null {
  return useContext(MarcoContext)
}

/** Clases del contenedor enfocable de cada gráfico. */
export const CLASE_LIENZO =
  "relative w-full min-w-0 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"

/** «sin dato» para el resumen accesible. */
export const TEXTO_SIN_DATO = "sin dato"

/**
 * Halo del color de la superficie detrás de un rótulo que cae sobre marcas
 * (referencia, umbral, etiqueta directa): se lee sin tapar el dato.
 */
export const HALO = {
  paintOrder: "stroke",
  stroke: "var(--card)",
  strokeWidth: 3,
  strokeLinejoin: "round",
} as const
