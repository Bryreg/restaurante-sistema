import type { TimelineCountOut, TimelineRowOut } from "@/api/inventory"
import { formatClockTime, formatInstant } from "@/lib/businessDate"
import { cn } from "@/lib/utils"

import { UNIDAD, cantidadCorta, type MarcaEje } from "./lineaDeTiempo"

/**
 * **La vida de un insumo en una barra** (Inventario › Línea de tiempo y la
 * ficha del insumo; adaptada de `BarraInsumo` de café-sistema).
 *
 * El saldo es un área **escalonada**: el stock no cambia de a poquito, cambia
 * de golpe con cada venta y con cada llegada, y una curva suave inventaría un
 * movimiento que nunca ocurrió. Cada tramo se pinta por cómo estaba: gris al
 * día, **ámbar bajo el mínimo** y **rojo en cero o menos** — así la barra dice
 * cuánto tiempo faltó sin leer un número. La raya punteada es el mínimo.
 *
 * Encima van los **conteos**: el punto es lo que alguien vio en el estante y
 * el palito lo une con lo que el libro creía en ese instante. Rojo si faltaba,
 * tinta si sobraba, verde si coincidía. Abajo, una marca por cada llegada.
 *
 * Cada barra tiene **su propia escala**: un insumo va en gramos y otro en
 * unidades; lo comparable entre filas es la forma. Los números del dibujo
 * son sólo píxeles: el saldo, los totales y las diferencias los manda el
 * servidor (`app.inventory.timeline`), acá no se suma ningún movimiento.
 */

const W = 1000

function ms(iso: string): number {
  return new Date(iso).getTime()
}

interface Tramo {
  desde: number
  hasta: number
  saldo: number
}

/** Los tramos del dibujo: del arranque a cada punto, y del último hasta «ahora». */
function tramos(row: TimelineRowOut, t0: number, ahora: number): Tramo[] {
  const lista: Tramo[] = []
  let desde = t0
  let saldo = Number(row.start_qty)
  for (const p of row.points) {
    const t = Math.min(ahora, Math.max(t0, ms(p.at)))
    if (t > desde) lista.push({ desde, hasta: t, saldo })
    desde = t
    saldo = Number(p.qty)
  }
  if (ahora > desde) lista.push({ desde, hasta: ahora, saldo })
  return lista
}

function tonoDiferencia(c: TimelineCountOut): string {
  const d = Number(c.diff)
  if (d < 0) return "bg-destructive"
  if (d > 0) return "bg-foreground"
  return "bg-success"
}

function palabraDiferencia(c: TimelineCountOut, unidad: string): string {
  const d = Number(c.diff)
  if (d === 0) return "coincidió con el libro"
  return `${d < 0 ? "faltaban" : "sobraban"} ${cantidadCorta(c.diff.replace("-", ""), unidad)}`
}

