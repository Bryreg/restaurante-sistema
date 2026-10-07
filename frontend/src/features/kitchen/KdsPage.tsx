import { useQueryClient } from "@tanstack/react-query"
import { Ban, ChefHat, History, Maximize, Minimize, Printer, TriangleAlert, Wine } from "lucide-react"
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react"

import { useCocinaPantalla } from "@/app/theme"
import { useSession } from "@/app/session"
import { ApiError, newIdempotencyKey } from "@/api/client"
import {
  bumpItem,
  expediteOrder,
  registerPrintJob,
  unbumpItem,
  type KitchenPrintJobOut,
  type KitchenRoundItemOut,
  type KitchenRoundOut,
} from "@/api/kitchen"
import { setProductAvailability } from "@/api/catalog"
import { markReady, markServed } from "@/api/orders"
import { SegmentadoTactil } from "@/components/admin"
import { Cargando } from "@/components/Cargando"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { EmptyState } from "@/components/EmptyState"
import { formatClockTime } from "@/lib/businessDate"
import { errorMessage } from "@/lib/errors"
import { formatFechaCorta } from "@/lib/format"
import { stationLabel } from "@/lib/stations"
import { cn } from "@/lib/utils"

import { useKdsPrintJobs, useKdsRounds, useKdsStations } from "./hooks"
import {
  channelLabel,
  columnasQueEntran,
  courseLabel,
  elapsedFromSeconds,
  esEstacionDelBar,
  estacionesDeLaBarra,
  hasActivePerson,
  mentionsAllergy,
  readKdsPrefs,
  repartirEnColumnas,
  SEMAPHORE_LABEL,
  worstSemaphore,
  writeKdsPrefs,
  type KdsArea,
  type KdsTema,
  type KitchenSemaphoreValue,
  type StationPerson,
} from "./lib"
import { StationPinDialog } from "./StationPinDialog"

// -----------------------------------------------------------------------
// Atribución: el KDS es una pantalla de ESTACIÓN. Mirarlo no exige persona
// (`PosLayout` no manda a «Quién opera» desde acá); marcar algo sí, porque
// queda a nombre de alguien. `attribute(run)` corre la acción si hay una
// persona vigente y, si no (o si el servidor responde `IDENTIFY_REQUIRED`),
// abre el PIN rápido y la corre después de identificar.
// -----------------------------------------------------------------------

type Attribute = (label: string, run: () => Promise<unknown>) => Promise<"done" | "cancelled">

const AttributeContext = createContext<Attribute>(async (_label, run) => {
  await run()
  return "done"
})

/**
 * `true` con `kitchen.kds` encendida: deshacer listo, expedir e impresión por
 * estación. Con sólo `kitchen.view` la pantalla es la misma, pero «Listo» marca
 * por `POST /orders/{id}/items/{id}/ready` (la ruta de `kitchen.view`) y no se
 * deshace, y no hay expedición ni impresión: esas rutas exigen `kitchen.kds`.
 */
const FullKdsContext = createContext(true)

/** Pantalla completa: el destino en 30 px y el plato en 24 (25 y 21 si no). */
const GrandeContext = createContext(false)

function isIdentifyRequired(err: unknown): boolean {
  return err instanceof ApiError && err.code === "IDENTIFY_REQUIRED"
}

interface PinRequest {
  label: string
  /** Quién usó la estación por última vez, leído al abrir el teclado. */
  person: StationPerson | null
  run: () => Promise<unknown>
  resolve: (value: "done" | "cancelled") => void
  reject: (err: unknown) => void
}

// -----------------------------------------------------------------------
// El tono del tiquete (handoff «Burbujas», 10a–10d): ● a tiempo, ▲ por
// vencer, ■ demorado. El estado NO se recalcula con minutos fijos: es el
// semáforo que manda el servidor (`_semaphore`, con el objetivo por estación
// y curso que configura la sede), y el tiquete toma el del plato más urgente
// que falta. Forma, color y palabra: nunca sólo color.
// -----------------------------------------------------------------------

const TONO: Record<
  KitchenSemaphoreValue,
  { aro: string; suave: string; texto: string; forma: string; resumen: string }
> = {
  green: {
    aro: "shadow-[inset_0_0_0_4px_var(--ring-ok)]",
    suave: "bg-success-soft",
    texto: "text-success",
    forma: "rounded-full",
    resumen: "a tiempo",
  },
  amber: {
    aro: "shadow-[inset_0_0_0_4px_var(--ring-warning)]",
    suave: "bg-warning-soft",
    texto: "text-warning",
    forma: "[clip-path:polygon(50%_0,100%_100%,0_100%)]",
    resumen: "por vencer",
  },
  red: {
    aro: "shadow-[inset_0_0_0_4px_var(--ring-destructive)]",
    suave: "bg-destructive-soft",
    texto: "text-destructive",
    forma: "rounded-[2px]",
    resumen: "demorados",
  },
}

/** La forma de 10 px del tono, en el color del texto. */
function Forma({ valor, className }: { valor: KitchenSemaphoreValue; className?: string }): React.JSX.Element {
  return <span aria-hidden="true" className={cn("size-[10px] shrink-0 bg-current", TONO[valor].forma, className)} />
}

/** Pastilla de detalle del plato: 16/600, padding 4/10, radio 12. */
const PASTILLA = "inline-flex items-center gap-1.5 rounded-[12px] px-2.5 py-1 text-[16px] leading-tight"

