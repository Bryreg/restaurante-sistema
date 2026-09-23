import { TEXTO_SIN_DATO } from "./nucleo"

export interface DivergingDatum {
  key: string
  etiqueta: string
  valor: number | null
}

export interface DivergingBarsProps {
  datos: DivergingDatum[]
  /** Formatea la cifra CON su signo tal como la manda el backend (`formatCOP(-18000)` → «-$ 18.000»). */
  formato: (v: number) => string
  /** Qué signo es faltante. Caja y varianza: «negativo» (por defecto). */
  faltaCuando?: "negativo" | "positivo"
  /** Las palabras que acompañan al color. */
  palabras?: { falta: string; sobra: string; cero: string }
  resumen?: string
}

const PALABRAS = { falta: "faltante", sobra: "sobrante", cero: "cuadra" }

/**
 * Barras divergentes con el cero al centro (gris neutro): faltante en rojo,
 * sobrante en ámbar, y SIEMPRE ▼/▲ con la cifra con signo y la palabra, así
 * el color nunca es la única señal. `null` es «sin dato» rayado, no un 0.
 * No reordena: el orden lo decide quien lo usa (turno, persona, insumo).
 */
export function DivergingBars({
  datos,
  formato,
  faltaCuando = "negativo",
  palabras = PALABRAS,
  resumen,
}: DivergingBarsProps): React.JSX.Element {
  const tope = Math.max(0, ...datos.map((d) => (d.valor === null ? 0 : d.valor < 0 ? -d.valor : d.valor)))
  const esFalta = (v: number) => (faltaCuando === "negativo" ? v < 0 : v > 0)

  const conSigno = (v: number) => {
    const t = formato(v)
    if (v > 0 && !t.startsWith("+")) return `+${t}`
    return t.replace(/^-/, "−")
  }

  const faltantes = datos.filter((d) => d.valor !== null && esFalta(d.valor)).length
  const texto =
    resumen ??
    `Diferencias de ${datos.length} elementos con el cero al centro: ${faltantes} con ${palabras.falta}. El detalle está en la tabla.`

  return (
    <ol role="img" aria-label={texto} className="m-0 list-none space-y-2.5 p-0">
      {datos.map((d) => {
        if (d.valor === null) {
          return (
            <li key={d.key} data-fila={d.key} className="min-w-0">
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span className="min-w-0 truncate">{d.etiqueta}</span>
                <span className="shrink-0 text-muted-foreground italic">{TEXTO_SIN_DATO}</span>
              </div>
              <div className="sin-dato mt-1 h-2.5 w-full" data-hueco={d.key} />
            </li>
          )
        }
        const v = d.valor
        const falta = esFalta(v)
        const cero = v === 0
        const flecha = cero ? "=" : v < 0 ? "▼" : "▲"
        const palabra = cero ? palabras.cero : falta ? palabras.falta : palabras.sobra
        const color = falta ? "var(--diverge-falta)" : "var(--diverge-sobra)"
        const mitad = tope > 0 ? ((v < 0 ? -v : v) / tope) * 50 : 0
        return (
          <li key={d.key} data-fila={d.key} className="min-w-0" title={`${d.etiqueta} · ${conSigno(v)} ${palabra}`}>
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="min-w-0 truncate">{d.etiqueta}</span>
              <span className="shrink-0 whitespace-nowrap">
                <span aria-hidden="true" className="mr-1 text-xs">
                  {flecha}
                </span>
                <span className="font-medium" data-cifra="">
                  {cero ? formato(v) : conSigno(v)}
                </span>
                <span className="ml-1 text-xs text-muted-foreground">{palabra}</span>
              </span>
            </div>
            <div className="relative mt-1 h-2.5 w-full">
              <div
                className="absolute inset-y-[-3px] left-1/2 w-[2px] -translate-x-1/2"
                style={{ background: "var(--diverge-mid)" }}
              />
              {cero ? null : (
                <div
                  data-barra={falta ? "falta" : "sobra"}
                  className={v < 0 ? "absolute inset-y-0 rounded-l-[4px]" : "absolute inset-y-0 rounded-r-[4px]"}
                  style={{
                    background: color,
                    width: `calc(${mitad}% - 1px)`,
                    minWidth: 2,
                    ...(v < 0 ? { right: "calc(50% + 1px)" } : { left: "calc(50% + 1px)" }),
                  }}
                />
              )}
            </div>
          </li>
        )
      })}
    </ol>
  )
}