export function BarraVidaInsumo({
  row,
  startAt,
  endAt,
  nowAt,
  alto = 48,
  className,
}: {
  row: TimelineRowOut
  startAt: string
  endAt: string
  nowAt: string
  alto?: number
  className?: string
}): React.JSX.Element {
  const t0 = ms(startAt)
  const t1 = Math.max(t0 + 1, ms(endAt))
  const ahora = Math.min(t1, Math.max(t0, ms(nowAt)))
  const span = t1 - t0
  const u = (t: number) => Math.min(1, Math.max(0, (t - t0) / span))
  const unidad = UNIDAD[row.base_unit] ?? row.base_unit
  const minimo = Number(row.min_stock)

  const lista = tramos(row, t0, ahora)
  // La escala de la fila: todo lo que se dibuja entra, también lo contado
  // (recortarlo para que la curva se vea linda escondería el hallazgo).
  const valores = [0, minimo, ...lista.map((t) => t.saldo)]
  for (const c of row.counts) valores.push(Number(c.counted), Number(c.expected))
  const alto_ = Math.max(...valores)
  const bajo = Math.min(...valores)
  const rango = alto_ - bajo || 1
  const pad = 3
  const y = (v: number) => pad + ((alto_ - v) / rango) * (alto - pad * 2)
  const yCero = y(0)

  return (
    <div className={cn("relative", className)} style={{ height: alto }}>
      <svg
        viewBox={`0 0 ${W} ${alto}`}
        preserveAspectRatio="none"
        className="absolute inset-0 size-full overflow-visible"
        aria-hidden="true"
      >
        {/* Lo que todavía no pasó: el resto del período, en el pozo. */}
        {ahora < t1 ? (
          <rect
            data-futuro=""
            x={u(ahora) * W}
            y={0}
            width={(1 - u(ahora)) * W}
            height={alto}
            className="fill-muted"
          />
        ) : null}
        {lista.map((t) => {
          const x = u(t.desde) * W
          // +1.5: cada tramo se monta sobre el siguiente; sin eso el
          // suavizado deja una rendija blanca entre dos escalones.
          const w = Math.max(0.5, (u(t.hasta) - u(t.desde)) * W) + 1.5
          // En cero exacto no hay área: una franja de 2 px para que se vea.
          const top = t.saldo > 0 ? y(t.saldo) : t.saldo === 0 ? yCero - 2 : yCero
          const h = t.saldo === 0 ? 2 : Math.max(0.5, Math.abs(y(t.saldo) - yCero))
          return (
            <rect
              key={t.desde}
              data-tramo={t.saldo <= 0 ? "cero" : t.saldo < minimo ? "bajo" : "ok"}
              x={x}
              y={top}
              width={w}
              height={h}
              shapeRendering="crispEdges"
              className={t.saldo <= 0 ? "fill-destructive" : t.saldo < minimo ? "fill-warning" : "fill-data-bar"}
            />
          )
        })}
        <line
          data-minimo=""
          x1={0}
          x2={W}
          y1={y(minimo)}
          y2={y(minimo)}
          strokeDasharray="5 4"
          vectorEffect="non-scaling-stroke"
          className="stroke-foreground opacity-55"
          strokeWidth={1}
        />
        {bajo < 0 ? (
          <line x1={0} x2={W} y1={yCero} y2={yCero} vectorEffect="non-scaling-stroke" className="stroke-border" strokeWidth={1} />
        ) : null}
      </svg>

      {/* Las llegadas: una marca abajo, en HTML para que no se estire. */}
      {row.arrivals.map((a) => (
        <span
          key={`${a.at}-${a.qty}`}
          data-llegada=""
          title={`Llegó ${cantidadCorta(a.qty, unidad)} · ${formatInstant(a.at)}`}
          className="absolute -bottom-2.5 size-2 -translate-x-1/2 bg-foreground [clip-path:polygon(50%_0,100%_100%,0_100%)]"
          style={{ left: `${u(ms(a.at)) * 100}%` }}
        />
      ))}

      {/* Los conteos: el punto es lo contado; el palito, la distancia al libro. */}
      {row.counts.map((c) => {
        const left = `${u(ms(c.at)) * 100}%`
        const yc = y(Number(c.counted))
        const ye = y(Number(c.expected))
        const tono = tonoDiferencia(c)
        return (
          <span key={`${c.at}-${c.label}`} data-conteo="" className="absolute inset-y-0" style={{ left }}>
            <span
              aria-hidden="true"
              className={cn("absolute w-0.5 -translate-x-1/2", tono)}
              style={{ top: Math.min(yc, ye), height: Math.max(1, Math.abs(yc - ye)) }}
            />
            <span
              title={`${c.label} · ${formatClockTime(c.at)}: contaron ${cantidadCorta(c.counted, unidad)}; el libro decía ${cantidadCorta(c.expected, unidad)} — ${palabraDiferencia(c, unidad)}`}
              className={cn(
                "absolute size-[11px] -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-card",
                tono,
              )}
              style={{ top: yc }}
            />
          </span>
        )
      })}
    </div>
  )
}

/** La regla de tiempo encima de las barras. */
export function EjeTiempo({ marcas, className }: { marcas: MarcaEje[]; className?: string }): React.JSX.Element {
  return (
    <div aria-hidden="true" className={cn("relative h-4 text-[11px] text-muted-foreground", className)}>
      {marcas.map((m) => (
        <span key={`${m.u}-${m.texto}`} className="absolute whitespace-nowrap" style={{ left: `${m.u * 100}%` }}>
          <span className="absolute top-4 h-2 w-px bg-border" />
          {m.texto}
        </span>
      ))}
    </div>
  )
}
