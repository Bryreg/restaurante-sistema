import { useId } from "react"

import { Globo, Rayado, RenglonGlobo } from "./base"
import {
  BARRA_MAX,
  HALO,
  CLASE_LIENZO,
  SEPARACION,
  TEXTO_PX,
  TEXTO_SIN_DATO,
  TINTA,
  anchoTexto,
  barraV,
  escalaRedonda,
  idSeguro,
  lineal,
  useAncho,
  useRecorrido,
} from "./nucleo"

export interface ColumnDatum {
  key: string
  etiqueta: string
  valor: number | null
}

export interface ColumnChartProps {
  datos: ColumnDatum[]
  formato: (v: number) => string
  /** Línea horizontal gris rotulada (p. ej. el promedio que manda el backend). */
  referencia?: { valor: number; etiqueta: string }
  /** Un valor de referencia por columna, alineado por índice con `datos` (p. ej. mismo día de la semana pasada). */
  serieReferencia?: (number | null)[]
  /** Cómo se llama la serie de referencia en la leyenda y el globo. */
  etiquetaSerieReferencia?: string
  /** Cómo se llama la serie principal (sólo aparece si hay `serieReferencia`). */
  etiquetaSerie?: string
  /** `key` de la columna que cuenta la historia: va en tinta llena y las demás se aclaran. */
  resaltar?: string
  /** Alto del área de dibujo en px (sin el eje X). */
  alto?: number
  /** Resumen para lectores de pantalla; por defecto se arma con el máximo. */
  resumen?: string
}

const MARGEN_SUP = 18
const BANDA_X = 22

/**
 * Columnas para lo ORDINAL (horas, días de la semana): eje en 0, ticks
 * redondos, `null` como hueco rayado (nunca una columna de 0).
 */
