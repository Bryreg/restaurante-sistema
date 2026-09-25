import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { listApprovedSupplyRequests, markRequestBought, type StaffRequest } from "@/api/requests";
import { Cargando } from "@/components/Cargando";
import { Button } from "@/components/ui/button";
import { formatInstant } from "@/lib/businessDate";
import { errorMessage } from "@/lib/errors";
import { formatCantidad } from "@/lib/format";

import { REQUESTS_QUERY_KEYS } from "./lib";

function Pedido({ storeId, request }: { storeId: number; request: StaffRequest }): React.JSX.Element {
  const queryClient = useQueryClient();
  const bought = useMutation({
    mutationFn: () => markRequestBought(request.id),
    onSuccess: () => {
      toast.success("Marcado como comprado.");
      void queryClient.invalidateQueries({ queryKey: REQUESTS_QUERY_KEYS.adminApprovedSupplies(storeId) });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  // Un renglón aprobado en "0" es «no se compra»: no va a la lista. Es una
  // comparación contra el texto que manda el servidor, no una cuenta.
  const lineas = request.lines.filter((line) => line.qty_approved !== null && line.qty_approved !== "0");

  return (
    <li className="space-y-2 rounded-lg border p-3">
      <p className="text-sm text-muted-foreground">
        Pidió {request.requested_by.name} · aprobado {formatInstant(request.resolved_at)}
        {request.resolution_note ? ` · ${request.resolution_note}` : ""}
      </p>
      <ul className="text-sm">
        {lineas.map((line) => (
          <li key={line.id}>
            {line.ingredient_name}: <strong>{formatCantidad(line.qty_approved, line.base_unit)}</strong>
          </li>
        ))}
      </ul>
      <Button
        type="button"
        variant="outline"
        className="h-10"
        disabled={bought.isPending}
        onClick={() => bought.mutate()}
      >
        Marcar comprado
      </Button>
    </li>
  );
}

/**
 * Insumos aprobados y por comprar: la lista de lo que hay que traer. Conviene
 * montarla en Inventario › Compras, al lado de las recepciones: «comprado»
 * se marca cuando la compra se recibe. Esta pantalla no crea recepciones ni
 * pagos.
 */
export function ApprovedSuppliesPanel({ storeId }: { storeId: number }): React.JSX.Element {
  const query = useQuery({
    queryKey: REQUESTS_QUERY_KEYS.adminApprovedSupplies(storeId),
    queryFn: () => listApprovedSupplyRequests(storeId),
  });

  return (
    <section aria-labelledby="por-comprar" className="space-y-3">
      <h2 id="por-comprar" className="text-lg font-semibold">
        Por comprar (pedidos del salón)
      </h2>
      {query.isLoading ? (
        <Cargando filas={2} />
      ) : query.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(query.error)}
        </p>
      ) : (query.data ?? []).length === 0 ? (
        <p className="text-sm text-muted-foreground">No hay insumos aprobados por comprar.</p>
      ) : (
        <ul className="space-y-3">
          {(query.data ?? []).map((request) => (
            <Pedido key={request.id} storeId={storeId} request={request} />
          ))}
        </ul>
      )}
    </section>
  );
}
