import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { toast } from "sonner";

import { ApiError, newIdempotencyKey } from "@/api/client";
import {
  closeCount,
  confirmClose,
  getCloseReview,
  type CashDifferenceCause,
  type CloseReview,
} from "@/api/shifts";
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

type Step = 1 | 2 | 3 | "done";

/**
 * Cierre a ciegas en tres pasos (`cash.blind_close`, spec § "Business day &
 * shifts"): el paso 1 **nunca** muestra ni pide el esperado, y no dispara
 * ningún pedido de review antes de tener `count_id` (por eso `getCloseReview`
 * vive en un `useQuery` con `enabled: step === 2`, nunca en un `useEffect`
 * disparado por otra cosa). El paso 3 manda `difference_seen` exactamente
 * como lo mostró el paso 2; si el servidor responde `400 DIFFERENCE_CHANGED`
 * vuelve al paso 2 con la review nueva que trae el propio error.
 *
 * **Iteración 3 (H-8)**: al lado del campo de propinas del paso 1 se
 * muestra, como REFERENCIA de sólo lectura, `cash_out` de `GET
 * /shifts/{id}/tips` (`useShiftTips`) — lo que el servidor calcula que sale
 * del cajón como propina. No se usa para calcular ni validar
 * `tipsCashOut`: sólo se pinta.
 */
