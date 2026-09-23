import { useQuery } from "@tanstack/react-query"
import { useState } from "react"

import { getInventoryStock, inventoryStockCsvUrl, type StockRowOut } from "@/api/inventory"
import {
  DenseTable,
  DenseTableBar,
  FilterEmptyState,
  OriginBar,
  TimeAgo,
  type DenseColumn,
  type LegendEntry,
  type RowStatus,
} from "@/components/admin"
import { CostValue } from "@/components/CostValue"
import { CsvExportButton } from "@/components/CsvExportButton"
import { EmptyState } from "@/components/EmptyState"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { errorMessage } from "@/lib/errors"
import { formatCantidad } from "@/lib/format"
import { cn } from "@/lib/utils"

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
 * un color crudo, y **nunca es la única señal**: la palabra la dice también.
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
  const [label, dot] = row.negative
    ? (["Negativo", "bg-destructive"] as const)
    : row.below_min
      ? (["Bajo mínimo", "bg-warning"] as const)
      : (["Al día", "bg-success"] as const)
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={cn("size-1.5 shrink-0 rounded-full", dot)} aria-hidden="true" />
      {label}
    </span>
  )
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

/**
 * Admin → Inventario → Stock (SPEC-NEGOCIO §5.2 / §9.3): saldo teórico por
 * insumo, filtros por críticos/bajo mínimo/negativos — la MISMA combinación
 * AND que aplica el servidor (`backend/app/inventory/service.py
 * stock_rows`), nunca una intersección calculada acá. El costo siempre con
 * su origen; ningún saldo se deriva en el cliente.
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
  const [criticalOnly, setCriticalOnly] = useState(initialCriticalOnly)
  const [belowMin, setBelowMin] = useState(initialBelowMin)
  const [negative, setNegative] = useState(initialNegative)

  /**
   * Se llegó acá **desde un enlace con filtro** —una tarjeta o un aviso de
   * Hoy—, no tocando la pestaña. Se congela en el primer render a propósito:
   * la barra de procedencia cuenta de dónde venís, y eso no deja de ser
   * cierto porque después toques una casilla.
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

  const rows = query.data ?? []
  const total = totalQuery.data?.length

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

  const columns: readonly DenseColumn<StockRowOut>[] = [
    {
      key: "name",
      header: "Insumo",
      kind: "name",
      cell: (row) => (
        <span className="inline-flex items-center gap-2">
          {row.name}
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
      header: "Stock teórico",
      kind: "number",
      // El saldo negativo es lo único que se tiñe en la columna de cantidad:
      // es el dato que la fila vino a denunciar.
      cell: (row) => (
        <span className={cn(row.negative && "font-bold text-destructive")}>
          {formatCantidad(row.qty_base, unit(row))}
        </span>
      ),
    },
    {
      key: "min",
      header: "Mínimo",
      kind: "number",
      cell: (row) => formatCantidad(row.min_stock, unit(row)),
    },
    {
      key: "status",
      header: "Estado",
      cell: (row) => <StatusCell row={row} />,
    },
    {
      key: "since",
      header: "Desde",
      kind: "secondary",
      // «hace 1 día» en la celda y el instante exacto en el `title` —que
      // `TimeAgo` ya pone solo—: la columna deja de gastar 130 px en un
      // minuto que a nadie le importa (`docs/PATRONES-ADMIN.md`, el defecto
      // medido de a1).
      cell: (row) => <TimeAgo iso={row.negative_since} />,
    },
    {
      key: "cost",
      header: "Costo por unidad",
      kind: "number",
      // `CostValue` ya dice «Sin costo» y nunca «$ 0»: la distinción vive en
      // el componente compartido, y la leyenda del pie la explica.
      cell: (row) => <CostValue cost={row.cost} costSource={row.cost_source} />,
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

  const filters = (
    <>
      <div className="flex items-center gap-2">
        <Checkbox
          id="stock-critical"
          checked={criticalOnly}
          onCheckedChange={(v) => setCriticalOnly(v === true)}
        />
        <Label htmlFor="stock-critical">Sólo críticos</Label>
      </div>
      <div className="flex items-center gap-2">
        <Checkbox id="stock-below-min" checked={belowMin} onCheckedChange={(v) => setBelowMin(v === true)} />
        <Label htmlFor="stock-below-min">Bajo mínimo</Label>
      </div>
      <div className="flex items-center gap-2">
        <Checkbox id="stock-negative" checked={negative} onCheckedChange={(v) => setNegative(v === true)} />
        <Label htmlFor="stock-negative">Negativos</Label>
      </div>
      <CsvExportButton
        href={inventoryStockCsvUrl({
          storeId,
          criticalOnly,
          belowMin,
          negative,
        })}
      />
    </>
  )

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
        rowStatus={statusOf}
        legend={LEGEND}
        bar={
          <DenseTableBar
            shown={rows.length}
            total={total ?? rows.length}
            noun="insumos activos"
            hidden={
              query.isLoading
                ? "contando…"
                : total !== undefined && total > rows.length
                  ? `${total - rows.length} ocultos por ${applied.length === 1 ? `el filtro «${applied[0]}»` : "los filtros"}`
                  : undefined
            }
          >
            {filters}
          </DenseTableBar>
        }
        note={
          <>
            <b>Ámbar y rojo no son dos grados de lo mismo</b>: ámbar es que falta comprar, rojo es que falta
            registrar. Un saldo negativo se explica con un movimiento —una compra que no se registró, una
            merma que no se cargó— o se corrige con un ajuste manual desde Movimientos, que pide PIN de
            administrador y deja el motivo. <b>El ajuste no borra la deuda: la explica.</b>
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
          ) : (
            <EmptyState
              title="Todavía no hay insumos"
              description="El stock se arma sobre los insumos de la pestaña Insumos. Creá el primero ahí."
            />
          )
        }
      />
    </div>
  )
}

export default StockTab
