import { useState } from "react"
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * **34 px medidos.** No es una clase de Tailwind ni una variable de densidad:
 * es el número del patrón (`docs/PATRONES-ADMIN.md` § 8), y va en el `style`
 * de la celda para que ninguna clase de sitio de llamada lo pise.
 */
export const DENSE_ROW_HEIGHT_PX = 34

/**
 * **La regla dura del patrón 8**, y la única forma de que el componente la
 * *impida* en vez de pedirla: ninguna celda de datos parte una palabra ni
 * hace crecer la fila. Si no cabe, la tabla se desliza dentro de su
 * contenedor.
 *
 * Es `style` y no clase a propósito. El defecto real que esto corrige —el
 * número de comanda partido en dos líneas a 1440 y en **cuatro** a 1280, con
 * la fila creciendo de 34 a 61 px— salió de un `overflow-wrap:anywhere` que
 * llegaba desde afuera de la celda. Un estilo en línea gana contra cualquier
 * clase, así que la corrección no se puede volver a perder.
 */
const DATA_CELL_STYLE: React.CSSProperties = {
  height: `${DENSE_ROW_HEIGHT_PX}px`,
  whiteSpace: "nowrap",
  overflowWrap: "normal",
  wordBreak: "normal",
  hyphens: "none",
}

/**
 * Qué clase de dato hay en la columna.
 * - `"number"`: cifra **a la derecha**, con `tabular-nums`.
 * - `"id"`: identificador de una sola palabra (`#1418`), nunca `141`/`8`.
 * - `"name"`: el nombre de la fila, en negrita.
 * - `"secondary"`: dato de apoyo, en tinta 2.
 * - `"actions"`: íconos en columna de **ancho fijo**, para que el borde
 *   derecho no se mueva de fila a fila.
 */
export type DenseCellKind = "text" | "name" | "secondary" | "number" | "id" | "actions"

const KIND_STYLE: Record<DenseCellKind, React.CSSProperties> = {
  text: {},
  name: {},
  secondary: {},
  number: { textAlign: "right", fontVariantNumeric: "tabular-nums" },
  id: { fontVariantNumeric: "tabular-nums", width: "1%" },
  actions: { textAlign: "right", width: "1%" },
}

const KIND_CLASS: Record<DenseCellKind, string> = {
  text: "",
  name: "font-bold",
  secondary: "text-xs text-muted-foreground",
  number: "",
  id: "font-bold",
  actions: "",
}

export interface DenseColumn<R> {
  key: string
  header: string
  kind?: DenseCellKind
  /** Ancho fijo en px cuando la columna no puede bailar. */
  widthPx?: number
  cell: (row: R) => React.ReactNode
  /** Lo largo va al `title` y lo corto a la celda: «hace 1 día» / el instante exacto. */
  cellTitle?: (row: R) => string | undefined
  sort?: { direction?: "asc" | "desc" | null; onSort: () => void }
  /**
   * **Columna secundaria**: no se dibuja hasta que alguien toca «Más
   * columnas» (mapa de pantallas, regla 3: «tablas de cinco columnas como
   * máximo»). No se pierde nada —la columna sigue ahí, a un toque—; lo que
   * cambia es que la primera lectura de la tabla son las cinco que deciden.
   */
  secondary?: boolean
}

/** La franja de estado de la primera celda: la forma del problema, sin leer. */
export type RowStatus = "none" | "ok" | "warning" | "critical"

const STATUS_STRIPE: Record<RowStatus, string> = {
  none: "border-l-transparent",
  ok: "border-l-success/50",
  warning: "border-l-warning",
  critical: "border-l-destructive",
}

/**
 * Una entrada de la leyenda. Sostiene las distinciones que el sistema separa
 * a propósito: negativo ≠ bajo mínimo, sin costo ≠ $ 0, sin enviar ≠ sin
 * cobrar.
 */
export interface LegendEntry {
  term: string
  meaning: React.ReactNode
}

