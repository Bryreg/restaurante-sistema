import { Globo, RenglonGlobo } from "./base"
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
}: QuadrantScatterProps): React.JSX.Element {
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
  puntos.forEach((p, i) => p.resaltar && candidatos.push(i))
  if (puntos.length) {
    const idx = (f: (a: ScatterPunto, b: ScatterPunto) => boolean) =>
      puntos.reduce((m, p, i) => (f(p, puntos[m]!) ? i : m), 0)
    for (const i of [idx((a, b) => a.y > b.y), idx((a, b) => a.x > b.x), idx((a, b) => a.y < b.y)])
      if (!candidatos.includes(i)) candidatos.push(i)
  }
  const ocupadas: Caja[] = [
    // Los nombres de cuadrante en las esquinas.
    { x: x0, y: y0, w: anchoTexto(cuadrantes[1]), h: 16 },
    { x: x1 - anchoTexto(cuadrantes[0]), y: y0, w: anchoTexto(cuadrantes[0]), h: 16 },
    { x: x0, y: y1 - 16, w: anchoTexto(cuadrantes[2]), h: 16 },
    { x: x1 - anchoTexto(cuadrantes[3]), y: y1 - 16, w: anchoTexto(cuadrantes[3]), h: 16 },
  ]
  const rotulos: { i: number; x: number; y: number; ancla: "start" | "end" }[] = []
  for (const i of candidatos) {
    const p = puntos[i]!
    const px = sx(p.x)
    const py = sy(p.y)
    const w = anchoTexto(p.etiqueta)
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
      .join("; ")}. El detalle está en la tabla.`

  const activoP = activo !== null ? puntos[activo] : undefined
  const alto1 = y1 + BANDA_X

  // Rótulo del umbral X arriba de su línea, sin salirse por los costados.
  const wUx = anchoTexto(umbralX.etiqueta)
  const anclaUx = ux + wUx / 2 > ancho - 2 ? "end" : ux - wUx / 2 < 2 ? "start" : "middle"

  return (
    <div
      ref={ref}
      role="img"
      aria-label={texto}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onBlur={soltar}
      className={CLASE_LIENZO}
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
          <line x1={ux} x2={ux} y1={y0 - 4} y2={y1} stroke="var(--data-muted)" strokeWidth={1} strokeDasharray="4 3" />
          <text x={ux} y={y0 - 8} textAnchor={anclaUx} fontSize={TEXTO_PX} fill={TINTA.secundario} {...HALO}>
            {umbralX.etiqueta}
          </text>
        </g>
        <g data-umbral="y">
          <line x1={x0} x2={x1} y1={uy} y2={uy} stroke="var(--data-muted)" strokeWidth={1} strokeDasharray="4 3" />
          <text x={x1} y={uy - 4} textAnchor="end" fontSize={TEXTO_PX} fill={TINTA.secundario} {...HALO}>
            {umbralY.etiqueta}
          </text>
        </g>

        {/* Nombres de los cuadrantes, en sus esquinas. */}
        <g fontSize={TEXTO_PX} fontWeight={600} fill={TINTA.secundario} {...HALO} data-cuadrantes="">
          <text x={x1 - 2} y={y0 + 12} textAnchor="end">
            {cuadrantes[0]}
          </text>
          <text x={x0 + 4} y={y0 + 12}>
            {cuadrantes[1]}
          </text>
          <text x={x0 + 4} y={y1 - 5}>
            {cuadrantes[2]}
          </text>
          <text x={x1 - 2} y={y1 - 5} textAnchor="end">
            {cuadrantes[3]}
          </text>
        </g>

        {puntos.map((p, i) => (
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
        ))}

        {rotulos.map((r) => (
          <text
            key={`r-${puntos[r.i]!.key}`}
            data-rotulo={puntos[r.i]!.key}
            x={r.x}
            y={r.y}
            dy="0.32em"
            textAnchor={r.ancla}
            fontSize={TEXTO_PX}
            fontWeight={puntos[r.i]!.resaltar ? 600 : 400}
            fill={TINTA.texto}
            {...HALO}
          >
            {puntos[r.i]!.etiqueta}
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
        </Globo>
      ) : null}
    </div>
  )
}
