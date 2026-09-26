import { useQuery } from "@tanstack/react-query"
import { ChefHat, ClipboardCheck, Table2, Users, Wallet } from "lucide-react"
import { Link } from "react-router-dom"

import { getPanel, type PanelLight, type StorePanelOut } from "@/api/panel"
import { useStoreSelection } from "@/app/storeContext"
import { FilterLink, type FilterLinkProps } from "@/components/admin"
import { SinDato } from "@/components/SinDato"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { formatInstant } from "@/lib/businessDate"
import { formatFechaCorta } from "@/lib/format"
import { cn } from "@/lib/utils"

import { fichaPersonaHref, fichaTurnoHref } from "./fichas/rutas"

/** El mismo ritmo que Hoy: la portada es lo que pasa ahora. */
const REFRESH_MS = 30_000

/** Las palabras del semáforo: el color nunca es la única señal. */
const LIGHT_WORD: Record<PanelLight, string> = {
  red: "Requiere atención",
  amber: "Para revisar",
  green: "Al día",
}

const LIGHT_DOT: Record<PanelLight, string> = {
  red: "bg-destructive",
  amber: "bg-warning",
  green: "bg-success",
}

function Luz({ light, className }: { light: PanelLight; className?: string }): React.JSX.Element {
  return <span aria-hidden="true" className={cn("inline-block size-2.5 shrink-0 rounded-full", LIGHT_DOT[light], className)} />
}

/**
 * **Todas las sedes en un semáforo.** Sólo con más de una sede. Tocar una
 * sede la vuelve la sede activa: el resto de Hoy pasa a hablar de ella.
 */
