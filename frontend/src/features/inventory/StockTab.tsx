import { useQuery } from "@tanstack/react-query"
import { FileText, History, RotateCcw, SlidersHorizontal } from "lucide-react"
import { useState } from "react"
import { Link, useNavigate } from "react-router-dom"

import { useSession } from "@/app/session"
import { getInventoryStock, inventoryStockCsvUrl, type StockRowOut } from "@/api/inventory"
import {
  DenseTable,
  DenseTableBar,
  DenseTableSearch,
  FilterEmptyState,
  FilterPill,
  OriginBar,
  RowStatusLabel,
  TimeAgo,
  type DenseColumn,
  type LegendEntry,
  type RowStatus,
} from "@/components/admin"
import { CostValue } from "@/components/CostValue"
import { CsvExportButton } from "@/components/CsvExportButton"
import { EmptyState } from "@/components/EmptyState"
import { buttonVariants } from "@/components/ui/button"
import { DropdownMenuItem } from "@/components/ui/dropdown-menu"
import { errorMessage } from "@/lib/errors"
import { formatCantidad } from "@/lib/format"
import { cn } from "@/lib/utils"
import { fichaInsumoHref } from "@/features/reports/fichas/rutas"

import { AdjustmentDialog } from "./AdjustmentDialog"
import { RecountDialog } from "./RecountDialog"

const UNIT_LABEL: Record<string, string> = { g: "g", ml: "ml", unit: "unidad" }

function unit(row: StockRowOut): string {
  return UNIT_LABEL[row.base_unit] ?? row.base_unit
}

/**
 * **La distinción que esta pantalla existe para sostener** (SPEC-NEGOCIO
 * §5.2, `docs/PATRONES-ADMIN.md` § 8d). En la referencia un helado estuvo
 * tres meses en −400 g sin que nadie lo viera porque «negativo» y «bajo
 * mínimo» se habían confundido en una sola alerta.
 *
 * No son dos grados de lo mismo:
 *
 * - **Bajo mínimo** es **ámbar** y es **escasez**: hay existencia, por
 *   debajo del umbral de la ficha. Falta comprar.
 * - **Negativo** es **rojo** y es **deuda de registro**: se descontó más de
 *   lo que se registró entrando. **No bloquea la venta** — miente el costo
 *   del plato. Falta registrar.
 *
 * El color va por el token de estado (`warning` / `destructive`), nunca por
 * un color crudo, y **nunca es la única señal**: la forma (■ ▲ ●) y la
 * palabra lo dicen también.
 */
function statusOf(row: StockRowOut): RowStatus {
  if (row.negative) return "critical"
  if (row.below_min) return "warning"
  // Al día no lleva franja. La franja es «la forma del problema sin leer»
  // (patrón 8b): si también tiñe lo que está bien, deja de señalar nada y el
  // color vuelve a ser decoración.
  return "none"
}

function StatusCell({ row }: { row: StockRowOut }): React.JSX.Element {
  // `negative` implica `below_min` (el mínimo siempre es > 0), así que se
  // dice UNA sola cosa por fila: el estado más grave. Decir las dos sería
  // ruido, no una alerta nueva.
  if (row.negative) return <RowStatusLabel status="critical">Negativo</RowStatusLabel>
  if (row.below_min) return <RowStatusLabel status="warning">Bajo mínimo</RowStatusLabel>
  return <RowStatusLabel status="ok">Al día</RowStatusLabel>
}

/**
 * **(d) La leyenda, al pie y una sola vez.** Sostiene las tres distinciones
 * que el sistema separa a propósito y que un rediseño tiende a unificar. Al
 * pie y no arriba: el dueño quiere las filas primero y la referencia cuando
 * dude (`docs/PATRONES-ADMIN.md` § 8).
 */
const LEGEND: readonly LegendEntry[] = [
  {
    term: "Negativo",
    meaning: (
      <>
        se descontó más de lo que se registró entrando. Es <b>deuda de registro</b>: no bloquea la venta, pero
        el costo de cada plato con ese insumo miente hasta que entre la compra o un ajuste.
      </>
    ),
  },
  {
    term: "Bajo mínimo",
    meaning: (
      <>
        hay existencia, por debajo del umbral que vos pusiste en la ficha. Es de <b>reposición</b>, no de
        registro.
      </>
    ),
  },
  {
    term: "Sin costo",
    meaning: (
      <>
        no es <b>$ 0</b> — el insumo no tiene costo oficial ni estimado. No se sabe cuánto vale, y por eso no
        entra en ninguna suma de costo.
      </>
    ),
  },
]

/** Cómo se llama cada filtro **en palabras**, que es como lo nombran el enlace
 * de Hoy (`FilterLink`), la barra de procedencia y el vacío por filtro. Una
 * sola fuente: tres frases escritas a mano se desincronizan. */
