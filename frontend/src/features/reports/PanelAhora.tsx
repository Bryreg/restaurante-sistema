import { useQuery } from "@tanstack/react-query"
import { ArrowUpRight, ChefHat, ClipboardList, LayoutGrid, Users, Wallet } from "lucide-react"
import { Link } from "react-router-dom"

import { getPanel, type BulletOut, type PanelLight, type PanelOut, type StorePanelOut } from "@/api/panel"
import { getToday, type SeriesOut } from "@/api/reports"
import { useEsCelular } from "@/app/celular"
import { useStoreSelection } from "@/app/storeContext"
import { BulletReferencia } from "@/components/charts"
import { SinDato } from "@/components/SinDato"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { formatClockTime } from "@/lib/businessDate"
import { formatDuracion, formatFechaCorta } from "@/lib/format"
import { formatCOP } from "@/lib/money"
import { cn } from "@/lib/utils"

import { HORARIO_SEMANA_HREF, fichaPersonaHref, fichaTurnoHref } from "./fichas/rutas"
import { SerieMini } from "./hoy/SerieMini"
import { formatDelta, shortDay } from "./lib"

/** El mismo ritmo que Hoy: la portada es lo que pasa ahora. */
const REFRESH_MS = 30_000

/**
 * Las palabras del semáforo (handoff, `AdminHoy`): ● En orden, ▲ Atención,
 * ■ Crítico y el gris «Cerrado». El color nunca es la única señal: va con
 * la forma y con la palabra.
 */
export const LIGHT_WORD: Record<PanelLight, string> = {
  red: "Crítico",
  amber: "Atención",
  green: "En orden",
  gray: "Cerrado",
}

/** El fondo suave de la pastilla de cada luz («Burbujas»). */
const LIGHT_PILL: Record<PanelLight, string> = {
  red: "bg-destructive-soft text-destructive",
  amber: "bg-warning-soft text-warning",
  green: "bg-success-soft text-success",
  gray: "bg-muted text-muted-foreground",
}

/** La forma del semáforo: ● redondo, ▲ triángulo, ■ cuadrado; gris, cuadrado apagado. */
export function Forma({ light, className }: { light: PanelLight; className?: string }): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      data-forma={light}
      className={cn(
        "inline-block size-3 shrink-0",
        light === "green" && "rounded-full bg-success",
        light === "amber" && "bg-warning [clip-path:polygon(50%_0,100%_100%,0_100%)]",
        light === "red" && "rounded-[1px] bg-destructive",
        light === "gray" && "rounded-[2px] bg-input",
        className,
      )}
    />
  )
}

/**
 * La consulta de la portada: con varias sedes, todas; con una, ésa. La
 * comparten el semáforo, los bloques «Ahora» y el riel de Hoy (que saca de
 * acá las salidas olvidadas con su entrada), así que sale una sola petición.
 */
export function usePanelAhora() {
  const { stores, activeStoreId } = useStoreSelection()
  const varias = stores.length > 1
  const query = useQuery({
    queryKey: ["admin-panel", varias ? "all" : activeStoreId],
    queryFn: () => getPanel(varias ? "all" : (activeStoreId as number)),
    enabled: activeStoreId !== null,
    refetchInterval: REFRESH_MS,
  })
  const panel: StorePanelOut | undefined = query.data?.stores.find((p) => p.store_id === activeStoreId)
  return { query, panel, varias, activeStoreId }
}

/**
 * Por qué una sede está como está. Las razones las manda el servidor con
 * la misma gravedad que los avisos de Hoy; una sede en orden no trae
 * ninguna, y ahí se dice lo que sí está bien —sin inventar una cifra—.
 */
function razones(s: StorePanelOut): string[] {
  if (s.reasons.length > 0) return s.reasons.map((r) => r.text)
  if (s.closed) return ["Sin turno ni actividad"]
  const out: string[] = []
  if (s.cash) out.push(`Caja abierta ${formatClockTime(s.cash.opened_at)}`)
  if (s.area_counts.enabled) out.push("Conteos completos")
  return out.length > 0 ? out : ["Nada pendiente"]
}

/**
 * **El semáforo por sede** (handoff, `AdminHoy`): cuatro tarjetas con borde
 * izquierdo de 4 px, la forma y la palabra, y sus razones. Tocar una sede la
 * vuelve la sede activa: el resto de Hoy pasa a hablar de ella. En el
 * celular va en 2 × 2 y cada sede dice una sola razón.
 */
