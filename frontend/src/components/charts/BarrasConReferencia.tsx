/**
 * «Barra + raya» (`docs/diseno/handoff-pos-y-panel/README.md` § «Patrón de
 * datos»): la barra es el dato, la raya su referencia (semana anterior,
 * meta, mínimo, umbral, capacidad). La barra va en ámbar —o en rojo con
 * `tono="destructive"`, para cocina y mesas— cuando queda del lado malo de
 * su raya, y su cifra lleva el mismo color **más** ▲/▼ y texto: nunca sólo
 * color.
 *
 * Tres formas: `columnas` (en el tiempo), `filas` (categorías) y
 * `BulletReferencia`, el mini de 90 × 10 para celdas de tabla y bloques de
 * Hoy.
 *
 * Nada de acá calcula una cifra de negocio: los valores y las rayas llegan
 * del backend (`api/reports.ts`, `api/panel.ts`) y sólo se llevan a
 * porcentajes de alto o de ancho para dibujarlos. Si el backend ya decidió
 * de qué lado quedó el punto (`fuera`), manda él; si no, se compara el valor
 * con su raya —comparar no es calcular—.
 */
import type { ReactNode } from "react"
import { Link } from "react-router-dom"

import { cn } from "@/lib/utils"

import { estaFuera, type LadoMalo } from "./referencia"

export type { LadoMalo } from "./referencia"

export type TonoMalo = "warning" | "destructive"
export type TonoResumen = "success" | "warning" | "data" | "muted"

export interface PuntoReferencia {
  /** Identidad estable; por defecto, la etiqueta. */
  key?: string
  etiqueta: string
  /** `null` = sin dato (se dibuja rayado y se lee «sin dato», nunca 0). */
  valor: number | null
  referencia?: number | null
  /** Lo que viene (proyección o programado): la barra al 35 %. */
  futuro?: boolean
  /** «Ahora» u «hoy»: la barra en tinta de texto (o con anillo si va fuera). */
  ahora?: boolean
  href?: string
  /** Lo decidió el backend (`outside`). Sin esto se compara con la raya. */
  fuera?: boolean
  /** Cifra escrita arriba de la columna o a la derecha de la fila. Por defecto `formato(valor)`. */
  cifra?: string
  /** Renglón en negrita bajo la etiqueta (columnas) o después de la cifra (filas). */
  detalle?: string
  /** Valor de la fila extra bajo las columnas (p. ej. meseros en turno). */
  extra?: string
}

export interface LeyendaReferencia {
  barra: string
  raya: string
  fuera: string
}

export interface RenglonResumen {
  titulo: string
  detalle: string
  tono: TonoResumen
}

export interface BarrasConReferenciaProps {
  /** El título es la pregunta que responde el gráfico. */
  pregunta: string
  puntos: PuntoReferencia[]
  /** Raya común a todos los puntos (meta, umbral, límite). */
  referenciaComun?: number | null
  malo: LadoMalo
  tono?: TonoMalo
  leyenda: LeyendaReferencia
  resumen?: RenglonResumen[]
  /** Rótulo en versalitas del resumen lateral. */
  rotuloResumen?: string
  variante?: "columnas" | "filas"
  /** Cómo se escribe un valor (`formatCOP`, `formatPct`, `formatDuracion`…). */
  formato: (v: number) => string
  /** Escribe ▲/▼ delante de la cifra de todo punto con raya (comparaciones). Fuera, siempre. */
  flechas?: boolean
  /** Tope del eje (p. ej. 10.000 bp = 100 %). Por defecto, el mayor valor o raya. */
  maximo?: number
  /** Alto del área de columnas, en px. */
  alto?: number
  /** Rótulo de la fila extra (p. ej. «meseros»). */
  unidadExtra?: string
  /** Qué se escribe en la fila extra donde un punto no trae `extra`. «—» por defecto; `""` la deja en blanco (retiros de la ficha de turno). */
  extraVacio?: string
  /** Clase de la cifra de la fila extra (p. ej. los retiros en tinta de acción). */
  claseExtra?: string
  /** Controles propios (selector de día…), a la derecha de la pregunta. */
  acciones?: ReactNode
  className?: string
}

