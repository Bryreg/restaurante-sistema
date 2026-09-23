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

import { getVarianceByDish, type VarianceByDishRowOut } from "@/api/analytics"
import { DenseTable, DenseTableBar, type DenseColumn } from "@/components/admin"
import { EmptyState } from "@/components/EmptyState"
import { Diferencia } from "@/components/Diferencia"
import { formatInstant } from "@/lib/businessDate"
import { errorMessage } from "@/lib/errors"
import { formatCOP } from "@/lib/money"

import { formatBasisPoints } from "@/features/inventory/lib"

const VARIANCE_COLUMNS: readonly DenseColumn<VarianceByDishRowOut>[] = [
  { key: "product", header: "Plato", kind: "name", cell: (r) => r.product_name ?? `#${r.product_id}` },
  {
    key: "share",
    header: "Peso del prorrateo",
    kind: "number",
    cell: (r) => formatBasisPoints(r.theoretical_consumption_share_bp ?? null),
  },
  {
    key: "value",
    header: "Valor de la varianza",
    kind: "number",
    cell: (r) => <Diferencia valor={r.variance_value} faltaCuando="positivo" motivoSinDato="insumos sin costo" />,
  },
  { key: "ingredients", header: "Insumos involucrados", kind: "number", cell: (r) => r.ingredients_involved ?? "—" },
]

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
          {query.data.window_from && query.data.window_to
            ? ` Ventana: ${formatInstant(query.data.window_from)} a ${formatInstant(query.data.window_to)}.`
            : ""}
        </p>
      ) : null}

      {query.isLoading ? (
        <p className="text-sm text-muted-foreground">Calculando la varianza por plato…</p>
      ) : query.isError ? (
        <EmptyState reason="error" title="No se pudo calcular la varianza por plato" description={errorMessage(query.error)} action={{ label: "Reintentar", onClick: () => void query.refetch() }} />
      ) : !query.data?.available ? (
        <EmptyState reason="dependency" title="Varianza por plato no disponible" description={query.data?.reason ?? "Hacen falta conteos completos aplicados y consecutivos."} />
      ) : rows.length === 0 ? (
        <EmptyState
          reason="dependency"
          title="No hay platos con varianza para mostrar en esta ventana"
          description="La ventana del último conteo aplicado no dejó ninguna diferencia que prorratear."
        />
      ) : (
        <>
          <DenseTable
            caption="Varianza estimada por plato sobre la ventana del último conteo aplicado."
            columns={VARIANCE_COLUMNS}
            rows={rows}
            rowKey={(r) => String(r.product_id)}
            maxBodyHeightPx={460}
            bar={<DenseTableBar shown={rows.length} total={rows.length} noun="platos con varianza estimada" />}
            legend={[
              {
                term: "Peso del prorrateo",
                meaning: "qué parte del consumo teórico de la ventana explica este plato. No es su culpa: es su porción.",
              },
              {
                term: "Varianza ≠ robo",
                meaning: "es la diferencia entre lo que la ficha dice que debió salir y lo que el conteo encontró. Merma, porción y error de registro entran igual.",
              },
            ]}
          />
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