/** Modificadores y notas en amarillo; si nombran una alergia, en rojo con ícono. */
function Detalle({ text }: { text: string }): React.JSX.Element {
  if (mentionsAllergy(text)) {
    return (
      <span className={cn(PASTILLA, "bg-destructive-soft font-bold text-destructive")}>
        <TriangleAlert className="size-[15px] shrink-0" aria-hidden="true" />
        <span>
          <span className="sr-only">Alerta de alergia: </span>
          {text}
        </span>
      </span>
    )
  }
  return <span className={cn(PASTILLA, "bg-warning-soft font-semibold text-warning")}>{text}</span>
}

// -----------------------------------------------------------------------
// Plato: bump / deshacer bump. El backend es idempotente (backend-kds.md §4):
// bumpear un ítem ya `ready` devuelve `changed: false`, NUNCA un error — el
// botón se deshabilita mientras hay un pedido en vuelo. Los estados del
// plato en cocina son dos (`sent` → `ready`): no hay paso «preparando».
// -----------------------------------------------------------------------

/**
 * Un plato es un pozo: cantidad y nombre, debajo lo que cocina tiene que leer
 * (modificadores, nota, alergia) y, a la derecha, «Listo» de 56 × 96. Ya
 * listo, el botón va en verde con «✓ Listo» y el plato tachado y al 50 %;
 * tocarlo otra vez lo deshace (con `kitchen.kds`).
 */
function ItemRow({
  item,
  orderId,
  onChanged,
  semaforoTiquete,
}: {
  item: KitchenRoundItemOut
  orderId: number
  onChanged: () => void
  /** El del tiquete: si el plato dice lo mismo, no se repite. */
  semaforoTiquete: KitchenSemaphoreValue
}): React.JSX.Element {
  const attribute = useContext(AttributeContext)
  const full = useContext(FullKdsContext)
  const grande = useContext(GrandeContext)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [soldOut, setSoldOut] = useState(false)
  const [markingSoldOut, setMarkingSoldOut] = useState(false)
  const semaphore = (item.semaphore ?? "green") as KitchenSemaphoreValue
  const ready = item.status === "ready"
  const fired = item.course_fired_at != null
  const name = item.name ?? "ítem"
  const urgente = !ready && semaphore !== "green" && semaphore !== semaforoTiquete

  async function handleToggle() {
    setPending(true)
    setError(null)
    try {
      const result = await attribute(ready ? `Deshacer listo: ${name}` : `Marcar listo: ${name}`, () => {
        if (ready) return unbumpItem(item.item_id)
        return full ? bumpItem(item.item_id) : markReady(orderId, item.item_id, newIdempotencyKey())
      })
      if (result === "done") onChanged()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setPending(false)
    }
  }

  // Lista 86 (auditoría p5): se acabó en la cocina → agotado en la carta del
  // POS, de un toque y a nombre de quien lo marcó. Se vuelve a ofrecer desde
  // la carta del POS («Agotados») o desde Carta.
  const productId = item.product_id ?? null
  async function handleSoldOut() {
    if (productId === null) return
    setMarkingSoldOut(true)
    setError(null)
    try {
      const result = await attribute(`Marcar agotado: ${name}`, () =>
        setProductAvailability(productId, { available: false }, newIdempotencyKey()),
      )
      if (result === "done") setSoldOut(true)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setMarkingSoldOut(false)
    }
  }

  const plato = grande ? "text-[24px]" : "text-[21px]"
  const extras =
    Boolean(item.modifiers_text) || Boolean(item.note) || fired || urgente || soldOut || (ready && item.bumped_by)

  return (
    <li className={cn("flex flex-col gap-1.5 rounded-[18px] bg-muted py-3 pr-3 pl-4", ready && "opacity-50")}>
      <div className="flex items-center gap-3">
        <b className={cn("min-w-7 font-bold", plato)}>{item.qty ?? 1}</b>
        <span className="flex min-w-0 flex-1 flex-col gap-1.5">
          <span className={cn("leading-[1.2] font-semibold", plato, ready && "line-through")}>{item.name ?? "—"}</span>
          {extras ? (
            <span className="flex flex-wrap items-center gap-1.5">
              {item.modifiers_text ? <Detalle text={item.modifiers_text} /> : null}
              {item.note ? <Detalle text={item.note} /> : null}
              {fired && item.course ? <Badge variant="outline">{courseLabel(item.course)}</Badge> : null}
              {fired ? (
                <Badge variant="secondary" title="Curso marchado">
                  Marchado
                </Badge>
              ) : null}
              {/* Un plato que va más tarde que su tiquete: forma, color y palabra. */}
              {urgente ? (
                <span className={cn(PASTILLA, "bg-card font-semibold whitespace-nowrap", TONO[semaphore].texto)}>
                  <Forma valor={semaphore} />
                  {elapsedFromSeconds(item.elapsed_seconds ?? 0)} · {SEMAPHORE_LABEL[semaphore]}
                </span>
              ) : null}
              {soldOut ? (
                <span role="status" className="text-[15px] font-semibold text-muted-foreground">
                  Agotado en la carta: el POS ya no lo ofrece.
                </span>
              ) : null}
              {ready && item.bumped_by ? (
                <span className="text-[15px] text-muted-foreground">Lo marcó listo {item.bumped_by.name}</span>
              ) : null}
            </span>
          ) : null}
        </span>
        {productId !== null && !ready ? (
          <button
            type="button"
            disabled={markingSoldOut || soldOut}
            onClick={() => void handleSoldOut()}
            aria-label={soldOut ? `${name}: agotado en la carta` : `Agotado: ${name}`}
            title="Marcar agotado en la carta del POS"
            className={cn(
              "inline-flex size-14 shrink-0 items-center justify-center rounded-[16px] transition-colors",
              "focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-60",
              soldOut ? "bg-destructive text-destructive-foreground" : "bg-card text-destructive",
            )}
          >
            <Ban className="size-6" aria-hidden="true" />
          </button>
        ) : null}
        <button
          type="button"
          // Sin `kitchen.kds` un plato listo no se deshace (no hay ruta para eso).
          disabled={pending || (ready && !full)}
          onClick={() => void handleToggle()}
          aria-label={ready ? (full ? `Deshacer listo: ${name}` : `Listo: ${name}`) : `Marcar listo: ${name}`}
          className={cn(
            "inline-flex h-14 min-w-24 shrink-0 items-center justify-center rounded-[16px] px-3.5 text-[17px] font-semibold transition-colors",
            "focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:cursor-not-allowed",
            ready ? "bg-success text-success-foreground" : "bg-card text-foreground",
          )}
        >
          {pending ? "…" : ready ? "✓ Listo" : "Listo"}
        </button>
      </div>
      {error ? (
        <p role="alert" className="text-[15px] text-destructive">
          {error}
        </p>
      ) : null}
    </li>
  )
}