const COLOR_FUERA: Record<TonoMalo, { barra: string; texto: string }> = {
  warning: { barra: "bg-warning", texto: "text-warning" },
  destructive: { barra: "bg-destructive", texto: "text-destructive" },
}

const COLOR_RESUMEN: Record<TonoResumen, string> = {
  success: "bg-success",
  warning: "bg-warning",
  data: "bg-(--data-1)",
  muted: "bg-muted-foreground",
}

/** ▲ si el valor está arriba de la raya, ▼ si abajo, nada si igual o sin raya. */
function flecha(valor: number | null, referencia: number | null | undefined): string {
  if (valor === null || referencia === null || referencia === undefined || valor === referencia) return ""
  return valor > referencia ? "▲" : "▼"
}

/** Porcentaje de dibujo (0–100) sobre el tope del eje. Sólo píxeles. */
function aPct(v: number | null | undefined, tope: number): number {
  if (v === null || v === undefined || !Number.isFinite(v) || tope <= 0) return 0
  return Math.min(100, Math.max(0, (v / tope) * 100))
}

function topeDe(puntos: PuntoReferencia[], comun: number | null | undefined, maximo?: number): number {
  if (maximo !== undefined && maximo > 0) return maximo
  let tope = 0
  for (const p of puntos) {
    if (p.valor !== null && p.valor > tope) tope = p.valor
    if (p.referencia != null && p.referencia > tope) tope = p.referencia
  }
  if (comun != null && comun > tope) tope = comun
  return tope > 0 ? tope : 1
}

interface PuntoResuelto extends PuntoReferencia {
  clave: string
  ref: number | null
  esFuera: boolean
  texto: string
  lectura: string
}

function resolver(
  puntos: PuntoReferencia[],
  { referenciaComun, malo, formato, flechas, leyenda }: BarrasConReferenciaProps,
): PuntoResuelto[] {
  return puntos.map((p, i) => {
    const ref = p.referencia ?? referenciaComun ?? null
    const esFuera = estaFuera(p.valor, ref, malo, p.fuera)
    const base = p.cifra ?? (p.valor === null ? "sin dato" : formato(p.valor))
    const conFlecha = esFuera || flechas ? flecha(p.valor, ref) : ""
    const texto = conFlecha ? `${conFlecha} ${base}` : base
    const partes = [
      `${p.etiqueta}: ${p.valor === null ? "sin dato" : formato(p.valor)}`,
      ref !== null ? `${leyenda.raya}: ${formato(ref)}` : null,
      p.cifra && p.valor !== null ? `${conFlecha ? `${conFlecha} ` : ""}${p.cifra}` : null,
      esFuera ? leyenda.fuera : null,
      p.futuro ? "lo que viene" : null,
      p.ahora ? "ahora" : null,
      p.detalle ?? null,
    ].filter(Boolean)
    return { ...p, clave: p.key ?? `${p.etiqueta}-${i}`, ref, esFuera, texto, lectura: partes.join(" · ") }
  })
}

/** Una marca clicable si tiene `href`; si no, un contenedor. */
function Enlace({
  href,
  className,
  title,
  children,
}: {
  href?: string
  className?: string
  title: string
  children: ReactNode
}): React.JSX.Element {
  if (href) {
    return (
      <Link
        to={href}
        title={title}
        aria-label={title}
        className={cn(
          "rounded-sm text-inherit no-underline outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
          className,
        )}
      >
        {children}
      </Link>
    )
  }
  return (
    <div title={title} aria-hidden="true" className={className}>
      {children}
    </div>
  )
}

function Leyenda({
  leyenda,
  tono,
  variante,
}: {
  leyenda: LeyendaReferencia
  tono: TonoMalo
  variante: "columnas" | "filas"
}): React.JSX.Element {
  return (
    <ul
      aria-hidden="true"
      data-slot="leyenda"
      className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 text-xs text-muted-foreground"
    >
      <li className="inline-flex items-center gap-1.5">
        <span className="inline-block size-3 rounded-[2px] bg-(--data-1)" />
        {leyenda.barra}
      </li>
      <li className="inline-flex items-center gap-1.5">
        <span className={cn("inline-block size-3 rounded-[2px]", COLOR_FUERA[tono].barra)} />
        {leyenda.fuera}
      </li>
      <li className="inline-flex items-center gap-1.5">
        {variante === "filas" ? (
          <span className="inline-block h-3.5 w-[3px] bg-foreground" />
        ) : (
          <span className="inline-block h-[3px] w-4 bg-foreground" />
        )}
        {leyenda.raya}
      </li>
    </ul>
  )
}

