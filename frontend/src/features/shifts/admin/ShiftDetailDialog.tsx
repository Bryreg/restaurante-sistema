import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

import {
  adminAdjustOpening,
  adminCancelShift,
  adminCloseAdministrative,
  adminReopenShift,
  adminReviewShift,
  getAdminShiftTimeline,
  getShiftSummary,
  type AdminShiftListItem,
} from "@/api/shifts";
import { Cargando } from "@/components/Cargando";
import { ConsequenceZone } from "@/components/admin";
import { EmptyState } from "@/components/EmptyState";
import { DenominationsInput, type Denomination } from "@/components/DenominationsInput";
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
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { MoneyInput } from "@/components/MoneyInput";
import { Textarea } from "@/components/ui/textarea";
import { formatBusinessDate, formatInstant } from "@/lib/businessDate";
import { errorMessage } from "@/lib/errors";
import { DENOMINATIONS, formatCOP } from "@/lib/money";

function emptyDenominations(): Denomination[] {
  return DENOMINATIONS.map((value) => ({ value, count: 0 }));
}

/**
 * § 11 · **El peligro va en el marco, nunca en el botón.** El botón de un
 * rescate es **azul y secundario**: azul porque azul es lo único que se toca
 * (`docs/DISENO.md` § La regla del color), secundario para que no sea lo más
 * fácil de pulsar. La misma constante viste el disparador y la confirmación,
 * para que no haya dos criterios.
 */
const BLUE_AND_SECONDARY = "border-primary/40 text-primary hover:bg-accent hover:text-primary";

export interface ShiftDetailDialogProps {
  shift: AdminShiftListItem;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Se llama tras cualquier rescate exitoso, para que la lista se refresque. */
  onChanged?: () => void;
}

/**
 * Detalle de un turno desde Dinero: timeline (`GET /admin/shifts/{id}/timeline`,
 * orden cronológico con quién, monto y foto), botón Revisar
 * (`POST /admin/shifts/{id}/review`) y los cuatro rescates de administrador
 * (spec § 3.7) — cada uno con confirmación y motivo obligatorio, salvo
 * "Cancelar": ver el GAP en el propio botón.
 */
