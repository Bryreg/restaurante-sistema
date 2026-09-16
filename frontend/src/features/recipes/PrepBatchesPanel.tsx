import { useQuery } from "@tanstack/react-query"

import { listPrepBatches, prepBatchesCsvUrl, type PreparationAdminOut } from "@/api/recipes"
import { CsvExportButton } from "@/components/CsvExportButton"
import { EmptyState } from "@/components/EmptyState"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { formatBusinessDate, formatInstant } from "@/lib/businessDate"
import { errorMessage } from "@/lib/errors"

import { CostValue, VarianceBadge } from "./costDisplay"

/**
 * Lotes de una preparación por lote (spec §9.3 "Preparaciones": stock por
 * lote, costo real, vencimiento, estado, rendimiento esperado vs real con
 * la diferencia resaltada > 15 %). Preparaciones `exploded` no tienen lotes
 * — el botón que abre este diálogo ni se ofrece para ellas.
 */
export function PrepBatchesPanel({
  preparation,
  open,
  onOpenChange,
}: {
  preparation: PreparationAdminOut
  open: boolean
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  const batchesQuery = useQuery({
    queryKey: ["recipes", "prep-batches", preparation.id],
    queryFn: () => listPrepBatches(preparation.id),
    enabled: open,
  })

  const batches = batchesQuery.data ?? []

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Lotes de «{preparation.name}»</DialogTitle>
        </DialogHeader>

        <div className="flex justify-end">
          <CsvExportButton href={prepBatchesCsvUrl(preparation.id)} />
        </div>

        {batchesQuery.isLoading ? (
          <p className="text-sm text-muted-foreground">Cargando lotes…</p>
        ) : batchesQuery.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {errorMessage(batchesQuery.error)}
          </p>
        ) : batches.length === 0 ? (
          <EmptyState
            title="Todavía no se produjo ningún lote"
            description="Producí desde el POS o cocina («Producir») para que aparezca acá."
          />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Producido</TableHead>
                  <TableHead>Esperado</TableHead>
                  <TableHead>Real</TableHead>
                  <TableHead>Diferencia</TableHead>
                  <TableHead>Costo del lote</TableHead>
                  <TableHead>Costo por unidad</TableHead>
                  <TableHead>Vence</TableHead>
                  <TableHead>Produjo</TableHead>
                  <TableHead>Estado</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {batches.map((batch) => (
                  <TableRow key={batch.id}>
                    <TableCell>{formatInstant(batch.produced_at)}</TableCell>
                    <TableCell className="tabular-nums">
                      {batch.qty_expected} {batch.unit}
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {batch.qty_real} {batch.unit}
                    </TableCell>
                    <TableCell>
                      <VarianceBadge pct={batch.variance_pct} alert={batch.variance_alert} />
                    </TableCell>
                    <TableCell>
                      <CostValue cost={batch.total_cost} costSource={batch.cost_source} />
                    </TableCell>
                    <TableCell>
                      <CostValue cost={batch.unit_cost} costSource={batch.cost_source} />
                    </TableCell>
                    <TableCell>{batch.expiry_date ? formatBusinessDate(batch.expiry_date) : "No vence"}</TableCell>
                    <TableCell>{batch.produced_by_employee_name}</TableCell>
                    <TableCell>
                      {batch.closed_at ? (
                        <span className="text-xs text-muted-foreground">
                          Cerrado {formatInstant(batch.closed_at)}
                          {batch.closed_reason ? ` — ${batch.closed_reason}` : ""}
                        </span>
                      ) : (
                        "Abierto"
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