export interface DenseTableProps<R> {
  /** Nombra la tabla para quien navega con lector de pantalla. */
  caption: string
  columns: readonly DenseColumn<R>[]
  rows: readonly R[]
  rowKey: (row: R) => string
  rowStatus?: (row: R) => RowStatus
  /** Una fila inactiva se dibuja apagada y rayada, pero se sigue viendo. */
  rowInactive?: (row: R) => boolean
  /** La barra de la tabla: `<DenseTableBar>`, con el recuento a la izquierda. */
  bar?: React.ReactNode
  /** **Al pie y una sola vez**: el dueño quiere las filas primero. */
  legend?: readonly LegendEntry[]
  /** Totales u otra fila de cierre, dentro del `<tfoot>`. */
  footer?: React.ReactNode
  /** La nota del pie: lo que hace una acción, qué PIN pide, qué no borra. */
  note?: React.ReactNode
  /** Qué se dibuja sin filas. Siempre un `EmptyState` **con motivo**. */
  empty?: React.ReactNode
  /**
   * Alto máximo del cuerpo, en px. Es lo que hace real la **cabecera fija**
   * del patrón: `position: sticky` se pega al ancestro que scrollea, y sin un
   * alto máximo no hay ninguno —la tabla crece y la página entera es la que
   * scrollea—. Sin esta prop la cabecera es una cabecera común, que es la
   * verdad: mejor eso que una clase `sticky` que no pega nada.
   */
  maxBodyHeightPx?: number
  className?: string
}

function SortIcon({ direction }: { direction?: "asc" | "desc" | null }): React.JSX.Element {
  if (direction === "asc") return <ArrowUp className="size-3 text-primary" aria-hidden="true" />
  if (direction === "desc") return <ArrowDown className="size-3 text-primary" aria-hidden="true" />
  return <ArrowUpDown className="size-3 opacity-30" aria-hidden="true" />
}

/**
 * **Tabla densa** (`docs/PATRONES-ADMIN.md` § 8). Fila de 34 px medida,
 * cabecera fija, cifras a la derecha con `tabular-nums`, acciones en columna
 * de ancho fijo.
 *
 * El sitio de llamada **no escribe `<td>`**: declara columnas y entrega
 * filas. Ésa es la parte que hace difícil romper la regla dura —no hay dónde
 * colgarle un `overflow-wrap` a una celda de datos— y la que deja que las
 * cuatro piezas del patrón (barra con recuento, franja de estado, palabra del
 * negocio en vez del enum, leyenda al pie) vivan en un solo lugar.
 *
 * Aplica a Pedidos, Movimientos, Lotes, Conteos, Carta, Compras, Gastos,
 * Documentos, Historial y Empleados.
 */
