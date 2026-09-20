import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { toast } from "sonner";

import { useSession } from "@/app/session";
import { ApiError, newIdempotencyKey } from "@/api/client";
import { closeSingleStep, type CashDifferenceCause } from "@/api/shifts";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DenominationsInput, type Denomination } from "@/components/DenominationsInput";
import { Label } from "@/components/ui/label";
import { MoneyInput } from "@/components/MoneyInput";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { errorMessage } from "@/lib/errors";
import { DENOMINATIONS, formatCOP } from "@/lib/money";

import { PhotoCaptureField } from "./PhotoCaptureField";
import { CURRENT_SHIFT_QUERY_KEY, shiftSummaryQueryKey, useShiftTips } from "./hooks";

const CAUSE_LABEL: Record<CashDifferenceCause, string> = {
  change_error: "Error al dar cambio",
  expense_without_voucher: "Gasto sin comprobante",
  tips_mixed: "Propinas mezcladas con la base",
  unrecorded_sale: "Venta no registrada",
  counting_error: "Error de conteo",
  unknown: "Sin identificar",
};

function emptyDenominations(): Denomination[] {
  return DENOMINATIONS.map((value) => ({ value, count: 0 }));
}

/**
 * Cierre en un solo paso — sólo cuando `cash.blind_close` está apagada.
 *
 * GAP: `features/fase-1a-cimientos/spec.md` documenta únicamente el cierre
 * en tres pasos; no lista una ruta de cierre de un solo paso. Este formulario
 * llama a `POST /shifts/{id}/close` (`closeSingleStep` en `api/shifts.ts`),
 * que existe en la implementación de `backend-caja` pero no en el contrato
 * escrito — ver la nota en `api/shifts.ts` y el detalle en el entregable de
 * este agente. Como no hay un paso de revisión previo, no se muestra ningún
 * esperado antes de mandar el conteo; recién en la pantalla de resultado
 * (después de que el servidor cierra el turno) aparecen `expected` y
 * `difference` — ambos calculados por el servidor.
 *
 * Caso restante (iteración 2, ajuste del Maestro): una tablet con flags
 * viejos puede llegar acá aunque la sede ya tenga `cash.blind_close`
 * encendida. El servidor lo rechaza con `400 BLIND_CLOSE_REQUIRED`
 * (`error.feature === "cash.blind_close"`) — acá NO se reintenta el POST:
 * se muestra el `message` del servidor tal cual y se dispara `refresh()` de
 * `useSession()` (vuelve a pedir `GET /auth/me`) para que `me.features` se
 * actualice y `ShiftPage` cambie de `SingleStepCloseForm` a `CloseWizard`
 * en el próximo render.
 *
 * **Iteración 3 (H-8)**: mismo agregado que `CloseWizard` — al lado del
 * campo de propinas se muestra, como REFERENCIA de sólo lectura, el
 * `cash_out` de `GET /shifts/{id}/tips` (`useShiftTips`).
 */
