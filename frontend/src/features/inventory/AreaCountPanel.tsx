import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ChevronDown, CircleCheck, CircleDashed, Lock, Minus, Plus } from "lucide-react"
import { useRef, useState } from "react"
import { toast } from "sonner"

import {
  answerAreaRecount,
  getAreaCountSheet,
  postAreaCountItem,
  type AreaCountItemOut,
  type AreaCountLineIn,
  type AreaCountMarkOut,
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

/** Tope de las enteras con −/+ (cuatro dígitos, como el teclado de plata). */
const MAX_ENTERAS = 9999

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

/** «Botella», «Kg», «Unidad»: cómo se cuenta, bajo el nombre del artículo. */
function unidadRotulo(item: AreaCountItemOut): string {
  const u = item.entry_unit.trim()
  if (u === "") return "Unidad"
  return u.charAt(0).toUpperCase() + u.slice(1)
}

/** «Contado por Kevin · 7:10» sin la cantidad; sin marca, «Por contar». */
function estadoDeMarca(mark: AreaCountMarkOut | null): string {
  return mark === null ? "Por contar" : contadoPor(mark)
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
    <div className="space-y-2 rounded-[12px] border bg-muted/40 p-3">
      <p className="text-[15px] font-semibold">{titulo}</p>
      <ul className="space-y-1 text-[17px]">
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

const BOTON_PASO =
  "grid size-[64px] shrink-0 place-items-center rounded-[12px] border bg-background text-foreground hover:bg-muted disabled:opacity-40"

/**
 * La entrada de un artículo según su unidad (handoff POS, pantalla 7):
 *
 * - botellas: enteras con −/+ de 64 px y el número en grande (también se
 *   teclea), y la abierta en décimas 0–9, botones de 64 px con su nivel;
 * - por unidad: −/+ y el número;
 * - por peso o volumen: el campo, con coma decimal, y su unidad.
 *
 * El número del medio sigue siendo un campo: una coma en las enteras avisa
 * en vez de pegarse («5,5» nunca se vuelve 55). −/+ sólo suman o quitan uno
 * a lo que ya está escrito; con un valor que no es entero no hacen nada.
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
  const avisoTexto = aviso ? (
    <p id={avisoId} role="alert" className="text-[15px] font-semibold text-destructive">
      {aviso}
    </p>
  ) : null

  if (!esEntero(item)) {
    return (
      <div className="space-y-1.5">
        <div className="flex flex-wrap items-center gap-3">
          <Label htmlFor={id} className="w-[170px] text-[16px] font-semibold">
            Cantidad ({unidadDe(item)})
          </Label>
          <Input
            id={id}
            inputMode="decimal"
            className="h-[64px] w-[160px] rounded-[12px] text-center text-[28px] font-bold tabular-nums md:text-[28px]"
            value={actual.valor}
            onChange={(event) => onChange({ ...actual, valor: limpiar(event.target.value) })}
          />
          <span className="text-[16px] text-muted-foreground">{unidadDe(item)}</span>
        </div>
      </div>
    )
  }

  const entero = /^\d+$/.test(actual.valor.trim()) ? Number(actual.valor.trim()) : actual.valor.trim() === "" ? 0 : null
  const rotulo = item.entry_mode === "bottle" ? rotuloEnteras(item.entry_unit) : "Unidades"
  const pasos = (
    <div className="flex flex-wrap items-center gap-3">
      <Label htmlFor={id} className="w-[170px] text-[16px] font-semibold">
        {rotulo}
      </Label>
      <button
        type="button"
        aria-label={`Quitar una a ${item.name}`}
        className={BOTON_PASO}
        disabled={entero === null || entero === 0 || actual.valor.trim() === ""}
        onClick={() => entero !== null && onChange({ ...actual, valor: String(Math.max(0, entero - 1)) })}
      >
        <Minus aria-hidden="true" className="size-6" />
      </button>
      <Input
        id={id}
        inputMode="numeric"
        className={cn(
          "h-[64px] w-[96px] rounded-[12px] bg-card text-center text-[36px] font-bold tabular-nums md:text-[36px]",
          aviso ? "border-destructive" : null,
        )}
        value={actual.valor}
        aria-invalid={aviso ? true : undefined}
        aria-describedby={aviso ? avisoId : undefined}
        onChange={(event) => onChange({ ...actual, valor: limpiar(event.target.value) })}
      />
      <button
        type="button"
        aria-label={`Sumar una a ${item.name}`}
        className={BOTON_PASO}
        disabled={entero === null || entero >= MAX_ENTERAS}
        onClick={() => entero !== null && onChange({ ...actual, valor: String(entero + 1) })}
      >
        <Plus aria-hidden="true" className="size-6" />
      </button>
    </div>
  )

  if (item.entry_mode !== "bottle") {
    return (
      <div className="space-y-1.5">
        {pasos}
        {avisoTexto}
      </div>
    )
  }

  const femenina = unidadEsFemenina(item.entry_unit)
  const singular = item.entry_unit.trim() === "" ? "unidad" : item.entry_unit
  const falta = actual.valor.trim() !== "" && actual.decimas === null
  return (
    <div className="space-y-3">
      {pasos}
      {avisoTexto}
      <fieldset className="space-y-2">
        <legend className="mb-2 text-[16px] font-semibold">
          Décimas de {femenina ? "la" : "el"} {singular} {femenina ? "abierta" : "abierto"}{" "}
          <span className="font-medium text-muted-foreground">· cuánto le queda, de 0 a 9</span>
        </legend>
        <div className="grid grid-cols-10 gap-1.5">
          {DECIMAS.map((d) => {
            const marcada = actual.decimas === d
            return (
              <button
                key={d}
                type="button"
                aria-pressed={marcada}
                aria-label={`${d}/10 de ${item.name}`}
                onClick={() => onChange({ ...actual, decimas: d })}
                className={cn(
                  "relative flex h-[64px] min-w-0 items-end justify-center overflow-hidden rounded-[10px] border pb-1.5 text-[20px] font-bold tabular-nums",
                  marcada ? "border-foreground bg-foreground text-background" : "bg-background text-foreground hover:bg-muted",
                )}
              >
                {/* El nivel de la botella: lo que le queda, a la vista. */}
                <span
                  aria-hidden="true"
                  className={cn("absolute inset-x-0 bottom-0", marcada ? "bg-background/25" : "bg-primary/15")}
                  style={{ height: `${Number(d) * 10}%` }}
                />
                <span className="relative">{d}</span>
              </button>
            )
          })}
        </div>
        {falta ? (
          <p className="text-[14px] text-muted-foreground">
            Marcá las décimas de {femenina ? "la" : "el"} {singular} {femenina ? "abierta" : "abierto"}; si no hay,
            tocá 0.
          </p>
        ) : null}
      </fieldset>
    </div>
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
    <li className="space-y-3 rounded-[12px] border border-warning/60 bg-warning/5 p-3">
      <p className="text-[15px]">
        <span className="font-semibold">Lo pidió {recount.requested_by_employee_name}</span>
        <span className="text-muted-foreground"> · {formatInstant(recount.requested_at)}</span>
      </p>
      {recount.note ? <p className="text-[15px]">{recount.note}</p> : null}
      <ul className="space-y-2">
        {recount.items.map((item) => {
          const id = `recuento-${recount.id}-${item.ingredient_id}`
          return (
            <li key={item.ingredient_id} className="grid gap-3 rounded-[12px] border bg-card p-3">
              <span className="text-[18px] font-bold">{item.name}</span>
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
        <p role="alert" className="text-[15px] text-destructive">
          {error}
        </p>
      ) : null}
      {revisando && payload !== null ? (
        <>
          <Resumen items={recount.items} entradas={entradas} titulo="Revisá antes de enviar" />
          <div className="grid grid-cols-2 gap-2">
            <Button type="button" variant="outline" className="h-[60px] rounded-[12px] text-[17px]" onClick={() => setRevisando(false)}>
              Corregir
            </Button>
            <Button
              type="button"
              className="h-[60px] rounded-[12px] text-[18px] font-bold"
              disabled={mutation.isPending}
              onClick={() => mutation.mutate()}
            >
              Enviar recuento
            </Button>
          </div>
        </>
      ) : (
        <Button
          type="button"
          className="h-[60px] w-full rounded-[12px] text-[18px] font-bold"
          disabled={payload === null}
          onClick={() => setRevisando(true)}
        >
          Revisar recuento
        </Button>
      )}
    </li>
  )
}

