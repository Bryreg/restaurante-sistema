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
import {
  AllClearEmptyState,
  DenseTable,
  DenseTableBar,
  FilterEmptyState,
  NoticeRail,
  PageHeader,
  TimeAgo,
  type DenseColumn,
  type Notice,
} from "@/components/admin";
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

  /**
   * El mismo turno abierto que consulta el diálogo, con la misma clave de
   * caché. Se pregunta acá arriba porque **es lo que decide si el riel tiene
   * algo urgente que decir**: con devoluciones esperando y ningún turno
   * abierto, la salida que la gente usa no está disponible, y eso se sabe
   * antes de abrir el diálogo o no se sabe.
   */
  const openShiftQuery = useQuery({
    queryKey: ["fiscal-pending-refund-open-shift", activeStoreId],
    queryFn: () => listAdminShifts({ storeId: activeStoreId as number }),
    enabled: activeStoreId !== null,
  });
  const openShift = (openShiftQuery.data ?? []).find((s) => s.status === "open");

  if (storeLoading) {
    return <p className="text-sm text-muted-foreground">Cargando sedes…</p>;
  }
  if (activeStoreId === null) {
    return <p className="text-sm text-muted-foreground">Todavía no hay sedes creadas.</p>;
  }

  const rows = query.data ?? [];
  const pendientes = rows.filter((row) => row.status === "pending");

  /**
   * El riel dice **lo que hay que atender de la pantalla**, no una copia de
   * las filas: la tabla ya las muestra. Lo único urgente acá es quedarse sin
   * la salida que la gente usa (patrón 7).
   */
  const notices: Notice[] = [];
  if (pendientes.length > 0 && !openShift && !openShiftQuery.isLoading) {
    notices.push({
      id: "sin-turno",
      severity: "critical",
      title: `${pendientes.length} ${pendientes.length === 1 ? "devolución espera" : "devoluciones esperan"} y no hay turno abierto`,
      consequence:
        "«Desde el turno abierto» es la salida que deja el egreso registrado en la caja. Sin turno abierto sólo queda «De la mano del dueño», que salda la deuda con el cliente pero no toca la caja: la plata sale del bolsillo de alguien y el cajón nunca se entera.",
    });
  } else if (pendientes.length > 0) {
    notices.push({
      id: "pendientes",
      severity: "warning",
      title: `${pendientes.length} ${pendientes.length === 1 ? "devolución pendiente" : "devoluciones pendientes"} de pagar`,
      consequence: "Cada una es plata que el restaurante le debe a un cliente desde que se emitió la nota.",
    });
  }

  const columns: readonly DenseColumn<PendingRefundOut>[] = [
    { key: "customer", header: "Cliente", kind: "name", cell: (row) => row.customer_name ?? "Consumidor final" },
    { key: "document", header: "Documento", kind: "id", cell: (row) => `#${row.document_id}` },
    { key: "amount", header: "Monto", kind: "number", cell: (row) => formatCOP(row.amount) },
    { key: "method", header: "Medio", kind: "secondary", cell: (row) => row.method ?? "—" },
    {
      key: "authorized",
      header: "Autorizó",
      kind: "secondary",
      cell: (row) => row.authorized_by_employee_name ?? "—",
    },
    {
      key: "requested",
      header: "Solicitada",
      kind: "secondary",
      widthPx: 100,
      cell: (row) => (row.requested_at ? <TimeAgo iso={row.requested_at} /> : "—"),
      cellTitle: (row) => (row.requested_at ? formatInstant(row.requested_at) : undefined),
    },
    {
      key: "status",
      header: "Estado",
      cell: (row) => (
        <Badge variant={row.status === "settled" ? "default" : "outline"}>
          {row.status ? STATUS_LABEL[row.status] : "—"}
        </Badge>
      ),
    },
    {
      key: "actions",
      header: "",
      kind: "actions",
      cell: (row) =>
        row.status === "pending" ? (
          <Button type="button" variant="outline" size="sm" onClick={() => setSettling(row)}>
            Saldar
          </Button>
        ) : (
          <span className="text-xs text-muted-foreground">
            {row.settled_from === "shift" ? `Turno #${row.settled_shift_id}` : "De la mano del dueño"}
          </span>
        ),
    },
  ];

  const filtroPuesto = status ? STATUS_LABEL[status] : null;

  return (
    <div className="space-y-3">
      <PageHeader
        name="Devoluciones pendientes"
        question="¿A qué clientes les debe plata el restaurante por una nota que se emitió sin turno abierto, y con qué se les paga?"
        context={[
          { label: "Sin flag: es ley", title: "Toda corrección va por nota; la devolución que quedó debiendo no se puede esconder." },
          { label: "Pendientes", value: `${pendientes.length}` },
          {
            label: "Turno abierto",
            value: openShiftQuery.isLoading ? "…" : openShift ? `#${openShift.id}` : "ninguno",
            title: "Saldar desde el turno crea el egreso en ESE turno, no en el que originó la nota.",
          },
        ]}
        actions={<LocalCsvExportButton href={pendingRefundsCsvUrl({ storeId: activeStoreId, status })} />}
      />

      <div className="grid items-start gap-3 xl:grid-cols-[minmax(0,1fr)_320px]">
        {query.isLoading ? (
          <p className="text-sm text-muted-foreground">Cargando devoluciones…</p>
        ) : query.isError ? (
          <EmptyState
            role="alert"
            reason="error"
            title="No se pudieron cargar las devoluciones"
            description={errorMessage(query.error)}
            action={{ label: "Reintentar", onClick: () => void query.refetch() }}
          />
        ) : (
          <DenseTable
            caption="Devoluciones pendientes de saldar en esta sede"
            columns={columns}
            rows={rows}
            rowKey={(row) => String(row.id)}
            rowStatus={(row) => (row.status === "pending" ? "warning" : "ok")}
            rowInactive={(row) => row.status === "settled"}
            bar={
              <DenseTableBar
                shown={rows.length}
                total={rows.length}
                noun={filtroPuesto ? `devoluciones · filtro «${filtroPuesto}»` : "devoluciones"}
              >
                <Select
                  value={status ?? "all"}
                  onValueChange={(v) => setStatus(v === "all" ? undefined : (v as PendingRefundStatus))}
                >
                  <SelectTrigger className="h-9 w-44" aria-label="Estado">
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
              </DenseTableBar>
            }
            legend={[
              {
                term: "Desde el turno abierto",
                meaning: "crea el egreso en ESE turno, no en el que originó la nota: el cajón de hoy es el que paga.",
              },
              {
                term: "De la mano del dueño",
                meaning: "salda la deuda con el cliente y no toca la caja. Queda registrado, pero ningún turno lo cuenta.",
              },
              {
                term: "Saldada no es anulada",
                meaning: "la nota que la originó sigue existiendo; acá sólo se registra que la plata volvió.",
              },
            ]}
            empty={
              filtroPuesto ? (
                <FilterEmptyState
                  title="Ninguna devolución pendiente con este filtro"
                  filters={[filtroPuesto]}
                  onRemove={() => setStatus(undefined)}
                />
              ) : (
                <EmptyState title="Ninguna devolución pendiente con este filtro" />
              )
            }
          />
        )}

        <NoticeRail
          notices={notices}
          empty={
            <AllClearEmptyState
              title="Nadie está esperando plata"
              description="Ninguna nota quedó con una devolución sin saldar en esta sede."
            />
          }
          footNote="Nacen de una nota con devolución en efectivo emitida sin turno abierto."
        />
      </div>

      <SettleDialog storeId={activeStoreId} refund={settling} onOpenChange={(open) => !open && setSettling(null)} />
    </div>
  );
}

export default PendingRefundsPage;
