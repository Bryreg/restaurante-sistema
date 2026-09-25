import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useRef, useState } from "react"
import { toast } from "sonner"

import {
  answerAreaRecount,
  getDeviceAreaCount,
  postAreaCount,
  type AreaCountItemOut,
  type AreaCountLineIn,
  type AreaCountRegularMoment,
  type DeviceAreaRecountOut,
} from "@/api/areaCounts"
import { ApiError, newIdempotencyKey } from "@/api/client"
import { useSession } from "@/app/session"
import { Cargando } from "@/components/Cargando"
import { EmptyState } from "@/components/EmptyState"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { formatInstant } from "@/lib/businessDate"
import { errorMessage } from "@/lib/errors"
import { cn } from "@/lib/utils"

import { AREA_COUNT_QUERY_KEY } from "./areaCountLib"

const MOMENT_LABEL: Record<AreaCountRegularMoment, string> = {
  opening: "Apertura",
  closing: "Cierre",
}

/** Décimas de la botella abierta: 0 a 9. */
const DECIMAS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"] as const

/**
 * Lo que la persona tecleó para un artículo, tal cual. Para una botella son
 * dos partes (enteras y décimas de la abierta); el texto que viaja al
 * servidor es «enteras.décimas» — se escribe, no se calcula: la conversión a
 * mililitros la hace el servidor.
 */
interface Entrada {
  valor: string
  decimas: string
}

type Entradas = Record<number, Entrada>

function textoDe(item: AreaCountItemOut, entrada: Entrada | undefined): string | null {
  if (!entrada || entrada.valor.trim() === "") return null
  const valor = entrada.valor.trim()
  if (item.entry_mode === "bottle") return entrada.decimas === "0" ? valor : `${valor}.${entrada.decimas}`
  return valor
}

function lineas(items: AreaCountItemOut[], entradas: Entradas): AreaCountLineIn[] | null {
  const out: AreaCountLineIn[] = []
  for (const item of items) {
    const qty = textoDe(item, entradas[item.ingredient_id])
    if (qty === null) return null
    out.push({ ingredient_id: item.ingredient_id, qty })
  }
  return out
}

/** Una fila de la lista: nombre y la entrada cómoda según la unidad. */
function FilaArticulo({
  item,
  entrada,
  onChange,
  prefijo,
}: {
  item: AreaCountItemOut
  entrada: Entrada | undefined
  onChange: (e: Entrada) => void
  prefijo: string
}): React.JSX.Element {
  const actual = entrada ?? { valor: "", decimas: "0" }
  const id = `${prefijo}-${item.ingredient_id}`
  if (item.entry_mode === "bottle") {
    return (
      <li className="grid gap-2 rounded-lg border bg-card p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
        <span className="text-base font-semibold">{item.name}</span>
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label htmlFor={id}>Botellas enteras</Label>
            <Input
              id={id}
              inputMode="numeric"
              className="h-11 w-24 text-lg tabular-nums"
              value={actual.valor}
              onChange={(event) => onChange({ ...actual, valor: event.target.value.replace(/[^0-9]/g, "") })}
            />
          </div>
          <fieldset className="space-y-1">
            <legend className="text-sm font-medium">Décimas de la abierta</legend>
            <div className="flex flex-wrap gap-1">
              {DECIMAS.map((d) => (
                <Button
                  key={d}
                  type="button"
                  size="sm"
                  variant={actual.decimas === d ? "default" : "outline"}
                  className="h-11 w-9 tabular-nums"
                  aria-pressed={actual.decimas === d}
                  aria-label={`${d}/10 de ${item.name}`}
                  onClick={() => onChange({ ...actual, decimas: d })}
                >
                  {d}
                </Button>
              ))}
            </div>
          </fieldset>
        </div>
      </li>
    )
  }
  const unidad = item.entry_mode === "unit" ? "unidades" : item.entry_unit
  return (
    <li className="grid gap-2 rounded-lg border bg-card p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
      <Label htmlFor={id} className="text-base font-semibold">
        {item.name}
      </Label>
      <div className="flex items-center gap-2">
        <Input
          id={id}
          inputMode="decimal"
          className="h-11 w-32 text-lg tabular-nums"
          value={actual.valor}
          onChange={(event) => onChange({ ...actual, valor: event.target.value.replace(/[^0-9.,]/g, "") })}
        />
        <span className="w-16 text-sm text-muted-foreground">{unidad}</span>
      </div>
    </li>
  )
}

