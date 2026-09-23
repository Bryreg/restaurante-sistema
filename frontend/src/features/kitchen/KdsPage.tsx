import { useQueryClient } from "@tanstack/react-query"
import { CheckCircle2, Printer, Rocket, Undo2 } from "lucide-react"
import { useEffect, useState } from "react"

import { useSession } from "@/app/session"
import {
  bumpItem,
  expediteOrder,
  registerPrintJob,
  unbumpItem,
  type KitchenPrintJobOut,
  type KitchenRoundItemOut,
  type KitchenRoundOut,
} from "@/api/kitchen"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { EmptyState } from "@/components/EmptyState"
import { errorMessage } from "@/lib/errors"

import { useKdsPrintJobs, useKdsRounds } from "./hooks"
import { channelLabel, courseLabel, elapsedFromSeconds, SEMAPHORE_CLASS, SEMAPHORE_LABEL, type KitchenSemaphoreValue } from "./lib"

// -----------------------------------------------------------------------
// Ítem: bump / deshacer bump. El backend es idempotente (backend-kds.md §4):
// bumpear un ítem ya `ready` devuelve `changed: false`, NUNCA un error — el
// botón se deshabilita mientras hay un pedido en vuelo, así que dos toques
// rápidos del mismo dedo nunca chocan, pero si igual llegaran dos requests
// (dos personas, la misma pantalla compartida) la pantalla no se rompe ni
// queda en un estado raro.
// -----------------------------------------------------------------------

/**
 * Las estaciones de fábrica (`DEFAULT_STATIONS` en `app/stores/service.py`)
 * son códigos; en la pantalla de cocina salían crudos («hot_kitchen»). Una
 * estación que el dueño creó con su propio nombre se muestra tal cual.
 */
const STATION_LABEL: Record<string, string> = {
  hot_kitchen: "Cocina caliente",
  cold_kitchen: "Cocina fría",
  bar: "Bar",
  desserts: "Postres",
  none: "Sin estación",
}

function stationLabel(code: string): string {
  return STATION_LABEL[code] ?? code
}

function ItemRow({ item, onChanged }: { item: KitchenRoundItemOut; onChanged: () => void }): React.JSX.Element {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const semaphore = (item.semaphore ?? "green") as KitchenSemaphoreValue
  const ready = item.status === "ready"
  const fired = item.course_fired_at != null

  async function handleToggle() {
    setPending(true)
    setError(null)
    try {
      if (ready) {
        await unbumpItem(item.item_id)
      } else {
        await bumpItem(item.item_id)
      }
      onChanged()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setPending(false)
    }
  }

  return (
    <li className="tiquete-item space-y-1.5 py-2.5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <p className="tiquete-plato">
            {item.qty ?? 1}× {item.name ?? "—"}
          </p>
          {item.modifiers_text ? <p className="tiquete-detalle font-semibold">{item.modifiers_text}</p> : null}
          {item.note ? <p className="tiquete-detalle italic">Nota: {item.note}</p> : null}
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
              className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 font-mono text-xs font-medium ${SEMAPHORE_CLASS[semaphore]}`}
            >
              <i className={`semaforo semaforo-${semaphore}`} aria-hidden="true" />
              {elapsedFromSeconds(item.elapsed_seconds ?? 0)} · {SEMAPHORE_LABEL[semaphore]}
            </span>
          </div>
          {ready && item.bumped_by ? (
            <p className="tiquete-detalle text-xs">Lo marcó listo {item.bumped_by.name}</p>
          ) : null}
        </div>
        <Button
          type="button"
          variant={ready ? "outline" : "default"}
          className="h-11 min-w-[104px] shrink-0"
          disabled={pending}
          onClick={() => void handleToggle()}
          aria-label={ready ? `Deshacer listo: ${item.name ?? "ítem"}` : `Marcar listo: ${item.name ?? "ítem"}`}
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
              <CheckCircle2 className="size-4" aria-hidden="true" />
              Listo
            </>
          )}
        </Button>
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
// Comanda: agrupa TODAS sus rondas (usualmente una) bajo un solo header y
// un solo botón «Expedir comanda completa» — `POST
// /kitchen/orders/{order_id}/expedite` bumpea todos los `sent` de la
// comanda ENTERA, no sólo la ronda que se ve en esta tarjeta
// (backend-kds.md §2), así que el botón vive acá y no por ronda.
// -----------------------------------------------------------------------

interface OrderGroup {
  orderId: number
  channel?: string
  tables?: string[]
  takeoutName?: string | null
  covers?: number | null
  platform?: KitchenRoundOut["platform"]
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
        rounds: [],
      }
      groups.set(round.order_id, group)
    }
    group.rounds.push(round)
  }
  return Array.from(groups.values())
}

