import { useQuery } from "@tanstack/react-query"
import { ChevronRight } from "lucide-react"
import { useState } from "react"
import { Link, Navigate } from "react-router-dom"

import { getPanelSection, type SectionCardOut, type SectionKey, type SectionRowOut, type SectionTone } from "@/api/panel"
import type { SeriesUnit } from "@/api/reports"
import { useEsCelular } from "@/app/celular"
import { useStoreSelection } from "@/app/storeContext"
import { EmptyState } from "@/components/EmptyState"
import { SinDato } from "@/components/SinDato"
import { Skeleton } from "@/components/ui/skeleton"
import { formatBusinessDate, formatClockTime } from "@/lib/businessDate"
import { errorMessage } from "@/lib/errors"
import { formatDuracion, formatPct } from "@/lib/format"
import { formatCOP } from "@/lib/money"
import { cn } from "@/lib/utils"

import { SerieMini } from "../hoy/SerieMini"
import { businessDateOfInstant } from "../lib"

const REFRESH_MS = 30_000

/** El título de cada sección y a qué pantalla del escritorio manda fuera del celular. */
const SECCION: Record<SectionKey, { titulo: string; escritorio: string }> = {
  caja: { titulo: "Caja", escritorio: "/admin/dinero" },
  equipo: { titulo: "Equipo", escritorio: "/admin/personal" },
  informes: { titulo: "Informes", escritorio: "/admin/informes" },
}

/**
 * Lo que la pantalla pone alrededor de cada tarjeta: el rótulo corto, la
 * pregunta que contesta y la acción que la resuelve. Las cifras, el estado
 * y la serie vienen hechos del servidor (`GET /admin/panel/sections`).
 */
interface TarjetaConfig {
  corto: string
  pregunta: string
  accion: string
  href: string
  leyenda?: { barra: string; raya: string }
}

const TARJETAS: Record<string, TarjetaConfig> = {
  // Caja
  closes: { corto: "Cuadre de ayer", pregunta: "¿Cuadraron los turnos de ayer?", accion: "Ver turnos de ayer", href: "/admin/dinero?tab=historial" },
  deposits: {
    corto: "Consignaciones",
    pregunta: "¿Qué consignaciones faltan por confirmar?",
    accion: "Confirmar con la foto",
    href: "/admin/hoy#requiere-atencion",
  },
  pickups: { corto: "Retiros hoy", pregunta: "¿Cuánto salió en retiros hoy?", accion: "Ver retiros", href: "/admin/dinero" },
  expenses: { corto: "Gastos de caja", pregunta: "¿Cuánto se gastó de la caja hoy?", accion: "Ver gastos", href: "/admin/dinero" },
  // Equipo
  staff: { corto: "En turno ahora", pregunta: "¿Quién trabaja hoy?", accion: "Ver asistencia de hoy", href: "/admin/nomina?tab=horas" },
  late: { corto: "Llegadas tarde", pregunta: "¿Quién llegó tarde hoy?", accion: "Ver asistencia", href: "/admin/nomina?tab=horas" },
  exits: {
    corto: "Salidas olvidadas",
    pregunta: "¿Quién no marcó salida?",
    accion: "Marcar salida con motivo",
    href: "/admin/hoy#requiere-atencion",
  },
  hours: { corto: "Horas de la semana", pregunta: "¿Cómo van las horas de la semana?", accion: "Ver horas por persona", href: "/admin/nomina?tab=horas" },
  // Informes
  sales: {
    corto: "Ventas hoy",
    pregunta: "¿Vendo más o menos que la semana pasada?",
    accion: "Ver el día completo",
    href: "/admin/ventas",
    leyenda: { barra: "Hoy", raya: "Raya: la semana pasada a la misma hora" },
  },
  best_store: { corto: "Mejor sede", pregunta: "¿Qué sede va mejor hoy?", accion: "Comparar sedes", href: "/admin/informes" },
  load: {
    corto: "Carga por persona",
    pregunta: "¿A qué horas necesito más gente?",
    accion: "Ver horas pico de la semana",
    href: "/admin/informes",
    leyenda: { barra: "Comandas de salón", raya: "Raya: lo que alcanzan los meseros" },
  },
  orders: { corto: "Comandas hoy", pregunta: "¿Cuántas comandas llevamos?", accion: "Ver ventas", href: "/admin/ventas" },
}

