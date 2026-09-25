import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { toast } from "sonner";

import { approveRequest, listAdminRequests, rejectRequest, type StaffRequest } from "@/api/requests";
import { Cargando } from "@/components/Cargando";
import { DenominationsInput, type Denomination } from "@/components/DenominationsInput";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatInstant } from "@/lib/businessDate";
import { errorMessage } from "@/lib/errors";
import { formatCantidad } from "@/lib/format";
import { formatCOP } from "@/lib/money";

import { fullDenominations, KIND_LABEL, REQUESTS_QUERY_KEYS, typedTotal } from "./lib";

function Rechazo({
  onConfirm,
  pending,
}: {
  onConfirm: (reason: string) => void;
  pending: boolean;
}): React.JSX.Element {
  const [abierto, setAbierto] = useState(false);
  const [motivo, setMotivo] = useState("");
  const id = useId();
  if (!abierto) {
    return (
      <Button type="button" variant="outline" className="h-10" onClick={() => setAbierto(true)}>
        Rechazar
      </Button>
    );
  }
  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="space-y-1">
        <Label htmlFor={id}>Motivo del rechazo</Label>
        <Input id={id} className="h-10 w-64" value={motivo} onChange={(event) => setMotivo(event.target.value)} />
      </div>
      <Button
        type="button"
        variant="destructive"
        className="h-10"
        disabled={pending || motivo.trim() === ""}
        onClick={() => onConfirm(motivo.trim())}
      >
        Confirmar rechazo
      </Button>
      <Button type="button" variant="ghost" className="h-10" onClick={() => setAbierto(false)}>
        Cancelar
      </Button>
    </div>
  );
}

function PendingCard({ storeId, request }: { storeId: number; request: StaffRequest }): React.JSX.Element {
  const queryClient = useQueryClient();
  const [qtys, setQtys] = useState<Record<number, string>>(() =>
    Object.fromEntries(request.lines.map((line) => [line.id, line.qty_requested])),
  );
  const [denoms, setDenoms] = useState<Denomination[]>(() => fullDenominations(request.requested_denominations));
  const [error, setError] = useState<string | null>(null);

  function refrescar() {
    void queryClient.invalidateQueries({ queryKey: REQUESTS_QUERY_KEYS.adminPending(storeId) });
    void queryClient.invalidateQueries({ queryKey: REQUESTS_QUERY_KEYS.adminApprovedSupplies(storeId) });
  }

  const approve = useMutation({
    mutationFn: () =>
      request.kind === "supply"
        ? approveRequest(request.id, {
            lines: request.lines
              .filter((line) => (qtys[line.id] ?? "").trim() !== line.qty_requested)
              .map((line) => ({ line_id: line.id, qty: (qtys[line.id] ?? "").trim() })),
          })
        : approveRequest(request.id, {
            denominations: { denominations: denoms.filter((d) => d.count > 0), total: typedTotal(denoms) },
          }),
    onSuccess: () => {
      toast.success(request.kind === "supply" ? "Aprobado: queda por comprar." : "Aprobado: queda por entregar.");
      refrescar();
    },
    onError: (err) => setError(errorMessage(err)),
  });

  const reject = useMutation({
    mutationFn: (reason: string) => rejectRequest(request.id, reason),
    onSuccess: () => {
      toast.success("Solicitud rechazada.");
      refrescar();
    },
    onError: (err) => setError(errorMessage(err)),
  });

  const pending = approve.isPending || reject.isPending;

  return (
    <li className="space-y-3 rounded-lg border p-3">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="font-medium">{KIND_LABEL[request.kind]}</span>
        <span className="text-sm text-muted-foreground">
          {request.requested_by.name} · {formatInstant(request.requested_at)}
        </span>
      </div>
      {request.note ? <p className="text-sm">Nota: {request.note}</p> : null}

      {request.kind === "supply" ? (
        <ul className="space-y-2">
          {request.lines.map((line) => (
            <li key={line.id} className="flex flex-wrap items-center gap-2">
              <span className="min-w-0 flex-1 text-sm">
                {line.ingredient_name}
                <span className="text-muted-foreground">
                  {" "}
                  · pidió {formatCantidad(line.qty_requested, line.base_unit)}
                  {line.suggested_qty !== null ? ` · sugerido ${formatCantidad(line.suggested_qty, line.base_unit)}` : ""}
                </span>
              </span>
              <Label htmlFor={`aprobar-${line.id}`} className="sr-only">
                Cantidad aprobada de {line.ingredient_name}
              </Label>
              <Input
                id={`aprobar-${line.id}`}
                inputMode="decimal"
                className="h-10 w-24"
                value={qtys[line.id] ?? ""}
                onChange={(event) => setQtys((prev) => ({ ...prev, [line.id]: event.target.value }))}
              />
              <span className="w-10 text-sm text-muted-foreground">{line.base_unit}</span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="space-y-2">
          <p className="text-sm">
            Pidió {formatCOP(request.requested_total)} · Motivo: {request.reason}
          </p>
          <DenominationsInput value={denoms} onChange={setDenoms} legend="Sencilla que vas a llevar" />
        </div>
      )}

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap items-end gap-2">
        <Button type="button" className="h-10" disabled={pending} onClick={() => approve.mutate()}>
          Aprobar
        </Button>
        <Rechazo pending={pending} onConfirm={(reason) => reject.mutate(reason)} />
      </div>
    </li>
  );
}

/**
 * Bandeja de solicitudes del salón, para montar en Hoy (`pos.requests`): las
 * pendientes, la más vieja primero, con ajustar / aprobar / rechazar en línea.
 * Aprobar insumos los deja «por comprar» (los ve Compras); aprobar sencilla
 * la deja «por entregar» (el cajero la registra con el Cambio al recibirla).
 */
export function RequestsTray({ storeId }: { storeId: number }): React.JSX.Element {
  const query = useQuery({
    queryKey: REQUESTS_QUERY_KEYS.adminPending(storeId),
    queryFn: () => listAdminRequests(storeId, { status: "pending" }),
  });

  return (
    <section aria-labelledby="bandeja-solicitudes" className="space-y-3">
      <h2 id="bandeja-solicitudes" className="text-lg font-semibold">
        Solicitudes del salón
      </h2>
      {query.isLoading ? (
        <Cargando filas={2} />
      ) : query.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(query.error)}
        </p>
      ) : (query.data ?? []).length === 0 ? (
        <p className="text-sm text-muted-foreground">No hay solicitudes pendientes.</p>
      ) : (
        <ul className="space-y-3">
          {(query.data ?? []).map((request) => (
            <PendingCard key={request.id} storeId={storeId} request={request} />
          ))}
        </ul>
      )}
    </section>
  );
}
