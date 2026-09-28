import { useId, useState } from "react"
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronRight, CircleHelp, Search } from "lucide-react"

import { cn } from "@/lib/utils"

import { MenuDeFila } from "./MenuDeFila"

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
  /**
   * **La ayuda del encabezado** (handoff, pantalla 12): un «?» de 18 px al
   * lado del rótulo que abre, debajo del encabezado, una fila `accent` con la
   * explicación —«Estado: Negativo es…»—. Sólo en las columnas que la
   * necesitan; una a la vez. Es la regla 2 («la explicación va plegada»)
   * llevada a la columna: la definición está a un toque y no en cada fila.
   */
  help?: React.ReactNode
  /**
   * **La ranura del mini gráfico** («bullet» de 90 × 10 px del lenguaje
   * barra + raya). La tabla no dibuja el gráfico: reserva su lugar a la
   * derecha de la cifra, con ancho fijo para que la columna no baile, y
   * pinta lo que devuelva esta función. Lo enchufa `components/charts`
   * (p. ej. la columna Stock de Inventario: barra = stock, raya = mínimo).
   * Si devuelve `null` para una fila, la ranura queda vacía pero reservada.
   */
  bullet?: (row: R) => React.ReactNode
}

/** Ancho y alto de la ranura del mini gráfico, medidos en el handoff. */
export const DENSE_BULLET_SIZE = { width: 90, height: 10 } as const

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
  /**
   * Totales u otra fila de cierre, dentro del `<tfoot>`. Si la tabla tiene
   * columnas secundarias, puede ser una función que recibe si están abiertas
   * («Más columnas»): la fila de total tiene que tener las mismas celdas que
   * el encabezado, o sus cifras quedan corridas bajo otra columna.
   */
  footer?: React.ReactNode | ((todasLasColumnas: boolean) => React.ReactNode)
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
  /**
   * **Las acciones de la fila, en «⋯»** (regla 3). Devuelve los
   * `<DropdownMenuItem>` —con el rótulo literal adentro, para que el censo
   * de controles los vea—. La tabla agrega la columna de ancho fijo, el
   * botón con el nombre de la fila y la nota al pie del menú.
   */
  rowMenu?: (row: R) => React.ReactNode
  /** De qué fila son las acciones: «Acciones de Aceite», no nueve veces «Acciones». */
  rowLabel?: (row: R) => string
  /** La nota al pie del menú. Por defecto dice que nada se borra. */
  rowMenuNote?: React.ReactNode
  className?: string
}