const FILTER_WORD = {
  criticalOnly: "sólo críticos",
  belowMin: "bajo mínimo",
  negative: "negativos",
} as const

/** La búsqueda por nombre: sin tildes ni mayúsculas, «limon» encuentra «Limón». */
function normalizar(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim()
}

/**
 * Admin → Inventario → Stock (SPEC-NEGOCIO §5.2 / §9.3), con la tabla densa
 * del handoff (pantalla 12): barra con recuento, filtros en píldora y la
 * acción primaria; cinco columnas y «Más columnas»; «?» por encabezado;
 * franja de estado con forma y palabra; «Sin costo» rayado; «⋯» por fila.
 *
 * Los filtros son la MISMA combinación AND que aplica el servidor
 * (`backend/app/inventory/service.py stock_rows`), nunca una intersección
 * calculada acá. La búsqueda por nombre sí es local: no filtra datos del
 * negocio, sólo encuentra una fila entre las que ya llegaron. El costo
 * siempre con su origen; ningún saldo se deriva en el cliente.
 *
 * **La columna Stock deja lista la ranura del mini gráfico** (barra = stock,
 * raya = mínimo) pero no lo dibuja: lo enchufa `components/charts` por
 * `DenseColumn.bullet` cuando exista (y cuando el servidor mande el tope, que
 * el cliente no calcula).
 */
