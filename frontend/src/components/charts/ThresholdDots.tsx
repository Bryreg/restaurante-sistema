import { useId } from "react"

import { Globo, Rayado, RenglonGlobo } from "./base"
import {
  CLASE_LIENZO,
  HALO,
  TEXTO_PX,
  TEXTO_SIN_DATO,
  TINTA,
  anchoTexto,
  escalaRedonda,
  idSeguro,
  lineal,
  useAncho,
  useRecorrido,
} from "./nucleo"

export interface ThresholdPunto {
  key: string
  etiqueta: string
  valor: number | null
}

export interface ThresholdDotsProps {
  puntos: ThresholdPunto[]
  /** La regla (p. ej. `red_threshold_bp`): por encima, el punto va en rojo con ▲. */
  umbral: { valor: number; etiqueta: string }
  formato: (v: number) => string
  alto?: number
  /** Anclar el eje en 0 (por defecto sí). */
  desdeCero?: boolean
  resumen?: string
}

const MARGEN_SUP = 20
const BANDA_X = 22

/**
 * Puntos en el tiempo contra una regla de umbral (salud sostenida por
 * ventana). Por debajo: círculo en tinta de datos. Por encima: triángulo ▲
 * en rojo de faltante, así la forma también lo dice. `null` es un hueco
 * rayado, nunca un punto en 0.
 */
export function ThresholdDots({
  puntos,
  umbral,
  formato,
  alto = 140,
  desdeCero = true,
  resumen,
}: ThresholdDotsProps): React.JSX.Element {
  const [ref, ancho] = useAncho<HTMLDivElement>()
  const { activo, setActivo, onKeyDown, soltar } = useRecorrido(puntos.length)
  const rayado = `rayado-${idSeguro(useId())}`

  const valores = puntos.flatMap((p) => (p.valor === null ? [] : [p.valor]))
  const escala = escalaRedonda([...valores, umbral.valor], { incluirCero: desdeCero })
  const etY = escala.ticks.map((t) => formato(t))
  const margenIzq = Math.ceil(Math.max(...etY.map((t) => anchoTexto(t)))) + 8
  const x0 = margenIzq
  const x1 = ancho - 10
  const y0 = MARGEN_SUP
  const y1 = MARGEN_SUP + alto
  const n = puntos.length
  const banda = n ? (x1 - x0) / n : 0
  const x = (i: number) => x0 + banda * i + banda / 2
  const y = lineal([escala.min, escala.max], [y1, y0])
  const uy = y(umbral.valor)

  const anchoEt = Math.max(0, ...puntos.map((p) => anchoTexto(p.etiqueta))) + 8
  const salto = Math.max(1, Math.ceil(anchoEt / Math.max(1, banda)))

  const sobre = (v: number) => v > umbral.valor
  const ultimo = (() => {
    for (let i = n - 1; i >= 0; i--) if (puntos[i]!.valor !== null) return i
    return -1
  })()
  const cuantosSobre = valores.filter(sobre).length
  const texto =
    resumen ??
    `${n} puntos contra el umbral ${umbral.etiqueta} (${formato(umbral.valor)}): ${cuantosSobre} por encima${
      valores.length < n ? `, ${n - valores.length} sin dato` : ""
    }. El detalle está en la tabla.`

  const activoP = activo !== null ? puntos[activo] : undefined

  return (
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
        height={y1 + BANDA_X}
        viewBox={`0 0 ${ancho} ${y1 + BANDA_X}`}
        aria-hidden="true"
        className="block overflow-visible"
        onPointerMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          const px = ((e.clientX - r.left) / (r.width || 1)) * ancho
          const i = Math.floor((px - x0) / (banda || 1))
          setActivo(i >= 0 && i < n ? i : null)
        }}
      >
        <defs>
          <Rayado id={rayado} />
        </defs>
        {escala.ticks.map((t, i) => (
          <g key={t}>
            <line x1={x0} x2={x1} y1={y(t)} y2={y(t)} stroke={t === 0 ? TINTA.base : TINTA.grilla} strokeWidth={1} />
            <text x={x0 - 6} y={y(t)} dy="0.32em" textAnchor="end" fontSize={TEXTO_PX} fill={TINTA.secundario}>
              {etY[i]}
            </text>
          </g>
        ))}

        <g data-umbral="">
          <line x1={x0} x2={x1} y1={uy} y2={uy} stroke="var(--diverge-falta)" strokeOpacity={0.7} strokeWidth={1} strokeDasharray="4 3" />
          <text x={x0 + 4} y={uy - 5} fontSize={TEXTO_PX} fill={TINTA.secundario} {...HALO}>
            {umbral.etiqueta}: {formato(umbral.valor)}
          </text>
        </g>

        {puntos.map((p, i) => {
          const cx = x(i)
          if (p.valor === null) {
            const w = Math.max(6, Math.min(16, banda - 2))
            return <rect key={p.key} data-hueco={p.key} x={cx - w / 2} y={y0} width={w} height={y1 - y0} rx={2} fill={`url(#${rayado})`} />
          }
          const cy = y(p.valor)
          const realce = activo === i
          if (sobre(p.valor)) {
            const s = 6
            return (
              <path
                key={p.key}
                data-punto={p.key}
                data-sobre=""
                d={`M${cx},${cy - s}L${cx + s},${cy + s * 0.75}L${cx - s},${cy + s * 0.75}Z`}
                fill="var(--diverge-falta)"
                stroke={realce ? TINTA.texto : TINTA.superficie}
                strokeWidth={2}
                strokeLinejoin="round"
              />
            )
          }
          return (
            <circle
              key={p.key}
              data-punto={p.key}
              cx={cx}
              cy={cy}
              r={4.5}
              fill="var(--data-ink)"
              stroke={realce ? TINTA.texto : TINTA.superficie}
              strokeWidth={2}
            />
          )
        })}

        {ultimo >= 0 ? (
          <text
            x={x(ultimo)}
            y={y(puntos[ultimo]!.valor!) - 11}
            textAnchor={x(ultimo) + anchoTexto(formato(puntos[ultimo]!.valor!)) / 2 > ancho - 2 ? "end" : "middle"}
            fontSize={TEXTO_PX}
            fontWeight={600}
            fill={TINTA.texto}
            {...HALO}
          >
            {sobre(puntos[ultimo]!.valor!) ? "▲ " : ""}
            {formato(puntos[ultimo]!.valor!)}
          </text>
        ) : null}

        {puntos.map((p, i) =>
          i % salto === 0 ? (
            <text key={`x-${p.key}`} x={x(i)} y={y1 + 15} textAnchor="middle" fontSize={TEXTO_PX} fill={TINTA.secundario}>
              {p.etiqueta}
            </text>
          ) : null,
        )}
      </svg>

      {activoP && activo !== null ? (
        <Globo x={x(activo)} y={activoP.valor !== null ? y(activoP.valor) - 6 : (y0 + y1) / 2} ancho={ancho}>
          <div className="mb-0.5 text-muted-foreground">{activoP.etiqueta}</div>
          <RenglonGlobo
            color={activoP.valor !== null && sobre(activoP.valor) ? "var(--diverge-falta)" : "var(--data-ink)"}
            valor={
              activoP.valor === null
                ? TEXTO_SIN_DATO
                : `${sobre(activoP.valor) ? "▲ " : ""}${formato(activoP.valor)}`
            }
            etiqueta={activoP.valor !== null && sobre(activoP.valor) ? "sobre el umbral" : undefined}
          />
        </Globo>
      ) : null}
    </div>
  )
}
