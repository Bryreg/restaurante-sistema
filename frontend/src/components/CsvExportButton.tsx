import { Download } from "lucide-react"

import { Button } from "@/components/ui/button"

export interface CsvExportButtonProps {
  /** URL completa con `format=csv` y el resto de los filtros vigentes ya aplicados. */
  href: string
  label?: string
}

/**
 * "Toda lista exporta" (SPEC-NEGOCIO §9.3). Un enlace disfrazado de botón —
 * el navegador hace la descarga, no `fetch`: así el `Content-Disposition`
 * del backend (`app.core.csv.csv_response`) decide el nombre del archivo.
 * Mismo patrón que ya usaban `OrdersAdminPage`/`AdminShiftsPage` antes de
 * este componente, ahora en un solo lugar para toda pantalla nueva.
 */
export function CsvExportButton({ href, label = "Exportar CSV" }: CsvExportButtonProps): React.JSX.Element {
  return (
    <Button
      render={<a href={href} target="_blank" rel="noreferrer" />}
      variant="outline"
      className="h-11 gap-2"
    >
      <Download className="size-4" aria-hidden="true" />
      {label}
    </Button>
  )
}

export default CsvExportButton