export function ShiftDetailDialog({ shift, open, onOpenChange, onChanged }: ShiftDetailDialogProps): React.JSX.Element {
  const queryClient = useQueryClient();

  const timelineQuery = useQuery({
    queryKey: ["admin-shift-timeline", shift.id],
    queryFn: () => getAdminShiftTimeline(shift.id),
    enabled: open,
  });

  // Se usa sólo para decidir si "Cancelar" corresponde (sin actividad) —
  // nunca para mostrar un esperado que la propia fila ya trae.
  const summaryQuery = useQuery({
    queryKey: ["admin-shift-summary", shift.id],
    queryFn: () => getShiftSummary(shift.id),
    enabled: open,
  });

  function invalidateAll() {
    void queryClient.invalidateQueries({ queryKey: ["admin-shift-timeline", shift.id] });
    void queryClient.invalidateQueries({ queryKey: ["admin-shift-summary", shift.id] });
    onChanged?.();
  }

  const reviewMutation = useMutation({
    mutationFn: () => adminReviewShift(shift.id, {}),
    onSuccess: () => {
      toast.success("Cierre marcado como revisado.");
      invalidateAll();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const summary = summaryQuery.data;
  const hasActivity = Boolean(
    summary &&
      ((summary.movements?.length ?? 0) > 0 ||
        (summary.swaps?.length ?? 0) > 0 ||
        (summary.pickups?.length ?? 0) > 0 ||
        (summary.handovers?.length ?? 0) > 0 ||
        (summary.roster?.length ?? 0) > 1),
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* `sm:max-w-2xl` y no `max-w-2xl`: el `DialogContent` compartido trae
          `sm:max-w-sm`, y una clase sin variante no le gana a una con `sm:`
          —el diálogo quedaba en 384 px en un monitor de 1440—. Se corrige acá,
          en el sitio de llamada, porque la capa compartida es de sólo lectura
          en esta ola; queda dicho en el informe. */}
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            Turno #{shift.id} · {formatBusinessDate(shift.business_date)}
          </DialogTitle>
        </DialogHeader>

        <div className="max-h-[70vh] space-y-6 overflow-y-auto pr-1">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              className="h-9"
              disabled={reviewMutation.isPending || Boolean(shift.reviewed_at)}
              onClick={() => reviewMutation.mutate()}
            >
              {shift.reviewed_at ? "Ya revisado" : reviewMutation.isPending ? "Marcando…" : "Revisar"}
            </Button>

          </div>

          {/* § 11 · Zona de riesgo: estos cuatro reescriben un turno cerrado
              o lo hacen desaparecer, y ninguno se deshace solo. Van todos
              adentro del mismo marco rojo —el marco avisa— con el botón azul
              y secundario, y cada uno sigue pidiendo su motivo obligatorio,
              que es donde queda la constancia de por qué se hizo. */}
          <ConsequenceZone
            level="irreversible"
            scope={`Turno #${shift.id}`}
            explanation={
              <>
                Lo de acá abajo <b>no se deshace</b>: un cierre administrativo sella el turno con el esperado y
                diferencia cero, reabrir deja el conteo anterior sólo como histórico, cancelar elimina el turno y
                ajustar la apertura reescribe la base y todo lo que se derivó de ella. Cada uno pide un motivo, y el
                motivo queda en la cronología de abajo. Lo que <b>no</b> pasa: nada de esto toca una venta ya cobrada
                ni un documento ya emitido.
              </>
            }
          >
            <div className="flex flex-wrap items-center gap-2">
              {shift.status === "open" && shift.is_stale ? (
                <CloseAdministrativeButton shiftId={shift.id} onDone={invalidateAll} />
              ) : null}
              {shift.status === "closed" ? <ReopenButton shiftId={shift.id} onDone={invalidateAll} /> : null}
              {shift.status === "open" ? (
                <CancelButton shiftId={shift.id} disabled={hasActivity} onDone={invalidateAll} />
              ) : null}
              <AdjustOpeningButton shiftId={shift.id} onDone={invalidateAll} />
            </div>
          </ConsequenceZone>

          <div className="space-y-2">
            <h3 className="text-sm font-semibold">Cronología</h3>
            {timelineQuery.isLoading ? (
              <Cargando texto="Cargando…" />
            ) : timelineQuery.isError ? (
              <p role="alert" className="text-sm text-destructive">
                {errorMessage(timelineQuery.error)}
              </p>
            ) : (timelineQuery.data ?? []).length === 0 ? (
              <EmptyState title="Sin eventos todavía" />
            ) : (
              <ol className="space-y-2 border-l pl-4">
                {(timelineQuery.data ?? []).map((event, index) => (
                  <li key={index} className="space-y-0.5 text-sm">
                    <p className="font-medium">{event.summary ?? event.kind ?? "Evento"}</p>
                    <p className="text-muted-foreground">
                      {formatInstant(event.at)}
                      {event.employee_name ? ` · ${event.employee_name}` : ""}
                    </p>
                    {typeof event.data?.photo === "string" ? (
                      <img src={event.data.photo} alt="Foto del evento" className="mt-1 h-16 w-16 rounded-md border object-cover" />
                    ) : null}
                  </li>
                ))}
              </ol>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ReasonRescueButton({
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
          <Label htmlFor={`reason-${label}`}>Motivo</Label>
          <Textarea id={`reason-${label}`} value={reason} onChange={(event) => setReason(event.target.value)} />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancelar</AlertDialogCancel>
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

function CloseAdministrativeButton({ shiftId, onDone }: { shiftId: number; onDone: () => void }) {
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
      label="Cierre administrativo"
      title="Cerrar administrativamente este turno abandonado"
      description="Cierra con el esperado, diferencia cero, marcado como cerrado sin conteo, y cierra el día."
      disabled={mutation.isPending}
      onConfirm={(reason) => mutation.mutate(reason)}
    />
  );
}

function ReopenButton({ shiftId, onDone }: { shiftId: number; onDone: () => void }) {
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
      label="Reabrir"
      title="Reabrir este cierre"
      description="El conteo anterior queda como histórico; una venta de último momento puede volver a registrarse."
      disabled={mutation.isPending}
      onConfirm={(reason) => mutation.mutate(reason)}
    />
  );
}

function CancelButton({ shiftId, disabled, onDone }: { shiftId: number; disabled: boolean; onDone: () => void }) {
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
          <Button
            type="button"
            variant="outline"
            className={`h-9 ${BLUE_AND_SECONDARY}`}
            disabled={disabled || mutation.isPending}
          />
        }
      >
        Cancelar
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Cancelar este turno</AlertDialogTitle>
          <AlertDialogDescription>
            Sólo corresponde si se abrió por error y no tiene ninguna actividad. Se elimina lógicamente.
            {disabled ? " Este turno ya tiene actividad registrada: no se puede cancelar." : null}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <p className="text-xs text-muted-foreground">
          GAP: el endpoint <code>DELETE /admin/shifts/{"{id}"}</code> no recibe un motivo en el cuerpo (ver
          `features/fase-1a-cimientos/outputs/frontend-caja.md`); esta confirmación cumple el requisito de
          confirmación explícita, pero el motivo no se puede enviar al servidor con el contrato actual.
        </p>
        <AlertDialogFooter>
          <AlertDialogCancel>Volver</AlertDialogCancel>
          <AlertDialogAction
            variant="outline"
            className={BLUE_AND_SECONDARY}
            disabled={disabled || mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            Confirmar cancelación
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function AdjustOpeningButton({ shiftId, onDone }: { shiftId: number; onDone: () => void }) {
  const [denominations, setDenominations] = useState<Denomination[]>(emptyDenominations());
  const [reserve, setReserve] = useState<number | null>(0);
  const [reason, setReason] = useState("");

  const mutation = useMutation({
    mutationFn: () => {
      const total = denominations.reduce((acc, d) => acc + d.value * d.count, 0);
      return adminAdjustOpening(shiftId, {
        opening_cash: { denominations, total },
        cash_reserve: reserve ?? 0,
        reason: reason.trim(),
      });
    },
    onSuccess: () => {
      toast.success("Apertura ajustada.");
      onDone();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  return (
    <AlertDialog>
      <AlertDialogTrigger render={<Button type="button" variant="outline" className={`h-9 ${BLUE_AND_SECONDARY}`} />}>
        Ajustar apertura
      </AlertDialogTrigger>
      <AlertDialogContent className="max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>Ajustar base y reserva de apertura</AlertDialogTitle>
          <AlertDialogDescription>
            Reescribe la base y la reserva contadas al abrir, y todo lo derivado, con la misma función del flujo
            normal.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-3">
          <DenominationsInput value={denominations} onChange={setDenominations} legend="Base correcta" />
          <div className="space-y-1">
            <Label htmlFor="adjust-reserve">Reserva correcta</Label>
            <MoneyInput id="adjust-reserve" value={reserve} onChange={setReserve} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="adjust-reason">Motivo</Label>
            <Textarea id="adjust-reason" value={reason} onChange={(event) => setReason(event.target.value)} />
          </div>
          <p className="text-xs text-muted-foreground">
            Total tecleado: {formatCOP(denominations.reduce((acc, d) => acc + d.value * d.count, 0))}
          </p>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancelar</AlertDialogCancel>
          <AlertDialogAction
            variant="outline"
            className={BLUE_AND_SECONDARY}
            disabled={reason.trim() === "" || mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            Confirmar ajuste
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
