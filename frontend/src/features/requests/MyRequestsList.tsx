import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { listMyRequests, type StaffRequest } from "@/api/requests";
import { Cargando } from "@/components/Cargando";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatInstant } from "@/lib/businessDate";
import { errorMessage } from "@/lib/errors";
import { formatCantidad } from "@/lib/format";
import { formatCOP } from "@/lib/money";

import { unidadEnPlural } from "@/features/inventory/areaCountLib";

import { KIND_LABEL, REQUESTS_QUERY_KEYS, statusLabel, statusVariant } from "./lib";
import { ReceiveChangeForm } from "./ReceiveChangeForm";

function Denominaciones({ rows }: { rows: StaffRequest["requested_denominations"] }): React.JSX.Element | null {
  if (!rows || rows.length === 0) return null;
  return (
    <p className="text-sm text-muted-foreground">
      {rows.map((d) => `${d.count} × ${formatCOP(d.value)}`).join(" · ")}
    </p>
  );
}

function Detalle({ request }: { request: StaffRequest }): React.JSX.Element {
  if (request.kind === "supply") {
    return (
      <ul className="text-sm">
        {request.lines.map((line) => (
          <li key={line.id}>
            {line.ingredient_name}: {formatCantidad(line.qty_requested_entry, unidadEnPlural(line.entry_unit))}
            {line.qty_approved !== null && line.qty_approved !== line.qty_requested ? (
              <span className="text-muted-foreground">
                {" "}
                · aprobado {formatCantidad(line.qty_approved_entry, unidadEnPlural(line.entry_unit))}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    );
  }
  const aprobado = request.approved_denominations !== null;
  return (
    <div className="space-y-1">
      <p className="text-sm">
        {aprobado ? "Aprobado" : "Pedido"}: {formatCOP(aprobado ? request.approved_total : request.requested_total)}
        {request.reason ? <span className="text-muted-foreground"> · {request.reason}</span> : null}
      </p>
      <Denominaciones rows={aprobado ? request.approved_denominations : request.requested_denominations} />
    </div>
  );
}

/**
 * «Mis solicitudes»: las del turno abierto y las aprobadas que siguen por
 * comprar o por entregar. El estado lo dice el servidor. Una sencilla
 * aprobada ofrece registrarla con el Cambio cuando llega.
 */
export function MyRequestsList({ shiftId }: { shiftId: number }): React.JSX.Element {
  const query = useQuery({ queryKey: REQUESTS_QUERY_KEYS.mine, queryFn: listMyRequests });
  const [recibiendo, setRecibiendo] = useState<number | null>(null);

  if (query.isLoading) return <Cargando texto="Cargando tus solicitudes…" filas={2} />;
  if (query.isError) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {errorMessage(query.error)}
      </p>
    );
  }
  const rows = query.data ?? [];
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">Todavía no hay solicitudes en este turno.</p>;
  }

  return (
    <ul className="space-y-3" aria-label="Mis solicitudes">
      {rows.map((request) => (
        <li key={request.id} className="space-y-2 rounded-lg border p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{KIND_LABEL[request.kind]}</span>
            <Badge variant={statusVariant(request.status)}>{statusLabel(request)}</Badge>
            <span className="text-sm text-muted-foreground">
              {request.requested_by.name} · {formatInstant(request.requested_at)}
            </span>
          </div>
          <Detalle request={request} />
          {request.status === "rejected" && request.resolution_note ? (
            <p className="text-sm text-destructive">Motivo: {request.resolution_note}</p>
          ) : null}
          {request.kind === "change" && request.status === "approved" ? (
            recibiendo === request.id ? (
              <ReceiveChangeForm shiftId={shiftId} request={request} onDone={() => setRecibiendo(null)} />
            ) : (
              <Button type="button" className="h-11" onClick={() => setRecibiendo(request.id)}>
                Llegó la sencilla
              </Button>
            )
          ) : null}
        </li>
      ))}
    </ul>
  );
}