export function StockTab({
  storeId,
  initialCriticalOnly = false,
  initialBelowMin = false,
  initialNegative = false,
  onDropArrival,
}: {
  storeId: number
  initialCriticalOnly?: boolean
  initialBelowMin?: boolean
  initialNegative?: boolean
  /** Limpia también la query de la URL cuando se toma la salida (patrón 6). */
  onDropArrival?: () => void
}): React.JSX.Element {
  const { hasFeature } = useSession()
  const navigate = useNavigate()
  const [criticalOnly, setCriticalOnly] = useState(initialCriticalOnly)
  const [belowMin, setBelowMin] = useState(initialBelowMin)
  const [negative, setNegative] = useState(initialNegative)
  const [busqueda, setBusqueda] = useState("")
  const [ajustar, setAjustar] = useState<StockRowOut | null>(null)
  const [recontar, setRecontar] = useState<StockRowOut | null>(null)

  /**
   * Se llegó acá **desde un enlace con filtro** —una tarjeta o un aviso de
   * Hoy—, no tocando la pestaña. Se congela en el primer render a propósito:
   * la barra de procedencia cuenta de dónde venís, y eso no deja de ser
   * cierto porque después toques un filtro.
   */
  const [arrivedFiltered] = useState(initialCriticalOnly || initialBelowMin || initialNegative)
  const [arrivalDropped, setArrivalDropped] = useState(false)

  const query = useQuery({
    queryKey: ["inventory", "stock", storeId, criticalOnly, belowMin, negative],
    queryFn: () => getInventoryStock({ storeId, criticalOnly, belowMin, negative }),
  })

  // El total sin filtros es lo que deja decir «y ver los 47»: sin él, la
  // salida del patrón 6 no puede nombrar cuántas filas hay del otro lado.
  // Es la MISMA consulta que ya existe, sin filtros — no una ruta nueva.
  const totalQuery = useQuery({
    queryKey: ["inventory", "stock", storeId, false, false, false],
    queryFn: () =>
      getInventoryStock({
        storeId,
        criticalOnly: false,
        belowMin: false,
        negative: false,
      }),
  })

  const filtradas = query.data ?? []
  const buscado = normalizar(busqueda)
  const rows = buscado === "" ? filtradas : filtradas.filter((row) => normalizar(row.name).includes(buscado))
  const total = totalQuery.data?.length
  // Cuántas están en alerta: un recuento de filas que el servidor ya marcó
  // (`below_min`), no una cifra derivada.
  const enAlerta = totalQuery.data?.filter((row) => row.below_min).length

  const applied: string[] = [
    ...(criticalOnly ? [FILTER_WORD.criticalOnly] : []),
    ...(belowMin ? [FILTER_WORD.belowMin] : []),
    ...(negative ? [FILTER_WORD.negative] : []),
  ]

  function dropFilter(word: string): void {
    if (word === FILTER_WORD.criticalOnly) setCriticalOnly(false)
    if (word === FILTER_WORD.belowMin) setBelowMin(false)
    if (word === FILTER_WORD.negative) setNegative(false)
  }

  function dropAll(): void {
    setCriticalOnly(false)
    setBelowMin(false)
    setNegative(false)
    setArrivalDropped(true)
    onDropArrival?.()
  }

  function verTodos(): void {
    setCriticalOnly(false)
    setBelowMin(false)
    setNegative(false)
  }

  const columns: readonly DenseColumn<StockRowOut>[] = [
    {
      key: "name",
      header: "Insumo",
      kind: "name",
      cell: (row) => (
        <span className="inline-flex items-center gap-2">
          {/* El insumo lleva a su ficha: stock, entradas y salidas por causa, conteos. */}
          <Link to={fichaInsumoHref(row.ingredient_id)} className="text-primary hover:underline">
            {row.name}
          </Link>
          {row.key_item ? (
            <span className="rounded border px-1 py-px text-[0.7rem] font-normal text-muted-foreground">
              Crítico
            </span>
          ) : null}
        </span>
      ),
    },
    {
      key: "qty",
      header: "Stock",
      kind: "number",
      help: "Lo que dice el sistema ahora: último conteo más entradas menos salidas. Es teórico: sale de restarle a las compras lo que las recetas dicen que se gastó.",
      // El saldo que no llega es lo único que se remarca en la columna de
      // cantidad: rojo si es negativo, negrita si está bajo mínimo.
      cell: (row) => (
        <span className={cn(row.negative && "font-bold text-destructive", !row.negative && row.below_min && "font-bold")}>
          {formatCantidad(row.qty_base, unit(row))}
        </span>
      ),
    },
    {
      key: "min",
      header: "Mínimo",
      kind: "number",
      help: "Debajo de esto el insumo queda «bajo mínimo» y Reposición lo sugiere en la próxima compra. Se cambia en la ficha del insumo.",
      cell: (row) => formatCantidad(row.min_stock, unit(row)),
    },
    {
      key: "status",
      header: "Estado",
      help: "Negativo: el sistema descontó más de lo que había (falta registrar una compra o una receta está mal). Bajo mínimo es otra cosa: hay, pero poco.",
      cell: (row) => <StatusCell row={row} />,
    },
    {
      key: "cost",
      header: "Costo por unidad",
      kind: "number",
      help: "Costo por unidad de uso, con su origen (oficial, promedio ponderado, estimado…). «Sin costo» no es $ 0: falta la factura.",
      // `CostValue` dice «Sin costo» rayado y nunca «$ 0»: la distinción vive
      // en el componente compartido, y la leyenda del pie la explica.
      cell: (row) => <CostValue cost={row.cost} costSource={row.cost_source} variant="celda" />,
    },
    {
      key: "since",
      header: "Negativo desde",
      kind: "secondary",
      // Detrás de «Más columnas» (regla 3): el estado ya dice si es
      // negativo; desde cuándo es el segundo vistazo.
      secondary: true,
      // «hace 1 día» en la celda y el instante exacto en el `title` —que
      // `TimeAgo` ya pone solo—: la columna deja de gastar 130 px en un
      // minuto que a nadie le importa (`docs/PATRONES-ADMIN.md`, el defecto
      // medido de a1).
      cell: (row) => <TimeAgo iso={row.negative_since} />,
    },
  ]

  if (query.isError) {
    return (
      <EmptyState
        role="alert"
        title="No se pudo cargar el stock"
        description={errorMessage(query.error)}
        action={{ label: "Reintentar", onClick: () => void query.refetch() }}
      />
    )
  }

  const hidden = query.isLoading
    ? "contando…"
    : [
        ...(total !== undefined && total > filtradas.length
          ? [
              `${total - filtradas.length} ocultos por ${applied.length === 1 ? `el filtro «${applied[0]}»` : "los filtros"}`,
            ]
          : []),
        ...(filtradas.length > rows.length ? [`${filtradas.length - rows.length} no coinciden con «${busqueda.trim()}»`] : []),
        ...(applied.length === 0 && buscado === "" && enAlerta !== undefined && enAlerta > 0
          ? [`${enAlerta} en alerta`]
          : []),
      ].join(" · ") || undefined

  return (
    <div className="space-y-3">
      {arrivedFiltered && !arrivalDropped && applied.length > 0 ? (
        <OriginBar
          from="Venís de Hoy, con la pestaña Stock y el filtro ya puestos."
          applied={applied as [string, ...string[]]}
          exit={{
            label: total === undefined ? "Quitar el filtro" : `Quitar el filtro y ver los ${total}`,
            onClick: dropAll,
          }}
          back={{ label: "Volver a Hoy", to: "/admin/hoy" }}
        />
      ) : null}

      <DenseTable
        caption="Stock teórico por insumo"
        columns={columns}
        rows={rows}
        rowKey={(row) => String(row.ingredient_id)}
        rowLabel={(row) => row.name}
        rowStatus={statusOf}
        legend={LEGEND}
        rowMenuNote="Nada se borra: los ajustes quedan en el libro con motivo."
        rowMenu={(row) => (
          <>
            <DropdownMenuItem onClick={() => void navigate(fichaInsumoHref(row.ingredient_id))}>
              <FileText className="text-muted-foreground" aria-hidden="true" />
              Ver ficha del insumo
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setAjustar(row)}>
              <SlidersHorizontal className="text-muted-foreground" aria-hidden="true" />
              Ajustar con motivo
            </DropdownMenuItem>
            {hasFeature("inventory.shift_counts") ? (
              <DropdownMenuItem onClick={() => setRecontar(row)}>
                <RotateCcw className="text-muted-foreground" aria-hidden="true" />
                Pedir recuento
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem
              onClick={() => void navigate(`/admin/inventario?tab=movimientos&insumo=${row.ingredient_id}`)}
            >
              <History className="text-muted-foreground" aria-hidden="true" />
              Ver libro de movimientos
            </DropdownMenuItem>
          </>
        )}
        bar={
          <DenseTableBar shown={rows.length} total={total ?? filtradas.length} noun="insumos" hidden={hidden}>
            {/* Los filtros del servidor, en píldora. «Todos» es la salida:
                apaga los tres de una. Se combinan como en el servidor (Y). */}
            <FilterPill pressed={applied.length === 0} onClick={verTodos}>
              Todos
            </FilterPill>
            <FilterPill pressed={belowMin} onClick={() => setBelowMin((v) => !v)}>
              Bajo mínimo
            </FilterPill>
            <FilterPill pressed={negative} onClick={() => setNegative((v) => !v)}>
              Negativos
            </FilterPill>
            <FilterPill pressed={criticalOnly} onClick={() => setCriticalOnly((v) => !v)}>
              Sólo críticos
            </FilterPill>
            <DenseTableSearch value={busqueda} onChange={setBusqueda} placeholder="Buscar insumo" />
            <CsvExportButton
              href={inventoryStockCsvUrl({
                storeId,
                criticalOnly,
                belowMin,
                negative,
              })}
            />
            {/* La acción primaria de la pestaña baja a la barra de su tabla
                (patrón 2). Detrás de su flag: sin compras no hay a dónde ir. */}
            {hasFeature("purchases") ? (
              <Link
                to="/admin/compras?tab=recepciones"
                className={cn(buttonVariants({ size: "sm" }), "h-[30px] min-h-0 px-3 text-[0.8125rem] font-semibold")}
              >
                Registrar compra
              </Link>
            ) : null}
          </DenseTableBar>
        }
        note={
          <>
            <b>Ámbar y rojo no son dos grados de lo mismo</b>: ámbar es que falta comprar, rojo es que falta
            registrar. Un saldo negativo se explica con un movimiento —una compra que no se registró, una
            merma que no se cargó— o se corrige con un ajuste manual («⋯» › Ajustar con motivo), que pide PIN
            de administrador y deja el motivo. <b>El ajuste no borra la deuda: la explica.</b>
          </>
        }
        empty={
          query.isLoading ? undefined : applied.length > 0 ? (
            <FilterEmptyState
              title="Sin insumos para estos filtros"
              filters={applied as [string, ...string[]]}
              onRemove={dropFilter}
              totalWithoutFilters={total}
            />
          ) : buscado !== "" ? (
            <EmptyState
              title={`Ningún insumo se llama «${busqueda.trim()}»`}
              description="La búsqueda mira sólo el nombre. Borrala para ver todos."
            />
          ) : (
            <EmptyState
              title="Todavía no hay insumos"
              description="El stock se arma sobre los insumos de la pestaña Insumos. Creá el primero ahí."
            />
          )
        }
      />

      {/* Los diálogos del «⋯», montados sólo cuando una fila los pide: cada
          vez arrancan con el insumo de esa fila y nada de la anterior. */}
      {ajustar ? (
        <AdjustmentDialog
          key={`ajustar-${ajustar.ingredient_id}`}
          storeId={storeId}
          ingredients={(totalQuery.data ?? filtradas).map((row) => ({ id: row.ingredient_id, name: row.name }))}
          initialIngredientId={ajustar.ingredient_id}
          open
          onOpenChange={(open) => {
            if (!open) setAjustar(null)
          }}
          showTrigger={false}
        />
      ) : null}
      {recontar ? (
        <RecountDialog
          key={`recontar-${recontar.ingredient_id}`}
          storeId={storeId}
          ingredientId={recontar.ingredient_id}
          open
          onOpenChange={(open) => {
            if (!open) setRecontar(null)
          }}
          showTrigger={false}
        />
      ) : null}
    </div>
  )
}

export default StockTab