// -----------------------------------------------------------------------
// Comanda: agrupa TODAS sus rondas (usualmente una) en un solo tiquete.
// «Todo listo» respeta el filtro de estación: en «Todas» de la cocina expide
// la comanda completa; filtrada, SÓLO esa estación (`POST .../expedite?
// station=`) — en «Cocina caliente» se despachaban también las cervezas del
// bar (comanda 464). En el bar, «Todas» expide sólo sus estaciones.
// -----------------------------------------------------------------------

/** En «Todas», «Expedir» es la comanda completa, como siempre. */
const EXPEDITE_ALL = {
  title: "Marca listos de un golpe todos los ítems enviados de esta comanda, en todas sus rondas",
}

interface OrderGroup {
  orderId: number
  channel?: string
  tables?: string[]
  takeoutName?: string | null
  covers?: number | null
  platform?: KitchenRoundOut["platform"]
  stale: boolean
  rounds: KitchenRoundOut[]
}

function groupRoundsByOrder(rounds: KitchenRoundOut[]): OrderGroup[] {
  const groups = new Map<number, OrderGroup>()
  for (const round of rounds) {
    let group = groups.get(round.order_id)
    if (!group) {
      group = {
        orderId: round.order_id,
        channel: round.channel,
        tables: round.tables,
        takeoutName: round.takeout_name,
        covers: round.covers,
        platform: round.platform,
        stale: false,
        rounds: [],
      }
      groups.set(round.order_id, group)
    }
    group.stale = group.stale || round.stale === true
    group.rounds.push(round)
  }
  return Array.from(groups.values())
}

/** Sólo los platos de las estaciones que se quedan; una ronda sin ninguno no se muestra. */
function soloEstaciones(rounds: KitchenRoundOut[], queda: (station: string | null | undefined) => boolean): KitchenRoundOut[] {
  return rounds
    .map((r) => ({ ...r, items: (r.items ?? []).filter((i) => queda(i.station)) }))
    .filter((r) => r.items.length > 0)
}

/** Lo que se lee a dos metros: dónde va el plato. */
function destino(group: OrderGroup): string {
  if (group.tables && group.tables.length > 0) return `Mesa ${group.tables.join(", ")}`
  if (group.platform?.source) return group.platform.source
  if (group.takeoutName) return group.takeoutName
  return channelLabel(group.channel)
}

/** Lo que tarda el plato más viejo de la comanda (el `elapsed_seconds` de sus rondas, del servidor). */
function demoraDe(group: OrderGroup): number {
  return Math.max(0, ...group.rounds.map((r) => r.elapsed_seconds ?? 0))
}

function platosDe(group: OrderGroup): KitchenRoundItemOut[] {
  return group.rounds.flatMap((r) => r.items ?? [])
}

/** Los ítems que siguen en cocina (`sent`). */
function pendientesDe(group: OrderGroup): KitchenRoundItemOut[] {
  return platosDe(group).filter((i) => i.status === "sent")
}

/**
 * El tiquete (handoff «Burbujas», 10a–10d): una burbuja con un aro de 4 px
 * del tono, la cabecera teñida en su suave (destino, quién · número y los
 * minutos en una pastilla blanca con la forma), un pozo por plato y el botón
 * final: «Todo listo» marca todos; con todos listos, «Despachar Mesa N»
 * entrega la comanda.
 */