export function DenseTable<R>({
  caption,
  columns,
  rows,
  rowKey,
  rowStatus,
  rowInactive,
  bar,
  legend,
  footer,
  note,
  empty,
  maxBodyHeightPx,
  className,
}: DenseTableProps<R>): React.JSX.Element {
  const [todas, setTodas] = useState(false)
  const ocultas = columns.filter((column) => column.secondary).length
  const visibles = todas ? columns : columns.filter((column) => !column.secondary)
  const hayLeyenda = (legend && legend.length > 0) || Boolean(note)
  return (
    <section className={cn("overflow-hidden rounded-lg border bg-card", className)}>
      {bar}
      {rows.length === 0 && empty ? (
        <div className="p-3">{empty}</div>
      ) : (
        /* Si no cabe, la tabla se DESLIZA: nunca crece la fila. */
        <div
          className="overflow-auto"
          style={maxBodyHeightPx === undefined ? undefined : { maxHeight: `${maxBodyHeightPx}px` }}
        >
          <table className="w-full text-[0.9rem]">
            <caption className="sr-only">{caption}</caption>
            <thead>
              <tr>
                {visibles.map((column) => {
                  const kind = column.kind ?? "text"
                  const sorted = column.sort?.direction
                  return (
                    <th
                      key={column.key}
                      scope="col"
                      aria-sort={
                        sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : undefined
                      }
                      style={{
                        height: "30px",
                        whiteSpace: "nowrap",
                        ...KIND_STYLE[kind],
                        ...(column.widthPx === undefined ? {} : { width: `${column.widthPx}px` }),
                      }}
                      className="sticky top-0 z-[1] border-b-2 bg-muted px-2 text-[0.65rem] tracking-wide text-muted-foreground uppercase"
                    >
                      {column.sort ? (
                        <button
                          type="button"
                          onClick={column.sort.onSort}
                          className="inline-flex items-center gap-1 font-[inherit] tracking-[inherit] uppercase hover:text-primary"
                        >
                          {column.header}
                          <SortIcon direction={column.sort.direction} />
                        </button>
                      ) : (
                        column.header
                      )}
                    </th>
                  )
                })}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const status = rowStatus?.(row) ?? "none"
                const inactive = rowInactive?.(row) ?? false
                return (
                  <tr
                    key={rowKey(row)}
                    data-status={status}
                    data-inactive={inactive ? "true" : undefined}
                    style={{ height: `${DENSE_ROW_HEIGHT_PX}px` }}
                    className={cn("border-b hover:bg-muted/60", inactive && "text-muted-foreground")}
                  >
                    {visibles.map((column, i) => {
                      const kind = column.kind ?? "text"
                      return (
                        <td
                          key={column.key}
                          title={column.cellTitle?.(row)}
                          style={{
                            ...DATA_CELL_STYLE,
                            ...KIND_STYLE[kind],
                            ...(column.widthPx === undefined ? {} : { width: `${column.widthPx}px` }),
                          }}
                          className={cn(
                            "px-2 align-middle",
                            KIND_CLASS[kind],
                            i === 0 && cn("border-l-[3px]", STATUS_STRIPE[status]),
                          )}
                        >
                          {column.cell(row)}
                        </td>
                      )
                    })}
                  </tr>
                )
              })}
            </tbody>
            {/* El total va bajo **doble raya**, como en el libro contable
                (`docs/diseno/propuesta.html` § Tablas): la raya dice «esto
                ya no es un renglón más, es la suma que da el servidor». */}
            {footer ? (
              <tfoot className="border-t-[3px] border-double border-foreground/60 bg-muted font-bold">{footer}</tfoot>
            ) : null}
          </table>
        </div>
      )}

      {ocultas > 0 || hayLeyenda ? (
        <div className="flex flex-wrap items-start gap-x-4 border-t px-3 py-1.5 text-xs text-muted-foreground">
          {ocultas > 0 ? (
            <button
              type="button"
              aria-pressed={todas}
              onClick={() => setTodas((v) => !v)}
              className="rounded-md px-1.5 py-1 font-medium text-primary hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              {todas ? "Menos columnas" : `Más columnas (${ocultas})`}
            </button>
          ) : null}
          {/* **Plegada** (mapa de pantallas, regla 5): la leyenda sostiene
              distinciones que importan —negativo ≠ bajo mínimo, sin costo ≠
              $ 0— pero se lee una vez, no cada vez que se abre la tabla. */}
          {hayLeyenda ? (
            <details className="min-w-0 flex-1 basis-full sm:basis-auto">
              <summary className="cursor-pointer rounded-md px-1.5 py-1 font-medium select-none hover:text-foreground">
                Cómo leer esta tabla
              </summary>
              {legend && legend.length > 0 ? (
                <dl className="grid gap-x-5 gap-y-1 px-1.5 pt-1 pb-1.5 sm:grid-cols-2 xl:grid-cols-3">
                  {legend.map((entry) => (
                    <div key={entry.term} className="min-w-0">
                      <dt className="inline font-bold text-foreground">{entry.term}</dt>{" "}
                      <dd className="inline">— {entry.meaning}</dd>
                    </div>
                  ))}
                </dl>
              ) : null}
              {note ? <div className="px-1.5 pb-1.5">{note}</div> : null}
            </details>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}

export interface DenseTableBarProps {
  /**
   * **El recuento**, que es lo que convierte casillas mudas en un control con
   * respuesta: «14 de 47 activos · 33 al día, ocultos por los filtros». Los
   * números se pasan como números y el componente escribe la frase: un
   * recuento armado a mano en cada pantalla es un recuento que se desincroniza.
   */
  shown: number
  total: number
  /** El sustantivo: «activos», «comandas abiertas», «documentos». */
  noun: string
  /** Lo que los filtros esconden, en palabras: «33 al día, ocultos por los filtros». */
  hidden?: string
  /** Filtros y salidas, a la derecha. */
  children?: React.ReactNode
  className?: string
}

/**
 * **(a) La barra de la tabla.** El recuento a la izquierda, los filtros y las
 * salidas a la derecha. Con pestañas, la acción primaria de la pantalla baja
 * hasta acá (`docs/PATRONES-ADMIN.md` § 2 y § 8).
 */
export function DenseTableBar({
  shown,
  total,
  noun,
  hidden,
  children,
  className,
}: DenseTableBarProps): React.JSX.Element {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-2 border-b bg-muted px-3 py-2",
        className,
      )}
    >
      <p className="min-w-0 text-xs text-muted-foreground">
        <b className="font-bold text-foreground tabular-nums">{shown}</b> de{" "}
        <b className="font-bold text-foreground tabular-nums">{total}</b> {noun}
        {hidden ? <> · {hidden}</> : null}
      </p>
      {children ? <div className="ml-auto flex flex-wrap items-center gap-2">{children}</div> : null}
    </div>
  )
}

export default DenseTable
