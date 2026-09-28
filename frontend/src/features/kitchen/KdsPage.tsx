import { useQueryClient } from "@tanstack/react-query"
import { Check, History, Maximize2, Minimize2, Printer, Rocket, TriangleAlert } from "lucide-react"
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react"

import { useCocinaPantalla } from "@/app/theme"
import { useSession } from "@/app/session"
import { ApiError } from "@/api/client"
import {
  bumpItem,
  expediteOrder,
  registerPrintJob,
  unbumpItem,
  type KitchenPrintJobOut,
  type KitchenRoundItemOut,
  type KitchenRoundOut,
} from "@/api/kitchen"
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
  estacionesDeLaBarra,
  hasActivePerson,
  mentionsAllergy,
  readKdsPrefs,
  repartirEnColumnas,
  SEMAPHORE_CLASS,
  SEMAPHORE_LABEL,
  worstSemaphore,
  writeKdsPrefs,
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
// Ítem: bump / deshacer bump. El backend es idempotente (backend-kds.md §4):
// bumpear un ítem ya `ready` devuelve `changed: false`, NUNCA un error — el
// botón se deshabilita mientras hay un pedido en vuelo, así que dos toques
// rápidos del mismo dedo nunca chocan, pero si igual llegaran dos requests
// (dos personas, la misma pantalla compartida) la pantalla no se rompe ni
// queda en un estado raro.
// -----------------------------------------------------------------------

/** Una línea de detalle del tiquete: amarilla si es un modificador, roja con ícono si nombra una alergia. */
function Detalle({ text, kind }: { text: string; kind: "modifiers" | "note" }): React.JSX.Element {
  if (mentionsAllergy(text)) {
    return (
      <p className="tiquete-alergia flex items-start gap-2">
        <TriangleAlert className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
        <span>
          <span className="sr-only">Alerta de alergia: </span>
          <span aria-hidden="true">ALERGIA: </span>
          {text}
        </span>
      </p>
    )
  }
  if (kind === "modifiers") return <p className="tiquete-modificadores">{text}</p>
  return <p className="tiquete-detalle italic">Nota: {text}</p>
}

/**
 * Un plato del tiquete (handoff POS, pantalla 6): «2× Arroz con pollo» en
 * letra condensada y «Listo» de 56 px —contorno verde; lleno, con el plato
 * tachado, cuando ya está—. Tocarlo otra vez lo deshace. Abajo, a todo lo
 * ancho, lo que cocina tiene que leer (modificadores, nota, alergia); y sólo
 * si dice algo, el curso marchado o un plato que va más tarde que su
 * tiquete (el semáforo del plato, tal cual lo mandó el servidor).
 */