function OrderCard({ group, onChanged }: { group: OrderGroup; onChanged: () => void }): React.JSX.Element {
  const [expediting, setExpediting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const hasSent = group.rounds.some((r) => (r.items ?? []).some((i) => i.status === "sent"))

  async function handleExpedite() {
    setExpediting(true)
    setError(null)
    try {
      await expediteOrder(group.orderId)
      onChanged()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setExpediting(false)
    }
  }

  return (
    <article className="tiquete space-y-2 p-3">
      <header className="tiquete-cabeza flex flex-wrap items-start justify-between gap-2 pb-2">
        <div className="min-w-0 space-y-1">
          <p className="tiquete-numero">Comanda #{group.orderId}</p>
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="outline">{channelLabel(group.channel)}</Badge>
            {group.tables && group.tables.length > 0 ? <Badge variant="outline">Mesa {group.tables.join(", ")}</Badge> : null}
            {group.takeoutName ? <Badge variant="outline">{group.takeoutName}</Badge> : null}
            {group.covers ? <Badge variant="outline">{group.covers} comensales</Badge> : null}
            {group.platform ? (
              <Badge variant="secondary">
                {group.platform.source ?? "Plataforma"}
                {group.platform.external_id ? ` · ${group.platform.external_id}` : ""}
              </Badge>
            ) : null}
          </div>
        </div>
        <Button
          type="button"
          variant="outline"
          className="h-11 shrink-0"
          disabled={expediting || !hasSent}
          onClick={() => void handleExpedite()}
          aria-label={`Expedir comanda completa #${group.orderId}`}
          title="Marca listos de un golpe todos los ítems enviados de esta comanda, en todas sus rondas"
        >
          <Rocket className="size-4" aria-hidden="true" />
          {expediting ? "Expidiendo…" : "Expedir comanda"}
        </Button>
      </header>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
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
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleConfirm() {
    setPending(true)
    setError(null)
    try {
      await registerPrintJob({ round_id: job.round_id, station: job.station })
      onChanged()
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
// Pantalla: KDS completo (`kitchen.kds`). La vista mínima de 1b
// (`/pos/cocina`, `kitchen.view`, `features/orders/KitchenPage.tsx`) sigue
// existiendo IGUAL y NO es de este territorio — con `kitchen.kds` apagada
// esta pantalla no se monta (el manifiesto la saca del router) y esa otra
// queda idéntica.
// -----------------------------------------------------------------------

export function KdsPage(): React.JSX.Element {
  const { hasFeature } = useSession()
  const enabled = hasFeature("kitchen.kds")
  const queryClient = useQueryClient()

  const [station, setStation] = useState<string | undefined>(undefined)
  const [knownStations, setKnownStations] = useState<string[]>([])
  const rounds = useKdsRounds(station, enabled)
  const printJobs = useKdsPrintJobs(station, enabled)

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

  const groups = groupRoundsByOrder(rounds.data ?? [])
  const jobs = printJobs.data ?? []

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-semibold">KDS</h1>
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
          {knownStations.map((value) => (
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
      </div>

      <Tabs defaultValue="rounds">
        <TabsList>
          <TabsTrigger value="rounds">Cocina</TabsTrigger>
          <TabsTrigger value="print">Impresión por estación</TabsTrigger>
        </TabsList>

        <TabsContent value="rounds" className="pt-4">
          {rounds.isLoading ? (
            <p className="text-sm text-muted-foreground">Cargando rondas…</p>
          ) : rounds.isError ? (
            <EmptyState
              role="alert"
              title="No se pudieron cargar las rondas"
              description={errorMessage(rounds.error)}
              action={{ label: "Reintentar", onClick: () => void rounds.refetch() }}
            />
          ) : groups.length === 0 ? (
            <EmptyState title="No hay rondas pendientes" description="Las comandas enviadas a cocina aparecen acá." />
          ) : (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {groups.map((group) => (
                <OrderCard key={group.orderId} group={group} onChanged={refreshRounds} />
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
            <p className="text-sm text-muted-foreground">Cargando trabajos de impresión…</p>
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
  )
}

export default KdsPage
