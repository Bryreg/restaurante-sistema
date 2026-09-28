import { Globo, RenglonGlobo } from "./base"
import { ResumenLateral, type RenglonResumen } from "./BarrasConReferencia"
import {
  CLASE_LIENZO,
  HALO,
  TEXTO_PX,
  TINTA,
  anchoTexto,
  escalaRedonda,
  lineal,
  useAncho,
  useRecorrido,
} from "./nucleo"

export interface ScatterPunto {
  key: string
  etiqueta: string
  x: number
  y: number
  /** Lleva etiqueta directa y marca más grande. */
  resaltar?: boolean
  /** Texto chico al lado del nombre (variante `mix`): el margen ya formateado. */
  detalle?: string
  /** El punto está en el grupo que hay que revisar (lo decide el backend): va en ámbar. */
  alerta?: boolean
}

export interface Eje {
  titulo: string
  formato: (v: number) => string
}

export interface QuadrantScatterProps {
  puntos: ScatterPunto[]
  umbralX: { valor: number; etiqueta: string }
  umbralY: { valor: number; etiqueta: string }
  ejeX: Eje
  ejeY: Eje
  /** Nombres de los cuadrantes: arriba-der, arriba-izq, abajo-izq, abajo-der. */
  cuadrantes: [string, string, string, string]
  alto?: number
  resumen?: string
  /**
   * `mix` («Mix de platos» del rediseño): promedios punteados, puntos de
   * 14 px con borde del color de la tarjeta, nombre y detalle al lado de
   * cada punto, y el cuadrante de `cuadranteAlerta` rotulado en ámbar con ▲.
   */
  variante?: "clasico" | "mix"
  /** Índice (en el orden de `cuadrantes`) del cuadrante «▲ Revisar». */
  cuadranteAlerta?: 0 | 1 | 2 | 3
  /** Resumen lateral de 280 px: qué hacer con cada grupo. */
  resumenLateral?: RenglonResumen[]
  rotuloResumen?: string
}

const MARGEN_SUP = 34
const BANDA_X = 40
const HIT = 12 // radio del blanco: 24 px de diámetro

interface Caja {
  x: number
  y: number
  w: number
  h: number
}
const choca = (a: Caja, b: Caja) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

/**
 * Dispersión con cuadrantes (ingeniería de menú): una sola tinta, las dos
 * líneas de umbral rotuladas, nombre de cada cuadrante en su esquina, y
 * etiqueta directa sólo en los resaltados y los extremos (las que no entran
 * sin chocar quedan para el globo y la tabla).
 */