function SedesSemaforo({
  stores,
  activeStoreId,
  onPick,
}: {
  stores: StorePanelOut[]
  activeStoreId: number | null
  onPick: (id: number) => void
}): React.JSX.Element {
  return (
    <ul aria-label="Todas las sedes ahora" className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
      {stores.map((s) => {
        const top = s.reasons[0]
        const activa = s.store_id === activeStoreId
        return (
          <li key={s.store_id}>
            <button
              type="button"
              onClick={() => onPick(s.store_id)}
              aria-pressed={activa}
              title={`Ver ${s.store_name}`}
              className={cn(
                "flex w-full flex-col items-start gap-1 rounded-lg border bg-card px-3 py-2 text-left hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                activa && "border-primary",
              )}
            >
              <span className="flex items-center gap-2 font-semibold">
                <Luz light={s.light} />
                {s.store_name}
              </span>
              <span className="text-xs text-muted-foreground">
                {LIGHT_WORD[s.light]}
                {top ? ` · ${top.text}` : ""}
                {s.reasons.length > 1 ? ` (+${s.reasons.length - 1})` : ""}
              </span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}

function Bloque({
  icon: Icon,
  titulo,
  tone = "default",
  children,
  link,
}: {
  icon: typeof Wallet
  titulo: string
  tone?: "default" | "warning" | "critical"
  children: React.ReactNode
  link?: FilterLinkProps
}): React.JSX.Element {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-1 rounded-lg border border-l-[3px] bg-card p-3",
        tone === "critical" && "border-destructive/30 border-l-destructive bg-destructive/5",
        tone === "warning" && "border-warning/45 border-l-warning bg-warning/10",
        tone === "default" && "border-l-border",
      )}
    >
      <h3 className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <Icon className="size-4 shrink-0" aria-hidden="true" />
        {titulo}
      </h3>
      <div className="min-w-0 space-y-0.5 text-sm">{children}</div>
      {link ? <FilterLink {...link} className="mt-auto pt-1" /> : null}
    </div>
  )
}

function Caja({ panel }: { panel: StorePanelOut }): React.JSX.Element {
  const cash = panel.cash
  if (!cash) {
    return (
      <Bloque icon={Wallet} titulo="Caja" tone="critical" link={{ to: "/admin/dinero", screen: "Dinero", tab: "Operacional" }}>
        <p className="text-base font-semibold">Sin turno abierto</p>
        <p className="text-muted-foreground">Sin turno no se puede vender.</p>
      </Bloque>
    )
  }
  const tone = cash.is_stale ? "critical" : !cash.responsible.active || cash.cash_over_threshold ? "warning" : "default"
  return (
    <Bloque
      icon={Wallet}
      titulo="Caja"
      tone={tone}
      link={{ to: fichaTurnoHref(cash.shift_id), screen: "Dinero", tab: `Turno #${cash.shift_id}` }}
    >
      <p className="text-base font-semibold">
        {cash.is_stale ? `Turno abandonado del ${formatFechaCorta(cash.business_date)}` : `Turno #${cash.shift_id} abierto`}
      </p>
      <p>
        Responsable:{" "}
        <Link to={fichaPersonaHref(cash.responsible.id)} className="font-medium text-primary hover:underline">
          {cash.responsible.name}
        </Link>{" "}
        {!cash.responsible.active ? <Badge variant="destructive">inactivo</Badge> : null}
      </p>
      <p className="text-xs text-muted-foreground">
        {cash.is_stale && cash.stale_since
          ? `Nadie lo cerró; es abandonado desde ${formatInstant(cash.stale_since)}.`
          : `Desde ${formatInstant(cash.opened_at)}.`}
        {cash.cash_over_threshold ? " Efectivo sobre el umbral: conviene un retiro." : ""}
      </p>
    </Bloque>
  )
}

function QuienTrabaja({ panel }: { panel: StorePanelOut }): React.JSX.Element {
  const { clocked_in, identified_only, reason } = panel.staff
  return (
    <Bloque icon={Users} titulo="Quién trabaja">
      {reason ? (
        <SinDato motivo={reason} forma="bloque">
          Nadie en turno
        </SinDato>
      ) : (
        <>
          <p className="text-base font-semibold">
            {clocked_in.length} {clocked_in.length === 1 ? "persona" : "personas"} en turno
          </p>
          <ul className="flex flex-wrap gap-x-2 gap-y-0.5">
            {clocked_in.map((p) => (
              <li key={p.employee_id}>
                <Link to={fichaPersonaHref(p.employee_id)} className="text-primary hover:underline">
                  {p.name}
                </Link>
                {p.on_pause ? <span className="text-xs text-muted-foreground"> (en pausa)</span> : null}
                {!p.active ? <span className="text-xs text-destructive"> (inactivo)</span> : null}
              </li>
            ))}
          </ul>
          {identified_only.length > 0 ? (
            <p className="text-xs text-muted-foreground" title="Se identificaron en la tablet (para cobrar o autorizar) pero no marcaron entrada.">
              Sólo se identificaron, sin marcar entrada: {identified_only.map((p) => p.name).join(", ")}.
            </p>
          ) : null}
        </>
      )}
    </Bloque>
  )
}

function Conteos({ panel }: { panel: StorePanelOut }): React.JSX.Element {
  const a = panel.area_counts
  const link: FilterLinkProps = { to: "/admin/inventario?tab=por-area", screen: "Inventario", tab: "Conteo por área" }
  if (!a.enabled) {
    return (
      <Bloque icon={ClipboardCheck} titulo="Conteos">
        <SinDato motivo="El conteo corto por área está apagado en esta sede." forma="bloque" />
      </Bloque>
    )
  }
  // Mismo criterio que el aviso de Hoy y que la razón del semáforo: un área
  // sin conteo de apertura es crítica (no bloquea nada, pero sin apertura no
  // hay faltante que medir).
  const tone = a.opening_done < a.areas_total ? "critical" : a.flagged > 0 ? "warning" : "default"
  return (
    <Bloque icon={ClipboardCheck} titulo="Conteos" tone={tone} link={link}>
      <p className="text-base font-semibold">
        Apertura {a.opening_done}/{a.areas_total} · Cierre {a.closing_done}/{a.areas_total}
      </p>
      <p className="text-xs text-muted-foreground">
        {a.flagged > 0 ? `${a.flagged} faltante${a.flagged === 1 ? "" : "s"} sobre el umbral. ` : "Sin faltantes sobre el umbral. "}
        {a.pending_recounts > 0 ? `${a.pending_recounts} recuento${a.pending_recounts === 1 ? "" : "s"} por responder.` : ""}
      </p>
    </Bloque>
  )
}

function Salon({ panel }: { panel: StorePanelOut }): React.JSX.Element {
  const s = panel.salon
  const atascadas = s.unsent + s.unpaid
  return (
    <Bloque icon={Table2} titulo="Salón" tone={atascadas > 0 ? "warning" : "default"} link={{ to: "/admin/pedidos", screen: "Pedidos" }}>
      <p className="text-base font-semibold">
        {s.open_orders} comanda{s.open_orders === 1 ? "" : "s"} abierta{s.open_orders === 1 ? "" : "s"}
      </p>
      <p className="text-xs text-muted-foreground">
        {s.tables_total > 0 ? `Mesas ${s.tables_occupied}/${s.tables_total}. ` : ""}
        {atascadas > 0 ? `${s.unsent} sin enviar · ${s.unpaid} sin cobrar.` : "Ninguna atascada."}
      </p>
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
  return (
    <Bloque icon={ChefHat} titulo="Cocina" tone={k.late > 0 ? "warning" : "default"} link={{ to: "/admin/pedidos", screen: "Pedidos" }}>
      <p className="text-base font-semibold">
        {k.late > 0 ? `${k.late} plato${k.late === 1 ? "" : "s"} atrasado${k.late === 1 ? "" : "s"}` : "Nada atrasado"}
      </p>
      <p className="text-xs text-muted-foreground">
        {k.in_kitchen} en preparación
        {k.oldest_late_minutes !== null ? ` · el más viejo lleva ${k.oldest_late_minutes} min` : ""}.
      </p>
    </Bloque>
  )
}

/**
 * **La portada: qué está pasando ahora**, arriba de Hoy. Con varias sedes,
 * primero todas en un semáforo; después, de la sede activa, cinco bloques:
 * caja, quién trabaja, conteos, salón y cocina. Cada bloque lleva a la
 * pantalla —o a la ficha— donde se ve el detalle.
 *
 * Todo sale de `GET /admin/panel`, que usa las mismas funciones que Hoy,
 * Dinero y el KDS: el panel no puede decir un número distinto que ellas.
 * No repite el esperado del cajón: esa cifra ya es la tarjeta «Efectivo
 * esperado» de abajo (una cifra, un lugar).
 */
export function PanelAhora(): React.JSX.Element | null {
  const { stores, activeStoreId, setActiveStoreId } = useStoreSelection()
  const varias = stores.length > 1
  const query = useQuery({
    queryKey: ["admin-panel", varias ? "all" : activeStoreId],
    queryFn: () => getPanel(varias ? "all" : (activeStoreId as number)),
    enabled: activeStoreId !== null,
    refetchInterval: REFRESH_MS,
  })

  if (activeStoreId === null) return null
  if (query.isLoading) {
    return <Skeleton aria-label="Cargando lo que pasa ahora" className="h-36 w-full rounded-lg" />
  }
  if (query.isError || !query.data) {
    // Hoy sigue funcionando sin la portada: el error se dice y no tapa lo demás.
    return (
      <p role="status" className="rounded-lg border border-dashed px-3 py-2 text-sm text-muted-foreground">
        No se pudo leer «Ahora» ({query.error instanceof Error ? query.error.message : "sin respuesta"}). El resto de
        Hoy sigue al día.
      </p>
    )
  }

  const panels = query.data.stores
  const panel = panels.find((p) => p.store_id === activeStoreId)

  return (
    <section aria-labelledby="ahora-titulo" className="space-y-3">
      {varias ? <SedesSemaforo stores={panels} activeStoreId={activeStoreId} onPick={setActiveStoreId} /> : null}
      {panel ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <h2 id="ahora-titulo" className="text-lg font-bold">
              Ahora{varias ? ` en ${panel.store_name}` : ""}
            </h2>
            <span className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium">
              <Luz light={panel.light} />
              {LIGHT_WORD[panel.light]}
            </span>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
            <Caja panel={panel} />
            <QuienTrabaja panel={panel} />
            <Conteos panel={panel} />
            <Salon panel={panel} />
            <Cocina panel={panel} />
          </div>
        </>
      ) : (
        <h2 id="ahora-titulo" className="text-sm text-muted-foreground">
          Ahora: la sede elegida está inactiva y no entra en el semáforo.
        </h2>
      )}
    </section>
  )
}

export default PanelAhora