export function CloseWizard({ shiftId }: { shiftId: number }): React.JSX.Element {
  const queryClient = useQueryClient();

  const [step, setStep] = useState<Step>(1);
  const [countId, setCountId] = useState<number | null>(null);

  // Paso 1
  const [counted, setCounted] = useState<Denomination[]>(emptyDenominations());
  const [countedCard, setCountedCard] = useState<number | null>(null);
  const [countedTransfer, setCountedTransfer] = useState<number | null>(null);
  const [tipsCashOut, setTipsCashOut] = useState<number | null>(0);
  const [photo, setPhoto] = useState<string | null>(null);
  const [photoRequired, setPhotoRequired] = useState(false);
  const [step1Error, setStep1Error] = useState<string | null>(null);

  // Paso 3
  const [manualReview, setManualReview] = useState<CloseReview | null>(null);
  const [cause, setCause] = useState<CashDifferenceCause | "">("");
  const [note, setNote] = useState("");
  const [closesDay, setClosesDay] = useState(false);
  const [closesDayTouched, setClosesDayTouched] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [result, setResult] = useState<{ to_deposit?: number; closes_day?: boolean } | null>(null);

  const step1KeyRef = useRef(newIdempotencyKey());

  // Iteración 3 (H-8): sólo REFERENCIA de sólo lectura junto al campo de
  // propinas — `GET /shifts/{id}/tips` es alcanzable con sesión de
  // dispositivo (`app/shifts/router.py:339` usa `current_actor`, admite
  // device con persona identificada). `cash_out` se pinta tal cual llega,
  // nunca se suma ni se resta contra `tipsCashOut`.
  const tipsQuery = useShiftTips(shiftId);

  const countMutation = useMutation({
    mutationFn: () => {
      const total = counted.reduce((acc, d) => acc + d.value * d.count, 0);
      return closeCount(
        shiftId,
        {
          counted_cash: { denominations: counted, total },
          counted_card: countedCard,
          counted_transfer: countedTransfer,
          tips_cash_out: tipsCashOut ?? 0,
          photo,
        },
        step1KeyRef.current,
      );
    },
    onSuccess: (out) => {
      if (out.count_id === undefined) {
        setStep1Error("El servidor no devolvió el conteo. Intentá de nuevo.");
        return;
      }
      setCountId(out.count_id);
      setStep1Error(null);
      setStep(2);
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === "PHOTO_REQUIRED") {
        setPhotoRequired(true);
        step1KeyRef.current = newIdempotencyKey();
      }
      setStep1Error(errorMessage(err));
    },
  });

  // El único pedido que puede revelar el esperado: SOLO se dispara cuando ya
  // existe `countId` (paso 2 en adelante), nunca antes.
  const reviewQuery = useQuery({
    queryKey: ["shifts", "close-review", shiftId, countId],
    queryFn: () => getCloseReview(shiftId, countId as number),
    enabled: countId !== null && step === 2,
  });

  const review = manualReview ?? reviewQuery.data ?? null;

  function goToStep3() {
    if (!review) return;
    setCause("");
    setNote("");
    setClosesDay(Boolean(review.closes_day_suggested));
    setClosesDayTouched(false);
    setConfirmError(null);
    setStep(3);
  }

  const confirmMutation = useMutation({
    mutationFn: () => {
      if (countId === null || !review || review.difference === undefined) {
        throw new Error("Todavía no hay una revisión del cierre para confirmar.");
      }
      return confirmClose(shiftId, countId, {
        difference_seen: review.difference,
        cause: cause === "" ? undefined : cause,
        note: note.trim() === "" ? undefined : note.trim(),
        closes_day: closesDay,
        transfer_open_orders: false,
      });
    },
    onSuccess: (out) => {
      setResult(out);
      setStep("done");
      setConfirmError(null);
      void queryClient.invalidateQueries({ queryKey: CURRENT_SHIFT_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: shiftSummaryQueryKey(shiftId) });
      toast.success("Turno cerrado.");
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === "DIFFERENCE_CHANGED") {
        const newReview = err.extra.review as CloseReview | undefined;
        if (newReview) {
          setManualReview(newReview);
          setStep(2);
          toast.error("La diferencia cambió: revisá el resumen actualizado.");
          return;
        }
      }
      setConfirmError(errorMessage(err));
    },
  });

  if (step === "done") {
    return (
      <div className="space-y-2 rounded-md border p-4">
        <p className="text-lg font-semibold">Turno cerrado.</p>
        <p className="text-sm text-muted-foreground">
          A consignar: <span className="font-medium text-foreground">{formatCOP(result?.to_deposit)}</span>
        </p>
        <p className="text-sm text-muted-foreground">
          {result?.closes_day ? "Este cierre también cerró el día operativo." : "El día operativo sigue abierto (otro turno lo cierra)."}
        </p>
      </div>
    );
  }

  if (step === 1) {
    return (
      <div className="space-y-6">
        <p className="text-sm text-muted-foreground">
          Contá sin mirar lo esperado: el sistema lo revela recién en el paso siguiente.
        </p>
        <DenominationsInput value={counted} onChange={setCounted} legend="Efectivo contado" />
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-1">
            <Label htmlFor="close-card">Datáfono contado</Label>
            <MoneyInput id="close-card" value={countedCard} onChange={setCountedCard} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="close-transfer">Transferencias contadas</Label>
            <MoneyInput id="close-transfer" value={countedTransfer} onChange={setCountedTransfer} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="close-tips">Propinas en efectivo retiradas</Label>
            <MoneyInput id="close-tips" value={tipsCashOut} onChange={setTipsCashOut} />
            <p className="text-xs text-muted-foreground">
              Referencia del sistema (no se usa para calcular nada acá): lo que el sistema calcula que sale del
              cajón como propina es {formatCOP(tipsQuery.data?.cash_out)}.
            </p>
          </div>
        </div>
        <PhotoCaptureField value={photo} onChange={setPhoto} required={photoRequired} />
        {step1Error ? (
          <p role="alert" className="text-sm text-destructive">
            {step1Error}
          </p>
        ) : null}
        <Button type="button" className="h-11" disabled={countMutation.isPending} onClick={() => countMutation.mutate()}>
          {countMutation.isPending ? "Congelando conteo…" : "Continuar"}
        </Button>
      </div>
    );
  }

  if (step === 2) {
    if (reviewQuery.isLoading && !manualReview) {
      return <p className="text-sm text-muted-foreground">Calculando el esperado…</p>;
    }
    if (reviewQuery.isError && !manualReview) {
      return (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(reviewQuery.error)}
        </p>
      );
    }
    if (!review) {
      return <p className="text-sm text-muted-foreground">Sin datos de revisión todavía.</p>;
    }
    return (
      <div className="space-y-4">
        <div className="grid gap-3 rounded-md border p-4 sm:grid-cols-2">
          <div>
            <p className="text-sm text-muted-foreground">Esperado</p>
            <p className="text-lg font-semibold tabular-nums">{formatCOP(review.expected)}</p>
          </div>
          <div>
            <p className="text-sm text-muted-foreground">Diferencia</p>
            <p className="text-lg font-semibold tabular-nums">{formatCOP(review.difference)}</p>
          </div>
        </div>
        <dl className="grid grid-cols-2 gap-2 rounded-md border bg-muted/30 p-3 text-sm sm:grid-cols-5">
          <div>
            <dt className="text-muted-foreground">Base</dt>
            <dd className="tabular-nums">{formatCOP(review.equation?.base)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Ventas efectivo</dt>
            <dd className="tabular-nums">{formatCOP(review.equation?.cash_sales)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Ingresos</dt>
            <dd className="tabular-nums">{formatCOP(review.equation?.incomes)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Egresos</dt>
            <dd className="tabular-nums">{formatCOP(review.equation?.expenses)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Retiros</dt>
            <dd className="tabular-nums">{formatCOP(review.equation?.pickups)}</dd>
          </div>
        </dl>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-md border p-3 text-sm">
            <p className="font-medium">Datáfono</p>
            <p className="text-muted-foreground">
              Registrado {formatCOP(review.card?.registered)} · Contado {formatCOP(review.card?.counted)} · Diferencia{" "}
              {formatCOP(review.card?.difference)}
            </p>
          </div>
          <div className="rounded-md border p-3 text-sm">
            <p className="font-medium">Transferencias</p>
            <p className="text-muted-foreground">
              Registrado {formatCOP(review.transfer?.registered)} · Contado {formatCOP(review.transfer?.counted)} ·
              Diferencia {formatCOP(review.transfer?.difference)}
            </p>
          </div>
        </div>
        {review.is_critical ? (
          <p role="alert" className="rounded-md bg-destructive/10 p-2 text-sm font-medium text-destructive">
            Diferencia crítica: se va a notificar al administrador.
          </p>
        ) : null}
        <Button type="button" className="h-11" onClick={goToStep3}>
          Continuar
        </Button>
      </div>
    );
  }

  // step === 3
  if (!review) {
    return <p className="text-sm text-muted-foreground">Volvé al paso anterior: no hay revisión cargada.</p>;
  }
  const requiresCause = Boolean(review.requires_cause);
  const requiresIdentified = Boolean(review.requires_identified_cause);
  const causeOptions = requiresIdentified
    ? (Object.entries(CAUSE_LABEL).filter(([value]) => value !== "unknown") as [CashDifferenceCause, string][])
    : (Object.entries(CAUSE_LABEL) as [CashDifferenceCause, string][]);

  return (
    <div className="space-y-4">
      <div className="rounded-md border p-3 text-sm">
        <p>
          Diferencia a confirmar: <span className="font-medium tabular-nums">{formatCOP(review.difference)}</span>
        </p>
      </div>

      {requiresCause ? (
        <div className="space-y-3">
          {requiresIdentified ? (
            <p role="alert" className="text-sm font-medium text-destructive">
              La diferencia supera la tolerancia de causa desconocida: elegí una causa identificada.
            </p>
          ) : null}
          <div className="space-y-1">
            <Label htmlFor="close-cause">Causa</Label>
            <Select value={cause || undefined} onValueChange={(v) => setCause(v as CashDifferenceCause)}>
              <SelectTrigger id="close-cause" className="h-11 w-full">
                <SelectValue placeholder="Elegí una causa" />
              </SelectTrigger>
              <SelectContent>
                {causeOptions.map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="close-cause-note">Nota</Label>
            <Textarea id="close-cause-note" value={note} onChange={(event) => setNote(event.target.value)} />
          </div>
        </div>
      ) : null}

      <label className="flex items-center gap-2 text-sm">
        <Checkbox
          checked={closesDay}
          onCheckedChange={(checked) => {
            setClosesDay(Boolean(checked));
            setClosesDayTouched(true);
          }}
        />
        Este cierre también cierra el día operativo
        {!closesDayTouched && review.closes_day_suggested ? " (sugerido)" : ""}
      </label>

      {confirmError ? (
        <p role="alert" className="text-sm text-destructive">
          {confirmError}
        </p>
      ) : null}

      <Button
        type="button"
        className="h-11"
        disabled={confirmMutation.isPending || (requiresCause && cause === "")}
        onClick={() => confirmMutation.mutate()}
      >
        {confirmMutation.isPending ? "Cerrando…" : "Confirmar cierre"}
      </Button>
    </div>
  );
}