const TONO_TEXTO: Record<SectionTone, string> = {
  ok: "text-success",
  warning: "text-warning",
  critical: "text-destructive",
  muted: "text-muted-foreground",
}

const TONO_FONDO: Record<SectionTone, string> = {
  ok: "bg-success",
  warning: "bg-warning",
  critical: "bg-destructive",
  muted: "bg-input",
}

const TONO_BORDE_ARRIBA: Record<SectionTone, string> = {
  ok: "border-t-success",
  warning: "border-t-warning",
  critical: "border-t-destructive",
  muted: "border-t-input",
}

/** La forma del estado: ● en orden, ▲ atención, ■ crítico; gris, apagado. El texto va al lado. */
function Forma({ tono }: { tono: SectionTone }): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-block size-2 shrink-0",
        TONO_FONDO[tono],
        tono === "ok" && "rounded-full",
        tono === "warning" && "[clip-path:polygon(50%_0,100%_100%,0_100%)]",
        tono === "critical" && "rounded-[1px]",
        tono === "muted" && "rounded-[2px]",
      )}
    />
  )
}

/** Escribe un valor en su unidad. Sólo formato: el número llega del servidor. */
function formatoDe(unit: SeriesUnit, conSigno = false): (v: number) => string {
  switch (unit) {
    case "cop":
      return (v) => (conSigno && v !== 0 ? `${v < 0 ? "▼ −" : "▲ +"}${formatCOP(Math.abs(v))}` : formatCOP(v))
    case "minutes":
      return (v) => formatDuracion(v)
    case "bp":
      return (v) => (v === 0 ? formatPct(0) : `${v < 0 ? "▼ −" : "▲ +"}${formatPct(Math.abs(v))}`)
    default:
      return (v) => new Intl.NumberFormat("es-CO").format(v)
  }
}

/** La cifra grande de una tarjeta: «2 de 4», «$ 1.240.000», «Usaquén». */
function cifraDe(card: SectionCardOut): string | null {
  if (!card.available) return null
  if (card.value_text) return card.value_text
  if (card.value === null) return null
  if (card.of !== null) return `${card.value} de ${card.of}`
  return formatoDe(card.unit)(card.value)
}

function valorDeRenglon(r: SectionRowOut, diverge: boolean): { cifra: string | null; nota: string | null } {
  if (r.value === null) return { cifra: null, nota: r.note }
  if (r.note && r.value === 0) return { cifra: null, nota: r.note }
  return { cifra: formatoDe(r.unit, diverge)(r.value), nota: r.note }
}

function Tarjeta({
  card,
  elegida,
  onElegir,
}: {
  card: SectionCardOut
  elegida: boolean
  onElegir: () => void
}): React.JSX.Element {
  const cfg = TARJETAS[card.key]
  const cifra = cifraDe(card)
  const diverge = card.chart === "diverging"
  return (
    <button
      type="button"
      onClick={onElegir}
      aria-pressed={elegida}
      className={cn(
        "flex min-h-[112px] min-w-0 flex-col gap-[3px] rounded-[10px] bg-card p-2.5 text-left text-foreground",
        "focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
        elegida ? "border-2 border-foreground" : "border border-border",
      )}
    >
      <span className="text-xs text-muted-foreground">{cfg?.corto ?? card.key}</span>
      {cifra !== null ? (
        <b className="truncate text-[22px] leading-[1.1] font-bold tabular-nums">{cifra}</b>
      ) : (
        // `null` no es 0: la raya larga apagada, del tamaño de una cifra (la
        // tarjeta rayada entera se veía rota). El lector de pantalla oye «Sin dato».
        <b className="sin-dato sin-dato--calmo text-[22px] leading-[1.1] font-bold">
          <span aria-hidden="true">—</span>
          <span className="sr-only">Sin dato</span>
        </b>
      )}
      <span className={cn("flex items-start gap-1 text-[11px] leading-snug font-bold", TONO_TEXTO[card.tone])}>
        <span className="mt-[3px]">
          <Forma tono={card.tone} />
        </span>
        <span className="line-clamp-2">{card.available ? card.status : card.reason}</span>
      </span>
      {card.available && card.series.points.some((p) => p.value !== null) ? (
        <SerieMini
          className="mt-auto w-full"
          mini
          puntos={card.series.points}
          divergente={diverge}
          alto={26}
          formato={formatoDe(card.series.unit)}
          resumen={`Tendencia de ${cfg?.corto ?? card.key}`}
        />
      ) : null}
    </button>
  )
}

