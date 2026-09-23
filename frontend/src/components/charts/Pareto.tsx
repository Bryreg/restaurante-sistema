import { formatPct } from "@/lib/format"

import { Globo, RenglonGlobo } from "./base"
import {
  BARRA_MAX,
  CLASE_LIENZO,
  HALO,
  SEPARACION,
  TEXTO_PX,
  TINTA,
  anchoTexto,
  barraV,
  escalaRedonda,
  lineal,
  useAncho,
  useRecorrido,
} from "./nucleo"

export interface ParetoDatum {
  key: string
  etiqueta: string
  /** La magnitud de la barra (p. ej. |$| de la varianza), del backend. */
  valor: number
  /** Acumulado en puntos básicos hasta este elemento inclusive, del backend. */
  acumulado_bp: number
}

export interface ParetoProps {
  datos: ParetoDatum[]
  formato: (v: number) => string
  alto?: number
  /** Cómo se llama la magnitud de las barras en la leyenda. */
  etiquetaValor?: string
  resumen?: string
}

const MARGEN_SUP = 18
const GUIA_BP = 8000

/**
 * Pareto: barras de mayor a menor y el acumulado como una MARCA (línea gris
 * de 0 a 100 % sobre el mismo alto), no como un segundo eje de otra
 * magnitud: no lleva ticks propios, sólo la guía rotulada del 80 %. El
 * acumulado lo manda el backend; el orden se toma del acumulado (creciente),
 * que es el orden en que el backend lo calculó.
 */
