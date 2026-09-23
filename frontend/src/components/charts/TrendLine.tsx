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

export interface TrendPunto {
  key: string
  /** Lo que va en el eje X, ya corto: `formatFechaCorta(iso)` o «Turno 12». */
  etiqueta: string
  valor: number | null
}

export interface TrendLineProps {
  puntos: TrendPunto[]
  formato: (v: number) => string
  /** Línea gris rotulada (p. ej. el promedio del período que manda el backend). */
  referencia?: { valor: number; etiqueta: string }
  /** Alto del área de dibujo en px (sin el eje X). */
  alto?: number
  /** Anclar el eje Y en 0 (por defecto sí: plata y conteos). */
  desdeCero?: boolean
  resumen?: string
}

const MARGEN_SUP = 20
const BANDA_X = 22

/**
 * Línea para la tendencia en el tiempo (días, turnos). Los puntos llegan en
 * orden y a paso parejo (el backend rellena los días vacíos); un `null` corta
 * la línea y deja el hueco rayado. Marcador y etiqueta directa en el último
 * punto con dato; cruz vertical y globo al pasar.
 */
export function TrendLine({
  puntos,
  formato,
  referencia,
  alto = 160,
  desdeCero = true,
  resumen,
}: TrendLineProps): React.JSX.Element {
  const [ref, ancho] = useAncho<HTMLDivElement>()
  const { activo, setActivo, onKeyDown, soltar } = useRecorrido(puntos.length)
  const rayado = `rayado-${idSeguro(useId())}`

  const valores = puntos.flatMap((p) => (p.valor === null ? [] : [p.valor]))
  if (referencia) valores.push(referencia.valor)
  const escala = escalaRedonda(valores, { incluirCero: desdeCero })
  const etiquetasY = escala.ticks.map((t) => formato(t))
  const margenIzq = Math.ceil(Math.max(...etiquetasY.map((t) => anchoTexto(t)))) + 8

  const ultimo = (() => {
    for (let i = puntos.length - 1; i >= 0; i--) if (puntos[i]!.valor !== null) return i
    return -1
  })()
  const textoUltimo = ultimo >= 0 ? formato(puntos[ultimo]!.valor!) : ""
  // Lugar a la derecha para que la etiqueta del último punto no se corte.
  const margenDer = Math.max(8, Math.min(anchoTexto(textoUltimo) / 2 + 4, 40))

  const x0 = margenIzq
  const x1 = ancho - margenDer
  const y0 = MARGEN_SUP
  const y1 = MARGEN_SUP + alto
  const n = puntos.length
  const x = (i: number) => (n <= 1 ? (x0 + x1) / 2 : x0 + ((x1 - x0) * i) / (n - 1))
  const y = lineal([escala.min, escala.max], [y1, y0])

  // Tramos continuos (un null corta la línea).
  const tramos: number[][] = []
  let actual: number[] = []
  puntos.forEach((p, i) => {
    if (p.valor === null) {
      if (actual.length) tramos.push(actual)
      actual = []
    } else actual.push(i)
  })
  if (actual.length) tramos.push(actual)

  // Ticks del eje X: primero, último y los del medio que entren sin chocar.
  const anchoEt = Math.max(0, ...puntos.map((p) => anchoTexto(p.etiqueta))) + 10
  const cabenX = Math.max(2, Math.floor((x1 - x0) / (anchoEt * 1.25)) + 1)
  const pasoX = n <= cabenX ? 1 : Math.ceil((n - 1) / (cabenX - 1))
  const ticksX: number[] = []
  for (let i = 0; i < n; i += pasoX) ticksX.push(i)
  if (n > 1 && ticksX[ticksX.length - 1] !== n - 1) {
    // El último siempre; si choca con el anterior, se va el anterior.
    if (ticksX.length > 1 && x(n - 1) - x(ticksX[ticksX.length - 1]!) < anchoEt * 1.5) ticksX.pop()
    ticksX.push(n - 1)
  }

  const huecos = puntos.filter((p) => p.valor === null).length
  const texto =
    resumen ??
    (ultimo >= 0
      ? `Línea de ${n} puntos, de ${puntos[0]!.etiqueta} a ${puntos[n - 1]!.etiqueta}; el último con dato, ${puntos[ultimo]!.etiqueta}, es ${textoUltimo}${huecos ? `; ${huecos} sin dato` : ""}. El detalle está en la tabla.`
      : `Línea de ${n} puntos, todos sin dato.`)

  const activoP = activo !== null ? puntos[activo] : undefined
  const ultimoX = ultimo >= 0 ? x(ultimo) : 0
  const anclaUltimo = ultimoX + anchoTexto(textoUltimo) / 2 > ancho - 2 ? "end" : "middle"

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
          if (n === 0) return
          const r = e.currentTarget.getBoundingClientRect()
          const px = ((e.clientX - r.left) / (r.width || 1)) * ancho
          const i = n <= 1 ? 0 : Math.round(((px - x0) / (x1 - x0 || 1)) * (n - 1))
          setActivo(Math.max(0, Math.min(n - 1, i)))
        }}
      >
        <defs>
          <Rayado id={rayado} />
        </defs>
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

        {puntos.map((p, i) =>
          p.valor === null ? (
            <rect
              key={`h-${p.key}`}
              data-hueco={p.key}
              x={x(i) - Math.max(3, n > 1 ? (x1 - x0) / (n - 1) / 2 : 6)}
              width={Math.max(6, n > 1 ? (x1 - x0) / (n - 1) : 12)}
              y={y0}
              height={y1 - y0}
              fill={`url(#${rayado})`}
            />
          ) : null,
        )}

        {referencia ? (
          <g data-referencia="">
            <line
              x1={x0}
              x2={x1}
              y1={y(referencia.valor)}
              y2={y(referencia.valor)}
              stroke="var(--data-muted)"
              strokeWidth={1}
              strokeDasharray="4 3"
            />
            <text x={x0 + 2} y={y(referencia.valor) - 4} fontSize={TEXTO_PX} fill={TINTA.secundario} {...HALO}>
              {referencia.etiqueta}: {formato(referencia.valor)}
            </text>
          </g>
        ) : null}

        {tramos.map((t) =>
          t.length === 1 ? (
            <circle key={`t-${t[0]}`} data-tramo="" cx={x(t[0]!)} cy={y(puntos[t[0]!]!.valor!)} r={3} fill="var(--data-ink)" />
          ) : (
            <polyline
              key={`t-${t[0]}`}
              data-tramo=""
              points={t.map((i) => `${x(i)},${y(puntos[i]!.valor!)}`).join(" ")}
              fill="none"
              stroke="var(--data-ink)"
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          ),
        )}

        {activo !== null ? (
          <line x1={x(activo)} x2={x(activo)} y1={y0} y2={y1} stroke={TINTA.secundario} strokeWidth={1} data-cruz="" />
        ) : null}
        {activoP && activoP.valor !== null && activo !== ultimo ? (
          <circle cx={x(activo!)} cy={y(activoP.valor)} r={4} fill="var(--data-ink)" stroke={TINTA.superficie} strokeWidth={2} />
        ) : null}

        {ultimo >= 0 ? (
          <g data-ultimo="">
            <circle cx={ultimoX} cy={y(puntos[ultimo]!.valor!)} r={4.5} fill="var(--data-ink)" stroke={TINTA.superficie} strokeWidth={2} />
            <text
              x={anclaUltimo === "end" ? ancho - 2 : ultimoX}
              y={y(puntos[ultimo]!.valor!) - 10}
              textAnchor={anclaUltimo}
              fontSize={TEXTO_PX}
              fontWeight={600}
              fill={TINTA.texto}
              {...HALO}
            >
              {textoUltimo}
            </text>
          </g>
        ) : null}

        {ticksX.map((i) => (
          <text
            key={`x-${puntos[i]!.key}`}
            x={x(i)}
            y={y1 + 15}
            textAnchor={n > 1 && i === 0 ? "start" : n > 1 && i === n - 1 ? "end" : "middle"}
            fontSize={TEXTO_PX}
            fill={TINTA.secundario}
          >
            {puntos[i]!.etiqueta}
          </text>
        ))}
      </svg>

      {activoP && activo !== null ? (
        <Globo x={x(activo)} y={activoP.valor !== null ? y(activoP.valor) : (y0 + y1) / 2} ancho={ancho}>
          <div className="mb-0.5 text-muted-foreground">{activoP.etiqueta}</div>
          <RenglonGlobo
            color="var(--data-ink)"
            valor={activoP.valor === null ? TEXTO_SIN_DATO : formato(activoP.valor)}
          />
          {referencia ? (
            <RenglonGlobo color="var(--data-muted)" valor={formato(referencia.valor)} etiqueta={referencia.etiqueta} />
          ) : null}
        </Globo>
      ) : null}
    </div>
  )
}