/** El resumen lateral de 280 px: qué pasó y qué hacer. */
export function ResumenLateral({
  rotulo,
  renglones,
}: {
  rotulo?: string
  renglones: RenglonResumen[]
}): React.JSX.Element {
  return (
    <aside
      data-slot="resumen"
      className="flex flex-col gap-3 border-t p-4 md:w-[280px] md:shrink-0 md:border-t-0 md:border-l"
    >
      {rotulo ? (
        <span className="text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">{rotulo}</span>
      ) : null}
      {renglones.map((r, i) => (
        <div key={i} className="flex items-start gap-2.5" data-tono={r.tono}>
          <span aria-hidden="true" className={cn("w-1 self-stretch rounded-[2px]", COLOR_RESUMEN[r.tono])} />
          <div className="flex min-w-0 flex-col gap-0.5">
            <b className="text-[15px] leading-snug font-bold">{r.titulo}</b>
            <span className="text-[13px] leading-snug text-muted-foreground">{r.detalle}</span>
          </div>
        </div>
      ))}
    </aside>
  )
}

function claseBarra(p: PuntoResuelto, tono: TonoMalo): string {
  if (p.esFuera) return cn(COLOR_FUERA[tono].barra, p.ahora && "ring-2 ring-foreground ring-offset-1 ring-offset-card")
  if (p.ahora) return "bg-foreground"
  return "bg-(--data-1)"
}