/**
 * Un artículo de la lista: una fila de 64 px con su nombre, la unidad y el
 * área, y quién lo contó y cuándo (nunca cuánto) —o «Por contar»—. Se abre
 * al tocarla y ahí se cuenta; se guarda solo, al tocar «Guardar conteo»: no
 * hay que terminar la lista para que quede. Guardado, se cierra y la
 * cantidad deja de mostrarse. Si ya estaba contado, guardar agrega otra
 * entrada y manda la última.
 */
function FilaConteo({
  area,
  item,
  momento,
  abierta,
  onToggle,
}: {
  area: AreaCountSheetAreaOut
  item: AreaCountSheetItemOut
  momento: AreaCountRegularMoment
  abierta: boolean
  onToggle: (abrir: boolean) => void
}): React.JSX.Element {
  const queryClient = useQueryClient()
  const [entrada, setEntrada] = useState<Entrada | undefined>(undefined)
  const qty = textoDe(item, entrada)
  const mark = momento === "opening" ? item.opening : item.closing
  const id = `conteo-${area.area_id}-${item.ingredient_id}`
  const panelId = `${id}-panel`
  const { mutation, error } = useEnvio(
    (key) =>
      postAreaCountItem(
        { area_id: area.area_id, moment: momento, ingredient_id: item.ingredient_id, qty: qty ?? "" },
        key,
      ),
    (r) => {
      toast.success(`${r.ingredient_name}: guardado`)
      setEntrada(undefined)
      onToggle(false)
      void queryClient.invalidateQueries({ queryKey: AREA_COUNT_SHEET_QUERY_KEY })
      void queryClient.invalidateQueries({ queryKey: AREA_COUNT_GATE_QUERY_KEY })
      void queryClient.invalidateQueries({ queryKey: AREA_COUNT_QUERY_KEY })
    },
  )

  function cerrar() {
    setEntrada(undefined)
    onToggle(false)
  }

  return (
    <li className={cn("flex flex-col rounded-[12px] bg-card", abierta ? "border-2 border-primary" : "border")}>
      <button
        type="button"
        aria-expanded={abierta}
        aria-controls={panelId}
        onClick={() => (abierta ? cerrar() : onToggle(true))}
        className="flex min-h-[64px] w-full items-center gap-3 rounded-[12px] px-[14px] py-1.5 text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        {mark ? (
          <CircleCheck aria-hidden="true" className="size-[22px] shrink-0 text-success" />
        ) : (
          <CircleDashed aria-hidden="true" className="size-[22px] shrink-0 text-muted-foreground" />
        )}
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-[18px] font-bold">{item.name}</span>
          <span className="text-[14px] text-muted-foreground">
            {unidadRotulo(item)} · {area.area_name}
            {area.scope === "full" ? " · conteo completo" : ""}
          </span>
        </span>
        <span className={cn("text-right text-[15px] font-semibold", mark ? "text-success" : "text-warning")}>
          {estadoDeMarca(mark)}
        </span>
        <ChevronDown
          aria-hidden="true"
          className={cn("size-5 shrink-0 text-muted-foreground transition-transform", abierta && "rotate-180")}
        />
      </button>
      {abierta ? (
        <form
          id={panelId}
          className="flex flex-col gap-3 border-t border-dashed px-[14px] pt-3 pb-[14px]"
          onSubmit={(e) => {
            e.preventDefault()
            if (qty !== null && !mutation.isPending) mutation.mutate()
          }}
        >
          <CampoCantidad id={id} item={item} entrada={entrada} onChange={setEntrada} />
          {error ? (
            <p role="alert" className="text-[15px] text-destructive">
              {error}
            </p>
          ) : null}
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              className="h-[60px] rounded-[12px] px-5 text-[17px] font-semibold"
              onClick={cerrar}
            >
              Cancelar
            </Button>
            <Button
              type="submit"
              className="h-[60px] flex-1 rounded-[12px] text-[18px] font-bold"
              disabled={qty === null || mutation.isPending}
            >
              {mark ? "Guardar recuento" : "Guardar conteo"}
            </Button>
          </div>
          <p className="text-[14px] text-muted-foreground">
            Al guardar, la cantidad deja de mostrarse. Queda tu nombre y la hora.
          </p>
        </form>
      ) : null}
    </li>
  )
}

