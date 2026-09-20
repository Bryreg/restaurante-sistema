/**
 * Admin → Analítica → Varianza por plato (T4, `GET /admin/variance/by-dish`):
 * §5.4 la define explícitamente como "sólo estimación prorrateada" — esta
 * pantalla lo dice arriba de la tabla, con `method` tal cual llega, nunca
 * asumido como "prorated" por default si el backend mandara otra cosa.
 *
 * La ventana real de esta ruta es la del último conteo aplicado (`count_id`,
 * verificado contra `app/analytics/schemas.py::VarianceByDishOut`), no un
 * rango `from`/`to` de fecha de negocio — por eso esta pantalla no ofrece
 * `DateRangeFilter` (sería un filtro que no hace nada, el error contrario al
 * de un filtro que siempre `422`, ver `api/inventory.ts` sobre
 * `MovementCause`).
 */
import { useQuery } from "@tanstack/react-query"

import { getVarianceByDish } from "@/api/analytics"
import { EmptyState } from "@/components/EmptyState"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { errorMessage } from "@/lib/errors"
import { formatCOP } from "@/lib/money"

import { formatBasisPoints } from "@/features/inventory/lib"

export function VarianceByDishTab({ storeId }: { storeId: number }): React.JSX.Element {
  const query = useQuery({
    queryKey: ["analytics", "variance-by-dish", storeId],
    queryFn: () => getVarianceByDish({ storeId }),
  })

  const rows = query.data?.rows ?? []

  return (
    <div className="space-y-4">
      {query.data ? (
        <p className="text-xs text-muted-foreground">
          Método: <strong>{query.data.method}</strong> — es una ESTIMACIÓN prorrateada sobre la ventana del último
          conteo aplicado, no una medición directa por plato (SPEC-NEGOCIO §5.4).
          {query.data.window_from && query.data.window_to ? ` Ventana: ${query.data.window_from} a ${query.data.window_to}.` : ""}
        </p>
      ) : null}

      {query.isLoading ? (
        <p className="text-sm text-muted-foreground">Calculando la varianza por plato…</p>
      ) : query.isError ? (
        <EmptyState role="alert" title="No se pudo calcular la varianza por plato" description={errorMessage(query.error)} action={{ label: "Reintentar", onClick: () => void query.refetch() }} />
      ) : !query.data?.available ? (
        <EmptyState title="Varianza por plato no disponible" description={query.data?.reason ?? "Hacen falta conteos completos aplicados y consecutivos."} />
      ) : rows.length === 0 ? (
        <EmptyState title="No hay platos con varianza para mostrar en esta ventana" />
      ) : (
        <>
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Plato</TableHead>
                  <TableHead>Peso del prorrateo</TableHead>
                  <TableHead>Valor de la varianza</TableHead>
                  <TableHead>Insumos involucrados</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.product_id}>
                    <TableCell>{row.product_name ?? `#${row.product_id}`}</TableCell>
                    <TableCell className="tabular-nums">{formatBasisPoints(row.theoretical_consumption_share_bp ?? null)}</TableCell>
                    <TableCell className="tabular-nums">{formatCOP(row.variance_value ?? null)}</TableCell>
                    <TableCell className="tabular-nums">{row.ingredients_involved ?? "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          {query.data.unattributed_variance_value !== null && query.data.unattributed_variance_value !== undefined && query.data.unattributed_variance_value !== 0 ? (
            <p className="text-xs text-muted-foreground">
              {formatCOP(query.data.unattributed_variance_value)} de varianza no se pudo atribuir a ningún plato en
              esta ventana (consumo sin movimiento de venta rastreable a un ítem).
            </p>
          ) : null}
        </>
      )}
    </div>
  )
}

export default VarianceByDishTab
