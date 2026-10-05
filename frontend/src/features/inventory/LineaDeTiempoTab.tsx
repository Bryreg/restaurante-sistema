import { useQuery } from "@tanstack/react-query"
import { useMemo, useState } from "react"
import { Link } from "react-router-dom"

import { getInventoryTimeline, type TimelineOut, type TimelineRowOut } from "@/api/inventory"
import {
  Burbuja,
  DenseTable,
  DenseTableBar,
  DenseTableSearch,
  EstadoPastilla,
  FilterEmptyState,
  FilterPill,
  Pozo,
  Segmentado,
  type DenseColumn,
} from "@/components/admin"
import { Cargando } from "@/components/Cargando"
import { EmptyState } from "@/components/EmptyState"
import { errorMessage } from "@/lib/errors"
import { formatCOP } from "@/lib/money"
import { fichaInsumoHref } from "@/features/reports/fichas/rutas"

import { BarraVidaInsumo, EjeTiempo } from "./BarraVidaInsumo"
import { UNIDAD, cantidadCorta, duracion, marcasEje } from "./lineaDeTiempo"
import { CAUSE_LABEL, daysAgoLocal, todayLocal } from "./lib"

/**
 * **Inventario › Línea de tiempo**: la vida de cada insumo en el período, en
 * una barra por insumo —el saldo escalonado, lo que llegó y cada conteo contra
 * el libro— y, a un toque, la misma respuesta como tabla.
 *
 * Adaptada de la pestaña «Insumos» de café-sistema, con lo que allá faltaba
 * para decidir una compra: **cuánto tiempo estuvo bajo el mínimo y en cero**
 * (dos insumos con los mismos totales pueden haber pasado dos horas o tres
 * días sin stock), el mínimo dibujado en cada barra, y la diferencia de cada
 * conteo en plata. Las dos vistas contestan preguntas distintas: la barra dice
 * CUÁNDO, la tabla CUÁNTO; ninguna reemplaza a la otra.
 *
 * Todo sale de una llamada (`GET /admin/inventory/timeline`): los totales, la
 * plata y las duraciones los calcula el servidor. Acá sólo se ordena, se
 * filtra lo que ya llegó y se dibuja.
 */

type Periodo = "hoy" | "7" | "30" | "mes"
type Vista = "barras" | "tabla"
type Orden = "plata" | "cero" | "minimo" | "conteo" | "nombre"

const PERIODOS: readonly { value: Periodo; label: string }[] = [
  { value: "hoy", label: "Hoy" },
  { value: "7", label: "7 días" },
  { value: "30", label: "30 días" },
  { value: "mes", label: "Este mes" },
]

const ORDENES: readonly { value: Orden; label: string }[] = [
  { value: "plata", label: "Plata que salió" },
  { value: "cero", label: "Tiempo en cero" },
  { value: "minimo", label: "Tiempo bajo el mínimo" },
  { value: "conteo", label: "Diferencia en conteos" },
  { value: "nombre", label: "Nombre" },
]

function rango(p: Periodo): { from: string; to: string } {
  const hoy = todayLocal()
  if (p === "hoy") return { from: hoy, to: hoy }
  if (p === "mes") return { from: `${hoy.slice(0, 8)}01`, to: hoy }
  return { from: daysAgoLocal(Number(p) - 1), to: hoy }
}

function normalizar(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim()
}

/** La peor diferencia de conteo de la fila, en plata (la más negativa). */
function peorConteo(row: TimelineRowOut): number | null {
  const valores = row.counts.map((c) => c.diff_value).filter((v): v is number => v !== null)
  return valores.length ? Math.min(...valores) : null
}