function ItemRow({
  item,
  onChanged,
  semaforoTiquete,
}: {
  item: KitchenRoundItemOut
  onChanged: () => void
  /** El de la cabecera: si el plato dice lo mismo, no se repite. */
  semaforoTiquete: KitchenSemaphoreValue
}): React.JSX.Element {
  const attribute = useContext(AttributeContext)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const semaphore = (item.semaphore ?? "green") as KitchenSemaphoreValue
  const ready = item.status === "ready"
  const fired = item.course_fired_at != null
  const name = item.name ?? "ítem"
  const urgente = !ready && semaphore !== "green" && semaphore !== semaforoTiquete

  async function handleToggle() {
    setPending(true)
    setError(null)
    try {
      const result = await attribute(ready ? `Deshacer listo: ${name}` : `Marcar listo: ${name}`, () =>
        ready ? unbumpItem(item.item_id) : bumpItem(item.item_id),
      )
      if (result === "done") onChanged()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setPending(false)
    }
  }

  return (
    <li className="tiquete-item flex flex-col gap-1.5 px-3.5 py-2.5">
      <div className="flex items-center gap-2.5">
        <p className={cn("flex min-w-0 flex-1 items-center gap-2.5", ready && "opacity-55")}>
          <span className="tiquete-plato min-w-[34px] font-extrabold">{item.qty ?? 1}×</span>
          <span className={cn("tiquete-plato min-w-0 flex-1", ready && "line-through decoration-2")}>
            {item.name ?? "—"}
          </span>
        </p>
        <button
          type="button"
          disabled={pending}
          onClick={() => void handleToggle()}
          aria-label={ready ? `Deshacer listo: ${name}` : `Marcar listo: ${name}`}
          className={cn(
            "inline-flex h-[56px] min-w-[96px] shrink-0 items-center justify-center gap-1.5 rounded-[10px] border-2 border-success px-3 text-[17px] font-extrabold transition-colors",
            "focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:outline-none disabled:opacity-60",
            ready ? "bg-success text-success-foreground" : "bg-transparent text-success hover:bg-success/10",
          )}
        >
          {pending ? (
            "…"
          ) : (
            <>
              <Check className="size-5" aria-hidden="true" />
              Listo
            </>
          )}
        </button>
      </div>
      {item.modifiers_text ? <Detalle text={item.modifiers_text} kind="modifiers" /> : null}
      {item.note ? <Detalle text={item.note} kind="note" /> : null}
      {fired || urgente ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {item.course ? <Badge variant="outline">{courseLabel(item.course)}</Badge> : null}
          {fired ? (
            <Badge variant="secondary" title="Curso marchado">
              Marchado
            </Badge>
          ) : null}
          {/* Forma y color a la vez (▲ por vencer, ■ demorado): la urgencia
              se lee también sin distinguir rojo de verde. */}
          {urgente ? (
            <span
              className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 font-mono text-xs font-medium whitespace-nowrap ${SEMAPHORE_CLASS[semaphore]}`}
            >
              <i className={`semaforo semaforo-${semaphore}`} aria-hidden="true" />
              {elapsedFromSeconds(item.elapsed_seconds ?? 0)} · {SEMAPHORE_LABEL[semaphore]}
            </span>
          ) : null}
        </div>
      ) : null}
      {ready && item.bumped_by ? <p className="tiquete-detalle text-xs">Lo marcó listo {item.bumped_by.name}</p> : null}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </li>
  )
}

// -----------------------------------------------------------------------
// Comanda: agrupa TODAS sus rondas (usualmente una) bajo un solo header.
// «Expedir» respeta el filtro de estación: en «Todas» expide la comanda
// completa; filtrada, SÓLO esa estación (`POST .../expedite?station=`) — en
// «Cocina caliente» se despachaban también las cervezas del bar
// (comanda 464).
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

/** Los ítems que siguen en cocina (`sent`). */
function pendientesDe(group: OrderGroup): KitchenRoundItemOut[] {
  return group.rounds.flatMap((r) => r.items ?? []).filter((i) => i.status === "sent")
}

/**
 * El tiquete (handoff POS, pantalla 6): papel sobre la pizarra. La cabecera
 * va pintada con el semáforo del plato más urgente que falta —el que manda
 * el servidor, con su objetivo por curso y estación: ● a tiempo, ▲ por
 * vencer, ■ demorado (#0F7A6A, #9A6412, #C4302B dentro de `.tiquete`)—, con
 * la forma en blanco y mesa y minutos en 27 px condensados.
 */
function OrderCard({
  group,
  station,
  onChanged,
}: {
  group: OrderGroup
  station: string | undefined
  onChanged: () => void
}): React.JSX.Element {
  const attribute = useContext(AttributeContext)
  const [expediting, setExpediting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pendientes = pendientesDe(group)
  const hasSent = pendientes.length > 0
  // La cabecera toma el color del plato más urgente que falta: el que manda
  // el servidor, sin recalcular nada.
  const semaphore = worstSemaphore(pendientes.map((i) => i.semaphore))
  const expediteLabel = station ? `Expedir ${stationLabel(station)}` : "Expedir comanda"
  const meta = [
    group.channel === "dine_in" && group.tables && group.tables.length > 0 ? null : channelLabel(group.channel),
    group.covers ? `${group.covers} ${group.covers === 1 ? "comensal" : "comensales"}` : null,
    group.platform
      ? `${group.platform.source ?? "Plataforma"}${group.platform.external_id ? ` · ${group.platform.external_id}` : ""}`
      : null,
  ]
    .filter(Boolean)
    .join(" · ")

  async function handleExpedite() {
    setExpediting(true)
    setError(null)
    try {
      const result = await attribute(`${expediteLabel} #${group.orderId}`, () =>
        station ? expediteOrder(group.orderId, station) : expediteOrder(group.orderId),
      )
      if (result === "done") onChanged()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setExpediting(false)
    }
  }

  return (
    <article className="tiquete flex flex-col overflow-hidden" aria-label={`Comanda #${group.orderId}, ${destino(group)}`}>
      <header
        className={cn(
          "tiquete-cabeza-color flex items-center gap-2.5 px-3.5 py-2.5",
          hasSent ? SEMAPHORE_CLASS[semaphore] : "bg-secondary text-secondary-foreground",
        )}
      >
        {hasSent ? (
          <i className={`semaforo semaforo-${semaphore} text-[26px]`} aria-hidden="true" />
        ) : (
          <Check className="size-5 shrink-0" aria-hidden="true" />
        )}
        <p className="tiquete-destino min-w-0 flex-1 truncate" title={destino(group)}>
          {destino(group)}
        </p>
        <p className="tiquete-minutos shrink-0">{elapsedFromSeconds(demoraDe(group))}</p>
        <span className="sr-only">{hasSent ? ` · ${SEMAPHORE_LABEL[semaphore]}` : " · Todo listo"}</span>
      </header>
      <div className="tiquete-cabeza tiquete-detalle flex items-center justify-between gap-2 px-3.5 py-1.5 text-[15px]">
        <span className="min-w-0 truncate">
          {group.stale ? (
            <Badge variant="destructive" className="mr-1.5" title="Comanda de un día operativo anterior que sigue abierta">
              De ayer
            </Badge>
          ) : null}
          {meta}
        </span>
        <span className="shrink-0 font-mono">#{group.orderId}</span>
      </div>
      {group.rounds.map((round) => (
        <div key={`${round.order_id}-${round.round_no}`}>
          {group.rounds.length > 1 ? (
            <p className="tiquete-detalle px-3.5 pt-2 font-mono text-xs font-medium">
              Ronda {round.round_no} · {elapsedFromSeconds(round.elapsed_seconds ?? 0)}
            </p>
          ) : null}
          <ul>
            {(round.items ?? []).map((item) => (
              <ItemRow key={item.item_id} item={item} onChanged={onChanged} semaforoTiquete={semaphore} />
            ))}
          </ul>
        </div>
      ))}
      {error ? (
        <p role="alert" className="px-3.5 text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <div className="mt-auto border-t border-dashed border-[#CFC7B5] p-2.5">
        <Button
          type="button"
          variant="outline"
          className="h-12 w-full"
          disabled={expediting || !hasSent}
          onClick={() => void handleExpedite()}
          aria-label={
            station
              ? `Expedir ${stationLabel(station)} de la comanda #${group.orderId}`
              : `Expedir comanda completa #${group.orderId}`
          }
          title={
            station
              ? `Marca listos de un golpe sólo los ítems de ${stationLabel(station)} de esta comanda; las otras estaciones no se tocan`
              : EXPEDITE_ALL.title
          }
        >
          <Rocket className="size-4" aria-hidden="true" />
          {expediting ? "Expidiendo…" : expediteLabel}
        </Button>
      </div>
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
    <li className="space-y-2 rounded-md border p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <p className="font-medium">
            Comanda #{job.order_id} · Ronda {job.round_no} · {stationLabel(job.station)}
          </p>
          <p className="text-xs text-muted-foreground">
            {channelLabel(job.channel)}
            {job.tables.length > 0 ? ` · Mesa ${job.tables.join(", ")}` : ""} · {job.item_count} ítem
            {job.item_count === 1 ? "" : "s"}
          </p>
          <ul className="text-sm text-muted-foreground">
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
            className="h-11"
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
        <p role="alert" className="text-xs text-destructive">
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

// -----------------------------------------------------------------------
// Pantalla: KDS completo (`kitchen.kds`). La vista mínima de 1b
// (`/pos/cocina`, `kitchen.view`, `features/orders/KitchenPage.tsx`) cede su
// lugar cuando esta función está encendida — con `kitchen.kds` apagada esta
// pantalla no se monta (el manifiesto la saca del router) y esa otra queda
// idéntica.
// -----------------------------------------------------------------------

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

/** Cuántas columnas de tiquetes entran en el ancho de la grilla (hasta cinco, de 300 px mínimo). */
function useColumnas(): [React.RefCallback<HTMLDivElement>, number] {
  const [columnas, setColumnas] = useState(1)
  const observer = useRef<ResizeObserver | null>(null)
  const ref = useCallback((el: HTMLDivElement | null) => {
    observer.current?.disconnect()
    observer.current = null
    if (!el) return
    const medir = () => setColumnas(columnasQueEntran(el.clientWidth))
    medir()
    if (typeof ResizeObserver !== "undefined") {
      observer.current = new ResizeObserver(medir)
      observer.current.observe(el)
    }
  }, [])
  return [ref, columnas]
}

const RESUMEN: { valor: KitchenSemaphoreValue; texto: string; clase: string }[] = [
  { valor: "red", texto: "demorados", clase: "text-destructive" },
  { valor: "amber", texto: "por vencer", clase: "text-warning" },
  { valor: "green", texto: "a tiempo", clase: "text-success" },
]

export function KdsPage(): React.JSX.Element {
  useCocinaPantalla()
  const { me, hasFeature, refresh } = useSession()
  const enabled = hasFeature("kitchen.kds")
  const queryClient = useQueryClient()
  const ahora = useAhora()
  const [gridRef, columnas] = useColumnas()

  const [prefs] = useState(readKdsPrefs)
  const [station, setStationState] = useState<string | undefined>(prefs.station)
  const [showStale, setShowStale] = useState(prefs.showStale ?? false)
  const [fullscreen, setFullscreen] = useState(prefs.fullscreen ?? false)
  const [storedPerson, setStoredPerson] = useState<StationPerson | null>(prefs.lastPerson ?? null)
  const [pinRequest, setPinRequest] = useState<PinRequest | null>(null)
  const rounds = useKdsRounds(station, enabled)
  // Los conteos de la barra son de todas las estaciones: con una elegida,
  // se piden también todas (sin estación elegida, es la misma consulta).
  const todas = useKdsRounds(undefined, enabled && station !== undefined)
  const configuradas = useKdsStations(enabled)
  const printJobs = useKdsPrintJobs(station, enabled)

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
    writeKdsPrefs({ station: next })
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

  if (!enabled) {
    return (
      <EmptyState
        title="El KDS no está habilitado"
        description="Activá «KDS completo: bump, expedición e impresión por estación» (kitchen.kds) en Admin → Funciones."
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
  const allGroups = groupRoundsByOrder(rounds.data ?? [])
  const staleCount = allGroups.filter((g) => g.stale).length
  const hoy = allGroups.filter((g) => !g.stale).sort(porDemora)
  const groups = showStale ? [...hoy, ...allGroups.filter((g) => g.stale).sort(porDemora)] : hoy
  const jobs = printJobs.data ?? []

  // La barra: estaciones configuradas + las que aparecen en los tiquetes, y
  // cuántos tiquetes de hoy tienen algo pendiente en cada una.
  const gruposTodas = groupRoundsByOrder((station === undefined ? rounds.data : todas.data) ?? []).filter(
    (g) => !g.stale,
  )
  const vistas = gruposTodas.flatMap((g) => pendientesDe(g).map((i) => i.station ?? "")).filter(Boolean)
  const stations = estacionesDeLaBarra(configuradas.data, vistas, station)
  const conPendientes = gruposTodas.filter((g) => pendientesDe(g).length > 0)
  const cuantosEn = (s: string) => conPendientes.filter((g) => pendientesDe(g).some((i) => i.station === s)).length
  const resumen = { red: 0, amber: 0, green: 0 } as Record<KitchenSemaphoreValue, number>
  for (const g of hoy) {
    const p = pendientesDe(g)
    if (p.length > 0) resumen[worstSemaphore(p.map((i) => i.semaphore))] += 1
  }
  const personActive = hasActivePerson(employee, employeeExpiresAt)
  const tabla = repartirEnColumnas(groups, columnas)

  const estacionBoton = (activa: boolean) =>
    cn(
      "inline-flex h-[56px] items-center gap-2 rounded-[12px] border px-5 text-[18px] font-bold transition-colors",
      "focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
      activa ? "border-foreground bg-foreground text-background" : "border-input bg-card text-foreground hover:bg-muted",
    )

  return (
    <AttributeContext.Provider value={attribute}>
      <Tabs
        defaultValue="rounds"
        className={cn(
          "gap-0 bg-background text-foreground tabular-nums",
          fullscreen ? "kds-completa fixed inset-0 z-40 overflow-y-auto" : "min-h-full",
        )}
      >
        <header className="flex flex-wrap items-center gap-3.5 border-b px-5 py-3">
          <div className="mr-2 flex flex-col">
            <h1 className="text-[26px] leading-tight font-bold [font-stretch:90%]">Cocina</h1>
            <span className="text-[15px] text-muted-foreground">
              {me?.store?.name ? `${me.store.name} · ` : ""}
              {formatFechaCorta(hoyBogota(ahora))}
            </span>
          </div>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Estación">
            <button
              type="button"
              className={estacionBoton(station === undefined)}
              aria-pressed={station === undefined}
              onClick={() => setStation(undefined)}
            >
              Todas
              <span aria-hidden="true" className="text-[15px] font-semibold opacity-75">
                {conPendientes.length}
              </span>
            </button>
            {stations.map((value) => (
              <button
                key={value}
                type="button"
                className={estacionBoton(station === value)}
                aria-pressed={station === value}
                onClick={() => setStation(value)}
              >
                {stationLabel(value)}
                <span aria-hidden="true" className="text-[15px] font-semibold opacity-75">
                  {cuantosEn(value)}
                </span>
              </button>
            ))}
          </div>
          <div className="flex-1" />
          {/* ■ ▲ ●: forma, color y palabra; nunca sólo color. */}
          <p className="flex flex-wrap gap-[18px] text-[17px] font-semibold" aria-label="Tiquetes por demora">
            {RESUMEN.map((r) => (
              <span key={r.valor} className={cn("inline-flex items-center gap-2", r.clase)}>
                <i className={`semaforo semaforo-${r.valor} text-[20px]`} aria-hidden="true" />
                {resumen[r.valor]} {r.texto}
              </span>
            ))}
          </p>
          <p className="ml-2.5 text-[30px] font-bold">{formatClockTime(ahora.toISOString())}</p>
          <Button
            type="button"
            variant="outline"
            className="h-[56px] rounded-[12px] border-input bg-card px-[18px] text-[17px] font-semibold"
            aria-pressed={fullscreen}
            onClick={toggleFullscreen}
          >
            {fullscreen ? (
              <Minimize2 className="size-[22px]" aria-hidden="true" />
            ) : (
              <Maximize2 className="size-[22px]" aria-hidden="true" />
            )}
            {fullscreen ? "Salir de pantalla completa" : "Pantalla completa"}
          </Button>
        </header>
        <div className="flex flex-wrap items-center gap-3 px-5 pt-3">
          <p className="mr-auto text-[15px] text-muted-foreground">
            {personActive && employee ? `Marca: ${employee.name}` : "Nadie identificado · el PIN se pide al marcar"}
          </p>
          {staleCount > 0 ? (
            <Button
              type="button"
              variant="outline"
              className="h-[48px] rounded-[12px] px-4 text-[16px]"
              aria-pressed={showStale}
              onClick={toggleStale}
            >
              <History className="size-5" aria-hidden="true" />
              {showStale ? "Ocultar lo de ayer" : `Ver lo de ayer (${staleCount})`}
            </Button>
          ) : null}
          <TabsList className="h-[48px]">
            <TabsTrigger value="rounds" className="px-4 text-[16px]">
              Cocina
            </TabsTrigger>
            <TabsTrigger value="print" className="px-4 text-[16px]">
              Impresión por estación
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="rounds" className="px-5 py-4">
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
                  ? `Las comandas enviadas a cocina aparecen acá. Hay ${staleCount} de días anteriores apartada${staleCount === 1 ? "" : "s"}.`
                  : "Las comandas enviadas a cocina aparecen acá."
              }
            />
          ) : null}
          {/* Hasta cinco columnas de 300 px como mínimo; los tiquetes se
              reparten por turno, así la primera fila es la de los más
              demorados. */}
          <div
            ref={gridRef}
            className="grid items-start gap-4"
            style={{ gridTemplateColumns: `repeat(${columnas}, minmax(0, 1fr))` }}
          >
            {!rounds.isLoading && !rounds.isError
              ? tabla.map((columna, i) => (
                  <div key={i} className="flex min-w-0 flex-col gap-4">
                    {columna.map((group) => (
                      <OrderCard key={group.orderId} group={group} station={station} onChanged={refreshRounds} />
                    ))}
                  </div>
                ))
              : null}
          </div>
        </TabsContent>

        <TabsContent value="print" className="px-5 py-4">
          <p className="mb-3 text-sm text-muted-foreground">
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
            <ul className="space-y-2">
              {jobs.map((job) => (
                <PrintJobRow key={`${job.round_id}-${job.station}`} job={job} onChanged={refreshPrintJobs} />
              ))}
            </ul>
          )}
        </TabsContent>
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
    </AttributeContext.Provider>
  )
}

export default KdsPage
