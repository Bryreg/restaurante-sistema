import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { toast } from "sonner";

import { ApiError, newIdempotencyKey } from "@/api/client";
import { createPickup, reversePickup, type CashPickup } from "@/api/shifts";
import { EmptyState } from "@/components/EmptyState";
import { MoneyInput } from "@/components/MoneyInput";
import { PinPad } from "@/components/PinPad";
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
import { formatInstant } from "@/lib/businessDate";
import { errorMessage } from "@/lib/errors";
import { formatCOP } from "@/lib/money";

import { PhotoCaptureField } from "./PhotoCaptureField";
import { CURRENT_SHIFT_QUERY_KEY, shiftSummaryQueryKey, useShiftSummary } from "./hooks";

/**
 * Retiros de efectivo (`cash.pickups`, `POST /shifts/{id}/pickups`): PIN de
 * administrador siempre, foto sólo si el servidor la exige
 * (`400 PHOTO_REQUIRED`, config de sede vía `cash.photo_required`), y el
 * snapshot `expected_at_pickup` que devuelve el servidor — nunca se
 * recalcula acá. Cada retiro puede reversarse con motivo y PIN, sin
 * editarse ni borrarse.
 */
export function PickupsPanel({ shiftId }: { shiftId: number }): React.JSX.Element {
  const queryClient = useQueryClient();
  const summary = useShiftSummary(shiftId);

  const [amount, setAmount] = useState<number | null>(null);
  const [envelopeRef, setEnvelopeRef] = useState("");
  const [note, setNote] = useState("");
  const [photo, setPhoto] = useState<string | null>(null);
  const [photoRequired, setPhotoRequired] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const idempotencyKeyRef = useRef(newIdempotencyKey());

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: shiftSummaryQueryKey(shiftId) });
    void queryClient.invalidateQueries({ queryKey: CURRENT_SHIFT_QUERY_KEY });
  }

  const createMutation = useMutation({
    mutationFn: (authorizerPin: string) =>
      createPickup(
        shiftId,
        {
          amount: amount ?? 0,
          envelope_ref: envelopeRef.trim() === "" ? undefined : envelopeRef.trim(),
          note: note.trim() === "" ? undefined : note.trim(),
          photo: photo ?? undefined,
          authorizer_pin: authorizerPin,
        },
        idempotencyKeyRef.current,
      ),
    onSuccess: () => {
      toast.success("Retiro registrado.");
      setAmount(null);
      setEnvelopeRef("");
      setNote("");
      setPhoto(null);
      setPhotoRequired(false);
      setError(null);
      idempotencyKeyRef.current = newIdempotencyKey();
      invalidate();
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === "PHOTO_REQUIRED") {
        setPhotoRequired(true);
        idempotencyKeyRef.current = newIdempotencyKey();
      }
      setError(errorMessage(err));
    },
  });

  const reverseMutation = useMutation({
    mutationFn: ({ pickupId, reason, pin }: { pickupId: number; reason: string; pin: string }) =>
      reversePickup(shiftId, pickupId, { reason, authorizer_pin: pin }),
    onSuccess: () => {
      toast.success("Retiro reversado.");
      invalidate();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const amountValid = amount !== null && amount > 0;
  const pickups = summary.data?.pickups ?? [];

  return (
    <div className="space-y-6">
      <div className="grid gap-4 rounded-md border p-4 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="pickup-amount">Monto a retirar</Label>
          <MoneyInput id="pickup-amount" value={amount} onChange={setAmount} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="pickup-envelope">Número de sobre (opcional)</Label>
          <Input
            id="pickup-envelope"
            className="h-11"
            value={envelopeRef}
            onChange={(event) => setEnvelopeRef(event.target.value)}
          />
        </div>
        <div className="space-y-1 sm:col-span-2">
          <Label htmlFor="pickup-note">Nota</Label>
          <Textarea id="pickup-note" value={note} onChange={(event) => setNote(event.target.value)} />
        </div>
        <div className="sm:col-span-2">
          <PhotoCaptureField value={photo} onChange={setPhoto} required={photoRequired} />
        </div>

        {error ? (
          <p role="alert" className="text-sm text-destructive sm:col-span-2">
            {error}
          </p>
        ) : null}
      </div>

      {amountValid ? (
        <div className="flex flex-col items-center gap-3 rounded-md border p-4">
          <p className="text-sm text-muted-foreground">
            Retiro de {formatCOP(amount)} · PIN de administrador para autorizar
          </p>
          <PinPad
            length={4}
            label="PIN de administrador"
            disabled={createMutation.isPending}
            onSubmit={(pin) => createMutation.mutate(pin)}
          />
        </div>
      ) : null}

      {summary.isLoading ? (
        <p className="text-sm text-muted-foreground">Cargando retiros…</p>
      ) : pickups.length === 0 ? (
        <EmptyState title="Todavía no hay retiros en este turno" />
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Hora</TableHead>
                <TableHead>Monto</TableHead>
                <TableHead>Sobre</TableHead>
                <TableHead>Autorizó</TableHead>
                <TableHead>Estado</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {pickups.map((pickup) => (
                <PickupRow
                  key={pickup.id}
                  pickup={pickup}
                  onReverse={(reason, pin) => reverseMutation.mutate({ pickupId: pickup.id, reason, pin })}
                  reversing={reverseMutation.isPending}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

function PickupRow({
  pickup,
  onReverse,
  reversing,
}: {
  pickup: CashPickup;
  onReverse: (reason: string, pin: string) => void;
  reversing: boolean;
}) {
  const [reason, setReason] = useState("");
  const [pin, setPin] = useState("");
  const reversed = Boolean(pickup.reversed_at);

  return (
    <TableRow>
      <TableCell>{formatInstant(pickup.at)}</TableCell>
      <TableCell className="tabular-nums">{formatCOP(pickup.amount)}</TableCell>
      <TableCell>{pickup.envelope_ref ?? "—"}</TableCell>
      <TableCell>{pickup.authorized_by_employee_name ?? "—"}</TableCell>
      <TableCell>{reversed ? `Reversado: ${pickup.reversed_reason ?? "—"}` : "Vigente"}</TableCell>
      <TableCell>
        {reversed ? null : (
          <AlertDialog>
            <AlertDialogTrigger render={<Button type="button" variant="outline" size="sm" />}>
              Reversar
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Reversar retiro de {formatCOP(pickup.amount)}</AlertDialogTitle>
                <AlertDialogDescription>
                  El retiro no se borra: queda registrado junto con la reversa y el motivo.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <div className="space-y-3">
                <div className="space-y-1">
                  <Label htmlFor={`reverse-reason-${pickup.id}`}>Motivo</Label>
                  <Textarea
                    id={`reverse-reason-${pickup.id}`}
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor={`reverse-pin-${pickup.id}`}>PIN de administrador</Label>
                  <Input
                    id={`reverse-pin-${pickup.id}`}
                    type="password"
                    inputMode="numeric"
                    className="h-11"
                    value={pin}
                    onChange={(event) => setPin(event.target.value)}
                  />
                </div>
              </div>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancelar</AlertDialogCancel>
                <AlertDialogAction
                  disabled={reason.trim() === "" || pin.trim() === "" || reversing}
                  onClick={() => onReverse(reason.trim(), pin.trim())}
                >
                  Reversar
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
      </TableCell>
    </TableRow>
  );
}