function Detalle({ card }: { card: SectionCardOut }): React.JSX.Element {
  const cfg = TARJETAS[card.key]
  const cifra = cifraDe(card)
  const serie = card.series
  const diverge = card.chart === "diverging"
  const formato = formatoDe(serie.unit)
  const conPuntos = card.available && serie.points.length > 0
  // Todo `null` o todo 0: un eje de marcas vacías no dice nada; va una línea.
  const serieVacia = conPuntos && serie.points.every((p) => !p.value)
  return (
    <section
      aria-labelledby={`detalle-${card.key}`}
      className={cn("flex flex-col gap-2.5 rounded-[10px] border border-t-[3px] bg-card p-3.5", TONO_BORDE_ARRIBA[card.tone])}
    >
      <h2 id={`detalle-${card.key}`} className="text-base leading-snug font-bold">
        {cfg?.pregunta ?? card.key}
      </h2>
      {card.available ? (
        <div className="flex flex-col gap-0.5">
          {cifra !== null ? (
            <b className="text-[32px] leading-none font-extrabold tracking-tight tabular-nums">{cifra}</b>
          ) : (
            <SinDato motivo={card.reason} forma="linea" />
          )}
          {card.note ? <span className="text-[13px] leading-snug text-muted-foreground">{card.note}</span> : null}
        </div>
      ) : (
        <SinDato motivo={card.reason} forma="bloque" />
      )}
      {serieVacia ? (
        <p data-slot="serie-vacia" className="text-[13px] text-muted-foreground">
          Nada que dibujar en estos días: la serie no tiene movimientos.
        </p>
      ) : conPuntos ? (
        <SerieMini
          puntos={serie.points}
          alto={120}
          divergente={diverge}
          rayaPorPunto={card.chart === "dual"}
          referencia={card.chart === "columns" ? serie.reference : null}
          etiquetas="tres"
          formato={formato}
          resumen={`${cfg?.pregunta ?? card.key} ${serie.points.length} barras; ${serie.points.filter((p) => p.outside).length} del lado malo.`}
        />
      ) : null}
      {conPuntos && !serieVacia && (cfg?.leyenda || card.chart === "diverging") ? (
        <div aria-hidden="true" className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
          {cfg?.leyenda ? (
            <>
              <span className="inline-flex items-center gap-1.5">
                <span className="inline-block size-2.5 rounded-[2px] bg-(--data-1)" />
                {cfg.leyenda.barra}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="inline-block h-[3px] w-4 bg-foreground" />
                {cfg.leyenda.raya}
              </span>
            </>
          ) : (
            <>
              <span className="inline-flex items-center gap-1.5">
                <span className="inline-block size-2.5 rounded-[2px] bg-(--data-1)" />
                Sobra
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="inline-block size-2.5 rounded-[2px] bg-(--diverge-falta)" />
                Falta
              </span>
            </>
          )}
        </div>
      ) : null}
      {card.rows.length > 0 ? (
        <ul className="flex flex-col border-t">
          {card.rows.map((r) => {
            const { cifra: v, nota } = valorDeRenglon(r, diverge)
            return (
              <li key={r.key}>
                <Link
                  to={cfg?.href ?? "/admin/hoy"}
                  className="flex min-h-11 items-center gap-2 border-b text-sm text-foreground no-underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                  <span aria-hidden="true" className={cn("my-2 w-1 self-stretch rounded-[2px]", TONO_FONDO[r.tone])} />
                  <span className="min-w-0 flex-1 leading-snug">{r.label}</span>
                  {v !== null ? <b className={cn("whitespace-nowrap tabular-nums", r.tone === "critical" && "text-destructive")}>{v}</b> : null}
                  {nota ? (
                    <b className={cn("whitespace-nowrap", v !== null && "text-xs font-semibold", TONO_TEXTO[r.tone === "muted" ? "muted" : r.tone])}>
                      {nota}
                    </b>
                  ) : null}
                  <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                </Link>
              </li>
            )
          })}
        </ul>
      ) : null}
      {cfg ? (
        <Link
          to={cfg.href}
          className="flex h-12 items-center justify-center rounded-[10px] bg-primary text-[15px] font-bold text-primary-foreground no-underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-none"
        >
          {cfg.accion}
        </Link>
      ) : null}
    </section>
  )
}