function ordenar(rows: TimelineRowOut[], orden: Orden): TimelineRowOut[] {
  const copia = [...rows]
  const porNombre = (a: TimelineRowOut, b: TimelineRowOut) => a.name.localeCompare(b.name, "es")
  // `null` (sin costo) va al final: no es «$ 0», es «no se sabe».
  const desc = (a: number | null, b: number | null) =>
    a === null ? (b === null ? 0 : 1) : b === null ? -1 : b - a
  copia.sort((a, b) => {
    switch (orden) {
      case "plata":
        return desc(a.value_out, b.value_out) || porNombre(a, b)
      case "cero":
        return b.seconds_at_zero - a.seconds_at_zero || porNombre(a, b)
      case "minimo":
        return b.seconds_below_min - a.seconds_below_min || porNombre(a, b)
      case "conteo": {
        const pa = peorConteo(a)
        const pb = peorConteo(b)
        return (pa === null ? (pb === null ? 0 : 1) : pb === null ? -1 : pa - pb) || porNombre(a, b)
      }
      default:
        return porNombre(a, b)
    }
  })
  return copia
}

function unidad(row: TimelineRowOut): string {
  return UNIDAD[row.base_unit] ?? row.base_unit
}

/** Lo que dice la barra, en una frase, para quien no la ve. */
function resumenFila(row: TimelineRowOut): string {
  const u = unidad(row)
  const partes = [
    `${row.name}: arrancó con ${cantidadCorta(row.start_qty, u)} y queda con ${cantidadCorta(row.end_qty, u)}`,
    `entró ${cantidadCorta(row.in_qty, u)}, salió ${cantidadCorta(row.out_qty.replace("-", ""), u)}`,
  ]
  if (row.seconds_at_zero > 0) partes.push(`estuvo ${duracion(row.seconds_at_zero)} en cero`)
  if (row.seconds_below_min > 0) partes.push(`${duracion(row.seconds_below_min)} bajo el mínimo`)
  if (row.counts.length) partes.push(`${row.counts.length} conteo${row.counts.length === 1 ? "" : "s"}`)
  return `${partes.join("; ")}.`
}

function Estados({ row }: { row: TimelineRowOut }): React.JSX.Element | null {
  if (row.seconds_at_zero === 0 && row.seconds_below_min === 0) return null
  return (
    <span className="flex flex-wrap justify-end gap-1">
      {row.seconds_at_zero > 0 ? (
        <EstadoPastilla tono="destructive" className="h-[22px] px-2 text-[11px]">
          {duracion(row.seconds_at_zero)} en cero
        </EstadoPastilla>
      ) : null}
      {row.seconds_below_min > row.seconds_at_zero ? (
        <EstadoPastilla tono="warning" className="h-[22px] px-2 text-[11px]">
          {duracion(row.seconds_below_min)} bajo mín.
        </EstadoPastilla>
      ) : null}
    </span>
  )
}

function PlataFila({ row }: { row: TimelineRowOut }): React.JSX.Element {
  if (row.value_out === null) {
    return (
      <span className="text-xs text-muted-foreground" title="Lo que salió no tenía costo: no es $ 0, no se sabe">
        {Number(row.out_qty) === 0 ? "No salió" : "Sin costo"}
      </span>
    )
  }
  return (
    <span className="text-sm font-semibold tabular-nums" title={row.value_out_partial ? "Parte de lo que salió no tenía costo" : undefined}>
      {formatCOP(row.value_out)}
      {row.value_out_partial ? <span className="text-muted-foreground"> +?</span> : null}
    </span>
  )
}

