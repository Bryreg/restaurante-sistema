import type { SeriesPointOut } from "@/api/reports"
import { cn } from "@/lib/utils"

/**
 * **La barra + raya chica** de los bloques de Hoy (64 px), del detalle de
 * las tarjetas del celular (120 px) y de su mini tendencia (26 px).
 *
 * `BarrasConReferencia` es la versión de pantalla completa —tarjeta propia,
 * pregunta, leyenda y resumen lateral—; acá va adentro de un bloque que ya
 * tiene todo eso, así que es sólo el dibujo (handoff, `AdminHoy` y
 * `MovilSecciones`):
 *
 * - la barra es el dato, en `--data-1`, con radio de 2 px arriba;
 * - la raya **común** (60 min, 20 min, «lo sano: 7») es una línea punteada
 *   de 2 px de lado a lado, con su rótulo a la derecha;
 * - la raya **de cada punto** (la semana pasada a la misma hora) es un
 *   trazo sólido de 3 px que sobresale 2 px a cada lado de su barra;
 * - del lado malo, la barra va en ámbar (o en rojo con `tono="destructive"`:
 *   cocina); lo que viene, al 35 %; «ahora», en tinta de texto;
 * - `divergente`: el cero al medio, arriba sobra y abajo falta (rojo).
 *
 * Nada de acá decide una cifra: el lado de la raya lo manda el servidor
 * (`outside`) y los valores sólo se llevan a porcentajes de alto.
 */
export interface SerieMiniProps {
  puntos: readonly SeriesPointOut[]
  /** Raya común (punteada), con su rótulo. */
  referencia?: number | null
  rotuloReferencia?: string
  /** Cada barra con su propia raya (`reference` de cada punto). */
  rayaPorPunto?: boolean
  divergente?: boolean
  tono?: "warning" | "destructive"
  /** Alto del área de barras, en px. */
  alto: number
  /** Qué rótulos van debajo: todos, el primero · «ahora» o el del medio · el último, o ninguno. */
  etiquetas?: "todas" | "tres" | "ninguna"
  /** Cómo se escribe un valor en el `title` de cada barra. */
  formato: (v: number) => string
  /** Lo que el lector de pantalla oye: el dibujo resumido. */
  resumen: string
  /** Sin aire entre barras ni rayas: la mini tendencia de la tarjeta del celular. */
  mini?: boolean
  className?: string
}

const COLOR_FUERA = { warning: "bg-warning", destructive: "bg-destructive" } as const

/** Porcentaje de dibujo (0–100) sobre el tope del eje. Sólo píxeles. */
function aPct(v: number | null | undefined, tope: number): number {
  if (v === null || v === undefined || !Number.isFinite(v) || tope <= 0) return 0
  return Math.min(100, Math.max(0, (Math.abs(v) / tope) * 100))
}

function claseBarra(p: SeriesPointOut, tono: "warning" | "destructive", mini: boolean): string {
  if (p.outside) return cn(COLOR_FUERA[tono], p.now && !mini && "ring-2 ring-foreground ring-offset-1 ring-offset-card")
  if (p.now) return "bg-foreground"
  return "bg-(--data-1)"
}

