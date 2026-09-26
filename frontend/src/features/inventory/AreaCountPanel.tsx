import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { CircleCheck, CircleDashed, TriangleAlert } from "lucide-react"
import { useRef, useState } from "react"
import { toast } from "sonner"

import {
  answerAreaRecount,
  getAreaCountSheet,
  postAreaCountItem,
  type AreaCountItemOut,
  type AreaCountLineIn,
  type AreaCountProgressOut,
  type AreaCountRegularMoment,
  type AreaCountSheetAreaOut,
  type AreaCountSheetItemOut,
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

import {
  AREA_COUNT_GATE_QUERY_KEY,
  AREA_COUNT_QUERY_KEY,
  AREA_COUNT_SHEET_QUERY_KEY,
  contadoPor,
  horaBogota,
  rotuloEnteras,
  unidadEnPlural,
  unidadEsFemenina,
} from "./areaCountLib"

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
 *
 * `decimas` arranca en `null` (ninguna marcada): olvidar la abierta no puede
 * leerse como «no había abierta». El artículo no está contado hasta que se
 * toca una décima; si no hay abierta, se toca el 0.
 */
interface Entrada {
  valor: string
  decimas: string | null
}

type Entradas = Record<number, Entrada>

/** Se cuenta en enteros: botellas cerradas y artículos por unidad. */
function esEntero(item: AreaCountItemOut): boolean {
  return item.entry_mode === "bottle" || item.entry_mode === "unit"
}

/**
 * El aviso de un campo de enteros que trae coma o punto. No se limpia en
 * silencio: «5,5» sin la coma sería 55.
 */
function avisoEntero(item: AreaCountItemOut, valor: string): string | null {
  if (!esEntero(item) || /^\d*$/.test(valor.trim())) return null
  if (item.entry_mode === "bottle") {
    return `Acá van sólo ${unidadEnPlural(item.entry_unit)} ${unidadEsFemenina(item.entry_unit) ? "enteras" : "enteros"}, sin coma. La abierta se marca en décimas.`
  }
  return "Se cuentan unidades enteras, sin decimales."
}

function textoDe(item: AreaCountItemOut, entrada: Entrada | undefined): string | null {
  if (!entrada || entrada.valor.trim() === "") return null
  const valor = entrada.valor.trim()
  if (avisoEntero(item, valor) !== null) return null
  if (item.entry_mode === "bottle") {
    if (entrada.decimas === null) return null
    return entrada.decimas === "0" ? valor : `${valor}.${entrada.decimas}`
  }
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

/** La unidad escrita junto al número, en plural: «kg», «L», «bolsas», «unidades». */
function unidadDe(item: AreaCountItemOut): string {
  return unidadEnPlural(item.entry_unit)
}

/**
 * «Leche: 55,3 bolsas» — lo que la persona tecleó, con coma decimal, para
 * revisarlo antes de enviar un recuento. Nunca muestra lo esperado.
 */
function Resumen({
  items,
  entradas,
  titulo,
}: {
  items: AreaCountItemOut[]
  entradas: Entradas
  titulo: string
}): React.JSX.Element {
  return (
    <div className="space-y-2 rounded-lg border bg-muted/40 p-3">
      <p className="text-sm font-semibold">{titulo}</p>
      <ul className="space-y-1 text-base">
        {items.map((item) => {
          const qty = textoDe(item, entradas[item.ingredient_id]) ?? ""
          return (
            <li key={item.ingredient_id} className="flex justify-between gap-3">
              <span>{item.name}</span>
              <span className="font-semibold tabular-nums">
                {qty.replace(".", ",")} {unidadDe(item)}
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/**
 * La entrada cómoda de un artículo según su unidad: kg / litros / unidades
 * en un campo; botellas enteras en un campo y la abierta en décimas.
 */
function CampoCantidad({
  item,
  entrada,
  onChange,
  id,
}: {
  item: AreaCountItemOut
  entrada: Entrada | undefined
  onChange: (e: Entrada) => void
  id: string
}): React.JSX.Element {
  const actual = entrada ?? { valor: "", decimas: null }
  const avisoId = `${id}-aviso`
  const aviso = avisoEntero(item, actual.valor)
  // Se deja pasar la coma y el punto para poder avisar; el resto de
  // caracteres no numéricos no llega al campo.
  const limpiar = (texto: string) => texto.replace(/[^0-9.,]/g, "")
  const campo = (className: string) => (
    <Input
      id={id}
      inputMode={esEntero(item) ? "numeric" : "decimal"}
      className={cn(className, aviso ? "border-destructive" : null)}
      value={actual.valor}
      aria-invalid={aviso ? true : undefined}
      aria-describedby={aviso ? avisoId : undefined}
      onChange={(event) => onChange({ ...actual, valor: limpiar(event.target.value) })}
    />
  )
  const avisoTexto = aviso ? (
    <p id={avisoId} role="alert" className="text-sm text-destructive">
      {aviso}
    </p>
  ) : null

  if (item.entry_mode === "bottle") {
    const femenina = unidadEsFemenina(item.entry_unit)
    const singular = item.entry_unit.trim() === "" ? "unidad" : item.entry_unit
    const falta = actual.valor.trim() !== "" && actual.decimas === null
    return (
      <div className="space-y-2">
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label htmlFor={id}>{rotuloEnteras(item.entry_unit)}</Label>
            {campo("h-11 w-24 text-lg tabular-nums")}
          </div>
          <fieldset className="space-y-1">
            <legend className="text-sm font-medium">
              Décimas de {femenina ? "la" : "el"} {singular} {femenina ? "abierta" : "abierto"}
            </legend>
            <div className="flex flex-wrap gap-1">
              {DECIMAS.map((d) => (
                <Button
                  key={d}
                  type="button"
                  size="sm"
                  variant={actual.decimas === d ? "default" : "outline"}
                  className="h-11 min-w-11 tabular-nums"
                  aria-pressed={actual.decimas === d}
                  aria-label={`${d}/10 de ${item.name}`}
                  onClick={() => onChange({ ...actual, decimas: d })}
                >
                  {d}
                </Button>
              ))}
            </div>
            {falta ? (
              <p className="text-xs text-muted-foreground">
                Marcá las décimas de {femenina ? "la" : "el"} {singular} {femenina ? "abierta" : "abierto"}; si no
                hay, tocá 0.
              </p>
            ) : null}
          </fieldset>
        </div>
        {avisoTexto}
      </div>
    )
  }
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        {campo("h-11 w-32 text-lg tabular-nums")}
        <span className="w-20 text-sm text-muted-foreground">{unidadDe(item)}</span>
      </div>
      {avisoTexto}
    </div>
  )
}

/**
 * El nombre del artículo. Por peso o por unidad es el rótulo de su único
 * campo; en botellas los campos ya tienen el suyo («Botellas enteras», las
 * décimas), y el nombre es el título de la fila.
 */
function NombreArticulo({ item, id }: { item: AreaCountItemOut; id: string }): React.JSX.Element {
  if (item.entry_mode === "bottle") return <span className="text-base font-semibold">{item.name}</span>
  return (
    <Label htmlFor={id} className="text-base font-semibold">
      {item.name}
    </Label>
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
  const [revisando, setRevisando] = useState(false)
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
        {recount.items.map((item) => {
          const id = `recuento-${recount.id}-${item.ingredient_id}`
          return (
            <li key={item.ingredient_id} className="grid gap-2 rounded-lg border bg-card p-3">
              <NombreArticulo item={item} id={id} />
              <CampoCantidad
                id={id}
                item={item}
                entrada={entradas[item.ingredient_id]}
                onChange={(e) => {
                  setRevisando(false)
                  setEntradas((prev) => ({ ...prev, [item.ingredient_id]: e }))
                }}
              />
            </li>
          )
        })}
      </ul>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {revisando && payload !== null ? (
        <>
          <Resumen items={recount.items} entradas={entradas} titulo="Revisá antes de enviar" />
          <div className="grid grid-cols-2 gap-2">
            <Button type="button" variant="outline" className="h-11" onClick={() => setRevisando(false)}>
              Corregir
            </Button>
            <Button type="button" className="h-11" disabled={mutation.isPending} onClick={() => mutation.mutate()}>
              Enviar recuento
            </Button>
          </div>
        </>
      ) : (
        <Button type="button" className="h-11 w-full" disabled={payload === null} onClick={() => setRevisando(true)}>
          Revisar recuento
        </Button>
      )}
    </li>
  )
}

/**
 * Un artículo de la lista: su nombre, quién lo contó y cuándo (nunca
 * cuánto) y el campo para contarlo. Se guarda solo, al tocar «Guardar»: no
 * hay que terminar la lista para que quede. Si ya estaba contado, «Recontar»
 * agrega otra entrada y manda la última.
 */
function FilaConteo({
  area,
  item,
  momento,
}: {
  area: AreaCountSheetAreaOut
  item: AreaCountSheetItemOut
  momento: AreaCountRegularMoment
}): React.JSX.Element {
  const queryClient = useQueryClient()
  const [entrada, setEntrada] = useState<Entrada | undefined>(undefined)
  const qty = textoDe(item, entrada)
  const mark = momento === "opening" ? item.opening : item.closing
  const id = `conteo-${area.area_id}-${item.ingredient_id}`
  const { mutation, error } = useEnvio(
    (key) =>
      postAreaCountItem(
        { area_id: area.area_id, moment: momento, ingredient_id: item.ingredient_id, qty: qty ?? "" },
        key,
      ),
    (r) => {
      toast.success(`${r.ingredient_name}: guardado`)
      setEntrada(undefined)
      void queryClient.invalidateQueries({ queryKey: AREA_COUNT_SHEET_QUERY_KEY })
      void queryClient.invalidateQueries({ queryKey: AREA_COUNT_GATE_QUERY_KEY })
      void queryClient.invalidateQueries({ queryKey: AREA_COUNT_QUERY_KEY })
    },
  )
  return (
    <li
      className={cn(
        "grid gap-3 rounded-lg border bg-card p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center",
        mark ? "border-success/60" : null,
      )}
    >
      <div className="space-y-1">
        <NombreArticulo item={item} id={id} />
        <p className={cn("flex items-center gap-1.5 text-sm", mark ? "text-foreground" : "text-muted-foreground")}>
          {mark ? (
            <CircleCheck aria-hidden="true" className="size-4 text-success" />
          ) : (
            <CircleDashed aria-hidden="true" className="size-4" />
          )}
          {contadoPor(mark)}
        </p>
      </div>
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault()
          if (qty !== null && !mutation.isPending) mutation.mutate()
        }}
      >
        <CampoCantidad id={id} item={item} entrada={entrada} onChange={setEntrada} />
        <Button
          type="submit"
          className="h-11 min-w-28"
          variant={mark ? "outline" : "default"}
          disabled={qty === null || mutation.isPending}
        >
          {mark ? "Recontar" : "Guardar"}
        </Button>
      </form>
      {error ? (
        <p role="alert" className="text-sm text-destructive sm:col-span-2">
          {error}
        </p>
      ) : null}
    </li>
  )
}

function textoProgreso(p: AreaCountProgressOut): string {
  return `${p.counted} de ${p.total}`
}

/** «Bar», «Cocina» o «Todo»: el filtro de la lista. `mine` es «Mi área». */
type Filtro = "mine" | "all" | number

function areasDelFiltro(areas: AreaCountSheetAreaOut[], filtro: Filtro): AreaCountSheetAreaOut[] {
  if (filtro === "all") return areas
  if (filtro === "mine") return areas.filter((a) => a.mine)
  return areas.filter((a) => a.area_id === filtro)
}

/**
 * La pantalla de conteo del POS (`inventory.shift_counts`): `/pos/conteo` y
 * «Conteo» dentro de Turno. Trae las listas del día de **todas** las áreas y
 * se filtra por Mi área | cada área (Bar, Cocina…) | Todo, para que quien
 * termina primero ayude al otro. Cada artículo se guarda al contarlo, con
 * quién y a qué hora; **a ciegas**: nadie ve el stock, ni lo esperado, ni
 * la cantidad que tecleó otro —sólo «Contado por Kevin · 7:10»—. Recontar
 * agrega otra entrada y manda la última (el historial lo ve el dueño).
 *
 * La apertura del área de cada persona es obligatoria (la pantalla lo dice;
 * la puerta de las demás pantallas la hace cumplir `OpeningCountGate`). El
 * día del conteo completo mensual la lista es todo lo del área. Nada de esto
 * pide caja abierta.
 */
export function AreaCountPanel(): React.JSX.Element {
  const { hasFeature } = useSession()
  const enabled = hasFeature("inventory.shift_counts")
  const queryClient = useQueryClient()
  const query = useQuery({ queryKey: AREA_COUNT_SHEET_QUERY_KEY, queryFn: getAreaCountSheet, enabled })
  const [momento, setMomento] = useState<AreaCountRegularMoment | null>(null)
  const [filtro, setFiltro] = useState<Filtro | null>(null)

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
        title="No se pudo leer la lista de conteo"
        description={errorMessage(query.error)}
        action={{ label: "Reintentar", onClick: () => void query.refetch() }}
      />
    )
  }
  const sheet = query.data
  if (!sheet) return <Cargando />

  const refrescar = () => void queryClient.invalidateQueries({ queryKey: AREA_COUNT_SHEET_QUERY_KEY })
  const momentoElegido: AreaCountRegularMoment = momento ?? sheet.suggested_moment
  const hayMia = sheet.my_area_id !== null
  const filtroElegido: Filtro = filtro ?? (hayMia ? "mine" : "all")
  const visibles = areasDelFiltro(sheet.areas, filtroElegido)
  const mia = sheet.areas.find((a) => a.mine) ?? null
  const progresoDe = (a: AreaCountSheetAreaOut) => (momentoElegido === "opening" ? a.opening : a.closing)

  const opciones: { clave: Filtro; rotulo: string; progreso: string | null }[] = [
    ...(hayMia && mia ? [{ clave: "mine" as const, rotulo: "Mi área", progreso: textoProgreso(progresoDe(mia)) }] : []),
    ...sheet.areas.map((a) => ({ clave: a.area_id, rotulo: a.area_name, progreso: textoProgreso(progresoDe(a)) })),
    { clave: "all" as const, rotulo: "Todo", progreso: null },
  ]

  return (
    <div className="space-y-6">
      {sheet.opening_required && mia ? (
        <div role="alert" className="flex gap-3 rounded-lg border-2 border-destructive bg-destructive/10 p-4">
          <TriangleAlert aria-hidden="true" className="mt-0.5 size-6 shrink-0 text-destructive" />
          <div className="space-y-1">
            <p className="text-lg font-semibold">Primero el conteo de apertura de {mia.area_name}</p>
            <p className="text-sm">
              Es obligatorio: contá todos los artículos antes de seguir. Van {textoProgreso(mia.opening)}.
            </p>
          </div>
        </div>
      ) : null}
      {sheet.full_count_today ? (
        <p role="status" className="rounded-lg border border-warning/60 bg-warning/10 p-3 text-sm font-medium">
          Hoy es el conteo completo del mes: cada área cuenta todo lo suyo, no sólo la lista corta.
        </p>
      ) : null}

      {sheet.recounts.length > 0 ? (
        <section aria-labelledby="recuentos-pedidos" className="space-y-3">
          <h3 id="recuentos-pedidos" className="text-lg font-semibold">
            Recuentos pedidos ({sheet.recounts.length})
          </h3>
          <p className="text-sm text-muted-foreground">El administrador pidió volver a contar estos artículos.</p>
          <ul className="space-y-3">
            {sheet.recounts.map((r) => (
              <Recuento key={r.id} recount={r} onDone={refrescar} />
            ))}
          </ul>
        </section>
      ) : null}

      {sheet.areas.length === 0 ? (
        <EmptyState
          title="No hay lista para contar"
          description="El administrador todavía no armó las listas de las áreas en Inventario › Conteo por área."
        />
      ) : (
        <section aria-labelledby="conteo-areas" className="space-y-4">
          <div>
            <h3 id="conteo-areas" className="text-lg font-semibold">
              Conteo de {MOMENT_LABEL[momentoElegido].toLowerCase()}
            </h3>
            <p className="text-sm text-muted-foreground">
              Contá lo que hay de verdad; si no hay, escribí 0. Cada artículo se guarda al tocar «Guardar».
            </p>
            {sheet.reason ? <p className="mt-1 text-sm text-muted-foreground">{sheet.reason}</p> : null}
          </div>

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
                  className="h-12 text-base"
                  onClick={() => setMomento(m)}
                >
                  {MOMENT_LABEL[m]}
                </Button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              {momentoElegido === "opening" ? "Al abrir cuenta quien entra." : "Al cerrar cuenta quien sale."} Si
              recontás un artículo, manda el último.
            </p>
          </fieldset>

          <div role="group" aria-label="Qué lista ver" className="flex flex-wrap gap-2">
            {opciones.map((o) => (
              <Button
                key={String(o.clave)}
                type="button"
                variant={filtroElegido === o.clave ? "default" : "outline"}
                aria-pressed={filtroElegido === o.clave}
                className="h-11 gap-2"
                onClick={() => setFiltro(o.clave)}
              >
                {o.rotulo}
                {o.progreso ? <span className="text-xs tabular-nums opacity-80">{o.progreso}</span> : null}
              </Button>
            ))}
          </div>

          {visibles.length === 0 ? (
            <EmptyState title="No hay lista para contar" description={sheet.reason ?? undefined} />
          ) : (
            visibles.map((area) => {
              const progreso = progresoDe(area)
              return (
                <section key={area.area_id} aria-labelledby={`area-${area.area_id}`} className="space-y-2">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <h4 id={`area-${area.area_id}`} className="text-base font-semibold">
                      {area.area_name}
                      {area.scope === "full" ? (
                        <span className="ml-2 text-sm font-normal text-muted-foreground">conteo completo</span>
                      ) : null}
                    </h4>
                    <p className="text-sm tabular-nums text-muted-foreground">
                      {textoProgreso(progreso)} contados
                    </p>
                  </div>
                  {progreso.complete ? (
                    <p role="status" className="flex items-center gap-2 rounded-md bg-success/10 px-3 py-2 text-sm">
                      <CircleCheck aria-hidden="true" className="size-4 text-success" />
                      {MOMENT_LABEL[momentoElegido]} de {area.area_name} completa · {progreso.people.join(", ")} ·{" "}
                      {horaBogota(progreso.completed_at)}
                    </p>
                  ) : null}
                  <ul className="space-y-2">
                    {area.items.map((item) => (
                      <FilaConteo
                        key={`${momentoElegido}-${item.ingredient_id}`}
                        area={area}
                        item={item}
                        momento={momentoElegido}
                      />
                    ))}
                  </ul>
                </section>
              )
            })
          )}
        </section>
      )}
    </div>
  )
}