export function Pareto({ datos, formato, alto = 180, etiquetaValor = "Monto", resumen }: ParetoProps): React.JSX.Element {
  const [ref, ancho] = useAncho<HTMLDivElement>()
  const ordenados = datos
    .map((d, i) => ({ d, i }))
    .sort((a, b) => a.d.acumulado_bp - b.d.acumulado_bp || a.i - b.i)
    .map(({ d }) => d)
  const n = ordenados.length
  const { activo, setActivo, onKeyDown, soltar } = useRecorrido(n)

  const escala = escalaRedonda(ordenados.map((d) => d.valor))
  const etiquetasY = escala.ticks.map((t) => formato(t))
  const margenIzq = Math.ceil(Math.max(...etiquetasY.map((t) => anchoTexto(t)))) + 8
  const margenDer = Math.ceil(anchoTexto("80 %")) + 8
  const x0 = margenIzq
  const x1 = ancho - margenDer
  const banda = n ? (x1 - x0) / n : 0
  const w = Math.max(2, Math.min(BARRA_MAX, banda - SEPARACION))
  const xc = (i: number) => x0 + banda * i + banda / 2

  // Etiquetas del eje X: horizontales si entran; si no, inclinadas y cortas.
  const maxEt = Math.max(0, ...ordenados.map((d) => anchoTexto(d.etiqueta)))
  const inclinar = maxEt + 6 > banda
  const LARGO = 14
  const corta = (s: string) => (s.length > LARGO ? `${s.slice(0, LARGO - 1)}…` : s)
  const maxCorta = Math.max(0, ...ordenados.map((d) => anchoTexto(corta(d.etiqueta))))
  const bandaX = inclinar ? Math.ceil(maxCorta * 0.72) + 16 : 22
  const saltoX = inclinar ? Math.max(1, Math.ceil(16 / Math.max(1, banda))) : 1

  const y0 = MARGEN_SUP
  const y1 = MARGEN_SUP + alto
  const y = lineal([escala.min, escala.max], [y1, y0])
  const yAc = lineal([0, 10000], [y1, y0])

  const cruce = ordenados.findIndex((d) => d.acumulado_bp >= GUIA_BP)
  const texto =
    resumen ??
    (n
      ? `Pareto de ${n} elementos; el mayor es ${ordenados[0]!.etiqueta} con ${formato(ordenados[0]!.valor)}${cruce >= 0 ? `; los primeros ${cruce + 1} llegan al ${formatPct(ordenados[cruce]!.acumulado_bp, 0)} del total` : ""}. El detalle está en la tabla.`
      : "Pareto sin elementos.")

  const activoD = activo !== null ? ordenados[activo] : undefined

  return (
    <div className="min-w-0 space-y-2">
      <div
        ref={ref}
        role="img"
        aria-label={texto}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onBlur={soltar}
        onPointerLeave={soltar}
        className={CLASE_LIENZO}
      >
        <svg
          width="100%"
          height={y1 + bandaX}
          viewBox={`0 0 ${ancho} ${y1 + bandaX}`}
          aria-hidden="true"
          className="block overflow-visible"
          onPointerMove={(e) => {
            const r = e.currentTarget.getBoundingClientRect()
            const px = ((e.clientX - r.left) / (r.width || 1)) * ancho
            const i = Math.floor((px - x0) / (banda || 1))
            setActivo(i >= 0 && i < n ? i : null)
          }}
        >
          {escala.ticks.map((t, i) => (
            <g key={t}>
              <line x1={x0} x2={x1} y1={y(t)} y2={y(t)} stroke={t === 0 ? TINTA.base : TINTA.grilla} strokeWidth={1} />
              <text
                x={x0 - 6}
                y={y(t)}
                dy="0.32em"
                textAnchor="end"
                fontSize={TEXTO_PX}
                fill={TINTA.secundario}
                style={{ fontVariantNumeric: "tabular-nums" }}
              >
                {etiquetasY[i]}
              </text>
            </g>
          ))}

          {ordenados.map((d, i) => (
            <path
              key={d.key}
              data-columna={d.key}
              d={barraV(xc(i) - w / 2, w, y(0), y(d.valor))}
              fill="var(--data-ink)"
              stroke={activo === i ? TINTA.texto : "none"}
              strokeWidth={activo === i ? 1 : 0}
            />
          ))}

          <g data-guia80="">
            <line x1={x0} x2={x1} y1={yAc(GUIA_BP)} y2={yAc(GUIA_BP)} stroke="var(--data-muted)" strokeWidth={1} strokeDasharray="4 3" />
            <text x={x1 + 4} y={yAc(GUIA_BP)} dy="0.32em" fontSize={TEXTO_PX} fill={TINTA.secundario} {...HALO}>
              80 %
            </text>
          </g>

          {n ? (
            <g data-acumulado="">
              <polyline
                points={ordenados.map((d, i) => `${xc(i)},${yAc(d.acumulado_bp)}`).join(" ")}
                fill="none"
                stroke={TINTA.secundario}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
              {ordenados.map((d, i) => (
                <circle
                  key={`ac-${d.key}`}
                  cx={xc(i)}
                  cy={yAc(d.acumulado_bp)}
                  r={3}
                  fill={TINTA.secundario}
                  stroke={TINTA.superficie}
                  strokeWidth={1.5}
                />
              ))}
            </g>
          ) : null}

          {ordenados.map((d, i) =>
            i % saltoX !== 0 ? null : inclinar ? (
              <text
                key={`x-${d.key}`}
                transform={`translate(${xc(i)},${y1 + 10}) rotate(-40)`}
                textAnchor="end"
                fontSize={TEXTO_PX}
                fill={TINTA.secundario}
              >
                {corta(d.etiqueta)}
              </text>
            ) : (
              <text key={`x-${d.key}`} x={xc(i)} y={y1 + 15} textAnchor="middle" fontSize={TEXTO_PX} fill={TINTA.secundario}>
                {d.etiqueta}
              </text>
            ),
          )}
        </svg>

        {activoD && activo !== null ? (
          <Globo x={xc(activo)} y={Math.min(y(activoD.valor), yAc(activoD.acumulado_bp))} ancho={ancho}>
            <div className="mb-0.5 text-muted-foreground">{activoD.etiqueta}</div>
            <RenglonGlobo color="var(--data-ink)" valor={formato(activoD.valor)} />
            <RenglonGlobo color={TINTA.secundario} valor={formatPct(activoD.acumulado_bp)} etiqueta="acumulado" />
          </Globo>
        ) : null}
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-hidden="true">
        <li className="flex items-center gap-1.5">
          <span className="inline-block size-2.5 rounded-[2px]" style={{ background: "var(--data-ink)" }} />
          {etiquetaValor}
        </li>
        <li className="flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-3 rounded-full" style={{ background: TINTA.secundario }} />
          Acumulado (0 a 100 %)
        </li>
      </ul>
    </div>
  )
}