export function ColumnChart({
  datos,
  formato,
  referencia,
  serieReferencia,
  etiquetaSerieReferencia = "Referencia",
  etiquetaSerie = "Actual",
  resaltar,
  alto = 180,
  resumen,
}: ColumnChartProps): React.JSX.Element {
  const [ref, ancho] = useAncho<HTMLDivElement>()
  const { activo, setActivo, onKeyDown, soltar } = useRecorrido(datos.length)
  const rayado = `rayado-${idSeguro(useId())}`

  const valores: number[] = []
  for (const d of datos) if (d.valor !== null) valores.push(d.valor)
  for (const v of serieReferencia ?? []) if (v !== null) valores.push(v)
  if (referencia) valores.push(referencia.valor)
  const escala = escalaRedonda(valores)

  const etiquetasY = escala.ticks.map((t) => formato(t))
  const margenIzq = Math.ceil(Math.max(...etiquetasY.map((t) => anchoTexto(t)))) + 8
  const x0 = margenIzq
  const x1 = ancho - 4
  const y0 = MARGEN_SUP
  const y1 = MARGEN_SUP + alto
  const y = lineal([escala.min, escala.max], [y1, y0])
  const banda = datos.length ? (x1 - x0) / datos.length : 0
  const w = Math.max(2, Math.min(BARRA_MAX, banda - SEPARACION))
  const xCentro = (i: number) => x0 + banda * i + banda / 2

  // Etiquetas del eje X: una de cada `salto` para que no choquen.
  const anchoEtiqueta = Math.max(0, ...datos.map((d) => anchoTexto(d.etiqueta))) + 6
  const salto = Math.max(1, Math.ceil(anchoEtiqueta / Math.max(1, banda)))

  // Etiqueta directa selectiva: la resaltada o, si no hay, la más alta.
  let rotulado: number | null = null
  if (resaltar) {
    const i = datos.findIndex((d) => d.key === resaltar)
    if (i >= 0 && datos[i]!.valor !== null) rotulado = i
  } else {
    let max = -Infinity
    datos.forEach((d, i) => {
      if (d.valor !== null && d.valor > max) {
        max = d.valor
        rotulado = i
      }
    })
  }

  const conDato = datos.filter((d) => d.valor !== null)
  const texto =
    resumen ??
    (() => {
      if (conDato.length === 0) return `Columnas: ${datos.length} períodos, todos sin dato.`
      const mayor = conDato.reduce((a, b) => ((b.valor ?? 0) > (a.valor ?? 0) ? b : a))
      const huecos = datos.length - conDato.length
      return `Columnas de ${datos.length} períodos; el más alto es ${mayor.etiqueta} con ${formato(mayor.valor!)}${huecos ? `; ${huecos} sin dato` : ""}. El detalle está en la tabla.`
    })()

  const yCero = y(0)
  const activoDatum = activo !== null ? datos[activo] : undefined

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
          height={y1 + BANDA_X}
          viewBox={`0 0 ${ancho} ${y1 + BANDA_X}`}
          aria-hidden="true"
          className="block overflow-visible"
          onPointerMove={(e) => {
            const r = e.currentTarget.getBoundingClientRect()
            const px = ((e.clientX - r.left) / (r.width || 1)) * ancho
            const i = Math.floor((px - x0) / (banda || 1))
            setActivo(i >= 0 && i < datos.length ? i : null)
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

          {datos.map((d, i) => {
            const x = xCentro(i) - w / 2
            const apagado = resaltar !== undefined && d.key !== resaltar
            if (d.valor === null) {
              return (
                <rect
                  key={d.key}
                  data-hueco={d.key}
                  x={x}
                  y={y0}
                  width={w}
                  height={y1 - y0}
                  rx={2}
                  fill={`url(#${rayado})`}
                />
              )
            }
            return (
              <path
                key={d.key}
                data-columna={d.key}
                d={barraV(x, w, yCero, y(d.valor))}
                fill="var(--data-ink)"
                fillOpacity={apagado ? 0.4 : 1}
                stroke={activo === i ? TINTA.texto : "none"}
                strokeWidth={activo === i ? 1 : 0}
              />
            )
          })}

          {serieReferencia?.map((v, i) =>
            v === null || i >= datos.length ? null : (
              <line
                key={`ref-${i}`}
                data-referencia-serie=""
                x1={xCentro(i) - w / 2 - 2}
                x2={xCentro(i) + w / 2 + 2}
                y1={y(v)}
                y2={y(v)}
                stroke="var(--data-muted)"
                strokeWidth={2}
                strokeLinecap="round"
              />
            ),
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

          {rotulado !== null && datos[rotulado]?.valor != null ? (
            <text
              x={Math.min(x1, Math.max(x0, xCentro(rotulado)))}
              y={Math.min(y(datos[rotulado]!.valor!), yCero) - 5}
              textAnchor={xCentro(rotulado) > x1 - 30 ? "end" : xCentro(rotulado) < x0 + 30 ? "start" : "middle"}
              fontSize={TEXTO_PX}
              fontWeight={600}
              fill={TINTA.texto}
              {...HALO}
            >
              {formato(datos[rotulado]!.valor!)}
            </text>
          ) : null}

          {datos.map((d, i) =>
            i % salto === 0 ? (
              <text
                key={`x-${d.key}`}
                x={xCentro(i)}
                y={y1 + 15}
                textAnchor="middle"
                fontSize={TEXTO_PX}
                fill={TINTA.secundario}
              >
                {d.etiqueta}
              </text>
            ) : null,
          )}
        </svg>

        {activoDatum && activo !== null ? (
          <Globo x={xCentro(activo)} y={activoDatum.valor !== null ? Math.min(y(activoDatum.valor), yCero) : (y0 + y1) / 2} ancho={ancho}>
            <div className="mb-0.5 text-muted-foreground">{activoDatum.etiqueta}</div>
            <RenglonGlobo
              color="var(--data-ink)"
              valor={activoDatum.valor === null ? TEXTO_SIN_DATO : formato(activoDatum.valor)}
              etiqueta={serieReferencia ? etiquetaSerie : undefined}
            />
            {serieReferencia ? (
              <RenglonGlobo
                color="var(--data-muted)"
                valor={serieReferencia[activo] == null ? TEXTO_SIN_DATO : formato(serieReferencia[activo]!)}
                etiqueta={etiquetaSerieReferencia}
              />
            ) : null}
          </Globo>
        ) : null}
      </div>

      {serieReferencia ? (
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-hidden="true">
          <li className="flex items-center gap-1.5">
            <span className="inline-block size-2.5 rounded-[2px]" style={{ background: "var(--data-ink)" }} />
            {etiquetaSerie}
          </li>
          <li className="flex items-center gap-1.5">
            <span className="inline-block h-0.5 w-3 rounded-full" style={{ background: "var(--data-muted)" }} />
            {etiquetaSerieReferencia}
          </li>
        </ul>
      ) : null}
    </div>
  )
}
