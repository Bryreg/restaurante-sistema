/**
 * Qué pedidos de insumos del salón cubre esta recepción (u6). Lista los
 * aprobados y por comprar de la sede (`GET /admin/requests/supplies`); los
 * que se marcan viajan como `supply_request_ids` y el servidor los cierra
 * («comprado») en la misma transacción que la recepción. Sólo se monta con
 * `pos.requests` encendido.
 */
import { useQuery } from "@tanstack/react-query"

import { listApprovedSupplyRequests, type StaffRequest } from "@/api/requests"
import { Checkbox } from "@/components/ui/checkbox"
import { REQUESTS_QUERY_KEYS } from "@/features/requests"
import { formatInstant } from "@/lib/businessDate"
import { errorMessage } from "@/lib/errors"
import { formatCantidad } from "@/lib/format"
import { unidadEnPlural } from "@/features/inventory/areaCountLib"

function linesSummary(request: StaffRequest): string {
  // Un renglón aprobado en "0" es «no se compra»: comparación contra el
  // texto del servidor, no una cuenta.
  return request.lines
    .filter((line) => line.qty_approved !== null && line.qty_approved !== "0")
    .map((line) => `${line.ingredient_name}: ${formatCantidad(line.qty_approved_entry, unidadEnPlural(line.entry_unit))}`)
    .join(" · ")
}

export function SupplyRequestsPicker({
  storeId,
  selected,
  onChange,
  disabled = false,
}: {
  storeId: number
  selected: number[]
  onChange: (ids: number[]) => void
  disabled?: boolean
}): React.JSX.Element {
  const query = useQuery({
    queryKey: REQUESTS_QUERY_KEYS.adminApprovedSupplies(storeId),
    queryFn: () => listApprovedSupplyRequests(storeId),
  })
  const rows = query.data ?? []

  if (query.isLoading) {
    return <p className="text-sm text-muted-foreground">Cargando los pedidos por comprar…</p>
  }
  if (query.isError) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {errorMessage(query.error)}
      </p>
    )
  }
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">No hay pedidos del salón aprobados y por comprar.</p>
  }

  return (
    <ul className="space-y-2" aria-label="Pedidos por comprar">
      {rows.map((request) => {
        const checked = selected.includes(request.id)
        return (
          <li key={request.id} className="rounded-md border p-2">
            <label className="flex items-start gap-2 text-sm">
              <Checkbox
                className="mt-0.5"
                checked={checked}
                disabled={disabled}
                onCheckedChange={(value) =>
                  onChange(value === true ? [...selected, request.id] : selected.filter((id) => id !== request.id))
                }
              />
              <span className="space-y-0.5">
                <span className="block font-medium">
                  Pedido #{request.id} · {request.requested_by.name}
                </span>
                <span className="block text-muted-foreground">
                  {linesSummary(request) || "—"}
                  {request.resolved_at ? ` · aprobado ${formatInstant(request.resolved_at)}` : ""}
                </span>
              </span>
            </label>
          </li>
        )
      })}
    </ul>
  )
}