function useEnvio<T>(fn: (key: string) => Promise<T>, onOk: (r: T) => void) {
  const keyRef = useRef(newIdempotencyKey())
  const [error, setError] = useState<string | null>(null)
  const mutation = useMutation({
    mutationFn: () => fn(keyRef.current),
    onSuccess: (r) => {
      keyRef.current = newIdempotencyKey()
      setError(null)
      onOk(r)
    },
    onError: (err) => {
      if (!(err instanceof ApiError) || err.status !== 409) keyRef.current = newIdempotencyKey()
      setError(errorMessage(err))
    },
  })
  return { mutation, error }
}

/** Un recuento sorpresa pedido por el administrador: sus 1–5 artículos, a ciegas. */
function Recuento({ recount, onDone }: { recount: DeviceAreaRecountOut; onDone: () => void }): React.JSX.Element {
  const [entradas, setEntradas] = useState<Entradas>({})
  const payload = lineas(recount.items, entradas)
  const { mutation, error } = useEnvio(
    (key) => answerAreaRecount(recount.id, payload ?? [], key),
    () => {
      toast.success("Recuento enviado.")
      onDone()
    },
  )
  return (
    <li className="space-y-3 rounded-lg border border-warning/60 bg-warning/5 p-3">
      <p className="text-sm">
        <span className="font-semibold">Lo pidió {recount.requested_by_employee_name}</span>
        <span className="text-muted-foreground"> · {formatInstant(recount.requested_at)}</span>
      </p>
      {recount.note ? <p className="text-sm">{recount.note}</p> : null}
      <ul className="space-y-2">
        {recount.items.map((item) => (
          <FilaArticulo
            key={item.ingredient_id}
            item={item}
            prefijo={`recuento-${recount.id}`}
            entrada={entradas[item.ingredient_id]}
            onChange={(e) => setEntradas((prev) => ({ ...prev, [item.ingredient_id]: e }))}
          />
        ))}
      </ul>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <Button
        type="button"
        className="h-11 w-full"
        disabled={payload === null || mutation.isPending}
        onClick={() => mutation.mutate()}
      >
        Enviar recuento
      </Button>
    </li>
  )
}

/**
 * «Conteo de mi área» en el POS (`inventory.shift_counts`). La persona
 * identificada ve **sólo la lista de su área** —la arma el administrador en
 * Inventario—, **a ciegas**: ni el stock del sistema ni lo que contó el
 * anterior. Arriba, los recuentos que pidió el administrador; después, el
 * conteo de apertura o de cierre, con el momento que sugiere el servidor
 * (según la hora y si ya se contó hoy). Contar no bloquea abrir ni cerrar la
 * caja: si un área no cuenta, el dueño lo ve en Hoy.
 *
 * Cada artículo se teclea en su unidad cómoda (kg, botellas y décimas de la
 * abierta, unidades); lo que se manda es el texto tal cual, y el servidor
 * convierte una sola vez. La pantalla no suma ni compara nada.
 */