export function QuadrantScatter({
  puntos,
  umbralX,
  umbralY,
  ejeX,
  ejeY,
  cuadrantes,
  alto = 260,
  resumen,
  variante = "clasico",
  cuadranteAlerta,
  resumenLateral,
  rotuloResumen,
}: QuadrantScatterProps): React.JSX.Element {
  const mix = variante === "mix"
  const nombreCuadrante = (i: number) =>
    i === cuadranteAlerta && !cuadrantes[i]!.startsWith("▲") ? `▲ ${cuadrantes[i]}` : cuadrantes[i]!
  const rotuloDe = (p: ScatterPunto) => (mix && p.detalle ? `${p.etiqueta} ${p.detalle}` : p.etiqueta)
  const [ref, ancho] = useAncho<HTMLDivElement>()
  const { activo, setActivo, onKeyDown, soltar } = useRecorrido(puntos.length)

  const ex = escalaRedonda([...puntos.map((p) => p.x), umbralX.valor])
  const ey = escalaRedonda([...puntos.map((p) => p.y), umbralY.valor])
  const etY = ey.ticks.map((t) => ejeY.formato(t))
  const margenIzq = Math.ceil(Math.max(...etY.map((t) => anchoTexto(t)))) + 8
  const etX = ex.ticks.map((t) => ejeX.formato(t))
  const margenDer = Math.max(10, Math.ceil(anchoTexto(etX[etX.length - 1] ?? "") / 2))

  const x0 = margenIzq
  const x1 = ancho - margenDer
  const y0 = MARGEN_SUP
  const y1 = MARGEN_SUP + alto
  const sx = lineal([ex.min, ex.max], [x0, x1])
  const sy = lineal([ey.min, ey.max], [y1, y0])
  const ux = sx(umbralX.valor)
  const uy = sy(umbralY.valor)

  // Ticks X que entren sin chocar.
  const anchoTickX = Math.max(...etX.map((t) => anchoTexto(t))) + 10
  const saltoX = Math.max(1, Math.ceil(anchoTickX / ((x1 - x0) / Math.max(1, ex.ticks.length - 1))))

  // Etiquetas directas: resaltados primero, después extremos (máx./mín. de cada eje).
  const candidatos: number[] = []
  // En `mix` todo punto lleva su nombre al lado (el orden sigue siendo la
  // prioridad cuando dos chocan).
  puntos.forEach((p, i) => (p.resaltar || mix) && candidatos.push(i))
  if (puntos.length) {
    const idx = (f: (a: ScatterPunto, b: ScatterPunto) => boolean) =>
      puntos.reduce((m, p, i) => (f(p, puntos[m]!) ? i : m), 0)
    for (const i of [idx((a, b) => a.y > b.y), idx((a, b) => a.x > b.x), idx((a, b) => a.y < b.y)])
      if (!candidatos.includes(i)) candidatos.push(i)
  }
  const ocupadas: Caja[] = [
    // Los nombres de cuadrante en las esquinas.
    { x: x0, y: y0, w: anchoTexto(nombreCuadrante(1)), h: 16 },
    { x: x1 - anchoTexto(nombreCuadrante(0)), y: y0, w: anchoTexto(nombreCuadrante(0)), h: 16 },
    { x: x0, y: y1 - 16, w: anchoTexto(nombreCuadrante(2)), h: 16 },
    { x: x1 - anchoTexto(nombreCuadrante(3)), y: y1 - 16, w: anchoTexto(nombreCuadrante(3)), h: 16 },
  ]
  const rotulos: { i: number; x: number; y: number; ancla: "start" | "end" }[] = []
  for (const i of candidatos) {
    const p = puntos[i]!
    const px = sx(p.x)
    const py = sy(p.y)
    const w = anchoTexto(rotuloDe(p))
    const derecha = px + 8 + w <= ancho - 2
    const caja: Caja = derecha ? { x: px + 8, y: py - 8, w, h: 16 } : { x: px - 8 - w, y: py - 8, w, h: 16 }
    if (caja.x < 0) continue
    if (ocupadas.some((c) => choca(c, caja))) continue
    ocupadas.push(caja)
    rotulos.push({ i, x: derecha ? px + 8 : px - 8, y: py, ancla: derecha ? "start" : "end" })
  }

  const cuenta = [0, 0, 0, 0]
  for (const p of puntos) {
    const arriba = p.y >= umbralY.valor
    const der = p.x >= umbralX.valor
    cuenta[arriba ? (der ? 0 : 1) : der ? 3 : 2]!++
  }
  const texto =
    resumen ??
    `Dispersión de ${puntos.length} elementos: ${ejeX.titulo} contra ${ejeY.titulo}. ${cuadrantes
      .map((c, i) => `${c}: ${cuenta[i]}`)
      .join("; ")}.${
      mix && puntos.some((p) => p.alerta)
        ? ` A revisar: ${puntos
            .filter((p) => p.alerta)
            .map((p) => rotuloDe(p))
            .join(", ")}.`
        : ""
    } El detalle está en la tabla.`
  // Promedios punteados en `mix`; guiones en la forma clásica.
  const trazoUmbral = mix ? "1 3" : "4 3"
  const colorPunto = (p: ScatterPunto) => (mix ? (p.alerta ? "var(--warning)" : "var(--data-1)") : "var(--data-ink)")

  const activoP = activo !== null ? puntos[activo] : undefined
  const alto1 = y1 + BANDA_X

  // Rótulo del umbral X arriba de su línea, sin salirse por los costados.
  const wUx = anchoTexto(umbralX.etiqueta)
  const anclaUx = ux + wUx / 2 > ancho - 2 ? "end" : ux - wUx / 2 < 2 ? "start" : "middle"

  const lienzo = (
    <div
      ref={ref}
      role="img"
      aria-label={texto}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onBlur={soltar}
      className={CLASE_LIENZO}
      data-variante={variante}
    >
      <svg width="100%" height={alto1} viewBox={`0 0 ${ancho} ${alto1}`} aria-hidden="true" className="block overflow-visible">
        <text x={x0 - margenIzq} y={12} fontSize={TEXTO_PX} fontWeight={500} fill={TINTA.secundario}>
          {ejeY.titulo}
        </text>

        {ey.ticks.map((t, i) => (
          <g key={`y-${t}`}>
            <line x1={x0} x2={x1} y1={sy(t)} y2={sy(t)} stroke={TINTA.grilla} strokeWidth={1} />
            <text x={x0 - 6} y={sy(t)} dy={i === 0 ? "-0.1em" : "0.32em"} textAnchor="end" fontSize={TEXTO_PX} fill={TINTA.secundario}>
              {etY[i]}
            </text>
          </g>
        ))}
        {ex.ticks.map((t, i) => (
          <g key={`x-${t}`}>
            <line x1={sx(t)} x2={sx(t)} y1={y0} y2={y1} stroke={TINTA.grilla} strokeWidth={1} />
            {i % saltoX === 0 ? (
              <text x={sx(t)} y={y1 + 15} textAnchor="middle" fontSize={TEXTO_PX} fill={TINTA.secundario}>
                {etX[i]}
              </text>
            ) : null}
          </g>
        ))}
        <line x1={x0} x2={x1} y1={y1} y2={y1} stroke={TINTA.base} strokeWidth={1} />
        <line x1={x0} x2={x0} y1={y0} y2={y1} stroke={TINTA.base} strokeWidth={1} />
        <text x={(x0 + x1) / 2} y={y1 + 33} textAnchor="middle" fontSize={TEXTO_PX} fontWeight={500} fill={TINTA.secundario}>
          {ejeX.titulo}
        </text>

        {/* Umbrales rotulados. */}
        <g data-umbral="x">
          <line x1={ux} x2={ux} y1={y0 - 4} y2={y1} stroke="var(--data-muted)" strokeWidth={mix ? 1.5 : 1} strokeDasharray={trazoUmbral} strokeLinecap="round" />
          <text x={ux} y={y0 - 8} textAnchor={anclaUx} fontSize={TEXTO_PX} fill={TINTA.secundario} {...HALO}>
            {umbralX.etiqueta}
          </text>
        </g>
        <g data-umbral="y">
          <line x1={x0} x2={x1} y1={uy} y2={uy} stroke="var(--data-muted)" strokeWidth={mix ? 1.5 : 1} strokeDasharray={trazoUmbral} strokeLinecap="round" />
          <text x={x1} y={uy - 4} textAnchor="end" fontSize={TEXTO_PX} fill={TINTA.secundario} {...HALO}>
            {umbralY.etiqueta}
          </text>
        </g>

        {/* Nombres de los cuadrantes, en sus esquinas. */}
        <g fontSize={TEXTO_PX} fontWeight={600} fill={TINTA.secundario} {...HALO} data-cuadrantes="">
          {[
            { x: x1 - 2, y: y0 + 12, ancla: "end" as const },
            { x: x0 + 4, y: y0 + 12, ancla: "start" as const },
            { x: x0 + 4, y: y1 - 5, ancla: "start" as const },
            { x: x1 - 2, y: y1 - 5, ancla: "end" as const },
          ].map((c, i) => (
            <text
              key={i}
              x={c.x}
              y={c.y}
              textAnchor={c.ancla}
              data-cuadrante={i}
              data-alerta={i === cuadranteAlerta ? "" : undefined}
              fill={i === cuadranteAlerta ? "var(--warning)" : undefined}
            >
              {nombreCuadrante(i)}
            </text>
          ))}
        </g>

        {puntos.map((p, i) =>
          mix ? (
            // 14 px, borde del color de la tarjeta y un anillo fino del color del punto.
            <g key={p.key} data-punto={p.key} data-alerta={p.alerta ? "" : undefined}>
              <circle cx={sx(p.x)} cy={sy(p.y)} r={8} fill="none" stroke={colorPunto(p)} strokeWidth={1} />
              <circle
                cx={sx(p.x)}
                cy={sy(p.y)}
                r={6}
                fill={colorPunto(p)}
                fillOpacity={activo !== null && activo !== i ? 0.55 : 1}
                stroke={activo === i ? TINTA.texto : TINTA.superficie}
                strokeWidth={2}
              />
            </g>
          ) : (
            <circle
              key={p.key}
              data-punto={p.key}
              cx={sx(p.x)}
              cy={sy(p.y)}
              r={p.resaltar ? 6 : 4.5}
              fill="var(--data-ink)"
              fillOpacity={activo !== null && activo !== i ? 0.55 : 1}
              stroke={activo === i ? TINTA.texto : TINTA.superficie}
              strokeWidth={2}
            />
          ),
        )}

        {rotulos.map((r) => (
          <text
            key={`r-${puntos[r.i]!.key}`}
            data-rotulo={puntos[r.i]!.key}
            x={r.x}
            y={r.y}
            dy="0.32em"
            textAnchor={r.ancla}
            fontSize={TEXTO_PX}
            fontWeight={puntos[r.i]!.resaltar || mix ? 600 : 400}
            fill={TINTA.texto}
            {...HALO}
          >
            {puntos[r.i]!.etiqueta}
            {mix && puntos[r.i]!.detalle ? (
              <tspan fontWeight={400} fill={TINTA.secundario}>
                {` ${puntos[r.i]!.detalle}`}
              </tspan>
            ) : null}
          </text>
        ))}

        {/* Blancos de 24 px (más grandes que el punto). */}
        {puntos.map((p, i) => (
          <circle
            key={`hit-${p.key}`}
            cx={sx(p.x)}
            cy={sy(p.y)}
            r={HIT}
            fill="transparent"
            onPointerEnter={() => setActivo(i)}
            onPointerLeave={soltar}
          />
        ))}
      </svg>

      {activoP && activo !== null ? (
        <Globo x={sx(activoP.x)} y={sy(activoP.y) - 6} ancho={ancho}>
          <div className="mb-0.5 font-medium">{activoP.etiqueta}</div>
          <RenglonGlobo valor={ejeX.formato(activoP.x)} etiqueta={ejeX.titulo} />
          <RenglonGlobo valor={ejeY.formato(activoP.y)} etiqueta={ejeY.titulo} />
          {mix && activoP.alerta && cuadranteAlerta !== undefined ? (
            <div className="mt-0.5 font-semibold text-warning">{nombreCuadrante(cuadranteAlerta)}</div>
          ) : null}
        </Globo>
      ) : null}
    </div>
  )

  if (!resumenLateral || resumenLateral.length === 0) return lienzo
  return (
    <div className="flex min-w-0 flex-col md:flex-row" data-slot="cuadrante-con-resumen">
      <div className="min-w-0 flex-1">{lienzo}</div>
      <ResumenLateral rotulo={rotuloResumen} renglones={resumenLateral} />
    </div>
  )
}