/** «Bar», «Cocina» o «Todo»: el filtro de la lista. `mine` es «Mi área». */
type Filtro = "mine" | "all" | number

function areasDelFiltro(areas: AreaCountSheetAreaOut[], filtro: Filtro): AreaCountSheetAreaOut[] {
  if (filtro === "all") return areas
  if (filtro === "mine") return areas.filter((a) => a.mine)
  return areas.filter((a) => a.area_id === filtro)
}

function fraccion(p: { counted: number; total: number }): string {
  return `${p.counted}/${p.total}`
}

/** «el bar», «la cocina». */
function elArea(nombre: string): string {
  const n = nombre.trim().toLowerCase()
  return unidadEsFemenina(n) ? `la ${n}` : `el ${n}`
}

/** «del bar», «de la cocina»: el área en minúscula, para las frases del pie. */
function delArea(nombre: string): string {
  const n = nombre.trim().toLowerCase()
  return unidadEsFemenina(n) ? `de la ${n}` : `del ${n}`
}

export interface AreaCountPanelProps {
  /**
   * «Terminar conteo del {área}»: a dónde se sigue cuando la apertura del
   * área propia está completa (lo decide el servidor, `progress.complete`).
   * Sin esto el pie sólo dice cuánto falta.
   */
  onTerminar?: () => void
}