export function AreaCountPanel(): React.JSX.Element {
  const { hasFeature } = useSession()
  const enabled = hasFeature("inventory.shift_counts")
  const queryClient = useQueryClient()
  const query = useQuery({ queryKey: AREA_COUNT_QUERY_KEY, queryFn: getDeviceAreaCount, enabled })
  const [momento, setMomento] = useState<AreaCountRegularMoment | null>(null)
  const [entradas, setEntradas] = useState<Entradas>({})
  const [hecho, setHecho] = useState<string | null>(null)

  const board = query.data
  const momentoElegido: AreaCountRegularMoment = momento ?? board?.suggested_moment ?? "opening"
  const payload = board ? lineas(board.items, entradas) : null

  const { mutation, error } = useEnvio(
    (key) => postAreaCount({ moment: momentoElegido, lines: payload ?? [] }, key),
    (r) => {
      toast.success("Conteo registrado.")
      setHecho(`${MOMENT_LABEL[momentoElegido]} de ${r.area_name}: contó ${r.employee_name} · ${formatInstant(r.counted_at)}`)
      setEntradas({})
      setMomento(null)
      void queryClient.invalidateQueries({ queryKey: AREA_COUNT_QUERY_KEY })
    },
  )

  if (!enabled) {
    return (
      <EmptyState
        title="El conteo por área no está habilitado"
        description="Activá «Conteo corto por área» en Admin → Funciones."
      />
    )
  }
  if (query.isLoading) return <Cargando />
  if (query.isError) {
    return (
      <EmptyState
        role="alert"
        reason="error"
        title="No se pudo leer la lista de tu área"
        description={errorMessage(query.error)}
        action={{ label: "Reintentar", onClick: () => void query.refetch() }}
      />
    )
  }
  if (!board) return <Cargando />

  const refrescar = () => void queryClient.invalidateQueries({ queryKey: AREA_COUNT_QUERY_KEY })
  const hechoHoy = momentoElegido === "opening" ? board.opening_done : board.closing_done

  return (
    <div className="space-y-8">
      {board.recounts.length > 0 ? (
        <section aria-labelledby="recuentos-pedidos" className="space-y-3">
          <h3 id="recuentos-pedidos" className="text-lg font-semibold">
            Recuentos pedidos ({board.recounts.length})
          </h3>
          <p className="text-sm text-muted-foreground">El administrador pidió volver a contar estos artículos.</p>
          <ul className="space-y-3">
            {board.recounts.map((r) => (
              <Recuento key={r.id} recount={r} onDone={refrescar} />
            ))}
          </ul>
        </section>
      ) : null}

      {board.area_id === null || board.items.length === 0 ? (
        <EmptyState title="No hay lista para contar" description={board.reason ?? undefined} />
      ) : (
        <section aria-labelledby="conteo-area" className="space-y-4">
          <div>
            <h3 id="conteo-area" className="text-lg font-semibold">
              Conteo de {board.area_name}
            </h3>
            <p className="text-sm text-muted-foreground">
              Contá lo que hay de verdad. Si no hay, escribí 0.
            </p>
          </div>

          <dl className="grid gap-2 text-sm sm:grid-cols-2">
            {(["opening", "closing"] as const).map((m) => {
              const done = m === "opening" ? board.opening_done : board.closing_done
              return (
                <div key={m} className="rounded-md border px-3 py-2">
                  <dt className="font-medium">{MOMENT_LABEL[m]} de hoy</dt>
                  <dd className="text-muted-foreground">
                    {done ? `Contó ${done.employee_name} · ${formatInstant(done.counted_at)}` : "Todavía no"}
                  </dd>
                </div>
              )
            })}
          </dl>

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">¿Qué conteo es?</legend>
            <div className="grid grid-cols-2 gap-2">
              {(["opening", "closing"] as const).map((m) => (
                <Button
                  key={m}
                  type="button"
                  size="lg"
                  variant={momentoElegido === m ? "default" : "outline"}
                  aria-pressed={momentoElegido === m}
                  className={cn("h-12 text-base")}
                  onClick={() => setMomento(m)}
                >
                  {MOMENT_LABEL[m]}
                </Button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              {momentoElegido === "opening" ? "Al abrir cuenta quien entra." : "Al cerrar cuenta quien sale."}
              {hechoHoy ? " Ya se contó hoy: si contás de nuevo, manda el último." : ""}
            </p>
          </fieldset>

          <ul className="space-y-2">
            {board.items.map((item) => (
              <FilaArticulo
                key={item.ingredient_id}
                item={item}
                prefijo="conteo"
                entrada={entradas[item.ingredient_id]}
                onChange={(e) => {
                  setHecho(null)
                  setEntradas((prev) => ({ ...prev, [item.ingredient_id]: e }))
                }}
              />
            ))}
          </ul>

          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          {hecho ? (
            <p role="status" className="rounded-md border border-success/60 bg-success/5 px-3 py-2 text-sm">
              {hecho}
            </p>
          ) : null}
          <Button
            type="button"
            size="lg"
            className="h-12 w-full text-base"
            disabled={payload === null || mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            Guardar conteo de {MOMENT_LABEL[momentoElegido].toLowerCase()}
          </Button>
        </section>
      )}
    </div>
  )
}
