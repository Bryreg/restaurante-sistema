import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

import { newIdempotencyKey } from "@/api/client";
import {
  createDeliverySettlement,
  voidDeliverySettlement,
  type CourierPending,
  type DeliverySettlement,
} from "@/api/shifts";
import { EmptyState } from "@/components/EmptyState";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { errorMessage } from "@/lib/errors";
import { formatCOP } from "@/lib/money";

import { CURRENT_SHIFT_QUERY_KEY, DELIVERY_PENDING_QUERY_KEY, shiftSummaryQueryKey, usePendingDeliveryCash } from "./hooks";

/**
 * Liquidación del efectivo de domicilios (`pos.delivery`, §3.3): el
 * domiciliario entrega lo cobrado y ese efectivo entra recién ACÁ al
 * cajón del turno abierto. Hasta entonces es un renglón APARTE
 * (`ShiftSummaryPanel`), nunca parte del esperado.
 *
 * Esta pantalla PINTA los renglones tal como llegan de `GET
 * /delivery-settlements/pending` — no suma, no resta, no deriva ningún
 * total: `amount`, `tip_amount` y `total` de cada domiciliario y del
 * agregado ya vienen calculados por el servidor.
 *
 * Sin PIN: `POST /delivery-settlements` y su `/void` van con
 * `current_operator` (persona identificada en el dispositivo), no piden
 * PIN de administrador — a diferencia de un retiro o una reversa de caja,
 * que si lo piden (`PickupsPanel`).
 *
 * **Iteración 2 (ajuste del Maestro sobre H-1)**: `amount` (efectivo) y
 * `tip_amount` (propina) NO pesan igual sobre el esperado del turno. El
 * efectivo mueve el esperado al liquidar; la propina en efectivo entra al
 * cajón igual, pero no mueve el esperado — se salda al cerrar turno como
 * cualquier otra propina en efectivo (`tips_cash_out`). Los NÚMEROS y los
 * CAMPOS que se pintan son los mismos de siempre (`amount`, `tip_amount`,
 * `total` de `GET /delivery-settlements/pending`); lo único que cambió es
 * el rótulo, para que el cajero no lea los tres valores como si pesaran
 * igual sobre el cajón.
 *
 * **Iteración 3 (ajuste del Maestro sobre H-8)**: la primera mitad del
 * rótulo de propina («entra al cajón pero no mueve el esperado») sigue
 * siendo cierta y se queda. Se completa la segunda mitad para decir qué pasa
 * DESPUÉS de liquidar: esa propina queda físicamente en el cajón y, al
 * cerrar el turno, SALE de ahí como propina (`GET /shifts/{id}/tips` ahora
 * publica `cash_out = by_method.cash + delivery_tips_settled`,
 * `DeliverySettlementPanel` no lee ese endpoint) — nunca es plata a
 * consignar. Otra vez: ningún NÚMERO ni CAMPO pintado cambia (`amount`,
 * `tip_amount`, `total` siguen siendo los mismos de `GET
 * /delivery-settlements/pending`), sólo el texto de los rótulos.
 *
 * **Gap declarado**: no hay una ruta de dispositivo/operador para LISTAR
 * liquidaciones ya hechas (sólo `GET /admin/delivery-settlements`,
 * `current_admin` — fuera de esta sesión). Por eso "Deshacer" sólo está
 * disponible sobre las liquidaciones registradas EN ESTA PANTALLA durante
 * esta sesión del navegador (estado local, se pierde al recargar); no
 * existe un histórico del turno consultable desde el POS. Declarado en el
 * entregable, no una omisión silenciosa.
 */