/**
 * La pantalla de conteo del POS (`inventory.shift_counts`), según el
 * handoff (pantalla 7, 820 × 1180): `/pos/conteo` y «Conteo» dentro de
 * Turno. Trae las listas del día de **todas** las áreas y se filtra con las
 * pestañas Mi área | cada área (Bar, Cocina…) | Todo, para que quien
 * termina primero ayude al otro. Cada artículo se guarda al contarlo, con
 * quién y a qué hora; **a ciegas**: nadie ve el stock, ni lo esperado, ni
 * la cantidad que tecleó otro —sólo «Contado por Kevin · 7:10»—. Recontar
 * agrega otra entrada y manda la última (el historial lo ve el dueño).
 *
 * La apertura del área de cada persona es obligatoria (la pastilla ámbar lo
 * dice; la puerta de las demás pantallas la hace cumplir
 * `OpeningCountGate`). El día del conteo completo mensual la lista es todo
 * lo del área. Los avances (x/y, «Faltan N») son los que manda el servidor.
 * Nada de esto pide caja abierta.
 */
export function AreaCountPanel({ onTerminar }: AreaCountPanelProps = {}): React.JSX.Element {
  const { hasFeature } = useSession()
  const enabled = hasFeature("inventory.shift_counts")
  const queryClient = useQueryClient()
  const query = useQuery({ queryKey: AREA_COUNT_SHEET_QUERY_KEY, queryFn: getAreaCountSheet, enabled })
  const [momento, setMomento] = useState<AreaCountRegularMoment | null>(null)
  const [filtro, setFiltro] = useState<Filtro | null>(null)
  const [abierta, setAbierta] = useState<string | null>(null)

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
  const progresoDe = (a: AreaCountSheetAreaOut): AreaCountProgressOut =>
    momentoElegido === "opening" ? a.opening : a.closing
  // Artículos contados sobre artículos de la lista: se juntan los avances
  // que mandó el servidor por área (no es plata, son renglones).
  const todo = sheet.areas.reduce(
    (acc, a) => ({ counted: acc.counted + progresoDe(a).counted, total: acc.total + progresoDe(a).total }),
    { counted: 0, total: 0 },
  )

  const opciones: { clave: Filtro; rotulo: string; sub: string }[] = [
    ...(hayMia && mia ? [{ clave: "mine" as const, rotulo: "Mi área", sub: mia.area_name }] : []),
    ...sheet.areas.map((a) => ({ clave: a.area_id, rotulo: a.area_name, sub: fraccion(progresoDe(a)) })),
    { clave: "all" as const, rotulo: "Todo", sub: fraccion(todo) },
  ]

  // La barra de avance es la del área propia; sin área propia, la de lo que
  // se está mirando si es una sola, o la de todo.
  const deLaBarra = mia ?? (visibles.length === 1 ? visibles[0]! : null)
  const avance = deLaBarra ? progresoDe(deLaBarra) : todo
  const obligatoria = sheet.opening_required && mia !== null && momentoElegido === "opening"
  const otras = sheet.areas.filter((a) => a !== mia)

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-[26px] font-extrabold [font-stretch:108%]">
            Conteo de {MOMENT_LABEL[momentoElegido].toLowerCase()}
          </h2>
          {obligatoria && mia ? (
            <span
              role="status"
              className="inline-flex items-center gap-1.5 rounded-full border border-warning bg-warning/20 px-3 py-[5px] text-[14px] font-bold"
            >
              <Lock aria-hidden="true" className="size-[15px]" />
              Obligatorio para abrir {elArea(mia.area_name)}
            </span>
          ) : null}
          <div role="group" aria-label="¿Qué conteo es?" className="ml-auto flex gap-1 rounded-[12px] bg-muted p-1">
            {(["opening", "closing"] as const).map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={momentoElegido === m}
                className={cn(
                  "h-[48px] rounded-[10px] px-4 text-[16px]",
                  momentoElegido === m ? "bg-card font-extrabold shadow-sm" : "font-semibold text-muted-foreground",
                )}
                onClick={() => {
                  setMomento(m)
                  setAbierta(null)
                }}
              >
                {MOMENT_LABEL[m]}
              </button>
            ))}
          </div>
        </div>
        <p className="text-[14px] text-muted-foreground">
          {momentoElegido === "opening" ? "Al abrir cuenta quien entra." : "Al cerrar cuenta quien sale."} Contá lo que
          hay de verdad; si no hay, 0. Si recontás un artículo, manda el último.
        </p>
        {sheet.reason ? <p className="text-[15px] text-muted-foreground">{sheet.reason}</p> : null}

        {sheet.areas.length > 0 ? (
          <div className="flex items-center gap-3">
            <div
              role="progressbar"
              aria-label="Artículos contados"
              aria-valuemin={0}
              aria-valuemax={avance.total}
              aria-valuenow={avance.counted}
              className="h-[10px] flex-1 overflow-hidden rounded-full bg-muted"
            >
              <div
                className="h-full rounded-full bg-foreground"
                style={{ width: avance.total > 0 ? `${(avance.counted / avance.total) * 100}%` : "0%" }}
              />
            </div>
            <b className="text-[17px] whitespace-nowrap tabular-nums">
              {avance.counted} de {avance.total} contados
            </b>
          </div>
        ) : null}

        {sheet.areas.length > 0 ? (
          <div
            role="group"
            aria-label="Qué lista ver"
            className="grid gap-1.5 rounded-[14px] bg-muted p-1"
            style={{ gridTemplateColumns: `repeat(${opciones.length}, minmax(0, 1fr))` }}
          >
            {opciones.map((o) => {
              const activa = filtroElegido === o.clave
              return (
                <button
                  key={String(o.clave)}
                  type="button"
                  aria-pressed={activa}
                  className={cn(
                    "flex h-[56px] min-w-0 flex-col items-center justify-center rounded-[10px] text-[17px] leading-[1.1]",
                    activa ? "bg-card font-extrabold shadow-[0_1px_3px_rgb(0_0_0/18%)]" : "font-semibold",
                  )}
                  onClick={() => {
                    setFiltro(o.clave)
                    setAbierta(null)
                  }}
                >
                  {o.rotulo}
                  <span className="text-[13px] font-medium text-muted-foreground tabular-nums">{o.sub}</span>
                </button>
              )
            })}
          </div>
        ) : null}
      </div>

      {sheet.full_count_today ? (
        <p role="status" className="rounded-[12px] border border-warning/60 bg-warning/10 p-3 text-[15px] font-medium">
          Hoy es el conteo completo del mes: cada área cuenta todo lo suyo, no sólo la lista corta.
        </p>
      ) : null}

      {sheet.recounts.length > 0 ? (
        <section aria-labelledby="recuentos-pedidos" className="space-y-3">
          <h3 id="recuentos-pedidos" className="text-[20px] font-bold">
            Recuentos pedidos ({sheet.recounts.length})
          </h3>
          <p className="text-[15px] text-muted-foreground">El administrador pidió volver a contar estos artículos.</p>
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
      ) : visibles.length === 0 ? (
        <EmptyState title="No hay lista para contar" description={sheet.reason ?? undefined} />
      ) : (
        visibles.map((area) => {
          const progreso = progresoDe(area)
          return (
            <section key={area.area_id} aria-label={`Artículos de ${area.area_name}`} className="flex flex-col gap-2">
              {visibles.length > 1 ? (
                <h3 className="flex items-baseline justify-between gap-2 pt-1 text-[18px] font-bold">
                  {area.area_name}
                  <span className="text-[15px] font-medium text-muted-foreground tabular-nums">
                    {progreso.counted} de {progreso.total} contados
                  </span>
                </h3>
              ) : null}
              {progreso.complete ? (
                <p role="status" className="flex items-center gap-2 rounded-[12px] bg-success/10 px-3 py-2 text-[15px]">
                  <CircleCheck aria-hidden="true" className="size-4 text-success" />
                  {MOMENT_LABEL[momentoElegido]} de {area.area_name} completa · {progreso.people.join(", ")} ·{" "}
                  {horaBogota(progreso.completed_at)}
                </p>
              ) : null}
              <ul className="flex flex-col gap-2">
                {area.items.map((item) => {
                  const clave = `${momentoElegido}-${area.area_id}-${item.ingredient_id}`
                  return (
                    <FilaConteo
                      key={clave}
                      area={area}
                      item={item}
                      momento={momentoElegido}
                      abierta={abierta === clave}
                      onToggle={(abrir) => setAbierta(abrir ? clave : null)}
                    />
                  )
                })}
              </ul>
            </section>
          )
        })
      )}

      {mia ? (
        <PieDelArea area={mia} progreso={progresoDe(mia)} otras={otras} progresoDe={progresoDe} onTerminar={onTerminar} />
      ) : null}
    </div>
  )
}

