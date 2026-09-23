import { useState } from "react"

import { formatPct } from "@/lib/format"

import { TINTA } from "./nucleo"

export interface Parte {
  key: string
  etiqueta: string
  /** Participación en puntos básicos (10.000 = 100 %), calculada por el backend. */
  share_bp: number
  /** La cifra ya formateada que acompaña al % en la leyenda («$ 1.234.000»). */
  valor?: string
}

export interface Stacked100Props {
  partes: Parte[]
  resumen?: string
}

/** Cuántas partes llevan color propio; de ahí en más, gris «otros». */
const CON_COLOR = 5

function colorDe(i: number): string {
  return i < CON_COLOR ? `var(--data-${i + 1})` : "var(--data-muted)"
}

/**
 * Una barra 100 % para la COMPOSICIÓN (medio de pago, canal). Nunca torta.
 * El color sigue al orden recibido (el backend lo fija), no al tamaño. Más
 * de cinco partes: las siguientes van en gris, cada una su segmento (no se
 * suman en un «otros»). La leyenda con el % está siempre a la vista.
 */
export function Stacked100({ partes, resumen }: Stacked100Props): React.JSX.Element {
  const [activo, setActivo] = useState<string | null>(null)
  const texto =
    resumen ??
    `Composición en ${partes.length} partes: ${partes.map((p) => `${p.etiqueta} ${formatPct(p.share_bp)}`).join(", ")}.`

  const visibles = partes.map((p, i) => ({ p, i })).filter(({ p }) => p.share_bp > 0)

  return (
    <div className="min-w-0 space-y-3">
      <div role="img" aria-label={texto} className="flex h-5 w-full min-w-0 gap-[2px] overflow-hidden rounded-[4px]">
        {visibles.map(({ p, i }) => (
          <div
            key={p.key}
            data-segmento={p.key}
            title={`${p.etiqueta} · ${formatPct(p.share_bp)}${p.valor ? ` · ${p.valor}` : ""}`}
            onPointerEnter={() => setActivo(p.key)}
            onPointerLeave={() => setActivo(null)}
            className="h-full min-w-[2px] motion-safe:transition-opacity"
            style={{
              flexGrow: p.share_bp,
              flexShrink: 1,
              flexBasis: 0,
              background: colorDe(i),
              opacity: activo !== null && activo !== p.key ? 0.55 : 1,
            }}
          />
        ))}
      </div>

      <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))] gap-x-4 gap-y-1.5 p-0 text-sm" aria-hidden="true">
        {partes.map((p, i) => (
          <li
            key={p.key}
            data-leyenda={p.key}
            className="min-w-0"
            onPointerEnter={() => setActivo(p.key)}
            onPointerLeave={() => setActivo(null)}
          >
            <div className="flex min-w-0 items-baseline gap-1.5">
              <span
                className="inline-block size-2.5 shrink-0 translate-y-[1px] rounded-[2px]"
                style={{ background: colorDe(i) }}
              />
              <span className="min-w-0 truncate" style={{ color: TINTA.texto }} title={p.etiqueta}>
                {p.etiqueta}
              </span>
              <span className="ml-auto shrink-0 font-medium">{formatPct(p.share_bp)}</span>
            </div>
            {p.valor ? <div className="pl-4 text-xs text-muted-foreground">{p.valor}</div> : null}
          </li>
        ))}
      </ul>
    </div>
  )
}