export function DeliverySettlementPanel({ shiftId }: { shiftId: number }): React.JSX.Element {
  const queryClient = useQueryClient();
  const pending = usePendingDeliveryCash(true);
  const [justSettled, setJustSettled] = useState<DeliverySettlement[]>([]);

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: DELIVERY_PENDING_QUERY_KEY });
    void queryClient.invalidateQueries({ queryKey: CURRENT_SHIFT_QUERY_KEY });
    void queryClient.invalidateQueries({ queryKey: shiftSummaryQueryKey(shiftId) });
  }

  const settleMutation = useMutation({
    mutationFn: ({ courierId, note }: { courierId: number; note: string }) =>
      createDeliverySettlement(
        { courier_employee_id: courierId, note: note.trim() === "" ? undefined : note.trim() },
        newIdempotencyKey(),
      ),
    onSuccess: (result) => {
      toast.success(`Liquidación registrada: ${formatCOP(result.total)}.`);
      setJustSettled((prev) => [result, ...prev]);
      invalidate();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const voidMutation = useMutation({
    mutationFn: ({ settlementId, reason }: { settlementId: number; reason: string }) =>
      voidDeliverySettlement(settlementId, { reason }, newIdempotencyKey()),
    onSuccess: (result) => {
      toast.success("Liquidación deshecha.");
      setJustSettled((prev) => prev.map((s) => (s.id === result.id ? result : s)));
      invalidate();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  if (pending.isLoading) {
    return <p className="text-sm text-muted-foreground">Consultando el efectivo de domicilios pendiente…</p>;
  }

  if (pending.isError) {
    return (
      <EmptyState
        role="alert"
        title="No se pudo consultar el efectivo de domicilios pendiente"
        description={errorMessage(pending.error)}
        action={{ label: "Reintentar", onClick: () => void pending.refetch() }}
      />
    );
  }

  const couriers = pending.data?.couriers ?? [];

  return (
    <div className="space-y-6">
      <div className="grid gap-3 rounded-md border p-4 sm:grid-cols-3">
        <div>
          <p className="text-sm text-muted-foreground">Efectivo — entra al cajón y mueve el esperado al liquidar</p>
          <p className="font-medium tabular-nums">{formatCOP(pending.data?.amount)}</p>
        </div>
        <div>
          <p className="text-sm text-muted-foreground">
            Propina — entra al cajón pero no mueve el esperado; al cerrar el turno sale del cajón como propina, no
            como plata a consignar
          </p>
          <p className="font-medium tabular-nums">{formatCOP(pending.data?.tip_amount)}</p>
        </div>
        <div>
          <p className="text-sm text-muted-foreground">Total pendiente (efectivo + propina)</p>
          <p className="font-medium tabular-nums">{formatCOP(pending.data?.total)}</p>
        </div>
      </div>

      {couriers.length === 0 ? (
        <EmptyState title="No hay efectivo de domicilios pendiente de liquidar" />
      ) : (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">
            Al liquidar, el efectivo mueve el esperado del turno; la propina en efectivo entra igual al cajón pero
            no mueve el esperado — se paga como propina, igual que la propina de cualquier otra venta, y al cerrar
            el turno sale del cajón como tal, nunca como plata a consignar.
          </p>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Domiciliario</TableHead>
                  <TableHead>Cobros</TableHead>
                  <TableHead>Efectivo (mueve el esperado)</TableHead>
                  <TableHead>Propina (no mueve el esperado; sale al cierre como propina)</TableHead>
                  <TableHead>Total</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {couriers.map((courier) => (
                  <CourierRow
                    key={courier.courier_employee_id}
                    courier={courier}
                    pending={settleMutation.isPending}
                    onSettle={(note) =>
                      settleMutation.mutate({ courierId: courier.courier_employee_id, note })
                    }
                  />
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}

      {justSettled.length > 0 ? (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold">Liquidaciones registradas en esta pantalla</h3>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Domiciliario</TableHead>
                  <TableHead>Total</TableHead>
                  <TableHead>Estado</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {justSettled.map((settlement) => (
                  <SettlementRow
                    key={settlement.id}
                    settlement={settlement}
                    voiding={voidMutation.isPending}
                    onVoid={(reason) => voidMutation.mutate({ settlementId: settlement.id, reason })}
                  />
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function CourierRow({
  courier,
  pending,
  onSettle,
}: {
  courier: CourierPending;
  pending: boolean;
  onSettle: (note: string) => void;
}) {
  const [note, setNote] = useState("");
  const [open, setOpen] = useState(false);

  return (
    <TableRow>
      <TableCell>{courier.courier_employee_name ?? "—"}</TableCell>
      <TableCell className="tabular-nums">{courier.payments_count ?? "—"}</TableCell>
      <TableCell className="tabular-nums">{formatCOP(courier.amount)}</TableCell>
      <TableCell className="tabular-nums">{formatCOP(courier.tip_amount)}</TableCell>
      <TableCell className="tabular-nums">{formatCOP(courier.total)}</TableCell>
      <TableCell>
        <AlertDialog open={open} onOpenChange={setOpen}>
          <AlertDialogTrigger render={<Button type="button" className="h-11" />}>Liquidar</AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                Liquidar {formatCOP(courier.total)} de {courier.courier_employee_name ?? "este domiciliario"}
              </AlertDialogTitle>
              <AlertDialogDescription>
                Registra que {courier.courier_employee_name ?? "el domiciliario"} entregó todo lo pendiente.
                El efectivo entra al turno abierto y deja de aparecer como pendiente.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <div className="space-y-1">
              <Label htmlFor={`settle-note-${courier.courier_employee_id}`}>Nota (opcional)</Label>
              <Textarea
                id={`settle-note-${courier.courier_employee_id}`}
                value={note}
                onChange={(event) => setNote(event.target.value)}
              />
            </div>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancelar</AlertDialogCancel>
              <AlertDialogAction
                disabled={pending}
                onClick={() => {
                  onSettle(note);
                  setOpen(false);
                }}
              >
                Liquidar
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </TableCell>
    </TableRow>
  );
}

function SettlementRow({
  settlement,
  voiding,
  onVoid,
}: {
  settlement: DeliverySettlement;
  voiding: boolean;
  onVoid: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  const [open, setOpen] = useState(false);
  const voided = settlement.status === "voided";

  return (
    <TableRow>
      <TableCell>{settlement.courier_employee_name ?? "—"}</TableCell>
      <TableCell className="tabular-nums">{formatCOP(settlement.total)}</TableCell>
      <TableCell>{voided ? `Deshecha: ${settlement.voided_reason ?? "—"}` : "Liquidada"}</TableCell>
      <TableCell>
        {voided ? null : (
          <AlertDialog open={open} onOpenChange={setOpen}>
            <AlertDialogTrigger render={<Button type="button" variant="outline" size="sm" />}>
              Deshacer
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Deshacer liquidación de {formatCOP(settlement.total)}</AlertDialogTitle>
                <AlertDialogDescription>
                  No se borra: queda registrada junto con el motivo, y los cobros vuelven a estar
                  pendientes de liquidar.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <div className="space-y-1">
                <Label htmlFor={`void-reason-${settlement.id}`}>Motivo</Label>
                <Input
                  id={`void-reason-${settlement.id}`}
                  className="h-11"
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                />
              </div>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancelar</AlertDialogCancel>
                <AlertDialogAction
                  disabled={reason.trim() === "" || voiding}
                  onClick={() => {
                    onVoid(reason.trim());
                    setOpen(false);
                  }}
                >
                  Deshacer
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
      </TableCell>
    </TableRow>
  );
}

export default DeliverySettlementPanel;
