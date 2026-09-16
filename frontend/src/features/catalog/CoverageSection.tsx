import { useQuery } from "@tanstack/react-query"
import { useState } from "react"

import { getRecipeCoverage, recipeCoverageCsvUrl } from "@/api/recipes"
import { CsvExportButton } from "@/components/CsvExportButton"
import { DateRangeFilter } from "@/components/DateRangeFilter"
import { EmptyState } from "@/components/EmptyState"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { errorMessage } from "@/lib/errors"

/**
 * "Platos que no descuentan" (SPEC-NEGOCIO §4.3): un plato vendido sin
 * ficha ni insumo directo no bloquea la venta, pero tiene que verse acá.
 * `date_from`/`date_to` son los nombres exactos que declara
 * `app.recipes.router.recipe_coverage` — distintos del `from`/`to` que usa
 * el resto de los reportes admin.
 */
export function CoverageSection({ storeId }: { storeId: number }): React.JSX.Element {
  const [range, setRange] = useState({ from: "", to: "" })

  const query = useQuery({
    queryKey: ["recipes", "coverage", storeId, range.from, range.to],
    queryFn: () =>
      getRecipeCoverage(storeId, {
        dateFrom: range.from || undefined,
        dateTo: range.to || undefined,
      }),
  })

  const rows = query.data ?? []

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Platos vendidos en el período que no tienen ficha técnica ni insumo directo: la venta siguió, pero no
        descontaron nada del inventario. Sin filtro de fecha, muestra los últimos 30 días.
      </p>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <DateRangeFilter from={range.from} to={range.to} onChange={setRange} idPrefix="coverage" />
        <CsvExportButton href={recipeCoverageCsvUrl({ storeId, dateFrom: range.from || undefined, dateTo: range.to || undefined })} />
      </div>

      {query.isLoading ? (
        <p className="text-sm text-muted-foreground">Cargando…</p>
      ) : query.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(query.error)}
        </p>
      ) : rows.length === 0 ? (
        <EmptyState title="Todo lo que se vendió en el período descontó algo" />
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Plato</TableHead>
                <TableHead>Ítems vendidos</TableHead>
                <TableHead>Cantidad vendida</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.product_id}>
                  <TableCell>{row.product_name ?? `Producto #${row.product_id}`}</TableCell>
                  <TableCell className="tabular-nums">{row.items_sold}</TableCell>
                  <TableCell className="tabular-nums">{row.qty_sold}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}
