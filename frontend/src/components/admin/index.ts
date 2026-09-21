/**
 * **La capa compartida de los 13 patrones del admin**
 * (`docs/PATRONES-ADMIN.md`). Ola 1 del rediseño: acá no hay ninguna
 * pantalla, sólo lo que las 24 van a componer.
 *
 * Qué resuelve cada patrón, y con qué:
 *
 * |  # | Patrón                  | Acá                                        |
 * |---:|-------------------------|--------------------------------------------|
 * |  1 | Armazón y alcance       | `RailItem` (la fila del rail, que usan las entradas **y** el pie) + `ScopeMarks`; el reparto es del layout |
 * |  2 | Cabecera de pantalla    | `PageHeader`                                |
 * |  3 | Rótulo de grupo         | `GroupLabel`                                |
 * |  4 | Banda de cifra          | `HeadlineFigure`                            |
 * |  5 | Tarjeta de indicador    | `StatTile` (extendido, `@/components/StatTile`) |
 * |  6 | Enlace con filtro       | `FilterLink` + `OriginBar` — van en par     |
 * |  7 | Aviso accionable        | `NoticeRail`                                |
 * |  8 | Tabla densa             | `DenseTable` + `DenseTableBar` + `TimeAgo`  |
 * |  9 | Sección de formulario   | `FormSection` + `FormField`                 |
 * | 10 | Marca de alcance        | `ScopeMarks` + `ScopeDestinations`          |
 * | 11 | Las dos zonas           | `ConsequenceZone`                           |
 * | 12 | Barra de guardado       | `SaveBar`                                   |
 * | 13 | Estado vacío            | `EmptyState` (extendido) + los cuatro motivos |
 */
export { ConsequenceZone, type ConsequenceAction, type ConsequenceLevel, type ConsequenceZoneProps } from "./ConsequenceZone"
export {
  DENSE_ROW_HEIGHT_PX,
  DenseTable,
  DenseTableBar,
  type DenseCellKind,
  type DenseColumn,
  type DenseTableBarProps,
  type DenseTableProps,
  type LegendEntry,
  type RowStatus,
} from "./DenseTable"
export {
  AllClearEmptyState,
  DependencyEmptyState,
  FeatureOffEmptyState,
  FilterEmptyState,
  type AllClearEmptyStateProps,
  type DependencyEmptyStateProps,
  type FeatureOffEmptyStateProps,
  type FilterEmptyStateProps,
} from "./EmptyStates"
export { FilterLink, type FilterLinkProps } from "./FilterLink"
export { FormField, FormSection, type FormFieldProps, type FormSectionProps } from "./FormSection"
export { GroupLabel, type GroupLabelProps } from "./GroupLabel"
export { HeadlineFigure, type HeadlineFigureProps, type LedgerRow } from "./HeadlineFigure"
export { NoticeRail, type Notice, type NoticeRailProps, type NoticeSeverity } from "./NoticeRail"
export { OriginBar, type OriginBarProps } from "./OriginBar"
export { PageHeader, type PageContextItem, type PageHeaderProps } from "./PageHeader"
export { RailItemContent, railItemClass, type RailItemContentProps } from "./RailItem"
export {
  ScopeDestinations,
  ScopeMarks,
  type ScopeAffects,
  type ScopeDestination,
  type ScopeDestinationsProps,
  type ScopeMarksProps,
} from "./ScopeMarks"
export { SaveBar, type PendingChange, type SaveBarProps } from "./SaveBar"
export { TimeAgo, formatTimeAgo, type TimeAgoProps } from "./TimeAgo"
