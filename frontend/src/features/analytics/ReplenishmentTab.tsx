/**
 * Admin → Analítica → Reposición sugerida (T4, `GET /admin/replenishment`):
 * consumo × lead time del proveedor, por insumo. Cantidades como texto
 * decimal (mismo criterio que `qty_base`) — nunca reescaladas acá.
 */
import { useQuery } from "@tanstack/react-query"

import { getReplenishment, type ReplenishmentRowOut } from "@/api/analytics"
import { DenseTable, DenseTableBar, type DenseColumn } from "@/components/admin"
import { EmptyState } from "@/components/EmptyState"
import { errorMessage } from "@/lib/errors"

const REPLENISHMENT_COLUMNS: readonly DenseColumn<ReplenishmentRowOut>[] = [
  { key: "ingredient", header: "Insumo", kind: "name", cell: (r) => r.ingredient_name ?? `#${r.ingredient_id}` },
  { key: "qty", header: "Cantidad sugerida", kind: "number", cell: (r) => r.suggested_qty ?? "—" },
  {
    // `null` no es 0: se dice por qué no se sabe, y el motivo largo va al
    // `title` para que la fila no crezca (§ 5 y § 8).
    key: "min",
    header: "Mínimo sugerido",
    kind: "number",
    cell: (r) => r.suggested_min ?? <span className="text-muted-foreground">Sin datos</span>,
    cellTitle: (r) => (r.suggested_min === null || r.suggested_min === undefined ? (r.reason ?? undefined) : undefined),
  },
  { key: "lead", header: "Lead time (días)", kind: "number", cell: (r) => r.lead_time_days ?? "—" },
  { key: "based", header: "Basado en", kind: "secondary", cell: (r) => r.based_on ?? "—" },
]

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
        <EmptyState reason="error" title="No se pudo calcular la reposición sugerida" description={errorMessage(query.error)} action={{ label: "Reintentar", onClick: () => void query.refetch() }} />
      ) : !query.data?.available ? (
        <EmptyState reason="dependency" title="Reposición sugerida no disponible" description={query.data?.reason ?? "Hace falta consumo e insumos con lead time del proveedor cargado."} />
      ) : rows.length === 0 ? (
        <EmptyState
          reason="dependency"
          title="No hay reposición sugerida por ahora"
          description="Hace falta consumo e insumos con lead time del proveedor cargado."
          action={{ label: "Cargar el lead time en Insumos", to: "/admin/inventario?tab=insumos" }}
        />
      ) : (
        <DenseTable
          caption="Insumos a reponer, con la cantidad sugerida y el lead time del proveedor."
          columns={REPLENISHMENT_COLUMNS}
          rows={rows}
          rowKey={(r) => String(r.ingredient_id)}
          maxBodyHeightPx={460}
          bar={<DenseTableBar shown={rows.length} total={rows.length} noun="insumos sugeridos" />}
          legend={[
            {
              term: "Sin datos",
              meaning: "no es 0: es que faltó consumo o lead time para calcular ese mínimo. El motivo está en el dato, al pasar el mouse.",
            },
            {
              term: "Lead time",
              meaning: "los días que el proveedor tarda en traerlo. Sin ese dato cargado, no hay sugerencia posible.",
            },
          ]}
        />
      )}
    </div>
  )
}

export default ReplenishmentTab