export function SingleStepCloseForm({ shiftId }: { shiftId: number }): React.JSX.Element {
  const queryClient = useQueryClient();
  const { refresh } = useSession();

  const [counted, setCounted] = useState<Denomination[]>(emptyDenominations());
  const [countedCard, setCountedCard] = useState<number | null>(null);
  const [countedTransfer, setCountedTransfer] = useState<number | null>(null);
  const [tipsCashOut, setTipsCashOut] = useState<number | null>(0);
  const [photo, setPhoto] = useState<string | null>(null);
  const [photoRequired, setPhotoRequired] = useState(false);
  const [cause, setCause] = useState<CashDifferenceCause | "">("");
  const [note, setNote] = useState("");
  const [closesDay, setClosesDay] = useState(false);
  // El cierre en un solo paso no sabe de antemano cuántas comandas quedaron
  // abiertas: se entera por `400 OPEN_ORDERS_EXIST`. Recién ahí ofrece
  // trasladarlas — que es lo que el propio mensaje del servidor pide y hasta
  // ahora ninguna pantalla sabía hacer.
  const [openOrders, setOpenOrders] = useState(0);
  const [transferOpenOrders, setTransferOpenOrders] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ to_deposit?: number; closes_day?: boolean; expected?: number; difference?: number } | null>(
    null,
  );

  const idempotencyKeyRef = useRef(newIdempotencyKey());

  // Iteración 3 (H-8): misma referencia de sólo lectura que `CloseWizard` —
  // ver el comentario ahí. `cash_out` se pinta tal cual llega.
  const tipsQuery = useShiftTips(shiftId);

  const mutation = useMutation({
    mutationFn: () => {
      const total = counted.reduce((acc, d) => acc + d.value * d.count, 0);
      return closeSingleStep(
        shiftId,
        {
          counted_cash: { denominations: counted, total },
          counted_card: countedCard,
          counted_transfer: countedTransfer,
          tips_cash_out: tipsCashOut ?? 0,
          photo,
          cause: cause === "" ? undefined : cause,
          note: note.trim() === "" ? undefined : note.trim(),
          closes_day: closesDay,
          transfer_open_orders: transferOpenOrders,
        },
        idempotencyKeyRef.current,
      );
    },
    onSuccess: (out) => {
      setResult(out);
      setError(null);
      toast.success("Turno cerrado.");
      void queryClient.invalidateQueries({ queryKey: CURRENT_SHIFT_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: shiftSummaryQueryKey(shiftId) });
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === "BLIND_CLOSE_REQUIRED") {
        // La sede prendió "cierre a ciegas" mientras esta pantalla estaba
        // abierta (tablet con flags viejos): NO se reintenta el POST acá —
        // se muestra el mensaje del servidor y se refresca la sesión para
        // que `ShiftPage` cambie al wizard en cuanto `me.features` llegue.
        setError(errorMessage(err));
        void refresh();
        return;
      }
      if (
        err instanceof ApiError &&
        (err.code === "PHOTO_REQUIRED" ||
          err.code === "CAUSE_REQUIRED" ||
          err.code === "IDENTIFIED_CAUSE_REQUIRED" ||
          err.code === "OPEN_ORDERS_EXIST")
      ) {
        if (err.code === "PHOTO_REQUIRED") setPhotoRequired(true);
        if (err.code === "OPEN_ORDERS_EXIST") {
          const cuantas = err.extra?.open_orders;
          setOpenOrders(typeof cuantas === "number" && cuantas > 0 ? cuantas : 1);
        }
        // El próximo intento va a llevar un campo más: clave nueva.
        idempotencyKeyRef.current = newIdempotencyKey();
      }
      setError(errorMessage(err));
    },
  });

  if (result) {
    return (
      <div className="space-y-2 rounded-md border p-4">
        <p className="text-lg font-semibold">Turno cerrado.</p>
        <p className="text-sm text-muted-foreground">Esperado: {formatCOP(result.expected)}</p>
        <p className="text-sm text-muted-foreground">Diferencia: {formatCOP(result.difference)}</p>
        <p className="text-sm text-muted-foreground">
          A consignar: <span className="font-medium text-foreground">{formatCOP(result.to_deposit)}</span>
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        Este cierre es en un solo paso porque «cierre a ciegas» está apagado en esta sede.
      </p>
      <DenominationsInput value={counted} onChange={setCounted} legend="Efectivo contado" />
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="space-y-1">
          <Label htmlFor="single-close-card">Datáfono contado</Label>
          <MoneyInput id="single-close-card" value={countedCard} onChange={setCountedCard} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="single-close-transfer">Transferencias contadas</Label>
          <MoneyInput id="single-close-transfer" value={countedTransfer} onChange={setCountedTransfer} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="single-close-tips">Propinas en efectivo retiradas</Label>
          <MoneyInput id="single-close-tips" value={tipsCashOut} onChange={setTipsCashOut} />
          <p className="text-xs text-muted-foreground">
            Referencia del sistema (no se usa para calcular nada acá): lo que el sistema calcula que sale del
            cajón como propina es {formatCOP(tipsQuery.data?.cash_out)}.
          </p>
        </div>
      </div>
      <PhotoCaptureField value={photo} onChange={setPhoto} required={photoRequired} />
      <div className="space-y-1">
        <Label htmlFor="single-close-cause">Causa de la diferencia (si hubo)</Label>
        <Select value={cause || undefined} onValueChange={(v) => setCause(v as CashDifferenceCause)}>
          <SelectTrigger id="single-close-cause" className="h-11 w-full">
            <SelectValue placeholder="Sin diferencia / elegí una causa" />
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
        <Label htmlFor="single-close-note">Nota</Label>
        <Textarea id="single-close-note" value={note} onChange={(event) => setNote(event.target.value)} />
      </div>
      {openOrders > 0 ? (
        <label className="flex items-start gap-2 rounded-md border border-dashed p-3 text-sm">
          <Checkbox
            checked={transferOpenOrders}
            onCheckedChange={(checked) => setTransferOpenOrders(Boolean(checked))}
          />
          <span>
            Trasladar al turno siguiente {openOrders === 1 ? "la comanda abierta" : `las ${openOrders} comandas abiertas`}
            <span className="block text-muted-foreground">
              Quedan a la espera y las adopta quien abra el próximo turno.
            </span>
          </span>
        </label>
      ) : null}
      <label className="flex items-center gap-2 text-sm">
        <Checkbox checked={closesDay} onCheckedChange={(checked) => setClosesDay(Boolean(checked))} />
        Este cierre también cierra el día operativo
      </label>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <Button type="button" className="h-11" disabled={mutation.isPending} onClick={() => mutation.mutate()}>
        {mutation.isPending ? "Cerrando…" : "Cerrar turno"}
      </Button>
    </div>
  );
}