function Columnas({
  puntos,
  tope,
  tono,
  alto,
  unidadExtra,
  extraVacio = "—",
  claseExtra,
}: {
  puntos: PuntoResuelto[]
  tope: number
  tono: TonoMalo
  alto: number
  unidadExtra?: string
  extraVacio?: string
  claseExtra?: string
}): React.JSX.Element {
  const conExtra = puntos.some((p) => p.extra !== undefined)
  const plantilla = { gridTemplateColumns: `repeat(${Math.max(1, puntos.length)}, minmax(0, 1fr))` }
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div
        className="grid items-end gap-1 border-b border-foreground sm:gap-2"
        style={{ ...plantilla, height: alto }}
        data-slot="columnas"
      >
        {puntos.map((p) => (
          <Enlace
            key={p.clave}
            href={p.href}
            title={p.lectura}
            className="relative flex h-full min-w-0 flex-col items-center justify-end"
          >
            <span
              data-cifra=""
              className={cn(
                "mb-[3px] max-w-full truncate text-[11px] font-bold tabular-nums sm:text-xs",
                p.esFuera ? COLOR_FUERA[tono].texto : "text-foreground",
                p.futuro && "opacity-60",
              )}
            >
              {p.texto}
            </span>
            {p.valor === null ? (
              <span data-hueco="" className="sin-dato block h-full w-full rounded-t-[3px]" />
            ) : (
              <span
                data-barra=""
                data-fuera={p.esFuera ? "" : undefined}
                data-futuro={p.futuro ? "" : undefined}
                data-ahora={p.ahora ? "" : undefined}
                className={cn("block w-full rounded-t-[3px]", claseBarra(p, tono), p.futuro && "opacity-35")}
                style={{ height: `${aPct(p.valor, tope)}%` }}
              />
            )}
            {p.ref !== null ? (
              <span
                data-raya=""
                className="pointer-events-none absolute -inset-x-1 h-[3px] translate-y-1/2 bg-foreground"
                style={{ bottom: `${aPct(p.ref, tope)}%` }}
              />
            ) : null}
          </Enlace>
        ))}
      </div>
      <div className="grid gap-1 text-center text-xs sm:gap-2" style={plantilla} aria-hidden="true">
        {puntos.map((p) => (
          <span key={p.clave} className="flex min-w-0 flex-col">
            <span className="truncate text-muted-foreground">{p.etiqueta}</span>
            {p.detalle ? <b className="truncate tabular-nums">{p.detalle}</b> : null}
          </span>
        ))}
      </div>
      {conExtra ? (
        <div
          className="grid gap-1 border-t border-dashed pt-1.5 text-center text-xs sm:gap-2"
          style={plantilla}
          aria-hidden="true"
          data-slot="fila-extra"
        >
          {puntos.map((p) => (
            <span key={p.clave} className="flex min-w-0 flex-col gap-px">
              <b className={cn("text-[13px] tabular-nums", claseExtra)}>{p.extra ?? extraVacio}</b>
              {unidadExtra ? <span className="truncate text-[10px] text-muted-foreground">{unidadExtra}</span> : null}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function Filas({
  puntos,
  tope,
  tono,
}: {
  puntos: PuntoResuelto[]
  tope: number
  tono: TonoMalo
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2" data-slot="filas">
      {puntos.map((p) => (
        <Enlace
          key={p.clave}
          href={p.href}
          title={p.lectura}
          className="grid grid-cols-[minmax(5rem,7.5rem)_minmax(0,1fr)] items-center gap-x-3 gap-y-0.5 text-sm sm:grid-cols-[7.5rem_minmax(0,1fr)_12.5rem]"
        >
          <span className="truncate">{p.etiqueta}</span>
          <span className="relative h-[22px] rounded-[3px] bg-muted">
            {p.valor === null ? (
              <span data-hueco="" className="sin-dato absolute inset-0 rounded-[3px]" />
            ) : (
              <span
                data-barra=""
                data-fuera={p.esFuera ? "" : undefined}
                data-futuro={p.futuro ? "" : undefined}
                data-ahora={p.ahora ? "" : undefined}
                className={cn(
                  "absolute inset-y-0 left-0 rounded-[3px]",
                  claseBarra(p, tono),
                  p.futuro && "opacity-35",
                )}
                style={{ width: `${aPct(p.valor, tope)}%` }}
              />
            )}
            {p.ref !== null ? (
              <span
                data-raya=""
                className="pointer-events-none absolute -inset-y-1 w-[3px] -translate-x-1/2 bg-foreground"
                style={{ left: `${aPct(p.ref, tope)}%` }}
              />
            ) : null}
          </span>
          <span className="col-span-2 flex items-baseline justify-end gap-2 whitespace-nowrap sm:col-span-1">
            <b
              data-cifra=""
              className={cn("tabular-nums", p.esFuera ? COLOR_FUERA[tono].texto : "text-foreground")}
            >
              {p.texto}
            </b>
            {p.detalle ? (
              <span
                className={cn(
                  "text-xs font-semibold",
                  p.esFuera ? COLOR_FUERA[tono].texto : "text-muted-foreground",
                )}
              >
                {p.detalle}
              </span>
            ) : null}
          </span>
        </Enlace>
      ))}
    </div>
  )
}

/**
 * Barras con su raya de referencia, con la pregunta como título, la
 * leyenda arriba y el resumen lateral opcional. Accesible como una lista:
 * cada punto se lee entero (dato, raya, si quedó fuera) y, si enlaza, se
 * alcanza con el teclado.
 */
export function BarrasConReferencia(props: BarrasConReferenciaProps): React.JSX.Element {
  const {
    pregunta,
    puntos,
    referenciaComun,
    tono = "warning",
    leyenda,
    resumen,
    rotuloResumen,
    variante = "columnas",
    maximo,
    alto = 200,
    unidadExtra,
    extraVacio,
    claseExtra,
    acciones,
    className,
  } = props
  const resueltos = resolver(puntos, props)
  const tope = topeDe(puntos, referenciaComun, maximo)
  const fuera = resueltos.filter((p) => p.esFuera).length

  return (
    <section
      aria-label={pregunta}
      data-slot="barras-con-referencia"
      data-variante={variante}
      className={cn("flex min-w-0 flex-col rounded-lg border bg-card text-card-foreground md:flex-row", className)}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-2 p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <h3 className="m-0 text-[15px] leading-snug font-bold">{pregunta}</h3>
          {acciones ? <div className="flex items-center gap-2">{acciones}</div> : null}
        </div>
        <Leyenda leyenda={leyenda} tono={tono} variante={variante} />
        {/* Lo que no enlaza se lee acá; lo que enlaza se lee en su propio enlace. */}
        <ul className="sr-only">
          {resueltos
            .filter((p) => !p.href)
            .map((p) => (
              <li key={p.clave}>{p.lectura}</li>
            ))}
          <li>
            {fuera === 0 ? `Ningún punto: ${leyenda.fuera.toLowerCase()}.` : `${fuera} de ${resueltos.length}: ${leyenda.fuera.toLowerCase()}.`}
          </li>
        </ul>
        {variante === "filas" ? (
          <Filas puntos={resueltos} tope={tope} tono={tono} />
        ) : (
          <Columnas
            puntos={resueltos}
            tope={tope}
            tono={tono}
            alto={alto}
            unidadExtra={unidadExtra}
            extraVacio={extraVacio}
            claseExtra={claseExtra}
          />
        )}
      </div>
      {resumen && resumen.length ? <ResumenLateral rotulo={rotuloResumen} renglones={resumen} /> : null}
    </section>
  )
}

export interface BulletReferenciaProps {
  /** Qué mide, para el texto accesible: «Efectivo en caja». */
  etiqueta: string
  valor: number | null
  referencia?: number | null
  malo: LadoMalo
  tono?: TonoMalo
  formato: (v: number) => string
  /** Cómo se llama la raya en el texto accesible: «umbral de retiro». */
  nombreRaya?: string
  /** Texto de «fuera»: «pasa el umbral». */
  textoFuera?: string
  fuera?: boolean
  /** Tope del dibujo (p. ej. mínimo × 2,5 en la columna de stock). */
  maximo?: number
  /** 90 px por defecto; `"completo"` ocupa el ancho del bloque (Hoy). */
  ancho?: number | "completo"
  href?: string
  className?: string
}

/**
 * El mini «bullet» de 90 × 10 px: la barra sobre una pista, la raya
 * vertical que sobresale 3 px arriba y abajo. Va dentro de celdas de tabla
 * y de los bloques de Hoy, así que su cifra la pone quien lo usa al lado;
 * acá va sólo el texto accesible y el `title`.
 */
export function BulletReferencia({
  etiqueta,
  valor,
  referencia,
  malo,
  tono = "warning",
  formato,
  nombreRaya = "referencia",
  textoFuera = "del lado malo de la referencia",
  fuera,
  maximo,
  ancho = 90,
  href,
  className,
}: BulletReferenciaProps): React.JSX.Element {
  const esFuera = estaFuera(valor, referencia, malo, fuera)
  const tope = topeDe([{ etiqueta, valor, referencia }], null, maximo)
  const lectura = [
    `${etiqueta}: ${valor === null ? "sin dato" : formato(valor)}`,
    referencia != null ? `${nombreRaya}: ${formato(referencia)}` : null,
    esFuera ? `${flecha(valor, referencia)} ${textoFuera}`.trim() : null,
  ]
    .filter(Boolean)
    .join(" · ")
  const cuerpo = (
    <span
      role="img"
      aria-label={lectura}
      title={lectura}
      data-slot="bullet"
      data-fuera={esFuera ? "" : undefined}
      className={cn("relative inline-block h-2.5 shrink-0 rounded-[2px] bg-muted align-middle", ancho === "completo" && "w-full", className)}
      style={ancho === "completo" ? undefined : { width: ancho }}
    >
      {valor === null ? (
        <span data-hueco="" className="sin-dato absolute inset-0 rounded-[2px]" />
      ) : (
        <span
          data-barra=""
          className={cn("absolute inset-y-0 left-0 rounded-[2px]", esFuera ? COLOR_FUERA[tono].barra : "bg-(--data-1)")}
          style={{ width: `${aPct(valor, tope)}%` }}
        />
      )}
      {referencia != null ? (
        <span
          data-raya=""
          className="absolute -inset-y-[3px] w-[3px] -translate-x-1/2 bg-foreground"
          style={{ left: `${aPct(referencia, tope)}%` }}
        />
      ) : null}
    </span>
  )
  if (!href) return cuerpo
  return (
    <Link to={href} className="inline-flex rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
      {cuerpo}
    </Link>
  )
}
