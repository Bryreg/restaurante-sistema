import { EmptyState } from "@/components/EmptyState"
import { Button } from "@/components/ui/button"

/**
 * **Los cuatro motivos** (`docs/PATRONES-ADMIN.md` § 13). Todos son el mismo
 * `EmptyState` —el que ya tiene noventa usos— con el motivo puesto. Lo que
 * agregan estos envoltorios es lo único que un texto genérico no puede dar:
 * **obligar por tipos a nombrar al culpable**. Un vacío por filtro que no
 * dice qué filtro, o uno por función apagada que no dice qué función, no
 * compila.
 */

export interface FilterEmptyStateProps {
  /** Qué no hay: «Sin insumos para estos filtros». */
  title: string
  /**
   * **Los filtros puestos, en palabras**: «Sólo críticos», «Bajo mínimo». Al
   * menos uno. El dueño llegó acá desde un enlace de Hoy y no sabe qué se
   * aplicó: si el vacío no los nombra, no tiene forma de enterarse.
   */
  filters: readonly [string, ...string[]]
  /** Quitar **ese** filtro. Nunca «limpiar todo». */
  onRemove: (filter: string) => void
  /** Cuántas filas quedarían sin filtros: «y ver los 47». */
  totalWithoutFilters?: number
  description?: React.ReactNode
}

/** Hasta tres salidas: más que eso deja de ser una salida y vuelve a ser una lista. */
const MAX_EXITS = 3

function exitLabel(filter: string, total: number | undefined): string {
  return total === undefined ? `Quitar «${filter}»` : `Quitar «${filter}» y ver los ${total}`
}

/**
 * **Vacío por filtro.** El motivo decide la acción: nombra cuál sacar, no
 * «limpiar todo».
 */
export function FilterEmptyState({
  title,
  filters,
  onRemove,
  totalWithoutFilters,
  description,
}: FilterEmptyStateProps): React.JSX.Element {
  const listed = filters.map((filter) => `«${filter}»`).join(" · ")
  const body =
    description ??
    (filters.length === 1
      ? `El filtro puesto es ${listed}. Quitalo para ver el resto.`
      : `Los filtros puestos son ${listed}. Quitá el que sobre para ver el resto.`)

  if (filters.length === 1) {
    return (
      <EmptyState
        reason="filter"
        title={title}
        description={body}
        action={{
          label: exitLabel(filters[0], totalWithoutFilters),
          onClick: () => onRemove(filters[0]),
        }}
      />
    )
  }

  return (
    <EmptyState reason="filter" title={title} description={body}>
      {filters.slice(0, MAX_EXITS).map((filter) => (
        <Button key={filter} type="button" variant="outline" onClick={() => onRemove(filter)}>
          {exitLabel(filter, totalWithoutFilters)}
        </Button>
      ))}
    </EmptyState>
  )
}

export interface FeatureOffEmptyStateProps {
  /** El nombre de la función, en palabras: «Varianza». */
  feature: string
  /** La clave del flag: `inventory.variance`. */
  flag: string
  /** Qué hace la función: por qué valdría la pena encenderla. */
  description: React.ReactNode
  /** A dónde se enciende. */
  to?: string
}

/**
 * **Vacío por función apagada.** Nombra la función y lleva a encenderla.
 *
 * Es el único de los cuatro que entiende que **la URL sobrevive al flag**: la
 * entrada de navegación desaparece con la función, pero el marcador del dueño
 * y los avisos de Hoy siguen apuntando acá. Por eso la pantalla no puede
 * limitarse a no existir.
 */
export function FeatureOffEmptyState({
  feature,
  flag,
  description,
  to = "/admin/features",
}: FeatureOffEmptyStateProps): React.JSX.Element {
  return (
    <EmptyState
      reason="feature-off"
      title={`«${feature}» no está encendida`}
      description={
        <>
          {description} Necesita{" "}
          <code className="rounded border bg-muted px-1 py-px font-mono text-xs">{flag}</code>.
        </>
      }
      action={{ label: `Encenderla en Funciones`, to }}
    />
  )
}

export interface DependencyEmptyStateProps {
  /** Qué no hay: «Sin insumos activos que marcar». */
  title: string
  /** Por qué: «Acá se eligen los insumos que entran al conteo rápido. Primero tienen que existir.» */
  description: React.ReactNode
  /** La pantalla que **crea** lo que falta. */
  create: { label: string; to: string }
}

/** **Vacío por dependencia.** Lleva a la pantalla que crea lo que falta. */
export function DependencyEmptyState({
  title,
  description,
  create,
}: DependencyEmptyStateProps): React.JSX.Element {
  return (
    <EmptyState
      reason="dependency"
      title={title}
      description={description}
      action={{ label: create.label, to: create.to }}
    />
  )
}

export interface AllClearEmptyStateProps {
  title?: string
  /** Qué se revisó para poder decirlo: «Ningún insumo en negativo, ninguna comanda atascada…». */
  description: React.ReactNode
}

/**
 * **Vacío bueno.** «Todo al día» es una **noticia**, no una ausencia — y por
 * eso el verde de acá es estado y no hay ningún botón verde en ninguna parte
 * (`docs/DISENO.md` § La regla del color).
 */
export function AllClearEmptyState({
  title = "Todo al día",
  description,
}: AllClearEmptyStateProps): React.JSX.Element {
  return <EmptyState reason="all-clear" title={title} description={description} />
}
