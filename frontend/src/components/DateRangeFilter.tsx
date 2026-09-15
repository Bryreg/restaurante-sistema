import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

export interface DateRangeFilterProps {
  from: string
  to: string
  onChange: (range: { from: string; to: string }) => void
  /** Ids únicos cuando la pantalla tiene más de un filtro de fecha a la vez. */
  idPrefix?: string
  /** Etiquetas por si una pantalla necesita distinguir dos rangos ("Período A"/"Período B"). */
  fromLabel?: string
  toLabel?: string
  disabled?: boolean
}

/**
 * Filtro de rango de fechas compartido por toda pantalla de reporte
 * (SPEC-NEGOCIO §9.3: "Ventas", "informe del contador", listados admin con
 * `from`/`to`). Dos `<input type="date">` nativos — el mismo control que ya
 * usaba `OrdersAdminPage` antes de este componente, ahora en un solo lugar.
 * Nunca deriva ni valida la fecha operativa acá: sólo junta lo que la
 * persona eligió y se lo pasa entero a `onChange`; el backend es quien
 * decide qué es un rango válido.
 */
export function DateRangeFilter({
  from,
  to,
  onChange,
  idPrefix = "date-range",
  fromLabel = "Desde",
  toLabel = "Hasta",
  disabled = false,
}: DateRangeFilterProps): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="space-y-1">
        <Label htmlFor={`${idPrefix}-from`}>{fromLabel}</Label>
        <Input
          id={`${idPrefix}-from`}
          type="date"
          className="h-10"
          value={from}
          max={to || undefined}
          disabled={disabled}
          onChange={(event) => onChange({ from: event.target.value, to })}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${idPrefix}-to`}>{toLabel}</Label>
        <Input
          id={`${idPrefix}-to`}
          type="date"
          className="h-10"
          value={to}
          min={from || undefined}
          disabled={disabled}
          onChange={(event) => onChange({ from, to: event.target.value })}
        />
      </div>
    </div>
  )
}

export default DateRangeFilter