/**
 * **Caja, Equipo e Informes en el celular**, variante A del handoff
 * (`MovilSecciones`, capturas 14a–14c): cuatro tarjetas de 112 px con su
 * mini tendencia; la elegida lleva borde de 2 px y abre su detalle debajo
 * —la pregunta, la cifra de 32 px, el gráfico de 120 px con su raya, las
 * excepciones en renglones de 44 px y la acción de 48 px—. Tocar otra
 * tarjeta cambia el detalle (estado local).
 *
 * Con varias sedes junta todas (como el semáforo de Hoy); con una, ésa. En
 * el escritorio estas rutas mandan a la pantalla de la sección: acá no hay
 * nada que no esté allá, sólo ordenado para el pulgar.
 */
export function SeccionMovil({ section }: { section: SectionKey }): React.JSX.Element {
  const celular = useEsCelular()
  const { stores, activeStoreId } = useStoreSelection()
  const varias = stores.length > 1
  const [elegida, setElegida] = useState(0)
  const query = useQuery({
    queryKey: ["admin-panel-section", section, varias ? "all" : activeStoreId],
    queryFn: () => getPanelSection(section, varias ? "all" : (activeStoreId as number)),
    enabled: celular && activeStoreId !== null,
    refetchInterval: REFRESH_MS,
  })
  const { titulo, escritorio } = SECCION[section]

  if (!celular) return <Navigate to={escritorio} replace />

  const data = query.data
  const card = data?.cards[elegida] ?? data?.cards[0]
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
        <h1 className="text-[26px] leading-tight font-extrabold [font-stretch:108%]">{titulo}</h1>
        {data ? (
          <span className="text-[13px] text-muted-foreground">
            Hoy · {formatBusinessDate(businessDateOfInstant(data.generated_at, 0))} · {formatClockTime(data.generated_at)}
            {data.scope === "all" ? " · todas las sedes" : ""}
          </span>
        ) : null}
      </div>
      {query.isError ? (
        <EmptyState
          reason="error"
          title={`No se pudo cargar ${titulo}`}
          description={errorMessage(query.error)}
          action={{ label: "Reintentar", onClick: () => void query.refetch() }}
        />
      ) : !data ? (
        <div aria-busy="true" aria-label={`Cargando ${titulo}`} className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-2">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-[112px] rounded-[10px]" />
            ))}
          </div>
          <Skeleton className="h-96 rounded-[10px]" />
        </div>
      ) : (
        <>
          <div role="group" aria-label={`Las cuatro preguntas de ${titulo}`} className="grid grid-cols-2 gap-2">
            {data.cards.map((c, i) => (
              <Tarjeta key={c.key} card={c} elegida={c.key === card?.key} onElegir={() => setElegida(i)} />
            ))}
          </div>
          {card ? <Detalle card={card} /> : null}
        </>
      )}
    </div>
  )
}

export function CajaMovil(): React.JSX.Element {
  return <SeccionMovil section="caja" />
}

export function EquipoMovil(): React.JSX.Element {
  return <SeccionMovil section="equipo" />
}

export function InformesMovil(): React.JSX.Element {
  return <SeccionMovil section="informes" />
}