/** El titular: la plata que salió, por causa, y lo que hay que mirar. */
function Resumen({ data }: { data: TimelineOut }): React.JSX.Element {
  const s = data.summary
  return (
    <Burbuja className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
      <div className="min-w-0">
        <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Salió del estante</p>
        <p className="mt-1 text-[40px] leading-none font-semibold tracking-[-0.03em] tabular-nums">
          {formatCOP(s.value_out)}
        </p>
        <p className="mt-2 text-[13px] text-muted-foreground">
          {s.with_movement} de {s.ingredients} insumos se movieron
          {s.value_out_partial ? " · parte de lo que salió no tiene costo y no está sumado" : ""}
        </p>
        {s.value_out_by_cause.length ? (
          <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[13px]">
            {s.value_out_by_cause.map((c) => (
              <li key={c.cause}>
                <span className="text-muted-foreground">{CAUSE_LABEL[c.cause] ?? c.cause}</span>{" "}
                <b className="font-semibold tabular-nums">{formatCOP(c.value)}</b>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <div className="grid gap-2.5 sm:grid-cols-3">
        <Pozo>
          <p className="text-xs text-muted-foreground">Se quedaron en cero</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums">{s.hit_zero}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {s.hit_zero === 1 ? "insumo" : "insumos"} en algún momento del período
          </p>
        </Pozo>
        <Pozo>
          <p className="text-xs text-muted-foreground">Pasaron bajo el mínimo</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums">{s.below_min}</p>
          <p className="mt-1 text-xs text-muted-foreground">el tiempo exacto va en cada fila</p>
        </Pozo>
        <Pozo>
          <p className="text-xs text-muted-foreground">Ajustes por conteo</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums">
            {formatCOP(s.value_count_shortage)}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            faltante · sobrante {formatCOP(s.value_count_surplus)} · {s.counts} conteo{s.counts === 1 ? "" : "s"}
          </p>
        </Pozo>
      </div>
    </Burbuja>
  )
}

function Leyenda(): React.JSX.Element {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-label="Cómo leer las barras">
      <li className="flex items-center gap-1.5">
        <span className="inline-block size-2.5 rounded-[2px] bg-data-bar" aria-hidden="true" /> Saldo según el libro
      </li>
      <li className="flex items-center gap-1.5">
        <span className="inline-block size-2.5 rounded-[2px] bg-warning" aria-hidden="true" /> Bajo el mínimo
      </li>
      <li className="flex items-center gap-1.5">
        <span className="inline-block size-2.5 rounded-[2px] bg-destructive" aria-hidden="true" /> En cero o menos
      </li>
      <li className="flex items-center gap-1.5">
        <span className="inline-block w-3 border-t border-dashed border-foreground opacity-55" aria-hidden="true" /> Mínimo
      </li>
      <li className="flex items-center gap-1.5">
        <span className="inline-block size-2 bg-foreground [clip-path:polygon(50%_0,100%_100%,0_100%)]" aria-hidden="true" />{" "}
        Llegó mercancía
      </li>
      <li className="flex items-center gap-1.5">
        <span className="inline-block size-2.5 rounded-full bg-destructive" aria-hidden="true" /> Conteo: lo que vieron, y el
        palito hasta lo que decía el libro
      </li>
    </ul>
  )
}

function VistaBarras({ data, rows }: { data: TimelineOut; rows: TimelineRowOut[] }): React.JSX.Element {
  const marcas = marcasEje(data.date_from, data.start_at, data.end_at)
  return (
    <div className="space-y-3 px-4 pb-4">
      <div className="hidden grid-cols-[200px_minmax(0,1fr)_150px] gap-4 md:grid">
        <span />
        <EjeTiempo marcas={marcas} />
        <span />
      </div>
      <ul className="m-0 list-none space-y-1 p-0">
        {rows.map((row) => {
          const u = unidad(row)
          return (
            <li
              key={row.ingredient_id}
              data-insumo={row.ingredient_id}
              className="grid items-center gap-x-4 gap-y-2 border-t border-border/60 py-3 first:border-t-0 md:grid-cols-[200px_minmax(0,1fr)_150px]"
            >
              <div className="min-w-0">
                <Link to={fichaInsumoHref(row.ingredient_id)} className="block truncate text-sm font-semibold text-primary hover:underline">
                  {row.name}
                </Link>
                <p className="text-xs text-muted-foreground tabular-nums">
                  {cantidadCorta(row.start_qty, u)} → <b className="font-semibold text-foreground">{cantidadCorta(row.end_qty, u)}</b>
                </p>
              </div>
              <div role="img" aria-label={resumenFila(row)} className="pb-2.5">
                <BarraVidaInsumo row={row} startAt={data.start_at} endAt={data.end_at} nowAt={data.now_at} />
              </div>
              <div className="flex flex-col items-start gap-1 md:items-end">
                <PlataFila row={row} />
                <Estados row={row} />
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function columnas(): DenseColumn<TimelineRowOut>[] {
  return [
    {
      key: "insumo",
      header: "Insumo",
      kind: "name",
      cell: (r) => (
        <Link to={fichaInsumoHref(r.ingredient_id)} className="font-semibold text-primary hover:underline">
          {r.name}
        </Link>
      ),
    },
    { key: "arranco", header: "Arrancó", kind: "number", cell: (r) => cantidadCorta(r.start_qty, unidad(r)), secondary: true },
    { key: "entro", header: "Entró", kind: "number", cell: (r) => cantidadCorta(r.in_qty, unidad(r)) },
    { key: "salio", header: "Salió", kind: "number", cell: (r) => cantidadCorta(r.out_qty.replace("-", ""), unidad(r)) },
    {
      key: "ajuste",
      header: "Ajuste por conteo",
      kind: "number",
      secondary: true,
      cell: (r) => (Number(r.count_adjustment_qty) === 0 ? "—" : cantidadCorta(r.count_adjustment_qty, unidad(r))),
    },
    { key: "queda", header: "Queda", kind: "number", cell: (r) => cantidadCorta(r.end_qty, unidad(r)) },
    { key: "plata", header: "Plata que salió", kind: "number", cell: (r) => <PlataFila row={r} /> },
    {
      key: "cero",
      header: "En cero",
      kind: "number",
      cell: (r) => (r.seconds_at_zero ? <b className="text-destructive">{duracion(r.seconds_at_zero)}</b> : "—"),
      help: "Cuánto tiempo del período el libro tuvo este insumo en cero o menos: lo que no se pudo vender o se vendió sin registrar la compra.",
    },
    {
      key: "minimo",
      header: "Bajo mínimo",
      kind: "number",
      secondary: true,
      cell: (r) => (r.seconds_below_min ? duracion(r.seconds_below_min) : "—"),
    },
    {
      key: "conteos",
      header: "Conteos",
      kind: "number",
      secondary: true,
      cell: (r) => {
        const peor = peorConteo(r)
        if (!r.counts.length) return "—"
        return peor === null || peor === 0 ? String(r.counts.length) : `${r.counts.length} · ${formatCOP(peor)}`
      },
    },
  ]
}

export function LineaDeTiempoTab({ storeId }: { storeId: number }): React.JSX.Element {
  const [periodo, setPeriodo] = useState<Periodo>("7")
  const [vista, setVista] = useState<Vista>("barras")
  const [orden, setOrden] = useState<Orden>("plata")
  const [criticos, setCriticos] = useState(false)
  const [soloCero, setSoloCero] = useState(false)
  const [soloMinimo, setSoloMinimo] = useState(false)
  const [soloConteo, setSoloConteo] = useState(false)
  const [busqueda, setBusqueda] = useState("")
  const { from, to } = rango(periodo)

  const query = useQuery({
    queryKey: ["inventory", "timeline", storeId, from, to, criticos],
    queryFn: () => getInventoryTimeline({ storeId, from, to, criticalOnly: criticos }),
  })

  const filas = useMemo(() => {
    const data = query.data
    if (!data) return []
    const q = normalizar(busqueda)
    const filtradas = data.rows.filter(
      (r) =>
        (!soloCero || r.seconds_at_zero > 0) &&
        (!soloMinimo || r.seconds_below_min > 0) &&
        (!soloConteo || r.counts.length > 0) &&
        (!q || normalizar(r.name).includes(q)),
    )
    return ordenar(filtradas, orden)
  }, [query.data, busqueda, soloCero, soloMinimo, soloConteo, orden])

  const filtrosPuestos = soloCero || soloMinimo || soloConteo || busqueda !== ""

  const controles = (
    <div className="flex flex-wrap items-center gap-2">
      <Segmentado etiqueta="Período" opciones={PERIODOS} valor={periodo} onChange={setPeriodo} chico />
      <Segmentado
        etiqueta="Vista"
        opciones={[
          { value: "barras", label: "Barras" },
          { value: "tabla", label: "Tabla" },
        ]}
        valor={vista}
        onChange={setVista}
        chico
      />
      <label className="ml-auto inline-flex items-center gap-2 text-xs text-muted-foreground">
        Ordenar por
        <select
          value={orden}
          onChange={(e) => setOrden(e.target.value as Orden)}
          className="h-[30px] rounded-full border border-input bg-card px-3 text-xs font-semibold text-foreground"
        >
          {ORDENES.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
    </div>
  )

  if (query.isLoading) {
    return (
      <div className="space-y-4">
        {controles}
        <Cargando texto="Armando la línea de tiempo…" />
      </div>
    )
  }
  if (query.isError || !query.data) {
    return (
      <div className="space-y-4">
        {controles}
        <EmptyState
          reason="error"
          title="No se pudo cargar la línea de tiempo"
          description={errorMessage(query.error)}
          action={{ label: "Reintentar", onClick: () => void query.refetch() }}
        />
      </div>
    )
  }

  const data = query.data
  const barra = (
    <DenseTableBar shown={filas.length} total={data.rows.length} noun="insumos">
      <FilterPill pressed={soloCero} onClick={() => setSoloCero((v) => !v)}>
        Se quedaron en cero
      </FilterPill>
      <FilterPill pressed={soloMinimo} onClick={() => setSoloMinimo((v) => !v)}>
        Bajo el mínimo
      </FilterPill>
      <FilterPill pressed={soloConteo} onClick={() => setSoloConteo((v) => !v)}>
        Con conteo
      </FilterPill>
      <FilterPill pressed={criticos} onClick={() => setCriticos((v) => !v)}>
        Sólo críticos
      </FilterPill>
      <DenseTableSearch value={busqueda} onChange={setBusqueda} placeholder="Buscar insumo" />
    </DenseTableBar>
  )
  const puestos: string[] = [
    ...(soloCero ? ["se quedaron en cero"] : []),
    ...(soloMinimo ? ["bajo el mínimo"] : []),
    ...(soloConteo ? ["con conteo"] : []),
    ...(busqueda ? [`«${busqueda}»`] : []),
  ]
  const quitar = (f: string) => {
    if (f === "se quedaron en cero") setSoloCero(false)
    else if (f === "bajo el mínimo") setSoloMinimo(false)
    else if (f === "con conteo") setSoloConteo(false)
    else setBusqueda("")
  }
  const vacio = filtrosPuestos ? (
    <FilterEmptyState
      title="Sin insumos para estos filtros"
      filters={puestos as [string, ...string[]]}
      onRemove={quitar}
      totalWithoutFilters={data.rows.length}
    />
  ) : (
    <EmptyState
      reason="all-clear"
      title="No hay insumos para mostrar"
      description="Los insumos activos de la sede aparecen acá con su movimiento."
    />
  )

  return (
    <div className="space-y-4">
      {controles}
      <Resumen data={data} />
      {vista === "barras" ? (
        <section className="tabla-densa overflow-hidden rounded-[24px] bg-card">
          {barra}
          {filas.length ? <VistaBarras data={data} rows={filas} /> : <div className="px-4 pb-4">{vacio}</div>}
          <div className="border-t border-border/60 px-4 py-3">
            <Leyenda />
          </div>
        </section>
      ) : (
        <DenseTable
          caption="Movimiento de cada insumo en el período"
          columns={columnas()}
          rows={filas}
          rowKey={(r) => String(r.ingredient_id)}
          rowStatus={(r) => (r.seconds_at_zero > 0 ? "critical" : r.seconds_below_min > 0 ? "warning" : "none")}
          bar={barra}
          empty={vacio}
        />
      )}
    </div>
  )
}
