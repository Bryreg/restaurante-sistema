import { Link } from "react-router-dom"

import { TEXTO_SIN_DATO, useMarco } from "./nucleo"

export interface BarListDatum {
  key: string
  etiqueta: string
  valor: number | null
  /** Texto chico junto a la etiqueta: «32 comandas». */
  detalle?: string
}

export interface BarListProps {
  datos: BarListDatum[]
  formato: (v: number) => string
  /** Cuántas barras se dibujan (las más grandes). Por defecto 7. */
  max?: number
  /**
   * A dónde lleva «y N más». Sin esto, dentro de un `ChartFrame` abre la
   * tabla gemela, que tiene todas las filas.
   */
  enlaceResto?: { texto: string; onClick?: () => void; to?: string }
  /** Resumen para lectores de pantalla; por defecto se arma con el primero. */
  resumen?: string
}

/**
 * Barras horizontales para lo NOMINAL (canal, persona, plato, medio de
 * pago): ordenadas de mayor a menor, las `max` primeras. El resto NO se suma
 * en un «Otros» (sumar plata es del backend): se ofrece «y N más», que lleva
 * a la tabla. Para cifras con signo, `DivergingBars`.
 */
export function BarList({
  datos,
  formato,
  max = 7,
  enlaceResto,
  resumen,
}: BarListProps): React.JSX.Element {
  const marco = useMarco()
  // Ordenar sí se permite; los sin dato van al final, en su orden de llegada.
  const ordenados = datos
    .map((d, i) => ({ d, i }))
    .sort((a, b) => {
      if (a.d.valor === null && b.d.valor === null) return a.i - b.i
      if (a.d.valor === null) return 1
      if (b.d.valor === null) return -1
      return b.d.valor - a.d.valor || a.i - b.i
    })
    .map(({ d }) => d)
  const visibles = ordenados.slice(0, Math.max(0, max))
  const resto = ordenados.length - visibles.length
  const tope = Math.max(0, ...visibles.map((d) => d.valor ?? 0))

  const primero = visibles.find((d) => d.valor !== null)
  const texto =
    resumen ??
    (primero
      ? `Barras de ${datos.length} elementos ordenadas de mayor a menor; primero ${primero.etiqueta} con ${formato(primero.valor!)}${resto ? `; se muestran ${visibles.length}` : ""}. El detalle está en la tabla.`
      : `Barras: ${datos.length} elementos sin dato.`)

  const textoResto = enlaceResto?.texto ?? `y ${resto} más`
  const claseResto =
    "rounded-sm text-xs font-medium text-muted-foreground underline underline-offset-4 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"

  return (
    <div className="min-w-0 space-y-2">
      <ol role="img" aria-label={texto} className="m-0 list-none space-y-2.5 p-0">
        {visibles.map((d) => {
          const valorTxt = d.valor === null ? TEXTO_SIN_DATO : formato(d.valor)
          const pct = d.valor === null || tope <= 0 ? 0 : (Math.max(0, d.valor) / tope) * 100
          return (
            <li
              key={d.key}
              data-barra={d.key}
              className="group min-w-0"
              title={d.detalle ? `${d.etiqueta} · ${valorTxt} · ${d.detalle}` : `${d.etiqueta} · ${valorTxt}`}
            >
              <div className="flex min-w-0 items-baseline justify-between gap-3 text-sm">
                <span className="min-w-0 truncate text-foreground">
                  {d.etiqueta}
                  {d.detalle ? <span className="ml-1.5 text-xs text-muted-foreground">{d.detalle}</span> : null}
                </span>
                <span className={d.valor === null ? "shrink-0 text-muted-foreground italic" : "shrink-0 font-medium"}>
                  {valorTxt}
                </span>
              </div>
              <div className="mt-1 h-2.5 w-full">
                {d.valor === null ? (
                  <div className="sin-dato h-full w-full" data-hueco={d.key} />
                ) : (
                  <div
                    className="h-full rounded-r-[4px] motion-safe:transition-opacity group-hover:opacity-80"
                    style={{
                      width: `${pct}%`,
                      minWidth: d.valor > 0 ? 2 : 0,
                      background: "var(--data-ink)",
                    }}
                  />
                )}
              </div>
            </li>
          )
        })}
      </ol>

      {resto > 0 ? (
        enlaceResto?.to ? (
          <Link to={enlaceResto.to} className={claseResto} onClick={enlaceResto.onClick}>
            {textoResto}
          </Link>
        ) : enlaceResto?.onClick || marco ? (
          <button
            type="button"
            className={claseResto}
            onClick={() => (enlaceResto?.onClick ? enlaceResto.onClick() : marco?.verTabla())}
          >
            {textoResto}
          </button>
        ) : (
          <p className="text-xs text-muted-foreground">{textoResto}</p>
        )
      ) : null}
    </div>
  )
}