function OrderCard({
  group,
  station,
  expedirEn,
  onChanged,
}: {
  group: OrderGroup
  station: string | undefined
  /** Las estaciones a expedir; `undefined` es la comanda completa. */
  expedirEn: string[] | undefined
  onChanged: () => void
}): React.JSX.Element {
  const attribute = useContext(AttributeContext)
  const full = useContext(FullKdsContext)
  const grande = useContext(GrandeContext)
  const [working, setWorking] = useState<"todo" | "despacho" | null>(null)
  const [error, setError] = useState<string | null>(null)
  const pendientes = pendientesDe(group)
  const listos = platosDe(group).filter((i) => i.status === "ready")
  const hasSent = pendientes.length > 0
  // El tiquete toma el tono del plato más urgente que falta: el que manda el
  // servidor, sin recalcular nada.
  const semaphore = worstSemaphore(pendientes.map((i) => i.semaphore))
  const tono = TONO[semaphore]
  const dondeVa = destino(group)
  const expediteLabel = expedirEn ? `Expedir ${expedirEn.map(stationLabel).join(", ")}` : "Expedir comanda"
  const meta = [
    group.channel === "dine_in" && group.tables && group.tables.length > 0 ? null : channelLabel(group.channel),
    group.covers ? `${group.covers} ${group.covers === 1 ? "comensal" : "comensales"}` : null,
    group.platform
      ? `${group.platform.source ?? "Plataforma"}${group.platform.external_id ? ` · ${group.platform.external_id}` : ""}`
      : null,
  ]
    .filter(Boolean)
    .join(" · ")

  async function correr(kind: "todo" | "despacho", label: string, run: () => Promise<unknown>) {
    setWorking(kind)
    setError(null)
    try {
      const result = await attribute(label, run)
      if (result === "done") onChanged()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setWorking(null)
    }
  }

  // «Todo listo»: con `kitchen.kds`, la expedición (de un golpe, en el
  // servidor); con sólo `kitchen.view`, «listo» plato por plato por la ruta
  // de la comanda, que es la única que esa función habilita.
  function handleTodoListo() {
    if (full) {
      void correr("todo", `${expediteLabel} #${group.orderId}`, async () => {
        if (!expedirEn) return expediteOrder(group.orderId)
        for (const s of expedirEn) await expediteOrder(group.orderId, s)
      })
      return
    }
    void correr("todo", `Marcar listos los platos de la comanda #${group.orderId}`, async () => {
      for (const item of pendientes) await markReady(group.orderId, item.item_id, newIdempotencyKey())
    })
  }

  // «Despachar»: todo listo, sale de la cocina. Es la entrega que ya existe
  // (`POST /orders/{id}/items/{id}/served`, la misma de la comanda), para los
  // platos que muestra este tiquete.
  function handleDespachar() {
    void correr("despacho", `Despachar ${dondeVa} (comanda #${group.orderId})`, async () => {
      for (const item of listos) await markServed(group.orderId, item.item_id, newIdempotencyKey())
    })
  }

  const todoAria = full
    ? station
      ? `Todo listo: expedir ${stationLabel(station)} de la comanda #${group.orderId}`
      : expedirEn
        ? `Todo listo: expedir ${expedirEn.map(stationLabel).join(", ")} de la comanda #${group.orderId}`
        : `Todo listo: expedir comanda completa #${group.orderId}`
    : `Todo listo: marcar listos los platos de la comanda #${group.orderId}`
  const todoTitle = full
    ? station
      ? `Marca listos de un golpe sólo los ítems de ${stationLabel(station)} de esta comanda; las otras estaciones no se tocan`
      : expedirEn
        ? `Marca listos de un golpe sólo los ítems de ${expedirEn.map(stationLabel).join(", ")} de esta comanda`
        : EXPEDITE_ALL.title
    : "Marca listos, uno por uno, los platos que faltan de esta comanda"

  return (
    <article
      className={cn("flex flex-col gap-2.5 rounded-[26px] bg-card p-4", tono.aro)}
      aria-label={`Comanda #${group.orderId}, ${dondeVa}`}
    >
      <header className={cn("-mx-1 -mt-1 flex items-start gap-2.5 rounded-[20px] py-3.5 pr-3.5 pl-4", tono.suave)}>
        <span className="flex min-w-0 flex-1 flex-col">
          <b
            className={cn("leading-[1.15] font-semibold tracking-[-0.015em]", grande ? "text-[30px]" : "text-[25px]")}
            title={dondeVa}
          >
            {dondeVa}
          </b>
          <span className="text-[15px] text-muted-foreground">
            {group.stale ? (
              <Badge variant="destructive" className="mr-1.5" title="Comanda de un día operativo anterior que sigue abierta">
                De ayer
              </Badge>
            ) : null}
            {meta ? `${meta} · ` : ""}#{group.orderId}
          </span>
        </span>
        <span
          className={cn(
            "inline-flex h-11 shrink-0 items-center gap-2 rounded-[22px] bg-card px-3.5 text-[22px] font-semibold whitespace-nowrap",
            tono.texto,
          )}
        >
          <Forma valor={semaphore} />
          {elapsedFromSeconds(demoraDe(group))}
          <span className="sr-only">{hasSent ? ` · ${SEMAPHORE_LABEL[semaphore]}` : " · Todo listo"}</span>
        </span>
      </header>
      {group.rounds.map((round) => (
        <div key={`${round.order_id}-${round.round_no}`} className="flex flex-col gap-2.5">
          {group.rounds.length > 1 ? (
            <p className="px-1 text-[15px] font-medium text-muted-foreground">
              Ronda {round.round_no} · {elapsedFromSeconds(round.elapsed_seconds ?? 0)}
            </p>
          ) : null}
          <ul className="flex flex-col gap-2.5">
            {(round.items ?? []).map((item) => (
              <ItemRow
                key={item.item_id}
                item={item}
                orderId={group.orderId}
                onChanged={onChanged}
                semaforoTiquete={semaphore}
              />
            ))}
          </ul>
        </div>
      ))}
      {error ? (
        <p role="alert" className="px-1 text-[15px] text-destructive">
          {error}
        </p>
      ) : null}
      {hasSent ? (
        <button
          type="button"
          disabled={working !== null}
          onClick={handleTodoListo}
          aria-label={todoAria}
          title={todoTitle}
          className="h-[60px] rounded-[18px] bg-muted text-[18px] font-semibold text-foreground transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-60"
        >
          {working === "todo" ? "Marcando…" : "Todo listo"}
        </button>
      ) : (
        <button
          type="button"
          disabled={working !== null || listos.length === 0}
          onClick={handleDespachar}
          aria-label={`Despachar ${dondeVa}: entregar la comanda #${group.orderId}`}
          title="Marca entregados los platos de este tiquete: salen de la pantalla"
          className="h-[60px] rounded-[18px] bg-primary text-[18px] font-semibold text-primary-foreground transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-none disabled:opacity-60"
        >
          {working === "despacho" ? "Despachando…" : `Despachar ${dondeVa}`}
        </button>
      )}
    </article>
  )
}

