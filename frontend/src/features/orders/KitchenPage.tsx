import { useQueryClient } from "@tanstack/react-query"
import { CheckCircle2 } from "lucide-react"
import { useEffect, useState } from "react"

import { useCocinaPantalla } from "@/app/theme"
import { useSession } from "@/app/session"
import { newIdempotencyKey } from "@/api/client"
import { markReady } from "@/api/orders"
import type { KitchenRoundItemOut, KitchenSemaphore } from "@/api/kitchen"
import { Cargando } from "@/components/Cargando"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { EmptyState } from "@/components/EmptyState"
import { errorMessage } from "@/lib/errors"

import { kitchenRoundsQueryKey, useKitchenRounds } from "./hooks"
import { CHANNEL_LABEL, courseLabel, elapsedFromSeconds } from "./lib"

const SEMAPHORE_LABEL: Record<KitchenSemaphore, string> = { green: "A tiempo", amber: "Por vencer", red: "Demorado" }
// El semáforo de cocina sigue siendo sólido y con tinta invertida: el KDS se
// lee cruzado por la cocina y el estado tiene que gritar. Lo que cambió es de
// dónde sale el color. La excepción de CONTRATO-INTERNO §6.1 («clases crudas
// de Tailwind, nunca un token de color de marca») existía porque NO había
// tokens de estado; ahora los hay, y no son de marca: `success`/`warning`/
// `destructive` son de estado y nada más (`docs/DISENO.md`). De paso arregla
// el contraste que el comentario anterior daba por AA y no lo era: blanco
// sobre `emerald-600` da 3,77:1 y sobre `amber-600` 3,19:1 — por debajo de
// 4,5:1. Los de m2b dan 5,02:1, 5,02:1 y 6,47:1.
const SEMAPHORE_CLASS: Record<KitchenSemaphore, string> = {
  green: "bg-success text-success-foreground",
  amber: "bg-warning text-warning-foreground",
  red: "bg-destructive text-destructive-foreground",
}

function ItemRow({
  item,
  orderId,
  onMarkedReady,
}: {
  item: KitchenRoundItemOut
  orderId: number
  onMarkedReady: () => void
}) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const semaphore = item.semaphore ?? "green"

  async function handleReady() {
    setPending(true)
    setError(null)
    try {
      await markReady(orderId, item.item_id, newIdempotencyKey())
      onMarkedReady()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setPending(false)
    }
  }

  return (
    <li className="space-y-1 rounded-md border p-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="space-y-0.5">
          <p className="font-medium">
            {item.qty ?? 1}× {item.name ?? "—"}
          </p>
          {item.modifiers_text ? <p className="text-sm font-semibold text-foreground">{item.modifiers_text}</p> : null}
          {item.note ? <p className="text-sm italic text-muted-foreground">Nota: {item.note}</p> : null}
          <div className="flex flex-wrap items-center gap-1">
            {item.course ? <Badge variant="outline">{courseLabel(item.course)}</Badge> : null}
            <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${SEMAPHORE_CLASS[semaphore]}`}>
              {elapsedFromSeconds(item.elapsed_seconds ?? 0)} · {SEMAPHORE_LABEL[semaphore]}
            </span>
          </div>
        </div>
        {item.status === "ready" ? (
          <span className="inline-flex h-11 items-center gap-1 px-2 text-sm text-muted-foreground">
            <CheckCircle2 className="size-5" aria-hidden="true" />
            Listo
          </span>
        ) : (
          <Button
            type="button"
            className="h-11 min-w-[88px]"
            disabled={pending}
            onClick={() => void handleReady()}
            aria-label={`Marcar listo: ${item.name ?? "ítem"}`}
          >
            {pending ? "Marcando…" : "Listo"}
          </Button>
        )}
      </div>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </li>
  )
}

/**
 * Vista de cocina mínima (SPEC-NEGOCIO §9.2): rondas por estación, orden de
 * llegada (el backend ya ordena por `sent_at`), semáforo por curso. No
 * navega a ninguna otra pantalla (CONTRATO-INTERNO §6.2).
 */
export function KitchenPage(): React.JSX.Element {
  useCocinaPantalla()
  const { hasFeature } = useSession()
  const enabled = hasFeature("kitchen.view")
  const queryClient = useQueryClient()

  const [station, setStation] = useState<string | undefined>(undefined)
  const [knownStations, setKnownStations] = useState<string[]>([])
  const rounds = useKitchenRounds(station, enabled)

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
        title="La vista de cocina no está habilitada"
        description="Activá «Cocina» (kitchen.view) en Admin → Funciones."
      />
    )
  }

  function refresh() {
    void queryClient.invalidateQueries({ queryKey: kitchenRoundsQueryKey(station) })
  }

  const rows = rounds.data ?? []

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-semibold">Cocina</h1>
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
              {value}
            </Button>
          ))}
        </div>
      </div>

      {rounds.isLoading ? (
        <Cargando texto="Cargando rondas…" />
      ) : rows.length === 0 ? (
        <EmptyState title="No hay rondas pendientes" description="Las comandas enviadas a cocina aparecen acá." />
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {rows.map((round) => (
            <article key={`${round.order_id}-${round.round_no}`} className="space-y-2 rounded-lg border p-3">
              <header className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="font-medium">
                    Comanda #{round.order_id} · Ronda {round.round_no}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {round.channel ? CHANNEL_LABEL[round.channel] ?? round.channel : "—"}
                    {round.tables && round.tables.length > 0 ? ` · Mesa ${round.tables.join(", ")}` : ""}
                    {round.takeout_name ? ` · ${round.takeout_name}` : ""}
                    {round.covers ? ` · ${round.covers} comensales` : ""}
                  </p>
                </div>
                <Badge variant="outline">{elapsedFromSeconds(round.elapsed_seconds ?? 0)}</Badge>
              </header>
              <ul className="space-y-2">
                {(round.items ?? []).map((item) => (
                  <ItemRow key={item.item_id} item={item} orderId={round.order_id} onMarkedReady={refresh} />
                ))}
              </ul>
            </article>
          ))}
        </div>
      )}
    </div>
  )
}

export default KitchenPage
