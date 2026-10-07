import type { LucideIcon } from "lucide-react"
import { ArrowUpRight } from "lucide-react"
import type { ReactNode } from "react"
import { Link } from "react-router-dom"

import { cn } from "@/lib/utils"

/**
 * **Las piezas del estilo «Burbujas»** (handoff `design_handoff_estilo_burbujas`,
 * § 3). Una burbuja es una superficie blanca de esquinas grandes, sin borde ni
 * sombra, sobre el gris de la página; un pozo es el hueco gris de adentro donde
 * van los gráficos, las cifras secundarias y los ítems de una lista.
 */

export type Tono = "success" | "warning" | "destructive" | "neutral"

/** La forma de cada tono: el color nunca es la única señal. */
const FORMA: Record<Tono, string> = {
  success: "rounded-full",
  warning: "[clip-path:polygon(50%_0,100%_100%,0_100%)]",
  destructive: "rounded-[1px]",
  neutral: "rounded-[1px]",
}

const PASTILLA: Record<Tono, string> = {
  success: "bg-success-soft text-success",
  warning: "bg-warning-soft text-warning",
  destructive: "bg-destructive-soft text-destructive",
  neutral: "bg-muted text-muted-foreground",
}

/**
 * **Pastilla de estado**: 26 px, fondo suave del tono, texto del tono en 12/600
 * y la forma (● ▲ ■) de 7 px. El texto dice el estado con palabras; la forma y
 * el color lo repiten.
 */
export function EstadoPastilla({
  tono,
  children,
  className,
  sinForma = false,
}: {
  tono: Tono
  children: ReactNode
  className?: string
  /** El texto ya trae su forma (▲ ▼ ■): no se repite. */
  sinForma?: boolean
}): React.JSX.Element {
  return (
    <span
      className={cn(
        "inline-flex h-[26px] shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs font-semibold whitespace-nowrap",
        PASTILLA[tono],
        className,
      )}
    >
      {sinForma ? null : <span aria-hidden="true" className={cn("size-[7px] shrink-0 bg-current", FORMA[tono])} />}
      {children}
    </span>
  )
}

/** El hueco gris de adentro de una burbuja. */
export function Pozo({
  children,
  className,
  ...props
}: React.ComponentProps<"div">): React.JSX.Element {
  return (
    <div className={cn("rounded-2xl bg-muted px-4 py-3.5", className)} {...props}>
      {children}
    </div>
  )
}

/** El botón redondo de 32 px que lleva a la pantalla de la burbuja. */
export function IrRedondo({
  to,
  label,
  grande = false,
}: {
  to: string
  label: string
  grande?: boolean
}): React.JSX.Element {
  return (
    <Link
      to={to}
      aria-label={label}
      title={label}
      className={cn(
        "grid shrink-0 place-items-center rounded-full bg-muted text-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
        grande ? "size-10" : "size-8",
      )}
    >
      <ArrowUpRight className={grande ? "size-[18px]" : "size-4"} aria-hidden="true" />
    </Link>
  )
}

/**
 * **La burbuja**: radio 24, padding 22–28, sin borde ni sombra. La cabecera
 * (ícono, título, estado y botón para ir) es opcional; sin `titulo`, la
 * burbuja es sólo la superficie.
 */
export function Burbuja({
  icono: Icono,
  titulo,
  estado,
  ir,
  accion,
  span,
  className,
  children,
  ...props
}: {
  icono?: LucideIcon
  titulo?: ReactNode
  estado?: { tono: Tono; texto: ReactNode }
  ir?: { to: string; label: string }
  /** Algo más en la cabecera, a la derecha (un botón de CSV, por ejemplo). */
  accion?: ReactNode
  /** Ocupa las dos columnas de una grilla de dos. */
  span?: 2
} & Omit<React.ComponentProps<"section">, "title">): React.JSX.Element {
  const conCabecera = titulo !== undefined || estado !== undefined || ir !== undefined || accion !== undefined
  return (
    <section
      className={cn("burbuja min-w-0 rounded-[24px] bg-card p-6", span === 2 && "md:col-span-2", className)}
      {...props}
    >
      {conCabecera ? (
        <header className="mb-3.5 flex items-center gap-3">
          {Icono ? (
            <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-muted">
              <Icono className="size-[18px]" aria-hidden="true" />
            </span>
          ) : null}
          {titulo !== undefined ? (
            <h2 className="min-w-0 flex-1 truncate text-[15px] font-semibold tracking-normal">{titulo}</h2>
          ) : (
            <span className="flex-1" />
          )}
          {estado ? <EstadoPastilla tono={estado.tono}>{estado.texto}</EstadoPastilla> : null}
          {accion}
          {ir ? <IrRedondo to={ir.to} label={ir.label} /> : null}
        </header>
      ) : null}
      {children}
    </section>
  )
}

