/**
 * Admin → Analítica → Reposición sugerida (T4, `GET /admin/replenishment`):
 * consumo × lead time del proveedor, por insumo. Cantidades como texto
 * decimal (mismo criterio que `qty_base`) — nunca reescaladas acá.
 */
import { useQuery } from "@tanstack/react-query"

import { getReplenishment } from "@/api/analytics"
import { EmptyState } from "@/components/EmptyState"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { errorMessage } from "@/lib/errors"

export function ReplenishmentTab({ storeId }: { storeId: number }): React.JSX.Element {
  const query = useQuery({
    queryKey: ["analytics", "replenishment", storeId],
    queryFn: () => getReplenishment(storeId),
  })

  const rows = query.data?.rows ?? []

  return (
    <div className="space-y-4">
      {query.isLoading ? (
        <p className="text-sm text-muted-foreground">Calculando la reposición sugerida…</p>
      ) : query.isError ? (
        <EmptyState role="alert" title="No se pudo calcular la reposición sugerida" description={errorMessage(query.error)} action={{ label: "Reintentar", onClick: () => void query.refetch() }} />
      ) : !query.data?.available ? (
        <EmptyState title="Reposición sugerida no disponible" description={query.data?.reason ?? "Hace falta consumo e insumos con lead time del proveedor cargado."} />
      ) : rows.length === 0 ? (
        <EmptyState title="No hay reposición sugerida por ahora" description="Hace falta consumo e insumos con lead time del proveedor cargado." />
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Insumo</TableHead>
                <TableHead>Cantidad sugerida</TableHead>
                <TableHead>Mínimo sugerido</TableHead>
                <TableHead>Lead time (días)</TableHead>
                <TableHead>Basado en</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.ingredient_id}>
                  <TableCell>{row.ingredient_name ?? `#${row.ingredient_id}`}</TableCell>
                  <TableCell className="tabular-nums">{row.suggested_qty ?? "—"}</TableCell>
                  <TableCell className="tabular-nums">
                    {row.suggested_min ?? (
                      <span className="text-muted-foreground">Sin datos{row.reason ? ` (${row.reason})` : ""}</span>
                    )}
                  </TableCell>
                  <TableCell className="tabular-nums">{row.lead_time_days ?? "—"}</TableCell>
                  <TableCell className="text-muted-foreground">{row.based_on ?? "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}

export default ReplenishmentTab