// -----------------------------------------------------------------------
// Impresión por estación: el TRABAJO de impresión (backend-kds.md §2 y §6.3)
// — «Confirmar impresión» REGISTRA que la estación imprimió, no manda nada
// a una impresora física (eso es fase 3, § Alcance de la spec). La pantalla
// lo dice tal cual para no simular algo que no pasó.
// -----------------------------------------------------------------------

function PrintJobRow({ job, onChanged }: { job: KitchenPrintJobOut; onChanged: () => void }): React.JSX.Element {
  const attribute = useContext(AttributeContext)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleConfirm() {
    setPending(true)
    setError(null)
    try {
      const result = await attribute(`Confirmar impresión de la comanda #${job.order_id}`, () =>
        registerPrintJob({ round_id: job.round_id, station: job.station }),
      )
      if (result === "done") onChanged()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setPending(false)
    }
  }

  return (
    <li className="space-y-2 rounded-[18px] bg-muted px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <p className="font-semibold">
            Comanda #{job.order_id} · Ronda {job.round_no} · {stationLabel(job.station)}
          </p>
          <p className="text-[15px] text-muted-foreground">
            {channelLabel(job.channel)}
            {job.tables.length > 0 ? ` · Mesa ${job.tables.join(", ")}` : ""} · {job.item_count} ítem
            {job.item_count === 1 ? "" : "s"}
          </p>
          <ul className="text-[15px] text-muted-foreground">
            {job.items.map((i) => (
              <li key={i.item_id}>
                {i.qty}× {i.name}
                {i.modifiers_text ? ` — ${i.modifiers_text}` : ""}
              </li>
            ))}
          </ul>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          {job.printed ? (
            <Badge variant="secondary">
              Registrada como impresa{job.print_count > 1 ? ` (×${job.print_count})` : ""}
            </Badge>
          ) : (
            <Badge variant="outline">Sin registrar</Badge>
          )}
          <Button
            type="button"
            variant="outline"
            className="h-12 rounded-[14px] bg-card"
            disabled={pending}
            onClick={() => void handleConfirm()}
            aria-label={`Confirmar impresión: comanda ${job.order_id}, ronda ${job.round_no}, ${stationLabel(job.station)}`}
          >
            <Printer className="size-4" aria-hidden="true" />
            {pending ? "Registrando…" : job.printed ? "Reimprimir" : "Confirmar impresión"}
          </Button>
        </div>
      </div>
      {error ? (
        <p role="alert" className="text-[15px] text-destructive">
          {error}
        </p>
      ) : null}
    </li>
  )
}

// -----------------------------------------------------------------------
// Pantalla completa: la pantalla de la estación sin la barra del salón
// (persona, turno, secciones: ~340 px que en la cocina no se usan). Se
// dibuja ENCIMA del marco del POS (`fixed inset-0`), sin tocar `PosLayout`,
// y además pide al navegador su pantalla completa cuando puede (sólo con un
// toque: al recargar queda la capa, que ya tapa el marco).
// -----------------------------------------------------------------------

function requestBrowserFullscreen(on: boolean): void {
  try {
    if (on) {
      if (!document.fullscreenElement) void document.documentElement.requestFullscreen?.().catch(() => {})
    } else if (document.fullscreenElement) {
      void document.exitFullscreen?.().catch(() => {})
    }
  } catch {
    // un navegador sin Fullscreen API igual se queda con la capa
  }
}

/** Hoy en Bogotá como «2026-09-27» (UTC-5 todo el año, igual que `formatClockTime`). */
function hoyBogota(now: Date): string {
  const b = new Date(now.getTime() - 5 * 60 * 60 * 1000)
  const dos = (n: number) => String(n).padStart(2, "0")
  return `${b.getUTCFullYear()}-${dos(b.getUTCMonth() + 1)}-${dos(b.getUTCDate())}`
}

/** El reloj de la barra: se mueve solo. */
function useAhora(): Date {
  const [ahora, setAhora] = useState(() => new Date())
  useEffect(() => {
    const id = window.setInterval(() => setAhora(new Date()), 15_000)
    return () => window.clearInterval(id)
  }, [])
  return ahora
}