/**
 * **El interruptor segmentado** (handoff § 2): contenedor en `--muted` con
 * 4 px de aire; la opción activa sobre `--card`, en 600 y con la única sombra
 * permitida del estilo.
 */
export function Segmentado<V extends string | number>({
  etiqueta,
  opciones,
  valor,
  onChange,
  chico,
}: {
  etiqueta: string
  opciones: readonly { value: V; label: string }[]
  valor: V
  onChange: (v: V) => void
  chico?: boolean
}): React.JSX.Element {
  return (
    <div role="group" aria-label={etiqueta} className="inline-flex flex-wrap gap-0.5 rounded-xl bg-muted p-1">
      {opciones.map((o) => {
        const activa = o.value === valor
        return (
          <button
            key={String(o.value)}
            type="button"
            aria-pressed={activa}
            onClick={() => onChange(o.value)}
            className={segmentoClase(activa, chico)}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

/** Las clases de un segmento, para los que son enlaces y no botones. */
export function segmentoClase(activa: boolean, chico = false): string {
  return cn(
    "inline-flex items-center gap-1.5 rounded-[9px] transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
    chico ? "h-7 px-2.5 text-xs" : "h-8 px-3.5 text-sm",
    activa
      ? "bg-card font-semibold text-foreground shadow-[0_1px_2px_rgb(0_0_0/6%)]"
      : "font-medium text-muted-foreground hover:text-foreground",
  )
}

/**
 * **El interruptor segmentado en tamaño táctil** (handoff del POS § 2):
 * contenedor en `--muted` con 4 px de aire y radio 16; cada opción de 48 px
 * (60 en las elecciones grandes del cobro), la elegida sobre `--card` en 600
 * con `0 1px 2px rgb(0 0 0 / 8%)`. `detalle` va al lado (un recuento) o
 * debajo (`apilado`, la cifra de la propina). Con `columnas`, las opciones
 * se reparten a lo ancho en partes iguales.
 */
export function SegmentadoTactil<V extends string | number>({
  etiqueta,
  opciones,
  valor,
  onChange,
  alto = 48,
  columnas,
  apilado = false,
  apagadas = false,
  className,
}: {
  etiqueta: string
  opciones: readonly { value: V; label: ReactNode; detalle?: ReactNode; disabled?: boolean; testId?: string }[]
  /** `null`: ninguna elegida todavía. */
  valor: V | null
  onChange: (v: V) => void
  alto?: 44 | 48 | 56 | 60
  columnas?: number
  apilado?: boolean
  /** Las no elegidas en gris (la barra de secciones), no en tinta. */
  apagadas?: boolean
  className?: string
}): React.JSX.Element {
  return (
    <div
      role="group"
      aria-label={etiqueta}
      className={cn(
        "gap-1 bg-muted p-1",
        alto >= 56 ? "rounded-[18px]" : "rounded-2xl",
        columnas ? "grid" : "inline-flex flex-wrap",
        className,
      )}
      style={columnas ? { gridTemplateColumns: `repeat(${columnas}, minmax(0, 1fr))` } : undefined}
    >
      {opciones.map((o) => {
        const activa = o.value === valor
        return (
          <button
            key={String(o.value)}
            type="button"
            aria-pressed={activa}
            disabled={o.disabled}
            data-testid={o.testId}
            onClick={() => onChange(o.value)}
            style={{ minHeight: alto }}
            className={cn(
              "min-w-0 transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50",
              alto >= 56 ? "rounded-[14px]" : alto <= 44 ? "rounded-[10px]" : "rounded-xl",
              apilado
                ? "flex flex-col items-center justify-center gap-px px-2 text-sm"
                : cn("inline-flex items-center justify-center gap-1.5 px-4", alto <= 44 ? "text-sm" : "text-[15px]"),
              activa
                ? "bg-card font-semibold text-foreground shadow-[0_1px_2px_rgb(0_0_0/8%)]"
                : cn("font-medium", apagadas ? "text-muted-foreground hover:text-foreground" : "text-foreground"),
            )}
          >
            {apilado ? <b className="font-semibold">{o.label}</b> : o.label}
            {o.detalle !== undefined ? " " : null}
            {o.detalle !== undefined ? (
              <span className={cn("font-normal text-muted-foreground", apilado ? "text-xs" : "text-[13px]")}>{o.detalle}</span>
            ) : null}
          </button>
        )
      })}
    </div>
  )
}
