import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { useStoreSelection } from "@/app/storeContext";
import { newIdempotencyKey } from "@/api/client";
import {
  listPendingRefunds,
  pendingRefundsCsvUrl,
  settlePendingRefund,
  type PendingRefundOut,
  type PendingRefundStatus,
  type SettleFrom,
} from "@/api/fiscal";
import { listAdminShifts } from "@/api/shifts";
import { EmptyState } from "@/components/EmptyState";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatInstant } from "@/lib/businessDate";
import { errorMessage } from "@/lib/errors";
import { formatCOP } from "@/lib/money";

import { LocalCsvExportButton } from "./components";

const STATUS_OPTIONS: PendingRefundStatus[] = ["pending", "settled"];
const STATUS_LABEL: Record<PendingRefundStatus, string> = { pending: "Pendiente", settled: "Saldada" };

function SettleDialog({
  storeId,
  refund,
  onOpenChange,
}: {
  storeId: number;
  refund: PendingRefundOut | null;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [from, setFrom] = useState<SettleFrom>("shift");

  const openShiftQuery = useQuery({
    queryKey: ["fiscal-pending-refund-open-shift", storeId],
    queryFn: () => listAdminShifts({ storeId }),
    enabled: refund !== null,
  });
  const openShift = (openShiftQuery.data ?? []).find((s) => s.status === "open");

  const mutation = useMutation({
    mutationFn: () => {
      if (refund === null) throw new Error("Sin devolución seleccionada.");
      if (from === "shift" && !openShift) throw new Error("No hay un turno abierto en esta sede.");
      return settlePendingRefund(
        refund.id,
        { from, shift_id: from === "shift" ? openShift?.id : undefined },
        newIdempotencyKey(),
      );
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["fiscal-pending-refunds", storeId] });
      onOpenChange(false);
    },
  });

  return (
    <Dialog open={refund !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Saldar devolución pendiente</DialogTitle>
        </DialogHeader>
        {refund ? (
          <div className="space-y-4 text-sm">
            <p>
              {refund.customer_name ?? "Consumidor final"} · {formatCOP(refund.amount)}
            </p>
            <div className="space-y-1">
              <p className="text-sm font-medium">Saldar</p>
              <Select value={from} onValueChange={(v) => setFrom(v as SettleFrom)}>
                <SelectTrigger className="h-11 w-full" aria-label="Saldar desde">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="shift">Desde el turno abierto (crea un egreso ahí)</SelectItem>
                  <SelectItem value="owner">De la mano del dueño (no toca la caja)</SelectItem>
                </SelectContent>
              </Select>
              {from === "shift" && !openShiftQuery.isLoading && !openShift ? (
                <p role="alert" className="text-xs text-destructive">
                  No hay ningún turno abierto en esta sede ahora mismo.
                </p>
              ) : null}
            </div>
            {mutation.isError ? (
              <p role="alert" className="text-sm text-destructive">
                {errorMessage(mutation.error)}
              </p>
            ) : null}
            <Button
              type="button"
              className="h-11 w-full"
              disabled={mutation.isPending || (from === "shift" && !openShift)}
              onClick={() => mutation.mutate()}
            >
              {mutation.isPending ? "Saldando…" : "Confirmar"}
            </Button>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Admin → Devoluciones pendientes (SPEC-NEGOCIO §6.3; `spec.md` "API
 * contract → Payments & fiscal document"): `GET /admin/pending-refunds`,
 * `POST /admin/pending-refunds/{id}/settle`. Saldar desde un turno crea el
 * egreso en ESE turno y no toca el original.
 */
export function PendingRefundsPage(): React.JSX.Element {
  const { activeStoreId, loading: storeLoading } = useStoreSelection();
  const [status, setStatus] = useState<PendingRefundStatus | undefined>("pending");
  const [settling, setSettling] = useState<PendingRefundOut | null>(null);

  const query = useQuery({
    queryKey: ["fiscal-pending-refunds", activeStoreId, status],
    queryFn: () => listPendingRefunds({ storeId: activeStoreId as number, status }),
    enabled: activeStoreId !== null,
  });

  if (storeLoading) {
    return <p className="text-sm text-muted-foreground">Cargando sedes…</p>;
  }
  if (activeStoreId === null) {
    return <p className="text-sm text-muted-foreground">Todavía no hay sedes creadas.</p>;
  }

  const rows = query.data ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">Devoluciones pendientes</h1>
          <p className="text-sm text-muted-foreground">
            Nacen de una nota con devolución en efectivo sin turno abierto al momento de emitirla.
          </p>
        </div>
        <LocalCsvExportButton href={pendingRefundsCsvUrl({ storeId: activeStoreId, status })} />
      </div>

      <Select value={status ?? "all"} onValueChange={(v) => setStatus(v === "all" ? undefined : (v as PendingRefundStatus))}>
        <SelectTrigger className="h-10 w-48" aria-label="Estado">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">Todas</SelectItem>
          {STATUS_OPTIONS.map((value) => (
            <SelectItem key={value} value={value}>
              {STATUS_LABEL[value]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {query.isLoading ? (
        <p className="text-sm text-muted-foreground">Cargando devoluciones…</p>
      ) : query.isError ? (
        <EmptyState role="alert" title="No se pudieron cargar las devoluciones" description={errorMessage(query.error)} />
      ) : rows.length === 0 ? (
        <EmptyState title="Ninguna devolución pendiente con este filtro" />
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Cliente</TableHead>
                <TableHead>Documento</TableHead>
                <TableHead>Monto</TableHead>
                <TableHead>Medio</TableHead>
                <TableHead>Autorizó</TableHead>
                <TableHead>Solicitada</TableHead>
                <TableHead>Estado</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>{row.customer_name ?? "Consumidor final"}</TableCell>
                  <TableCell>#{row.document_id}</TableCell>
                  <TableCell className="tabular-nums">{formatCOP(row.amount)}</TableCell>
                  <TableCell>{row.method ?? "—"}</TableCell>
                  <TableCell>{row.authorized_by_employee_name ?? "—"}</TableCell>
                  <TableCell>{row.requested_at ? formatInstant(row.requested_at) : "—"}</TableCell>
                  <TableCell>
                    <Badge variant={row.status === "settled" ? "default" : "outline"}>
                      {row.status ? STATUS_LABEL[row.status] : "—"}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    {row.status === "pending" ? (
                      <Button type="button" variant="outline" className="h-9" onClick={() => setSettling(row)}>
                        Saldar
                      </Button>
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        {row.settled_from === "shift" ? `Turno #${row.settled_shift_id}` : "De la mano del dueño"}
                      </span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <SettleDialog storeId={activeStoreId} refund={settling} onOpenChange={(open) => !open && setSettling(null)} />
    </div>
  );
}

export default PendingRefundsPage;