/** Cuatro columnas de tiquetes (las del handoff a 1920); menos sólo si no entran de 280 px. */
function useColumnas(): [React.RefCallback<HTMLDivElement>, number] {
  const [columnas, setColumnas] = useState(4)
  const observer = useRef<ResizeObserver | null>(null)
  const ref = useCallback((el: HTMLDivElement | null) => {
    observer.current?.disconnect()
    observer.current = null
    if (!el) return
    const medir = () => {
      // Sin ancho medible (jsdom, todavía sin pintar), las cuatro del diseño.
      if (el.clientWidth > 0) setColumnas(columnasQueEntran(el.clientWidth, 280, 12, 4))
    }
    medir()
    if (typeof ResizeObserver !== "undefined") {
      observer.current = new ResizeObserver(medir)
      observer.current.observe(el)
    }
  }, [])
  return [ref, columnas]
}

const RESUMEN: KitchenSemaphoreValue[] = ["red", "amber", "green"]

const AREA = {
  cocina: { titulo: "Cocina", Icono: ChefHat, de: "de cocina", a: "a cocina" },
  bar: { titulo: "Bar", Icono: Wine, de: "del bar", a: "al bar" },
} as const

/**
 * El KDS de cocina y de bar (handoff «Burbujas», 10a–10d): el mismo
 * componente con `area`. La cocina ve todas las estaciones, como siempre; el
 * bar, sólo las suyas (`BAR_STATIONS`).
 */
