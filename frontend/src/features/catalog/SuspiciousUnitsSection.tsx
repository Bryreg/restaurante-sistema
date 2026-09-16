import { useQuery } from "@tanstack/react-query"
import { AlertTriangle } from "lucide-react"

import { getSuspiciousUnits, suspiciousUnitsCsvUrl } from "@/api/recipes"
import { CsvExportButton } from "@/components/CsvExportButton"
import { EmptyState } from "@/components/EmptyState"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { errorMessage } from "@/lib/errors"

/**
 * "18 kg donde iban 18 g" (SPEC-NEGOCIO §4.3): líneas de ficha cuya cantidad
 * se aparta mucho del resto de su categoría, o supera un techo absoluto. El
 * `reason` lo arma el servidor (`app.recipes.service.suspicious_recipe_lines`)
 * — acá sólo se muestra tal cual.
 */
export function SuspiciousUnitsSection({ storeId }: { storeId: number }): React.JSX.Element {
  const query = useQuery({
    queryKey: ["recipes", "suspicious-units", storeId],
    queryFn: () => getSuspiciousUnits(storeId),
  })

  const rows = query.data ?? []

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-sm text-muted-foreground">
          Líneas de ficha con una cantidad que se aparta mucho de lo esperado para su categoría de insumo — el error
          típico de cargar «18 kg» cuando iban «18 g».
        </p>
        <CsvExportButton href={suspiciousUnitsCsvUrl(storeId)} />
      </div>

      {query.isLoading ? (
        <p className="text-sm text-muted-foreground">Cargando…</p>
      ) : query.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(query.error)}
        </p>
      ) : rows.length === 0 ? (
        <EmptyState title="No hay líneas sospechosas de unidad" />
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Plato</TableHead>
                <TableHead>Insumo</TableHead>
                <TableHead>Cantidad</TableHead>
                <TableHead>Motivo</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row, index) => (
                <TableRow key={`${row.product_id}-${row.ingredient_id}-${index}`}>
                  <TableCell>{row.product_name ?? `Producto #${row.product_id}`}</TableCell>
                  <TableCell>{row.ingredient_name ?? `Insumo #${row.ingredient_id}`}</TableCell>
                  <TableCell className="tabular-nums">
                    {row.qty} {row.unit}
                  </TableCell>
                  <TableCell>
                    <span className="inline-flex items-center gap-1.5 text-sm text-destructive">
                      <AlertTriangle className="size-3.5 shrink-0" aria-hidden="true" />
                      {row.reason}
                    </span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}
