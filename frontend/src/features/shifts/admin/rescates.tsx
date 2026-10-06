import { keepPreviousData, useMutation, useQuery } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import {
  adminAdjustOpening,
  adminCancelShift,
  adminCloseAdministrative,
  adminReopenShift,
  adminReviewShift,
  getAdjustOpeningForm,
  previewAdjustOpening,
  type AdminAdjustOpeningIn,
  type AdminShiftListItem,
  type AdjustOpeningForm,
} from "@/api/shifts";
import { ConsequenceZone } from "@/components/admin";
import { Cargando } from "@/components/Cargando";
import { MoneyInput } from "@/components/MoneyInput";
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
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { errorMessage } from "@/lib/errors";
import { formatFechaCorta } from "@/lib/format";
import { formatCOP } from "@/lib/money";
import { cn } from "@/lib/utils";

/**
 * § 11 · **El peligro va en el marco, nunca en el botón.** El botón de un
 * rescate es azul y secundario: azul porque azul es lo único que se toca,
 * secundario para que no sea lo más fácil de pulsar.
 */
export const BLUE_AND_SECONDARY = "border-primary/40 text-primary hover:bg-accent hover:text-primary";

export function ReasonRescueButton({
  label,
  title,
  description,
  disabled,
  onConfirm,
}: {
  label: string;
  title: string;
  description: string;
  disabled?: boolean;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  const id = `reason-${label.replace(/\s+/g, "-").toLowerCase()}`;
  return (
    <AlertDialog>
      <AlertDialogTrigger
        render={<Button type="button" variant="outline" className={`h-9 ${BLUE_AND_SECONDARY}`} disabled={disabled} />}
      >
        {label}
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-1">
          <Label htmlFor={id}>Motivo (obligatorio)</Label>
          <Textarea id={id} value={reason} onChange={(event) => setReason(event.target.value)} />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>Volver</AlertDialogCancel>
          <AlertDialogAction
            variant="outline"
            className={BLUE_AND_SECONDARY}
            disabled={reason.trim() === ""}
            onClick={() => onConfirm(reason.trim())}
          >
            Confirmar
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** «Cerrar turno pendiente»: el cierre administrativo de un turno abandonado (sólo pasada la hora de corte). */
export function CloseAdministrativeButton({ shiftId, onDone }: { shiftId: number; onDone: () => void }) {
  const mutation = useMutation({
    mutationFn: (reason: string) => adminCloseAdministrative(shiftId, { reason }),
    onSuccess: () => {
      toast.success("Turno cerrado administrativamente.");
      onDone();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  return (
    <ReasonRescueButton
      label="Cerrar turno pendiente"
      title="Cerrar administrativamente este turno abandonado"
      description="Cierra con el esperado, diferencia cero, marcado como cerrado sin conteo, y cierra el día."
      disabled={mutation.isPending}
      onConfirm={(reason) => mutation.mutate(reason)}
    />
  );
}

/** «Reabrir cierre»: el conteo anterior queda como histórico. */
export function ReopenButton({ shiftId, onDone }: { shiftId: number; onDone: () => void }) {
  const mutation = useMutation({
    mutationFn: (reason: string) => adminReopenShift(shiftId, { reason }),
    onSuccess: () => {
      toast.success("Turno reabierto.");
      onDone();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  return (
    <ReasonRescueButton
      label="Reabrir cierre"
      title="Reabrir este cierre"
      description="El conteo anterior queda como histórico; una venta de último momento puede volver a registrarse."
      disabled={mutation.isPending}
      onConfirm={(reason) => mutation.mutate(reason)}
    />
  );
}

/** «Cancelar»: sólo un turno abierto por error y sin actividad (el servidor lo hace cumplir). */
export function CancelButton({ shiftId, onDone }: { shiftId: number; onDone: () => void }) {
  const mutation = useMutation({
    mutationFn: () => adminCancelShift(shiftId),
    onSuccess: () => {
      toast.success("Turno cancelado.");
      onDone();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  return (
    <AlertDialog>
      <AlertDialogTrigger
        render={
          <Button type="button" variant="outline" className={`h-9 ${BLUE_AND_SECONDARY}`} disabled={mutation.isPending} />
        }
      >
        Cancelar
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Cancelar este turno</AlertDialogTitle>
          <AlertDialogDescription>
            Sólo corresponde si se abrió por error y no tiene ninguna actividad. Queda cancelado, no se borra.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Volver</AlertDialogCancel>
          <AlertDialogAction
            variant="outline"
            className={BLUE_AND_SECONDARY}
            disabled={mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            Confirmar cancelación
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * Los rescates de un turno en un diálogo, para la ficha del turno
 * (`features/reports/fichas/FichaTurno.tsx`): los mismos botones que la
 * tarjeta de Cuadres, más «Revisar». La cronología del turno ya no se
 * repite acá: vive en la tarjeta de Cuadres (movimientos y cuadres) y en la
 * propia ficha.
 */
export function ShiftRescuesDialog({
  shift,
  open,
  onOpenChange,
  onChanged,
}: {
  shift: AdminShiftListItem;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged?: () => void;
}): React.JSX.Element {
  const done = () => onChanged?.();
  const reviewMutation = useMutation({
    mutationFn: () => adminReviewShift(shift.id, {}),
    onSuccess: () => {
      toast.success("Cierre marcado como revisado.");
      done();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Rescates del turno #{shift.id}</DialogTitle>
          <DialogDescription>Cada rescate pide su motivo, y el motivo queda en la cronología del turno.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <Button
            type="button"
            variant="outline"
            className="h-9"
            disabled={reviewMutation.isPending || Boolean(shift.reviewed_at)}
            onClick={() => reviewMutation.mutate()}
          >
            {shift.reviewed_at ? "Ya revisado" : reviewMutation.isPending ? "Marcando…" : "Revisar"}
          </Button>
          <ConsequenceZone
            level="irreversible"
            scope={`Turno #${shift.id}`}
            explanation={
              <>
                Lo de acá abajo <b>no se deshace</b>: cerrar un turno pendiente lo sella con el esperado y diferencia
                cero, reabrir deja el conteo anterior sólo como histórico, cancelar lo saca del día y ajustar la
                apertura rehace con cuánto abrió y de qué días era esa plata. Nada de esto toca una venta ya cobrada ni
                un documento ya emitido.
              </>
            }
          >
            <div className="flex flex-wrap items-center gap-2">
              {shift.status === "open" && shift.is_stale ? <CloseAdministrativeButton shiftId={shift.id} onDone={done} /> : null}
              {shift.status === "closed" ? <ReopenButton shiftId={shift.id} onDone={done} /> : null}
              {shift.status === "open" ? <CancelButton shiftId={shift.id} onDone={done} /> : null}
              <AdjustOpeningButton shiftId={shift.id} onDone={done} />
            </div>
          </ConsequenceZone>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * **Ajustar apertura** (decisión del dueño, 2026-09-29, como el café): el
 * efectivo real de la registradora (el total, sin denominaciones), «¿de qué
 * días era la plata que había en el cajón?» y el motivo. Antes de guardar,
 * el servidor dice cómo va a quedar —«Va a quedar esperando $X de días
 * anteriores / consignable queda en $Y»— con la misma cuenta que va a
 * guardar. Esta pantalla no calcula nada.
 */
export function AdjustOpeningButton({ shiftId, onDone }: { shiftId: number; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" variant="outline" className={`h-9 ${BLUE_AND_SECONDARY}`} onClick={() => setOpen(true)}>
        Ajustar apertura
      </Button>
      {open ? <AdjustOpeningDialog shiftId={shiftId} onClose={() => setOpen(false)} onDone={onDone} /> : null}
    </>
  );
}

function AdjustOpeningDialog({
  shiftId,
  onClose,
  onDone,
}: {
  shiftId: number;
  onClose: () => void;
  onDone: () => void;
}): React.JSX.Element {
  const formQuery = useQuery({
    queryKey: ["admin-adjust-opening", shiftId],
    queryFn: () => getAdjustOpeningForm(shiftId),
  });
  return (
    <Dialog open onOpenChange={(next) => (next ? null : onClose())}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Ajustar apertura · turno #{shiftId}</DialogTitle>
          <DialogDescription>
            Corrige con cuánto abrió el cajón y de qué días era esa plata. Se recalcula todo con la misma cuenta del
            cierre; los relevos ya contados no se tocan.
          </DialogDescription>
        </DialogHeader>
        {formQuery.isLoading ? (
          <Cargando texto="Cargando la apertura…" />
        ) : formQuery.isError || !formQuery.data ? (
          <p role="alert" className="text-sm text-destructive">
            {errorMessage(formQuery.error)}
          </p>
        ) : (
          <AdjustOpeningFields form={formQuery.data} onClose={onClose} onDone={onDone} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function AdjustOpeningFields({
  form,
  onClose,
  onDone,
}: {
  form: AdjustOpeningForm;
  onClose: () => void;
  onDone: () => void;
}): React.JSX.Element {
  const [total, setTotal] = useState<number | null>(form.opening_cash_total);
  const [dias, setDias] = useState<number[]>(() => form.days.filter((d) => d.selected).map((d) => d.shift_id));
  const [reserve, setReserve] = useState<number | null>(form.cash_reserve);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  // La reserva de antes sólo existe en los turnos de la base fija: con la
  // regla del cajón la base de respaldo vive aparte y no se ajusta acá.
  const conReserva = form.opening_mode === "fixed_base";

  const body: AdminAdjustOpeningIn = {
    opening_cash_total: total ?? 0,
    carried_shift_ids: form.days.filter((d) => dias.includes(d.shift_id)).map((d) => d.shift_id),
    cash_reserve: conReserva ? (reserve ?? 0) : undefined,
    reason: reason.trim(),
  };

  const previewQuery = useQuery({
    queryKey: ["admin-adjust-opening-preview", form.shift_id, body.opening_cash_total, body.carried_shift_ids, body.cash_reserve],
    queryFn: () => previewAdjustOpening(form.shift_id, body),
    placeholderData: keepPreviousData,
    enabled: total !== null,
  });
  const preview = previewQuery.data;

  const mutation = useMutation({
    mutationFn: () => adminAdjustOpening(form.shift_id, body),
    onMutate: () => setError(null),
    onSuccess: () => {
      toast.success("Apertura ajustada.");
      onDone();
      onClose();
    },
    onError: (err) => setError(errorMessage(err)),
  });

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <Label htmlFor="adjust-total">Efectivo real de la registradora</Label>
        <MoneyInput id="adjust-total" value={total} onChange={setTotal} />
        <p className="text-xs text-muted-foreground">El total que había, sin teclear denominaciones.</p>
      </div>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">¿De qué días era la plata que había en el cajón?</legend>
        {form.days.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No hay días anteriores con saldo por consignar que pudieran estar en el cajón.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {form.days.map((d) => {
              const marcado = dias.includes(d.shift_id);
              return (
                <li key={d.shift_id}>
                  <button
                    type="button"
                    aria-pressed={marcado}
                    onClick={() =>
                      setDias((prev) =>
                        prev.includes(d.shift_id) ? prev.filter((id) => id !== d.shift_id) : [...prev, d.shift_id],
                      )
                    }
                    className={cn(
                      "flex min-h-11 w-full items-center gap-2.5 rounded-md border px-3 text-left text-sm",
                      marcado ? "border-success bg-success/5" : "",
                    )}
                  >
                    <span
                      aria-hidden="true"
                      className={cn(
                        "grid size-5 place-items-center rounded",
                        marcado ? "bg-success text-success-foreground" : "border-2 border-muted-foreground",
                      )}
                    >
                      {marcado ? <Check className="size-3.5" /> : null}
                    </span>
                    <span className="flex-1 capitalize">{formatFechaCorta(d.business_date)}</span>
                    <span className="font-semibold tabular-nums">{formatCOP(d.amount)}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </fieldset>

      {conReserva ? (
        <div className="space-y-1">
          <Label htmlFor="adjust-reserve">Reserva (regla anterior)</Label>
          <MoneyInput id="adjust-reserve" value={reserve} onChange={setReserve} />
        </div>
      ) : null}

      <div className="space-y-1">
        <Label htmlFor="adjust-reason">Motivo (obligatorio)</Label>
        <Textarea id="adjust-reason" value={reason} onChange={(event) => setReason(event.target.value)} />
      </div>

      <div data-testid="adjust-preview" className="space-y-1 rounded-md border bg-muted/40 p-3 text-sm" aria-live="polite">
        {preview ? (
          <>
            <p>
              Va a quedar esperando <b className="tabular-nums">{formatCOP(preview.carried_total_after)}</b> de días
              anteriores.
            </p>
            <p>
              Diferencia de apertura: <b className="tabular-nums">{formatCOP(preview.opening_difference_after)}</b>
            </p>
            {preview.to_deposit_after !== null ? (
              <>
                <p>
                  Consignable queda en <b className="tabular-nums">{formatCOP(preview.to_deposit_after)}</b>
                  {preview.to_deposit_before !== null ? (
                    <span className="text-muted-foreground"> (antes {formatCOP(preview.to_deposit_before)})</span>
                  ) : null}
                  .
                </p>
                <p>
                  Diferencia del cierre: <b className="tabular-nums">{formatCOP(preview.close_difference_after)}</b>
                  {preview.close_difference_before !== null ? (
                    <span className="text-muted-foreground"> (antes {formatCOP(preview.close_difference_before)})</span>
                  ) : null}
                </p>
              </>
            ) : (
              <p className="text-muted-foreground">El turno todavía no cerró con conteo: el consignable sale al cerrar.</p>
            )}
          </>
        ) : previewQuery.isError ? (
          <p role="alert" className="text-destructive">
            {errorMessage(previewQuery.error)}
          </p>
        ) : (
          <p className="text-muted-foreground">Calculando cómo va a quedar…</p>
        )}
      </div>

      {error ? (
        <p role="alert" className="text-sm font-semibold text-destructive">
          {error}
        </p>
      ) : null}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onClose}>
          Volver
        </Button>
        <Button
          type="button"
          variant="outline"
          className={BLUE_AND_SECONDARY}
          disabled={reason.trim() === "" || total === null || mutation.isPending || !preview}
          onClick={() => mutation.mutate()}
        >
          {mutation.isPending ? "Guardando…" : "Guardar ajuste"}
        </Button>
      </div>
    </div>
  );
}