export function KdsPage({ area = "cocina" }: { area?: KdsArea }): React.JSX.Element {
  const { me, hasFeature, refresh } = useSession()
  const enabled = hasFeature("kitchen.view") || hasFeature("kitchen.kds")
  const full = hasFeature("kitchen.kds")
  const queryClient = useQueryClient()
  const ahora = useAhora()
  const [gridRef, columnas] = useColumnas()
  const esBar = area === "bar"
  const queda = esBar ? esEstacionDelBar : () => true
  const textos = AREA[area]

  const [prefs] = useState(readKdsPrefs)
  const guardada = esBar ? prefs.stationBar : prefs.station
  const [station, setStationState] = useState<string | undefined>(
    guardada !== undefined && queda(guardada) ? guardada : undefined,
  )
  const [showStale, setShowStale] = useState(prefs.showStale ?? false)
  const [fullscreen, setFullscreen] = useState(prefs.fullscreen ?? false)
  const [tema, setTemaState] = useState<KdsTema>(prefs.tema ?? "noche")
  const [storedPerson, setStoredPerson] = useState<StationPerson | null>(prefs.lastPerson ?? null)
  const [pinRequest, setPinRequest] = useState<PinRequest | null>(null)
  useCocinaPantalla(tema === "claro")
  const rounds = useKdsRounds(station, enabled)
  // Los conteos de la barra son de todas las estaciones: con una elegida,
  // se piden también todas (sin estación elegida, es la misma consulta).
  const todas = useKdsRounds(undefined, enabled && station !== undefined)
  const configuradas = useKdsStations(enabled && full)
  const printJobs = useKdsPrintJobs(station, enabled && full)

  const employee = me?.employee ?? null
  const employeeExpiresAt = me?.employee_expires_at ?? null

  // Quien usa la estación queda recordado en ESTE dispositivo: el PIN rápido
  // lo trae ya elegido.
  const employeeId = employee?.id
  const employeeName = employee?.name
  useEffect(() => {
    if (employeeId === undefined || employeeName === undefined) return
    writeKdsPrefs({ lastPerson: { id: employeeId, name: employeeName } })
  }, [employeeId, employeeName])

  const attribute = useCallback<Attribute>(
    async (label, run) => {
      if (hasActivePerson(employee, employeeExpiresAt)) {
        try {
          await run()
          void refresh()
          return "done"
        } catch (err) {
          if (!isIdentifyRequired(err)) throw err
        }
      }
      return new Promise<"done" | "cancelled">((resolve, reject) => {
        // Lo guardado es lo más fresco: la persona pudo identificarse por
        // «Quién opera» mientras esta pantalla estaba abierta.
        setPinRequest({ label, person: readKdsPrefs().lastPerson ?? storedPerson, run, resolve, reject })
      })
    },
    [employee, employeeExpiresAt, storedPerson, refresh],
  )

  async function handleIdentified(person: StationPerson) {
    const request = pinRequest
    setStoredPerson(person)
    writeKdsPrefs({ lastPerson: person })
    await refresh()
    setPinRequest(null)
    if (!request) return
    try {
      await request.run()
      request.resolve("done")
    } catch (err) {
      request.reject(err)
    }
  }

  function handlePinCancel() {
    pinRequest?.resolve("cancelled")
    setPinRequest(null)
  }

  function setStation(next: string | undefined) {
    setStationState(next)
    writeKdsPrefs(esBar ? { stationBar: next } : { station: next })
  }

  function toggleFullscreen() {
    const next = !fullscreen
    setFullscreen(next)
    writeKdsPrefs({ fullscreen: next })
    requestBrowserFullscreen(next)
  }

  function toggleStale() {
    const next = !showStale
    setShowStale(next)
    writeKdsPrefs({ showStale: next })
  }

  function setTema(next: KdsTema) {
    setTemaState(next)
    writeKdsPrefs({ tema: next })
  }

  if (!enabled) {
    return (
      <EmptyState
        title={`La pantalla ${textos.de} no está habilitada`}
        description="Activá «Vista de cocina mínima por estación» (kitchen.view) en Admin → Funciones."
      />
    )
  }

  function refreshRounds() {
    void queryClient.invalidateQueries({ queryKey: ["kds", "rounds"] })
  }

  function refreshPrintJobs() {
    void queryClient.invalidateQueries({ queryKey: ["kds", "print-jobs"] })
  }

  // Lo «de ayer» (turno abandonado, mesa sin cerrar) no es la cola de hoy:
  // se aparta por defecto y va al final cuando se pide verlo. Lo de hoy, del
  // más demorado al menos (la demora es la del servidor).
  const porDemora = (a: OrderGroup, b: OrderGroup) =>
    Number(pendientesDe(b).length > 0) - Number(pendientesDe(a).length > 0) || demoraDe(b) - demoraDe(a)
  const allGroups = groupRoundsByOrder(soloEstaciones(rounds.data ?? [], queda))
  const staleCount = allGroups.filter((g) => g.stale).length
  const hoy = allGroups.filter((g) => !g.stale).sort(porDemora)
  const groups = showStale ? [...hoy, ...allGroups.filter((g) => g.stale).sort(porDemora)] : hoy
  const jobs = (printJobs.data ?? []).filter((j) => queda(j.station))

  // La barra: estaciones configuradas + las que aparecen en los tiquetes, y
  // cuántos platos de hoy faltan en cada una.
  const gruposTodas = groupRoundsByOrder(
    soloEstaciones((station === undefined ? rounds.data : todas.data) ?? [], queda),
  ).filter((g) => !g.stale)
  const pendientesHoy = gruposTodas.flatMap(pendientesDe)
  const vistas = pendientesHoy.map((i) => i.station ?? "").filter(Boolean)
  const stations = estacionesDeLaBarra(configuradas.data, vistas, station).filter(queda)
  const platosEn = (s: string | undefined) =>
    pendientesHoy.filter((i) => s === undefined || i.station === s).reduce((n, i) => n + (i.qty ?? 1), 0)
  const resumen = { red: 0, amber: 0, green: 0 } as Record<KitchenSemaphoreValue, number>
  for (const g of hoy) {
    const p = pendientesDe(g)
    if (p.length > 0) resumen[worstSemaphore(p.map((i) => i.semaphore))] += 1
  }
  const personActive = hasActivePerson(employee, employeeExpiresAt)
  const tabla = repartirEnColumnas(groups, columnas)
  // Qué expide «Todo listo»: la estación elegida; en «Todas» del bar, las
  // estaciones del bar que tenga la comanda (nunca la cocina); en «Todas» de
  // la cocina, la comanda completa.
  const expedirEn = (g: OrderGroup): string[] | undefined => {
    if (station !== undefined) return [station]
    if (!esBar) return undefined
    return Array.from(new Set(pendientesDe(g).map((i) => i.station ?? ""))).filter(Boolean)
  }
  const Icono = textos.Icono

  return (
    <FullKdsContext.Provider value={full}>
      <AttributeContext.Provider value={attribute}>
        <GrandeContext.Provider value={fullscreen}>
          <Tabs
            defaultValue="rounds"
            className={cn(
              "flex flex-col gap-3 bg-background p-3 text-foreground tabular-nums",
              fullscreen ? "kds-completa fixed inset-0 z-40 overflow-y-auto" : "min-h-full",
            )}
          >
            <header className="flex min-h-[84px] flex-none flex-wrap items-center gap-4 rounded-[26px] bg-card py-3.5 pr-3.5 pl-4">
              <span className="grid size-14 flex-none place-items-center rounded-[18px] bg-foreground text-card">
                <Icono className="size-[26px]" aria-hidden="true" />
              </span>
              <span className="flex flex-col">
                <h1 className="text-[28px] leading-tight font-semibold tracking-[-0.02em]">{textos.titulo}</h1>
                <span className="text-[15px] text-muted-foreground">
                  {me?.store?.name ? `${me.store.name} · ` : ""}
                  {formatFechaCorta(hoyBogota(ahora))} · {formatClockTime(ahora.toISOString())}
                </span>
              </span>
              {/* Estaciones con el recuento de platos que faltan: el
                  segmentado del handoff en su tamaño de cocina (56 px, aire
                  de 5, letra de 18). */}
              <div role="group" aria-label="Estación" className="ml-5 flex flex-wrap gap-1 rounded-[20px] bg-muted p-[5px]">
                {[undefined, ...stations].map((value) => {
                  const activa = station === value
                  return (
                    <button
                      key={value ?? "__todas__"}
                      type="button"
                      aria-pressed={activa}
                      onClick={() => setStation(value)}
                      className={cn(
                        "inline-flex h-14 items-center gap-2 rounded-[15px] px-[22px] text-[18px] text-foreground transition-colors",
                        "focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                        activa ? "bg-card font-semibold shadow-[0_1px_2px_rgb(0_0_0/10%)]" : "font-medium",
                      )}
                    >
                      {value === undefined ? "Todas" : stationLabel(value)}
                      <span aria-hidden="true" className="text-[15px] font-normal text-muted-foreground">
                        {platosEn(value)}
                      </span>
                    </button>
                  )
                })}
              </div>
              {/* ■ ▲ ●: forma, color y palabra; nunca sólo color. */}
              <p className="ml-auto flex flex-wrap gap-2" aria-label="Tiquetes por demora">
                {RESUMEN.map((valor) => (
                  <span
                    key={valor}
                    className={cn(
                      "inline-flex h-11 items-center gap-2 rounded-[22px] px-4 text-[17px] font-semibold",
                      TONO[valor].suave,
                      TONO[valor].texto,
                    )}
                  >
                    <Forma valor={valor} />
                    {resumen[valor]} {TONO[valor].resumen}
                  </span>
                ))}
              </p>
              <button
                type="button"
                onClick={toggleFullscreen}
                className="inline-flex h-14 items-center gap-2 rounded-[18px] bg-muted px-[18px] text-[16px] font-medium text-foreground transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                {fullscreen ? (
                  <Minimize className="size-[18px]" aria-hidden="true" />
                ) : (
                  <Maximize className="size-[18px]" aria-hidden="true" />
                )}
                {fullscreen ? "Salir de pantalla completa" : "Pantalla completa"}
              </button>
            </header>

            {/* Los ajustes de la pantalla (no van en la barra): quién marca,
                lo de ayer, la impresión por estación y claro / noche. */}
            <div className="flex flex-wrap items-center gap-3 px-1">
              <p className="mr-auto text-[15px] text-muted-foreground">
                {personActive && employee ? `Marca: ${employee.name}` : "Nadie identificado · el PIN se pide al marcar"}
              </p>
              {staleCount > 0 ? (
                <Button
                  type="button"
                  variant="ghost"
                  className="h-12 rounded-[16px] bg-muted px-4 text-[16px]"
                  aria-pressed={showStale}
                  onClick={toggleStale}
                >
                  <History className="size-5" aria-hidden="true" />
                  {showStale ? "Ocultar lo de ayer" : `Ver lo de ayer (${staleCount})`}
                </Button>
              ) : null}
              {full ? (
                <TabsList className="h-12 rounded-[16px] bg-muted p-1">
                  <TabsTrigger value="rounds" className="rounded-[12px] px-4 text-[16px]">
                    Tiquetes
                  </TabsTrigger>
                  <TabsTrigger value="print" className="rounded-[12px] px-4 text-[16px]">
                    Impresión por estación
                  </TabsTrigger>
                </TabsList>
              ) : null}
              <SegmentadoTactil
                etiqueta="Pantalla"
                opciones={[
                  { value: "noche", label: "Noche", testId: "kds-tema-noche" },
                  { value: "claro", label: "Claro", testId: "kds-tema-claro" },
                ]}
                valor={tema}
                onChange={setTema}
                alto={44}
              />
            </div>

            <TabsContent value="rounds" className="flex flex-col gap-3">
              {rounds.isLoading ? (
                <Cargando texto="Cargando rondas…" />
              ) : rounds.isError ? (
                <EmptyState
                  role="alert"
                  title="No se pudieron cargar las rondas"
                  description={errorMessage(rounds.error)}
                  action={{ label: "Reintentar", onClick: () => void rounds.refetch() }}
                />
              ) : groups.length === 0 ? (
                <EmptyState
                  title="No hay rondas pendientes"
                  description={
                    staleCount > 0
                      ? `Las comandas enviadas ${textos.a} aparecen acá. Hay ${staleCount} de días anteriores apartada${staleCount === 1 ? "" : "s"}.`
                      : `Las comandas enviadas ${textos.a} aparecen acá.`
                  }
                />
              ) : null}
              {/* Cuatro columnas; los tiquetes se reparten por turno (el
                  i-ésimo va a la columna i % 4), así la primera fila es la de
                  los más demorados. */}
              <div
                ref={gridRef}
                className="grid items-start gap-3"
                style={{ gridTemplateColumns: `repeat(${columnas}, minmax(0, 1fr))` }}
              >
                {!rounds.isLoading && !rounds.isError
                  ? tabla.map((columna, i) => (
                      <div key={i} className="flex min-w-0 flex-col gap-3">
                        {columna.map((group) => (
                          <OrderCard
                            key={group.orderId}
                            group={group}
                            station={station}
                            expedirEn={expedirEn(group)}
                            onChanged={refreshRounds}
                          />
                        ))}
                      </div>
                    ))
                  : null}
              </div>
            </TabsContent>

            {full ? (
              <TabsContent value="print" className="rounded-[26px] bg-card p-4">
                <p className="mb-3 text-[15px] text-muted-foreground">
                  Esto registra qué se imprimió, para qué estación y quién lo confirmó — no envía nada a una impresora
                  física (impresora térmica real: fase 3).
                </p>
                {printJobs.isLoading ? (
                  <Cargando texto="Cargando trabajos de impresión…" />
                ) : printJobs.isError ? (
                  <EmptyState
                    role="alert"
                    title="No se pudieron cargar los trabajos de impresión"
                    description={errorMessage(printJobs.error)}
                    action={{ label: "Reintentar", onClick: () => void printJobs.refetch() }}
                  />
                ) : jobs.length === 0 ? (
                  <EmptyState title="Nada para imprimir" description="Un docket aparece acá mientras tenga ítems enviados o listos." />
                ) : (
                  <ul className="space-y-2.5">
                    {jobs.map((job) => (
                      <PrintJobRow key={`${job.round_id}-${job.station}`} job={job} onChanged={refreshPrintJobs} />
                    ))}
                  </ul>
                )}
              </TabsContent>
            ) : null}
          </Tabs>

          {pinRequest ? (
            <StationPinDialog
              open
              lastPerson={pinRequest.person}
              actionLabel={pinRequest.label}
              onIdentified={handleIdentified}
              onCancel={handlePinCancel}
            />
          ) : null}
        </GrandeContext.Provider>
      </AttributeContext.Provider>
    </FullKdsContext.Provider>
  )
}

export default KdsPage
