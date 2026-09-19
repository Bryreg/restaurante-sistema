import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { toast } from "sonner";

import { ApiError, newIdempotencyKey } from "@/api/client";
import {
  createCashMovement,
  type CashMovementCause,
  type CashMovementIn,
  type CashMovementKind,
} from "@/api/shifts";
import { EmptyState } from "@/components/EmptyState";
import { MoneyInput } from "@/components/MoneyInput";
import { PinPad } from "@/components/PinPad";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { formatInstant } from "@/lib/businessDate";
import { errorMessage } from "@/lib/errors";
import { formatCOP } from "@/lib/money";

import { PhotoCaptureField } from "./PhotoCaptureField";
import { CURRENT_SHIFT_QUERY_KEY, shiftSummaryQueryKey, useShiftSummary } from "./hooks";

const KIND_LABEL: Record<CashMovementKind, string> = { income: "Ingreso", expense: "Egreso" };

/**
 * Exportado (Ronda 2, H-8) para que `MovementsPanel.test.tsx` pueda
 * recorrer `CASH_MOVEMENT_CAUSES` y exigir una etiqueta no vacía por cada
 * miembro — sin el `export`, el `Record<CashMovementCause, string>` ya
 * obliga a listar TODAS las causas del tipo (si no, no tipa), pero eso sólo
 * protege contra una causa presente en `CashMovementCause` y ausente acá;
 * no protege contra una causa que el backend ya declaró y que nadie agregó
 * todavía ni al tipo ni acá — que es exactamente lo que pasó con
 * `supplier_payment` hasta esta ronda. El test cierra ese segundo caso.
 */
export const CAUSE_LABEL: Record<CashMovementCause, string> = {
  petty_expense: "Gasto menor",
  emergency_purchase: "Compra de emergencia",
  refund: "Devolución",
  tip_payout: "Pago de propinas",
  // La columna de `kind` ya distingue ingreso de egreso: un pago a
  // proveedor desde el cajón llega con `kind: "expense"`, pero el
  // reintegro de un pago anulado llega con la MISMA causa y
  // `kind: "income"` (`backend/app/shifts/hooks.py`, pedido 2b de
  // compras) — por eso la etiqueta no dice "Egreso" ni "Salida".
  supplier_payment: "Pago a proveedor",
  other_income: "Otro ingreso",
  other_expense: "Otro egreso",
};

/**
 * Movimientos de caja (spec § "Business day & shifts", `POST
 * /shifts/{id}/cash-movements`): ingreso o egreso con causa tipada. Un
 * egreso por encima de `petty_cash_limit` responde `400 PETTY_CASH_LIMIT`
 * sin PIN — recién ahí se pide el PIN de administrador y se reintenta con
 * `authorizer_pin`, con una `Idempotency-Key` nueva porque el cuerpo cambió.
 */
export function MovementsPanel({ shiftId }: { shiftId: number }): React.JSX.Element {
  const queryClient = useQueryClient();
  const summary = useShiftSummary(shiftId);

  const [kind, setKind] = useState<CashMovementKind>("expense");
  const [cause, setCause] = useState<CashMovementCause>("petty_expense");
  const [amount, setAmount] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const [photo, setPhoto] = useState<string | null>(null);
  const [needsAuthorizerPin, setNeedsAuthorizerPin] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const idempotencyKeyRef = useRef(newIdempotencyKey());

  function resetForm() {
    setAmount(null);
    setNote("");
    setPhoto(null);
    setNeedsAuthorizerPin(false);
    idempotencyKeyRef.current = newIdempotencyKey();
  }

  const mutation = useMutation({
    mutationFn: (authorizerPin?: string) => {
      const body: CashMovementIn = {
        kind,
        cause,
        amount: amount ?? 0,
        note: note.trim() === "" ? undefined : note.trim(),
        receipt_photo: photo ?? undefined,
        authorizer_pin: authorizerPin,
      };
      return createCashMovement(shiftId, body, idempotencyKeyRef.current);
    },
    onSuccess: () => {
      toast.success(`${KIND_LABEL[kind]} registrado.`);
      resetForm();
      void queryClient.invalidateQueries({ queryKey: shiftSummaryQueryKey(shiftId) });
      void queryClient.invalidateQueries({ queryKey: CURRENT_SHIFT_QUERY_KEY });
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === "PETTY_CASH_LIMIT") {
        setNeedsAuthorizerPin(true);
        idempotencyKeyRef.current = newIdempotencyKey();
      }
      setError(errorMessage(err));
    },
  });

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (amount === null || amount <= 0) {
      setError("Ingresá un monto mayor a cero.");
      return;
    }
    setError(null);
    mutation.mutate(undefined);
  }

  const movements = summary.data?.movements ?? [];

  return (
    <div className="space-y-6">
      <form onSubmit={handleSubmit} className="grid gap-4 rounded-md border p-4 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="movement-kind">Tipo</Label>
          <Select value={kind} onValueChange={(v) => setKind(v as CashMovementKind)}>
            <SelectTrigger id="movement-kind" className="h-11 w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(KIND_LABEL).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="movement-cause">Causa</Label>
          <Select value={cause} onValueChange={(v) => setCause(v as CashMovementCause)}>
            <SelectTrigger id="movement-cause" className="h-11 w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(CAUSE_LABEL).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="movement-amount">Monto</Label>
          <MoneyInput id="movement-amount" value={amount} onChange={setAmount} />
        </div>
        <div className="space-y-1 sm:col-span-2">
          <Label htmlFor="movement-note">Nota</Label>
          <Textarea id="movement-note" value={note} onChange={(event) => setNote(event.target.value)} />
        </div>
        <div className="sm:col-span-2">
          <PhotoCaptureField value={photo} onChange={setPhoto} label="Foto del comprobante (opcional)" />
        </div>

        {error ? (
          <p role="alert" className="text-sm text-destructive sm:col-span-2">
            {error}
          </p>
        ) : null}

        {needsAuthorizerPin ? (
          <div className="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 sm:col-span-2">
            <PinPad
              length={4}
              label="PIN de administrador"
              disabled={mutation.isPending}
              onSubmit={(pin) => mutation.mutate(pin)}
            />
          </div>
        ) : null}

        {!needsAuthorizerPin ? (
          <Button type="submit" className="h-11 sm:col-span-2" disabled={mutation.isPending}>
            {mutation.isPending ? "Registrando…" : "Registrar movimiento"}
          </Button>
        ) : null}
      </form>

      {summary.isLoading ? (
        <p className="text-sm text-muted-foreground">Cargando movimientos…</p>
      ) : movements.length === 0 ? (
        <EmptyState title="Todavía no hay movimientos en este turno" />
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Hora</TableHead>
                <TableHead>Tipo</TableHead>
                <TableHead>Causa</TableHead>
                <TableHead>Monto</TableHead>
                <TableHead>Persona</TableHead>
                <TableHead>Autorizó</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {movements.map((movement) => (
                <TableRow key={movement.id}>
                  <TableCell>{formatInstant(movement.at)}</TableCell>
                  <TableCell>{movement.kind ? KIND_LABEL[movement.kind] : "—"}</TableCell>
                  <TableCell>{movement.cause ? CAUSE_LABEL[movement.cause] : "—"}</TableCell>
                  <TableCell className="tabular-nums">{formatCOP(movement.amount)}</TableCell>
                  <TableCell>{movement.employee_name ?? "—"}</TableCell>
                  <TableCell>{movement.authorized_by_employee_name ?? "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
