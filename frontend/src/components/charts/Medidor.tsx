import type { ReactNode } from "react"

export interface MedidorProps {
  valor: number
  meta: number
  formato: (v: number) => string
  /** «Vendido en el mes». */
  etiquetaValor: string
  /** «Punto de equilibrio». */
  etiquetaMeta: string
  /** El avance ya calculado por el backend («62,5 %»), si se quiere mostrar. */
  avance?: ReactNode
  resumen?: string
}

/**
 * Avance hacia una meta (punto de equilibrio). Sólo escala el ancho: el %
 * de avance, si se muestra, lo manda el backend. La pista es un paso claro
 * de la misma tinta; pasada la meta, la barra llena todo y la meta queda
 * marcada donde cae.
 */
export function Medidor({
  valor,
  meta,
  formato,
  etiquetaValor,
  etiquetaMeta,
  avance,
  resumen,
}: MedidorProps): React.JSX.Element {
  const tope = Math.max(valor, meta, 0)
  const relleno = tope > 0 ? (Math.max(0, valor) / tope) * 100 : 0
  const marcaMeta = tope > 0 ? (Math.max(0, meta) / tope) * 100 : 100
  const texto =
    resumen ?? `${etiquetaValor}: ${formato(valor)} de ${etiquetaMeta.toLowerCase()} ${formato(meta)}.`

  return (
    <div className="min-w-0 space-y-1.5">
      <div role="img" aria-label={texto} className="relative h-3 w-full">
        <div className="absolute inset-0 rounded-[4px]" style={{ background: "color-mix(in oklab, var(--data-ink) 18%, transparent)" }} />
        <div
          data-relleno=""
          className="absolute inset-y-0 left-0 rounded-r-[4px]"
          style={{ width: `${relleno}%`, minWidth: valor > 0 ? 2 : 0, background: "var(--data-ink)" }}
        />
        <div
          data-meta=""
          className="absolute -inset-y-1 w-[2px] -translate-x-1/2 rounded-full"
          style={{ left: `${marcaMeta}%`, background: "var(--foreground)" }}
        />
      </div>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-sm">
        <span className="min-w-0">
          <span className="text-muted-foreground">{etiquetaValor}: </span>
          <span className="font-medium">{formato(valor)}</span>
          {avance ? <span className="ml-1.5 text-xs text-muted-foreground">({avance})</span> : null}
        </span>
        <span className="min-w-0">
          <span className="text-muted-foreground">{etiquetaMeta}: </span>
          <span className="font-medium">{formato(meta)}</span>
        </span>
      </div>
    </div>
  )
}