/**
 * El pie fijo: cuánto le falta al área propia y cómo van las otras, y
 * «Terminar conteo del {área}», que se habilita cuando el servidor dice que
 * la lista está completa.
 */
function PieDelArea({
  area,
  progreso,
  otras,
  progresoDe,
  onTerminar,
}: {
  area: AreaCountSheetAreaOut
  progreso: AreaCountProgressOut
  otras: AreaCountSheetAreaOut[]
  progresoDe: (a: AreaCountSheetAreaOut) => AreaCountProgressOut
  onTerminar?: () => void
}): React.JSX.Element {
  const faltan = progreso.total - progreso.counted
  const detalle = otras
    .map((a) => {
      const p = progresoDe(a)
      const quien = p.people.length > 0 ? ` lo cuenta ${p.people.join(" y ")}` : ""
      return `${a.area_name}${quien} · ${p.counted} de ${p.total} hechos`
    })
    .join(" · ")
  return (
    <footer className="sticky bottom-0 z-10 mt-2 flex items-center gap-3 rounded-[12px] border bg-card px-4 py-3 shadow-[0_-4px_12px_rgb(0_0_0/6%)]">
      <div className="flex min-w-0 flex-1 flex-col">
        <b className="text-[18px]">
          {progreso.complete
            ? `${area.area_name} contado completo`
            : `Faltan ${faltan} ${faltan === 1 ? "artículo" : "artículos"} ${delArea(area.area_name)}`}
        </b>
        {detalle ? <span className="text-[14px] text-muted-foreground">{detalle}</span> : null}
      </div>
      {onTerminar ? (
        <Button
          type="button"
          className="h-[64px] rounded-[12px] px-[26px] text-[18px] font-bold"
          disabled={!progreso.complete}
          onClick={onTerminar}
        >
          Terminar conteo {delArea(area.area_name)}
        </Button>
      ) : null}
    </footer>
  )
}