/** Lo que dice el pie del menú «⋯» si el sitio de llamada no dice otra cosa. */
export const NADA_SE_BORRA = "Nada se borra: lo que se corrige queda en el libro, con su motivo."

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
  rowMenu,
  rowLabel,
  rowMenuNote = NADA_SE_BORRA,
  className,
}: DenseTableProps<R>): React.JSX.Element {
  const [todas, setTodas] = useState(false)
  const [ayuda, setAyuda] = useState<string | null>(null)
  const idAyuda = useId()
  const ocultas = columns.filter((column) => column.secondary).length
  const visibles = todas ? columns : columns.filter((column) => !column.secondary)
  const hayLeyenda = (legend && legend.length > 0) || Boolean(note)
  // La ayuda abierta sólo se dibuja si su columna está a la vista: plegar
  // «Más columnas» con la ayuda de una secundaria abierta la cierra sola.
  const ayudaAbierta = visibles.find((column) => column.key === ayuda && column.help !== undefined)
  const totalColumnas = visibles.length + (rowMenu ? 1 : 0)
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
                      className="sticky top-0 z-[1] border-b-2 bg-muted px-2 text-[0.65rem] font-semibold tracking-[0.06em] text-muted-foreground uppercase"
                    >
                      <span className="inline-flex items-center gap-1">
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
                        {column.help !== undefined ? (
                          <button
                            type="button"
                            aria-label={`¿Qué es ${column.header}?`}
                            aria-expanded={ayudaAbierta?.key === column.key}
                            aria-controls={idAyuda}
                            onClick={() => setAyuda((actual) => (actual === column.key ? null : column.key))}
                            className={cn(
                              "grid size-[18px] shrink-0 place-items-center rounded-full normal-case transition-colors",
                              "focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                              ayudaAbierta?.key === column.key
                                ? "bg-primary text-primary-foreground"
                                : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                            )}
                          >
                            <CircleHelp className="size-[13px]" aria-hidden="true" />
                          </button>
                        ) : null}
                      </span>
                    </th>
                  )
                })}
                {rowMenu ? (
                  <th
                    scope="col"
                    style={{ height: "30px", width: "1%" }}
                    className="sticky top-0 z-[1] border-b-2 bg-muted px-1.5"
                  >
                    <span className="sr-only">Acciones</span>
                  </th>
                ) : null}
              </tr>
              {/* La explicación del encabezado: una fila `accent` a todo el
                  ancho, debajo de los rótulos y encima de los datos. */}
              {ayudaAbierta ? (
                <tr id={idAyuda}>
                  <td
                    colSpan={totalColumnas}
                    className="border-b bg-accent px-3 py-2.5 text-[0.8125rem] whitespace-normal text-accent-foreground"
                  >
                    <b className="font-bold">{ayudaAbierta.header}:</b> {ayudaAbierta.help}
                  </td>
                </tr>
              ) : null}
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
                          {column.bullet ? (
                            <span className="flex w-full items-center justify-end gap-2.5">
                              <span>{column.cell(row)}</span>
                              <span
                                data-slot="bullet"
                                className="relative shrink-0"
                                style={{
                                  width: `${DENSE_BULLET_SIZE.width}px`,
                                  height: `${DENSE_BULLET_SIZE.height}px`,
                                }}
                              >
                                {column.bullet(row)}
                              </span>
                            </span>
                          ) : (
                            column.cell(row)
                          )}
                        </td>
                      )
                    })}
                    {rowMenu ? (
                      <td style={{ ...DATA_CELL_STYLE, width: "1%" }} className="px-1.5 text-right align-middle">
                        <MenuDeFila nombre={rowLabel?.(row) ?? rowKey(row)} nota={rowMenuNote}>
                          {rowMenu(row)}
                        </MenuDeFila>
                      </td>
                    ) : null}
                  </tr>
                )
              })}
            </tbody>
            {/* El total va bajo **doble raya**, como en el libro contable
                (`docs/diseno/propuesta.html` § Tablas): la raya dice «esto
                ya no es un renglón más, es la suma que da el servidor». */}
            {footer ? (
              <tfoot className="border-t-[3px] border-double border-foreground/60 bg-muted font-bold">
                {typeof footer === "function" ? footer(todas) : footer}
              </tfoot>
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
              className="rounded-md px-1.5 py-1 font-semibold text-primary hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              {todas ? "Menos columnas" : `Más columnas (${ocultas})`}
            </button>
          ) : null}
          {/* **Plegada** (mapa de pantallas, regla 5): la leyenda sostiene
              distinciones que importan —negativo ≠ bajo mínimo, sin costo ≠
              $ 0— pero se lee una vez, no cada vez que se abre la tabla. */}
          {hayLeyenda ? (
            <details className="group min-w-0 flex-1 basis-full sm:basis-auto">
              <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded-md px-1.5 py-1 font-semibold select-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none [&::-webkit-details-marker]:hidden">
                <ChevronRight
                  className="size-[13px] shrink-0 transition-transform group-open:rotate-90"
                  aria-hidden="true"
                />
                Cómo leer esta tabla
              </summary>
              {legend && legend.length > 0 ? (
                <dl className="grid gap-x-5 gap-y-1.5 px-1.5 pt-1 pb-2 sm:grid-cols-2 xl:grid-cols-3">
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

/**
 * **(b') La palabra del estado, con su forma.** La franja de 3 px de la
 * primera celda dice «hay algo» sin leer; esto dice qué, con el semáforo por
 * forma (■ crítico, ▲ atención, ● al día) y el texto. Nunca sólo color.
 */
export function RowStatusLabel({
  status,
  children,
}: {
  status: Exclude<RowStatus, "none">
  children: React.ReactNode
}): React.JSX.Element {
  const [forma, tinta] =
    status === "critical"
      ? (["semaforo-red", "text-destructive"] as const)
      : status === "warning"
        ? (["semaforo-amber", "text-warning"] as const)
        : (["semaforo-green", "text-success"] as const)
  return (
    <span data-status={status} className={cn("inline-flex items-center gap-1.5 text-xs font-bold", tinta)}>
      <span className={cn("semaforo", forma)} aria-hidden="true" />
      {children}
    </span>
  )
}

/**
 * **Un filtro de la barra, en píldora** (handoff, pantalla 12). Un botón que
 * se prende y se apaga (`aria-pressed`): la píldora llena en tinta es la que
 * está puesta. Vive en la barra de su tabla y no en la cabecera de pantalla:
 * lo que filtra una tabla se lee donde está la tabla (patrón 1).
 */
export function FilterPill({
  pressed,
  onClick,
  children,
}: {
  pressed: boolean
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        "h-[30px] shrink-0 rounded-full border px-2.5 text-xs font-semibold transition-colors",
        "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:outline-none",
        pressed
          ? "border-foreground bg-foreground text-background"
          : "border-border bg-card text-foreground hover:bg-accent hover:text-accent-foreground",
      )}
    >
      {children}
    </button>
  )
}

/** El buscador de la barra: 30 px de alto, 200 de ancho, lupa adentro. */
export function DenseTableSearch({
  value,
  onChange,
  placeholder,
}: {
  value: string
  onChange: (value: string) => void
  /** «Buscar insumo». Es también su nombre accesible. */
  placeholder: string
}): React.JSX.Element {
  return (
    <span className="relative inline-flex h-[30px] w-full items-center sm:w-[200px]">
      <Search className="pointer-events-none absolute left-2 size-3.5 text-muted-foreground" aria-hidden="true" />
      <input
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        className="h-full w-full rounded-md border border-input bg-card pr-2 pl-7 text-[0.8125rem] placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      />
    </span>
  )
}

export default DenseTable
