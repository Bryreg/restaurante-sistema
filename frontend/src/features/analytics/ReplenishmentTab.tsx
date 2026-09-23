/**
 * Admin → Analítica → Reposición sugerida (T4, `GET /admin/replenishment`):
 * consumo × lead time del proveedor, por insumo. Cantidades como texto
 * decimal (mismo criterio que `qty_base`) — nunca reescaladas acá, sólo
 * escritas en es-CO con `formatCantidad` («0,024 unidad», «10.000 g»).
 *
 * El consumo diario se muestra con su MEDIANA al lado del promedio y los
 * días de historial reales que lo sostienen (científico #17): con 14 días
 * de historial ya no se divide por 30.
 */
import { useQuery } from "@tanstack/react-query"

import { getReplenishment, type ReplenishmentRowOut } from "@/api/analytics"
import { DenseTable, DenseTableBar, type DenseColumn } from "@/components/admin"
import { EmptyState } from "@/components/EmptyState"
import { errorMessage } from "@/lib/errors"
import { formatCantidad } from "@/lib/format"

import { UNIT_LABEL } from "@/features/inventory/lib"

/** La unidad base del insumo; si faltara, la cantidad va sin unidad. */
function unidad(r: ReplenishmentRowOut): string {
  return r.base_unit ? (UNIT_LABEL[r.base_unit] ?? r.base_unit) : ""
}

function dias(n: number): string {
  return `${n} ${n === 1 ? "día" : "días"}`
}

const REPLENISHMENT_COLUMNS: readonly DenseColumn<ReplenishmentRowOut>[] = [
  { key: "ingredient", header: "Insumo", kind: "name", cell: (r) => r.ingredient_name ?? `#${r.ingredient_id}` },
  { key: "qty", header: "Cantidad sugerida", kind: "number", cell: (r) => formatCantidad(r.suggested_qty, unidad(r)) },
  { key: "stock", header: "Stock actual", kind: "number", cell: (r) => formatCantidad(r.current_stock, unidad(r)) },
  {
    key: "daily",
    header: "Consumo diario (mediana · promedio)",
    kind: "number",
    cell: (r) =>
      r.median_daily_consumption === null || r.median_daily_consumption === undefined ? (
        formatCantidad(r.avg_daily_consumption, unidad(r))
      ) : (
        <span className="whitespace-nowrap">
          {formatCantidad(r.median_daily_consumption, unidad(r))}
          <span className="text-muted-foreground"> · {formatCantidad(r.avg_daily_consumption, unidad(r))}</span>
        </span>
      ),
  },
  {
    key: "history",
    header: "Historial",
    kind: "number",
    cell: (r) => (r.history_days === undefined ? "—" : dias(r.history_days)),
  },
  {
    // `null` no es 0: se dice por qué no se sabe, y el motivo largo va al
    // `title` para que la fila no crezca (§ 5 y § 8).
    key: "min",
    header: "Mínimo sugerido",
    kind: "number",
    cell: (r) =>
      r.suggested_min === null || r.suggested_min === undefined ? (
        <span className="text-muted-foreground">Sin datos</span>
      ) : (
        formatCantidad(r.suggested_min, unidad(r))
      ),
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

  const rows: readonly ReplenishmentRowOut[] = query.data?.rows ?? []
  // «con 14 días de historial»: si todas las filas comparten los días, se
  // dice una vez arriba; si no, cada fila lo dice en su columna.
  const historiales = new Set(rows.map((r) => r.history_days).filter((d): d is number => d !== undefined))
  const historialComun = historiales.size === 1 ? [...historiales][0] : null
  const lookback = query.data?.lookback_days

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
        <>
          {historialComun !== null && historialComun !== undefined ? (
            <p className="text-sm text-muted-foreground" data-testid="historial-comun">
              Consumo diario calculado con {dias(historialComun)} de historial
              {lookback !== undefined ? ` (de los últimos ${lookback})` : ""}: se muestra la mediana, que no se deja
              mover por un día raro, junto al promedio.
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              Consumo diario sobre los días con historial de cada insumo
              {lookback !== undefined ? ` (de los últimos ${lookback})` : ""}: la columna «Historial» dice cuántos. Se
              muestra la mediana, que no se deja mover por un día raro, junto al promedio.
            </p>
          )}
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
              {
                term: "Mediana · promedio",
                meaning: "la mediana es el consumo de un día típico; el promedio se deja arrastrar por un día de evento. Si están lejos, mirá el historial.",
              },
            ]}
          />
        </>
      )}
    </div>
  )
}

export default ReplenishmentTab
