import { useQueryClient } from "@tanstack/react-query"
import { CheckCircle2, History, Maximize2, Minimize2, Printer, Rocket, TriangleAlert, Undo2 } from "lucide-react"
import { createContext, useCallback, useContext, useEffect, useState } from "react"

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
import { errorMessage } from "@/lib/errors"
import { stationLabel } from "@/lib/stations"
import { cn } from "@/lib/utils"

import { useKdsPrintJobs, useKdsRounds } from "./hooks"
import {
  channelLabel,
  courseLabel,
  elapsedFromSeconds,
  hasActivePerson,
  mentionsAllergy,
  readKdsPrefs,
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
      <p className="tiquete-alergia flex items-start gap-1.5">
        <TriangleAlert className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
        <span>
          <span className="sr-only">Alerta de alergia: </span>
          {kind === "note" ? `Nota: ${text}` : text}
        </span>
      </p>
    )
  }
  if (kind === "modifiers") return <p className="tiquete-modificadores">{text}</p>
  return <p className="tiquete-detalle italic">Nota: {text}</p>
}

function ItemRow({ item, onChanged }: { item: KitchenRoundItemOut; onChanged: () => void }): React.JSX.Element {
  const attribute = useContext(AttributeContext)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const semaphore = (item.semaphore ?? "green") as KitchenSemaphoreValue
  const ready = item.status === "ready"
  const fired = item.course_fired_at != null
  const name = item.name ?? "ítem"

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
    <li className={cn("tiquete-item space-y-1.5 py-2.5", ready && "opacity-70")}>
      {/* Arriba el plato y su botón; abajo, a todo lo ancho del tiquete, lo
          que cocina tiene que leer (modificadores, nota, alergia). */}
      <div className="flex items-start justify-between gap-2">
        <p className={cn("tiquete-plato min-w-0 flex-1 pt-1", ready && "line-through decoration-2")}>
          {item.qty ?? 1}× {item.name ?? "—"}
        </p>
        <Button
          type="button"
          variant={ready ? "outline" : "default"}
          className="h-12 min-w-[112px] shrink-0 text-base"
          disabled={pending}
          onClick={() => void handleToggle()}
          aria-label={ready ? `Deshacer listo: ${name}` : `Marcar listo: ${name}`}
        >
          {pending ? (
            "…"
          ) : ready ? (
            <>
              <Undo2 className="size-4" aria-hidden="true" />
              Deshacer
            </>
          ) : (
            <>
              <CheckCircle2 className="size-5" aria-hidden="true" />
              Listo
            </>
          )}
        </Button>
      </div>
      {item.modifiers_text ? <Detalle text={item.modifiers_text} kind="modifiers" /> : null}
      {item.note ? <Detalle text={item.note} kind="note" /> : null}
      <div className="flex flex-wrap items-center gap-1.5">
        {item.course ? <Badge variant="outline">{courseLabel(item.course)}</Badge> : null}
        {fired ? (
          <Badge variant="secondary" title="Curso marchado">
            Marchado
          </Badge>
        ) : null}
        {/* Forma y color a la vez (● a tiempo, ▲ por vencer, ■ demorado):
            la urgencia se lee también sin distinguir rojo de verde. */}
        <span
          className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 font-mono text-xs font-medium ${SEMAPHORE_CLASS[semaphore]}`}
        >
          <i className={`semaforo semaforo-${semaphore}`} aria-hidden="true" />
          {elapsedFromSeconds(item.elapsed_seconds ?? 0)} · {SEMAPHORE_LABEL[semaphore]}
        </span>
      </div>
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
  const items = group.rounds.flatMap((r) => r.items ?? [])
  const pendientes = items.filter((i) => i.status === "sent")
  const hasSent = pendientes.length > 0
  // La cabecera toma el color del plato más urgente que falta: el que manda
  // el servidor, sin recalcular nada.
  const semaphore = worstSemaphore(pendientes.map((i) => i.semaphore))
  const oldestSeconds = Math.max(0, ...group.rounds.map((r) => r.elapsed_seconds ?? 0))
  const expediteLabel = station ? `Expedir ${stationLabel(station)}` : "Expedir comanda"

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
    <article className="tiquete flex flex-col" aria-label={`Comanda #${group.orderId}, ${destino(group)}`}>
      <header
        className={cn(
          "tiquete-cabeza-color rounded-t-[4px] px-3 py-2",
          hasSent ? SEMAPHORE_CLASS[semaphore] : "bg-secondary text-secondary-foreground",
        )}
      >
        <div className="flex flex-wrap items-baseline justify-between gap-x-3">
          <p className="tiquete-destino min-w-0 break-words">{destino(group)}</p>
          <p className="tiquete-minutos flex shrink-0 items-center gap-1.5">
            {hasSent ? <i className={`semaforo semaforo-${semaphore}`} aria-hidden="true" /> : null}
            {elapsedFromSeconds(oldestSeconds)}
          </p>
        </div>
        <p className="font-mono text-xs font-semibold">
          Comanda #{group.orderId} · {channelLabel(group.channel)}
          {hasSent ? ` · ${SEMAPHORE_LABEL[semaphore]}` : " · Todo listo"}
        </p>
      </header>
      <div className="flex flex-1 flex-col space-y-2 p-3">
        <div className="flex flex-wrap items-center gap-1.5">
          {group.stale ? (
            <Badge variant="destructive" title="Comanda de un día operativo anterior que sigue abierta">
              De ayer
            </Badge>
          ) : null}
          {group.covers ? <Badge variant="outline">{group.covers} comensales</Badge> : null}
          {group.platform ? (
            <Badge variant="secondary">
              {group.platform.source ?? "Plataforma"}
              {group.platform.external_id ? ` · ${group.platform.external_id}` : ""}
            </Badge>
          ) : null}
        </div>
        {group.rounds.map((round) => (
          <div key={`${round.order_id}-${round.round_no}`} className="space-y-2">
            {group.rounds.length > 1 ? (
              <p className="tiquete-detalle font-mono text-xs font-medium">
                Ronda {round.round_no} · {elapsedFromSeconds(round.elapsed_seconds ?? 0)}
              </p>
            ) : null}
            <ul>
              {(round.items ?? []).map((item) => (
                <ItemRow key={item.item_id} item={item} onChanged={onChanged} />
              ))}
            </ul>
          </div>
        ))}
        {error ? (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        ) : null}
        <Button
          type="button"
          variant="outline"
          className="mt-auto h-12 w-full"
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

export function KdsPage(): React.JSX.Element {
  useCocinaPantalla()
  const { me, hasFeature, refresh } = useSession()
  const enabled = hasFeature("kitchen.kds")
  const queryClient = useQueryClient()

  const [prefs] = useState(readKdsPrefs)
  const [station, setStationState] = useState<string | undefined>(prefs.station)
  const [knownStations, setKnownStations] = useState<string[]>([])
  const [showStale, setShowStale] = useState(prefs.showStale ?? false)
  const [fullscreen, setFullscreen] = useState(prefs.fullscreen ?? false)
  const [storedPerson, setStoredPerson] = useState<StationPerson | null>(prefs.lastPerson ?? null)
  const [pinRequest, setPinRequest] = useState<PinRequest | null>(null)
  const rounds = useKdsRounds(station, enabled)
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

  useEffect(() => {
    if (station !== undefined || !rounds.data) return
    const set = new Set<string>()
    for (const round of rounds.data) {
      for (const item of round.items ?? []) {
        if (item.station) set.add(item.station)
      }
    }
    setKnownStations(Array.from(set).sort())
  }, [rounds.data, station])

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

  const allGroups = groupRoundsByOrder(rounds.data ?? [])
  const staleCount = allGroups.filter((g) => g.stale).length
  // Lo «de ayer» (turno abandonado, mesa sin cerrar) no es la cola de hoy:
  // se aparta por defecto y va al final cuando se pide verlo.
  const groups = showStale
    ? [...allGroups.filter((g) => !g.stale), ...allGroups.filter((g) => g.stale)]
    : allGroups.filter((g) => !g.stale)
  const jobs = printJobs.data ?? []
  const stations = station !== undefined && !knownStations.includes(station) ? [...knownStations, station] : knownStations
  const personActive = hasActivePerson(employee, employeeExpiresAt)

  return (
    <AttributeContext.Provider value={attribute}>
      <div
        className={cn(
          "space-y-4",
          fullscreen && "kds-completa fixed inset-0 z-40 overflow-y-auto bg-background p-4 text-foreground",
        )}
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-lg font-semibold">Tiquetes de cocina</h1>
            <p className="text-sm text-muted-foreground">
              {personActive && employee ? `Marca: ${employee.name}` : "Nadie identificado · el PIN se pide al marcar"}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Estación">
              <Button
                type="button"
                variant={station === undefined ? "default" : "outline"}
                className="h-11"
                aria-pressed={station === undefined}
                onClick={() => setStation(undefined)}
              >
                Todas
              </Button>
              {stations.map((value) => (
                <Button
                  key={value}
                  type="button"
                  variant={station === value ? "default" : "outline"}
                  className="h-11"
                  aria-pressed={station === value}
                  onClick={() => setStation(value)}
                >
                  {stationLabel(value)}
                </Button>
              ))}
            </div>
            {staleCount > 0 ? (
              <Button type="button" variant="outline" className="h-11" aria-pressed={showStale} onClick={toggleStale}>
                <History className="size-4" aria-hidden="true" />
                {showStale ? "Ocultar lo de ayer" : `Ver lo de ayer (${staleCount})`}
              </Button>
            ) : null}
            <Button type="button" variant="outline" className="h-11" aria-pressed={fullscreen} onClick={toggleFullscreen}>
              {fullscreen ? (
                <Minimize2 className="size-4" aria-hidden="true" />
              ) : (
                <Maximize2 className="size-4" aria-hidden="true" />
              )}
              {fullscreen ? "Salir de pantalla completa" : "Pantalla completa"}
            </Button>
          </div>
        </div>

        <Tabs defaultValue="rounds">
          <TabsList>
            <TabsTrigger value="rounds">Cocina</TabsTrigger>
            <TabsTrigger value="print">Impresión por estación</TabsTrigger>
          </TabsList>

          <TabsContent value="rounds" className="pt-4">
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
            ) : (
              // Columnas automáticas: tantas como entren de 300 px (seis en
              // 1920, cuatro en 1280), sin cortes fijos por breakpoint.
              <div className="grid items-start gap-3 [grid-template-columns:repeat(auto-fill,minmax(min(100%,300px),1fr))]">
                {groups.map((group) => (
                  <OrderCard key={group.orderId} group={group} station={station} onChanged={refreshRounds} />
                ))}
              </div>
            )}
          </TabsContent>

          <TabsContent value="print" className="pt-4">
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
      </div>

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