export function SerieMini({
  puntos,
  referencia,
  rotuloReferencia,
  rayaPorPunto = false,
  divergente = false,
  tono = "warning",
  alto,
  etiquetas = "ninguna",
  formato,
  resumen,
  mini = false,
  className,
}: SerieMiniProps): React.JSX.Element {
  // El tope deja aire arriba (×1,12) para que la raya más alta no quede
  // pegada al borde: es dibujo, no una cifra.
  let tope = 0
  for (const p of puntos) {
    if (p.value !== null) tope = Math.max(tope, Math.abs(p.value))
    if (rayaPorPunto && p.reference !== null) tope = Math.max(tope, Math.abs(p.reference))
  }
  if (referencia != null && !divergente) tope = Math.max(tope, referencia)
  tope = tope > 0 ? tope * (mini ? 1 : 1.12) : 1

  const iAhora = puntos.findIndex((p) => p.now)
  const conAhora = iAhora > 0 && iAhora < puntos.length - 1
  // El del medio del eje (índice, no una cifra).
  const medio = conAhora ? iAhora : (puntos.length - 1) >> 1
  const rotulos: { texto: string; lugar: "inicio" | "medio" | "fin" }[] =
    etiquetas === "tres" && puntos.length > 0
      ? [
          { texto: puntos[0]!.label, lugar: "inicio" },
          ...(puntos.length > 2
            ? [{ texto: conAhora ? "ahora" : (puntos[medio]?.label ?? ""), lugar: "medio" as const }]
            : []),
          ...(puntos.length > 1 ? [{ texto: puntos[puntos.length - 1]!.label, lugar: "fin" as const }] : []),
        ]
      : []

  return (
    <div className={cn("flex min-w-0 flex-col gap-1", className)}>
      <div
        role="img"
        aria-label={resumen}
        data-slot="serie-mini"
        className={cn(
          "relative flex items-stretch",
          mini ? "gap-0.5" : "gap-[3px]",
          !divergente && !mini && "border-b border-foreground",
        )}
        style={{ height: alto }}
      >
        {puntos.map((p) => {
          const lectura = `${p.label}: ${p.value === null ? "sin dato" : formato(p.value)}${
            rayaPorPunto && p.reference !== null ? ` · raya ${formato(p.reference)}` : ""
          }${p.future ? " · lo que viene" : ""}${p.now ? " · ahora" : ""}`
          if (divergente) {
            const arriba = p.value !== null && p.value > 0
            const abajo = p.value !== null && p.value < 0
            return (
              <span key={p.key} title={lectura} className="relative flex min-w-0 flex-1 flex-col">
                <span className="flex h-1/2 items-end">
                  {p.value === null ? (
                    <span data-hueco="" className="mx-auto block h-[2px] w-1/2 self-end rounded-full bg-muted-foreground/35" />
                  ) : (
                    <span
                      data-barra=""
                      className={cn("block w-full rounded-t-[2px]", p.now ? "bg-foreground" : "bg-(--data-1)")}
                      style={{ height: arriba ? `${aPct(p.value, tope)}%` : 0 }}
                    />
                  )}
                </span>
                <span className={cn("flex h-1/2 items-start", !mini && "border-t border-foreground")}>
                  <span
                    data-barra=""
                    data-fuera={abajo ? "" : undefined}
                    className="block w-full rounded-b-[2px] bg-(--diverge-falta)"
                    style={{ height: abajo ? `${aPct(p.value, tope)}%` : 0 }}
                  />
                </span>
              </span>
            )
          }
          return (
            <span key={p.key} title={lectura} className="relative flex min-w-0 flex-1 items-end">
              {p.value === null ? (
                // Sin dato: ni barra de 0 ni columna rayada; una marca
                // apagada al pie, que no se confunde con un dato.
                <span data-hueco="" className="mx-auto block h-[2px] w-1/2 rounded-full bg-muted-foreground/35" />
              ) : (
                <span
                  data-barra=""
                  data-fuera={p.outside ? "" : undefined}
                  data-futuro={p.future ? "" : undefined}
                  data-ahora={p.now ? "" : undefined}
                  className={cn(
                    "block w-full rounded-t-[2px]",
                    mini ? "min-h-[2px]" : "min-h-[2px]",
                    claseBarra(p, tono, mini),
                    p.future && "opacity-35",
                  )}
                  style={{ height: `${aPct(p.value, tope)}%` }}
                />
              )}
              {rayaPorPunto && !mini && p.reference !== null ? (
                <span
                  data-raya=""
                  aria-hidden="true"
                  className="pointer-events-none absolute -inset-x-0.5 z-[1] h-[3px] translate-y-1/2 bg-foreground"
                  style={{ bottom: `${aPct(p.reference, tope)}%` }}
                />
              ) : null}
            </span>
          )
        })}
        {referencia != null && !mini && !divergente ? (
          <>
            <span
              data-raya-comun=""
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-0 border-t-2 border-dashed border-foreground"
              style={{ bottom: `${aPct(referencia, tope)}%` }}
            />
            {rotuloReferencia ? (
              <span
                aria-hidden="true"
                className="pointer-events-none absolute right-0 -translate-y-full bg-card px-1 text-[10px] leading-tight font-bold"
                style={{ bottom: `${aPct(referencia, tope)}%` }}
              >
                {rotuloReferencia}
              </span>
            ) : null}
          </>
        ) : null}
      </div>
      {etiquetas === "todas" ? (
        <div aria-hidden="true" className={cn("flex text-[10px] text-muted-foreground", mini ? "gap-0.5" : "gap-[3px]")}>
          {puntos.map((p) => (
            <span key={p.key} className="min-w-0 flex-1 truncate text-center">
              {p.label}
            </span>
          ))}
        </div>
      ) : null}
      {rotulos.length > 0 ? (
        <div aria-hidden="true" className="relative h-[13px] text-[10px] leading-[13px] text-muted-foreground">
          {rotulos.map((r) => (
            <span
              key={r.lugar}
              className={cn(
                "absolute whitespace-nowrap",
                r.lugar === "inicio" && "left-0",
                r.lugar === "fin" && "right-0",
                r.lugar === "medio" && "-translate-x-1/2",
              )}
              style={r.lugar === "medio" ? { left: `${((medio + 0.5) / puntos.length) * 100}%` } : undefined}
            >
              {r.texto}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  )
}