export function Semaforo({
  stores,
  activeStoreId,
  onPick,
  celular = false,
}: {
  stores: StorePanelOut[]
  activeStoreId: number | null
  onPick: (id: number) => void
  celular?: boolean
}): React.JSX.Element {
  // Una fila de tarjetas iguales (captura 08a): con cuatro sedes, cuatro
  // columnas; con una, la tarjeta ocupa la fila entera y sus razones van en
  // renglón, en vez de quedar como una cajita suelta a la izquierda.
  const sola = !celular && stores.length === 1
  return (
    <ul
      aria-label="Todas las sedes ahora"
      className={cn(
        "grid",
        celular ? "grid-cols-2 gap-2" : "gap-3 [grid-template-columns:repeat(auto-fit,minmax(15rem,1fr))]",
      )}
    >
      {stores.map((s) => {
        const activa = s.store_id === activeStoreId
        const lineas = razones(s)
        return (
          <li key={s.store_id} className={cn("min-w-0", celular && stores.length === 1 && "col-span-2")}>
            <button
              type="button"
              onClick={() => onPick(s.store_id)}
              aria-pressed={activa}
              title={`Ver ${s.store_name}`}
              // «Burbujas»: cada sede es una burbuja sin borde; la luz va en una
              // pastilla con su forma y su palabra.
              className={cn(
                "flex h-full w-full flex-col items-start gap-2 rounded-[20px] bg-card text-left",
                "hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                celular ? "min-h-[72px] px-3 py-2.5" : "px-5 py-4",
                // El anillo dice cuál de varias es la activa; con una sola
                // no elige nada y sólo sumaba un marco negro.
                activa && stores.length > 1 && "shadow-[inset_0_0_0_2px_var(--foreground)]",
              )}
            >
              <span className="flex w-full min-w-0 items-center gap-2">
                <b className={cn("min-w-0 truncate font-semibold", celular ? "text-sm" : "text-base")}>{s.store_name}</b>
                <span
                  className={cn(
                    "ml-auto inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs font-semibold",
                    LIGHT_PILL[s.light],
                  )}
                >
                  <Forma light={s.light} className="size-[7px] bg-current" />
                  {LIGHT_WORD[s.light]}
                </span>
              </span>
              <span className={cn("flex min-w-0 flex-col gap-1.5", sola && "sm:flex-row sm:flex-wrap sm:gap-x-6")}>
                {(celular ? lineas.slice(0, 1) : lineas.slice(0, sola ? 3 : 2)).map((r) => (
                  <span
                    key={r}
                    className={cn(
                      "text-muted-foreground",
                      celular ? "line-clamp-2 text-xs leading-snug" : "text-[13px] leading-snug",
                    )}
                  >
                    {r}
                  </span>
                ))}
              </span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}

type Tono = "default" | "warning" | "critical"

/** La pastilla del estado de un bloque: fondo suave y texto del tono. */
const TONO_PASTILLA: Record<Tono, string> = {
  default: "bg-muted text-muted-foreground",
  warning: "bg-warning-soft text-warning",
  critical: "bg-destructive-soft text-destructive",
}

const TONO_TEXTO: Record<Tono, string> = {
  default: "text-muted-foreground",
  warning: "text-warning",
  critical: "text-destructive",
}

/**
 * Un bloque de «Ahora» en burbuja (handoff «Burbujas», Hoy § 4): ícono en su
 * cuadro, título, el estado en pastilla y el botón redondo que lleva a su
 * pantalla; la cifra grande, los gráficos en pozos y el detalle.
 */
function Bloque({
  icon: Icon,
  titulo,
  tono = "default",
  estado,
  cifra,
  cifraNota,
  cifraHref,
  children,
  enlace,
  className,
}: {
  icon: typeof Wallet
  titulo: string
  tono?: Tono
  estado?: string | null
  cifra?: React.ReactNode
  cifraNota?: React.ReactNode
  cifraHref?: string
  children?: React.ReactNode
  enlace?: { to: string; label: string }
  className?: string
}): React.JSX.Element {
  const cifraNodo =
    cifra !== undefined ? (
      <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="text-[30px] leading-[1.1] font-medium tracking-[-0.03em] tabular-nums">{cifra}</span>
        {cifraNota ? <span className="text-sm text-muted-foreground">{cifraNota}</span> : null}
      </span>
    ) : null
  return (
    <section
      aria-label={titulo}
      data-tono={tono}
      className={cn("burbuja flex min-w-0 flex-col gap-3 rounded-[24px] bg-card p-6", className)}
    >
      <h3 className="flex items-center gap-3 text-[15px] font-semibold">
        <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-muted">
          <Icon className="size-[18px]" aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1 truncate">{titulo}</span>
        {estado ? (
          <span className={cn("inline-flex h-[26px] shrink-0 items-center rounded-full px-2.5 text-xs font-semibold", TONO_PASTILLA[tono])}>
            {estado}
          </span>
        ) : null}
        {enlace ? (
          <Link
            to={enlace.to}
            title={enlace.label}
            className="grid size-8 shrink-0 place-items-center rounded-full bg-muted text-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            <ArrowUpRight className="size-4" aria-hidden="true" />
            <span className="sr-only">{enlace.label} →</span>
          </Link>
        ) : null}
      </h3>
      {cifraNodo && cifraHref ? (
        <Link to={cifraHref} className="min-w-0 rounded-sm text-foreground no-underline hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
          {cifraNodo}
        </Link>
      ) : (
        cifraNodo
      )}
      {children}
    </section>
  )
}

/** Un bullet de un bloque: el rótulo y la cifra arriba, la barra con su raya, y qué es la raya. */
function RenglonBullet({
  etiqueta,
  cifra,
  fuera,
  tono = "warning",
  children,
  pie,
}: {
  etiqueta: React.ReactNode
  cifra: string
  fuera: boolean
  tono?: "warning" | "destructive"
  children: React.ReactNode
  pie?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1.5 rounded-2xl bg-muted px-4 py-3.5">
      <span className="flex justify-between gap-2 text-xs">
        <span className="min-w-0 truncate text-muted-foreground">{etiqueta}</span>
        <b className={cn("shrink-0 tabular-nums", fuera ? (tono === "destructive" ? "text-destructive" : "text-warning") : "text-foreground")}>
          {cifra}
        </b>
      </span>
      {children}
      {pie ? <span className="text-[11px] leading-snug text-muted-foreground">{pie}</span> : null}
    </div>
  )
}

/** Tope del dibujo de un bullet: el mayor entre dato y raya, con aire. Es dibujo, no una cifra. */
function topeBullet(b: BulletOut): number | undefined {
  const mayor = Math.max(b.value ?? 0, b.reference ?? 0)
  return mayor > 0 ? mayor * 1.14 : undefined
}

/** «sáb 20», el día de la raya de ventas. */
function diaDe(iso: string | null | undefined): string {
  return iso ? shortDay(formatFechaCorta(iso)) : "la semana pasada"
}

function estadoCaja(panel: StorePanelOut): { tono: Tono; estado: string | null } {
  const cash = panel.cash
  if (!cash) return panel.closed ? { tono: "default", estado: "Cerrado" } : { tono: "critical", estado: "■ Sin turno abierto" }
  if (cash.is_stale) return { tono: "critical", estado: "■ Turno abandonado" }
  if (!cash.responsible.active) return { tono: "warning", estado: "▲ Responsable inactivo" }
  if (cash.cash_over_threshold) return { tono: "warning", estado: "▲ Retiro sugerido" }
  return { tono: "default", estado: null }
}

function Caja({ panel, orders }: { panel: StorePanelOut; orders: number | undefined }): React.JSX.Element {
  const cash = panel.cash
  const b = panel.bullets ?? null
  const { tono, estado } = estadoCaja(panel)
  const reserva =
    panel.pending.reserve_loans_open > 0 ? (
      <p className="text-[13px] font-semibold text-warning">
        ▲ {panel.pending.reserve_loans_open} préstamo{panel.pending.reserve_loans_open === 1 ? "" : "s"} de la base sin
        devolver
        {panel.pending.reserve_loans_total !== null ? ` · ${formatCOP(panel.pending.reserve_loans_total)}` : ""}.
      </p>
    ) : null
  const sales = b?.sales ?? null
  const delta = sales ? formatDelta(sales.delta_bp) : null
  return (
    <Bloque
      icon={Wallet}
      titulo="Caja"
      tono={tono}
      estado={estado}
      className="sm:col-span-2"
      cifra={sales?.value != null ? formatCOP(sales.value) : undefined}
      cifraNota={orders !== undefined ? `ventas netas · ${orders} ${orders === 1 ? "comanda" : "comandas"}` : "ventas netas"}
      cifraHref="/admin/ventas"
      enlace={cash ? { to: fichaTurnoHref(cash.shift_id), label: "Ficha del turno" } : { to: "/admin/dinero", label: "Dinero" }}
    >
      {sales ? (
        <div className="flex flex-col gap-2 md:flex-row">
          {sales.value === 0 && (sales.reference ?? 0) === 0 ? (
            // Nada vendido y nada contra qué comparar: una barra vacía con la
            // raya pegada al borde no dice nada; se dice en una línea.
            <p className="text-[13px] text-muted-foreground">
              {sales.reference === 0
                ? `Todavía no hay ventas hoy; el ${diaDe(b?.reference_business_date)} a esta hora tampoco había.`
                : "Todavía no hay ventas hoy."}
            </p>
          ) : (
          <RenglonBullet
            etiqueta="Ventas netas hoy"
            cifra={sales.value != null ? formatCOP(sales.value) : "—"}
            fuera={sales.outside}
            pie={
              sales.reference != null
                ? `Raya: ${diaDe(b?.reference_business_date)} a esta hora, ${formatCOP(sales.reference)}${delta ? ` · ${delta}` : ""}`
                : `Sin raya: ${sales.reason ?? "no hay contra qué comparar."}`
            }
          >
            <BulletReferencia
              etiqueta="Ventas netas hoy"
              valor={sales.value}
              referencia={sales.reference}
              malo="debajo"
              fuera={sales.outside}
              formato={formatCOP}
              nombreRaya={`${diaDe(b?.reference_business_date)} a esta hora`}
              textoFuera="debajo de la semana pasada"
              maximo={topeBullet(sales)}
              ancho="completo"
              className="h-3.5 rounded-[3px]"
            />
          </RenglonBullet>
          )}
          {b?.cash ? (
            <RenglonBullet
              etiqueta="Efectivo en caja"
              cifra={b.cash.value != null ? formatCOP(b.cash.value) : "—"}
              fuera={b.cash.outside}
              pie={
                b.cash.reference != null
                  ? `Raya: umbral de retiro ${formatCOP(b.cash.reference)}${b.cash.over_by != null ? ` · lo pasa por ${formatCOP(b.cash.over_by)}` : ""}`
                  : undefined
              }
            >
              <BulletReferencia
                etiqueta="Efectivo en caja"
                valor={b.cash.value}
                referencia={b.cash.reference}
                malo="encima"
                fuera={b.cash.outside}
                formato={formatCOP}
                nombreRaya="umbral de retiro"
                textoFuera="pasa el umbral de retiro"
                maximo={topeBullet(b.cash)}
                ancho="completo"
                className="h-3.5 rounded-[3px]"
              />
            </RenglonBullet>
          ) : null}
        </div>
      ) : null}
      {cash ? (
        <p className="text-sm text-muted-foreground">
          {cash.is_stale ? (
            <b className="text-destructive">Turno abandonado del {formatFechaCorta(cash.business_date)}</b>
          ) : (
            `Abierta ${formatClockTime(cash.opened_at)}`
          )}
          {" · responsable "}
          <Link to={fichaPersonaHref(cash.responsible.id)} className="font-medium text-primary hover:underline">
            {cash.responsible.name}
          </Link>{" "}
          {!cash.responsible.active ? <Badge variant="destructive">inactivo</Badge> : null}
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">
          {panel.closed ? "Sin turno ni actividad: la sede no está operando." : "Hay actividad y no hay turno: no se puede cobrar."}
        </p>
      )}
      {reserva}
    </Bloque>
  )
}

function serieOk(s: SeriesOut | undefined | null): s is SeriesOut {
  return !!s && s.available && s.points.length > 0
}

/** «Ana, Luis y 3 más»: los nombres sin repetir, hasta tres. */
function nombresCortos(nombres: string[]): string {
  const unicos = [...new Set(nombres)]
  const vistos = unicos.slice(0, 3)
  const resto = unicos.length - vistos.length
  return resto > 0 ? `${vistos.join(", ")} y ${resto} más` : vistos.join(", ")
}

function QuienTrabaja({ panel }: { panel: StorePanelOut }): React.JSX.Element {
  const { present, pending_review, reason } = panel.staff
  const serie = panel.bullets?.staff_by_hour
  const tono: Tono = pending_review.length > 0 ? "warning" : "default"
  return (
    <Bloque
      icon={Users}
      titulo="Quién trabaja"
      tono={tono}
      estado={
        pending_review.length > 0
          ? `▲ ${pending_review.length} salida${pending_review.length === 1 ? "" : "s"} olvidada${pending_review.length === 1 ? "" : "s"}`
          : null
      }
      cifra={String(present.length)}
      cifraNota={present.length === 1 ? "persona con entrada" : "con entrada hoy"}
      enlace={{ to: HORARIO_SEMANA_HREF, label: "Asistencia" }}
    >
      {serieOk(serie) && serie.points.some((p) => (p.value ?? 0) > 0) ? (
        <div className="flex flex-col gap-1.5 rounded-2xl bg-muted px-4 py-3.5">
          <span className="text-xs text-muted-foreground">Personas en turno por hora · lo claro es lo que viene</span>
          <SerieMini
            puntos={serie.points}
            alto={64}
            etiquetas="tres"
            formato={(v) => `${v} ${v === 1 ? "persona" : "personas"}`}
            resumen={`Personas en turno por hora, de ${serie.points[0]!.label} a ${serie.points[serie.points.length - 1]!.label}. Lo que viene sale más claro: ${serie.reason ?? "es una proyección"}`}
          />
        </div>
      ) : null}
      {present.length === 0 ? (
        // Nadie con entrada es un hecho (0 personas), no un dato que falte:
        // se dice en una línea, sin trama ni gráfico vacío.
        <p className="text-[13px] text-muted-foreground">{reason ?? "Nadie marcó entrada hoy."}</p>
      ) : (
        <ul className="flex flex-wrap gap-x-2 gap-y-0.5 text-[13px]">
          {present.map((p) => (
            <li key={p.employee_id}>
              <Link to={fichaPersonaHref(p.employee_id)} className="text-primary hover:underline">
                {p.name}
              </Link>
              {p.on_pause ? <span className="text-xs text-muted-foreground"> (en pausa)</span> : null}
              {!p.active ? <span className="text-xs text-destructive"> (inactivo)</span> : null}
            </li>
          ))}
        </ul>
      )}
      {pending_review.length > 0 ? (
        <p
          className="text-[13px] font-semibold text-warning"
          title="Entradas que quedaron abiertas en un día que ya pasó: no suman horas hasta corregirlas."
        >
          {pending_review.length} salida{pending_review.length === 1 ? "" : "s"} olvidada
          {pending_review.length === 1 ? "" : "s"} a revisar: {nombresCortos(pending_review.map((p) => p.name))}.
        </p>
      ) : null}
    </Bloque>
  )
}

function Conteos({ panel }: { panel: StorePanelOut }): React.JSX.Element {
  const a = panel.area_counts
  if (!a.enabled) {
    return (
      <Bloque icon={ClipboardList} titulo="Conteos de apertura">
        <SinDato motivo="El conteo corto por área está apagado en esta sede." forma="bloque" />
      </Bloque>
    )
  }
  // Mismo criterio que el aviso de Hoy y que la razón del semáforo: un área
  // con la apertura obligatoria sin hacer es crítica (no bloquea nada, pero
  // sin apertura no hay faltante que medir).
  if (a.areas_total === 0) {
    return (
      <Bloque icon={ClipboardList} titulo="Conteos de apertura" enlace={{ to: "/admin/inventario?tab=por-area", label: "Conteos" }}>
        <SinDato motivo="La sede todavía no tiene áreas de conteo." forma="bloque" />
      </Bloque>
    )
  }
  const tono: Tono = a.opening_missing > 0 ? "critical" : a.flagged > 0 ? "warning" : "default"
  const estado =
    a.opening_missing > 0
      ? `■ ${a.opening_missing} área${a.opening_missing === 1 ? "" : "s"} sin apertura`
      : a.flagged > 0
        ? `▲ ${a.flagged} faltante${a.flagged === 1 ? "" : "s"}`
        : null
  const areas = panel.bullets?.area_progress ?? []
  return (
    <Bloque
      icon={ClipboardList}
      titulo="Conteos de apertura"
      tono={tono}
      estado={estado}
      cifra={`${a.opening_done} de ${a.areas_total}`}
      cifraNota="áreas con apertura"
      enlace={{ to: "/admin/inventario?tab=por-area", label: "Conteos" }}
    >
      {areas.length > 0 ? (
        <div className="flex flex-col gap-2">
          {areas.map((ar) => (
            <RenglonBullet
              key={ar.area_id}
              etiqueta={ar.area_name}
              cifra={ar.counted != null && ar.total != null ? `${ar.counted} de ${ar.total}` : "Sin dato"}
              fuera={ar.behind}
            >
              <BulletReferencia
                etiqueta={`Conteo de apertura de ${ar.area_name}`}
                valor={ar.counted}
                malo="debajo"
                fuera={ar.behind}
                formato={(v) => `${v} artículos`}
                textoFuera="va atrasado"
                maximo={ar.total ?? undefined}
                ancho="completo"
                className="h-3.5 rounded-[3px]"
              />
            </RenglonBullet>
          ))}
        </div>
      ) : null}
      <p className="text-[13px] text-muted-foreground">
        Cierre {a.closing_done} de {a.areas_total}.{" "}
        {a.flagged > 0 ? `${a.flagged} faltante${a.flagged === 1 ? "" : "s"} sobre el umbral. ` : "Sin faltantes sobre el umbral. "}
        {a.pending_recounts > 0 ? `${a.pending_recounts} recuento${a.pending_recounts === 1 ? "" : "s"} por responder.` : ""}
      </p>
    </Bloque>
  )
}

/** Un tiquete con más de un día abierto no es «lento»: es de otro día. */
const MINUTOS_DIA = 24 * 60

/** «1 hora», «90 min»: el rótulo de la raya de minutos. */
function rotuloMinutos(min: number | null | undefined): string | undefined {
  if (min == null) return undefined
  return min === 60 ? "1 hora" : formatDuracion(min)
}

function Salon({ panel }: { panel: StorePanelOut }): React.JSX.Element {
  const s = panel.salon
  const serie = panel.bullets?.tables
  const tono: Tono = s.unsent > 0 ? "critical" : s.unpaid > 0 ? "warning" : "default"
  const estado = s.unsent > 0 ? `■ ${s.unsent} sin enviar` : s.unpaid > 0 ? `▲ ${s.unpaid} sin cobrar` : null
  return (
    <Bloque
      icon={LayoutGrid}
      titulo="Salón"
      tono={tono}
      estado={estado}
      cifra={s.tables_total > 0 ? String(s.tables_occupied) : String(s.open_orders)}
      cifraNota={
        s.tables_total > 0
          ? `mesas abiertas de ${s.tables_total} · ${s.open_orders} comanda${s.open_orders === 1 ? "" : "s"}`
          : `comanda${s.open_orders === 1 ? "" : "s"} abierta${s.open_orders === 1 ? "" : "s"}`
      }
      enlace={{ to: "/admin/pedidos", label: "Pedidos abiertos" }}
    >
      {serieOk(serie) ? (
        <div className="flex flex-col gap-1.5 rounded-2xl bg-muted px-4 py-3.5">
          <span className="text-xs text-muted-foreground">Minutos que lleva cada mesa abierta</span>
          <SerieMini
            puntos={serie.points}
            referencia={serie.reference}
            rotuloReferencia={rotuloMinutos(serie.reference)}
            alto={64}
            etiquetas="todas"
            formato={formatDuracion}
            resumen={`Minutos de cada mesa abierta contra ${rotuloMinutos(serie.reference) ?? "la mesa larga"}: ${serie.points.filter((p) => p.outside).length} la pasan.`}
          />
        </div>
      ) : null}
      {s.unsent > 0 || s.unpaid > 0 ? (
        <p className={cn("text-[13px] font-semibold", s.unsent > 0 ? "text-destructive" : "text-warning")}>
          {s.unsent} sin enviar · {s.unpaid} sin cobrar
        </p>
      ) : (
        <p className="text-[13px] text-muted-foreground">Ninguna atascada.</p>
      )}
    </Bloque>
  )
}

function Cocina({ panel }: { panel: StorePanelOut }): React.JSX.Element {
  const k = panel.kitchen
  if (!k.enabled) {
    return (
      <Bloque icon={ChefHat} titulo="Cocina">
        <SinDato motivo="La pantalla de cocina está apagada en esta sede." forma="bloque" />
      </Bloque>
    )
  }
  const serie = panel.bullets?.tickets
  return (
    <Bloque
      icon={ChefHat}
      titulo="Cocina"
      tono={k.late > 0 ? "critical" : "default"}
      estado={k.late > 0 ? `■ ${k.late} plato${k.late === 1 ? "" : "s"} atrasado${k.late === 1 ? "" : "s"}` : null}
      cifra={String(k.in_kitchen)}
      cifraNota="en preparación"
      enlace={{ to: "/admin/pedidos", label: "Tiquetes" }}
    >
      {serieOk(serie) ? (
        <div className="flex flex-col gap-1.5 rounded-2xl bg-muted px-4 py-3.5">
          <span className="text-xs text-muted-foreground">Minutos de cada tiquete</span>
          <SerieMini
            puntos={serie.points}
            referencia={serie.reference}
            rotuloReferencia={serie.reference != null ? `${serie.reference} min` : undefined}
            tono="destructive"
            alto={64}
            etiquetas="todas"
            formato={formatDuracion}
            resumen={`Minutos de cada tiquete contra ${serie.reference ?? "el límite"} min: ${serie.points.filter((p) => p.outside).length} lo pasan.`}
          />
        </div>
      ) : null}
      <p className="text-[13px] text-muted-foreground">
        {k.oldest_late_minutes === null
          ? "Nada atrasado."
          : k.oldest_late_minutes >= MINUTOS_DIA
            ? "El más viejo es de otro día: revisalo en Pedidos, no es de este servicio."
            : `El más viejo lleva ${formatDuracion(k.oldest_late_minutes)}.`}
      </p>
    </Bloque>
  )
}

/**
 * **«Ahora» en la sede activa**, variante A del handoff (`AdminHoy`): cinco
 * bloques en dos columnas —Caja ocupa las dos— con barra + raya: las ventas
 * contra el mismo día de la semana pasada a esta hora y el efectivo contra
 * el umbral de retiro; las personas por hora, con lo que viene al 35 %; el
 * avance de cada conteo; los minutos de cada mesa contra la mesa larga y los
 * de cada tiquete contra el tiquete demorado (en rojo si se pasa).
 *
 * Todo sale de `GET /admin/panel` (y las comandas pagadas, de `GET
 * /admin/today`, la misma consulta de Hoy): las mismas funciones de Hoy,
 * Dinero y el KDS, así que no puede decir un número distinto que ellas.
 */
export function AhoraBloques({ data }: { data: PanelOut | undefined }): React.JSX.Element | null {
  const { activeStoreId } = useStoreSelection()
  const celular = useEsCelular()
  const today = useQuery({
    queryKey: ["admin-today", activeStoreId],
    queryFn: () => getToday(activeStoreId as number),
    enabled: activeStoreId !== null,
    refetchInterval: REFRESH_MS,
  })
  if (!data) return null
  const panel = data.stores.find((p) => p.store_id === activeStoreId)
  if (!panel) {
    return (
      <h2 id="ahora-titulo" className="text-sm text-muted-foreground">
        Ahora: la sede elegida está inactiva y no entra en el semáforo.
      </h2>
    )
  }
  const orders = today.data?.orders
  if (celular) return <AhoraCelular panel={panel} orders={orders} />
  return (
    <section aria-labelledby="ahora-titulo" className="flex min-w-0 flex-col gap-3">
      <h2 id="ahora-titulo" className="sr-only">
        Ahora en {panel.store_name} · {formatClockTime(data.generated_at)}
      </h2>
      <div className="grid gap-3 sm:grid-cols-2">
        <Caja panel={panel} orders={orders} />
        <QuienTrabaja panel={panel} />
        <Conteos panel={panel} />
        <Salon panel={panel} />
        <Cocina panel={panel} />
      </div>
    </section>
  )
}

/** Un bloque compacto del celular (handoff, `AdminMovil`): título, la cifra y el estado. */
function BloqueCorto({
  icon: Icon,
  titulo,
  cifra,
  tono,
  estado,
  to,
  className,
}: {
  icon: typeof Wallet
  titulo: string
  cifra: string
  tono: Tono
  estado: string | null
  to: string
  className?: string
}): React.JSX.Element {
  return (
    <Link
      to={to}
      className={cn(
        "flex min-h-[84px] min-w-0 flex-col gap-0.5 rounded-[20px] bg-card px-4 py-3 text-foreground no-underline",
        "focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
        className,
      )}
    >
      <span className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
        <Icon className="size-4 shrink-0" aria-hidden="true" />
        {titulo}
      </span>
      <b className="truncate text-xl leading-tight tabular-nums">{cifra}</b>
      {estado ? <span className={cn("text-xs font-bold", TONO_TEXTO[tono])}>{estado}</span> : null}
    </Link>
  )
}

/**
 * «Ahora» en el celular (handoff, `AdminMovil` · captura 13a): la venta de
 * hoy con su comparación y los cinco bloques en corto —Caja a lo ancho, los
 * otros de a dos—. Cada bloque lleva a su pantalla.
 */
function AhoraCelular({ panel, orders }: { panel: StorePanelOut; orders: number | undefined }): React.JSX.Element {
  const sales = panel.bullets?.sales ?? null
  const ref = panel.bullets?.reference_business_date
  const delta = sales ? formatDelta(sales.delta_bp) : null
  const caja = estadoCaja(panel)
  const s = panel.salon
  const k = panel.kitchen
  const a = panel.area_counts
  return (
    <section aria-labelledby="ahora-titulo" className="flex min-w-0 flex-col gap-2">
      <h2 id="ahora-titulo" className="sr-only">
        Ahora en {panel.store_name}
      </h2>
      <Link
        to="/admin/ventas"
        className="flex flex-col gap-1 rounded-[24px] bg-card px-5 py-4 text-foreground no-underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <span className="text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
          Ventas netas de hoy · {panel.store_name}
        </span>
        <b className="text-[34px] leading-none font-medium tracking-[-0.03em] tabular-nums">
          {sales?.value != null ? formatCOP(sales.value) : <span className="text-muted-foreground">—</span>}
        </b>
        <span className="text-xs text-muted-foreground">
          {[
            orders !== undefined ? `${orders} ${orders === 1 ? "comanda" : "comandas"}` : null,
            sales?.reference != null ? `${diaDe(ref)} a esta hora: ${formatCOP(sales.reference)}` : sales?.reason ?? null,
            delta,
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </Link>
      <div className="grid grid-cols-2 gap-2">
        <BloqueCorto
          icon={Wallet}
          titulo="Caja"
          className="col-span-2"
          cifra={panel.cash ? `Abierta · ${panel.cash.responsible.name.split(" ")[0]}` : panel.closed ? "Cerrada" : "Sin turno"}
          tono={caja.tono}
          estado={caja.estado}
          to={panel.cash ? fichaTurnoHref(panel.cash.shift_id) : "/admin/dinero"}
        />
        <BloqueCorto
          icon={Users}
          titulo="Quién trabaja"
          cifra={String(panel.staff.present.length)}
          tono={panel.staff.pending_review.length > 0 ? "warning" : "default"}
          estado={panel.staff.pending_review.length > 0 ? `▲ ${panel.staff.pending_review.length} sin salida` : null}
          to={HORARIO_SEMANA_HREF}
        />
        <BloqueCorto
          icon={ClipboardList}
          titulo="Conteos"
          cifra={!a.enabled ? "Apagado" : a.areas_total === 0 ? "Sin áreas" : `${a.opening_done} de ${a.areas_total}`}
          tono={!a.enabled ? "default" : a.opening_missing > 0 ? "critical" : a.flagged > 0 ? "warning" : "default"}
          estado={a.enabled && a.opening_missing > 0 ? `■ ${a.opening_missing} sin apertura` : null}
          to="/admin/inventario?tab=por-area"
        />
        <BloqueCorto
          icon={LayoutGrid}
          titulo="Salón"
          cifra={s.tables_total > 0 ? `${s.tables_occupied} mesas` : `${s.open_orders} comandas`}
          tono={s.unsent > 0 ? "critical" : s.unpaid > 0 ? "warning" : "default"}
          estado={s.unsent > 0 ? `■ ${s.unsent} sin enviar` : s.unpaid > 0 ? `▲ ${s.unpaid} sin cobrar` : null}
          to="/admin/pedidos"
        />
        <BloqueCorto
          icon={ChefHat}
          titulo="Cocina"
          cifra={k.enabled ? `${k.in_kitchen} en cocina` : "Apagada"}
          tono={k.enabled && k.late > 0 ? "critical" : "default"}
          estado={k.enabled && k.late > 0 ? `■ ${k.late} atrasados` : null}
          to="/admin/pedidos"
        />
      </div>
    </section>
  )
}

/**
 * El semáforo de todas las sedes con lo que sirve para pintarlo: se dibuja
 * con varias sedes y también con una (una tarjeta que dice cómo está la
 * única sede). Mientras carga, el esqueleto; si falla, lo dice y no tapa
 * el resto de Hoy.
 */
export function SemaforoSedes(): React.JSX.Element | null {
  const { query, activeStoreId } = usePanelAhora()
  const { setActiveStoreId } = useStoreSelection()
  const celular = useEsCelular()
  if (activeStoreId === null) return null
  if (query.isLoading) return <Skeleton aria-label="Cargando las sedes" className="h-[5.5rem] w-full rounded-[20px]" />
  if (query.isError || !query.data) {
    // Hoy sigue funcionando sin la portada: el error se dice y no tapa lo demás.
    return (
      <p role="status" className="rounded-lg border border-dashed px-3 py-2 text-sm text-muted-foreground">
        No se pudo leer «Ahora» ({query.error instanceof Error ? query.error.message : "sin respuesta"}). El resto de
        Hoy sigue al día.
      </p>
    )
  }
  return (
    <Semaforo stores={query.data.stores} activeStoreId={activeStoreId} onPick={setActiveStoreId} celular={celular} />
  )
}

/** Los bloques «Ahora» de la sede activa, con su esqueleto mientras carga. */
export function AhoraSede(): React.JSX.Element | null {
  const { query, activeStoreId } = usePanelAhora()
  if (activeStoreId === null) return null
  if (query.isLoading) return <Skeleton aria-label="Cargando lo que pasa ahora" className="h-[28rem] w-full rounded-[24px]" />
  if (query.isError) return null
  return <AhoraBloques data={query.data} />
}

/**
 * **La portada: qué está pasando ahora.** El semáforo de las sedes y,
 * de la sede activa, los cinco bloques. Hoy los pone por separado (el
 * semáforo a todo el ancho, los bloques en la columna izquierda); juntos
 * sirven donde no hay riel.
 */
export function PanelAhora(): React.JSX.Element | null {
  return (
    <div className="flex flex-col gap-4">
      <SemaforoSedes />
      <AhoraSede />
    </div>
  )
}

export default PanelAhora
