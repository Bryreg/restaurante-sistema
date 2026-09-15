import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { toast } from "sonner";

import { useSession } from "@/app/session";
import { ApiError, newIdempotencyKey } from "@/api/client";
import { openShift, type CashDifferenceCause, type OpenShiftIn } from "@/api/shifts";
import { Button } from "@/components/ui/button";
import { DenominationsInput, type Denomination } from "@/components/DenominationsInput";
import { EmployeePicker } from "@/components/EmployeePicker";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { errorMessage } from "@/lib/errors";
import { DENOMINATIONS } from "@/lib/money";
import { MoneyInput } from "@/components/MoneyInput";

import { CURRENT_SHIFT_QUERY_KEY } from "./hooks";

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
 * Abrir turno (spec § "Business day & shifts", `POST /shifts/open`): base
 * fija contada por denominaciones, responsable de caja (por defecto quien
 * opera), y reserva aparte sólo si `cash.reserve` está encendida. La causa
 * de la diferencia **no se calcula acá**: se manda sin causa y, si el
 * servidor responde `400 OPENING_DIFFERENCE_NEEDS_CAUSE`, recién ahí se
 * pide — con una `Idempotency-Key` nueva, porque el cuerpo cambió.
 */
export function OpenShiftForm(): React.JSX.Element {
  const { me, hasFeature } = useSession();
  const queryClient = useQueryClient();
  const showReserve = hasFeature("cash.reserve");

  const [denominations, setDenominations] = useState<Denomination[]>(emptyDenominations());
  const [reserve, setReserve] = useState<number | null>(0);
  const [responsibleId, setResponsibleId] = useState<number | null>(
    me?.kind === "device" && me.employee ? me.employee.id : null,
  );
  const [needsCause, setNeedsCause] = useState(false);
  const [cause, setCause] = useState<CashDifferenceCause | "">("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  const idempotencyKeyRef = useRef(newIdempotencyKey());

  const total = denominations.reduce((acc, d) => acc + d.value * d.count, 0);
  const responsibleValid = responsibleId !== null;

  const mutation = useMutation({
    mutationFn: (body: OpenShiftIn) => openShift(body, idempotencyKeyRef.current),
    onSuccess: () => {
      toast.success("Turno abierto.");
      void queryClient.invalidateQueries({ queryKey: CURRENT_SHIFT_QUERY_KEY });
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === "OPENING_DIFFERENCE_NEEDS_CAUSE") {
        setNeedsCause(true);
        // El cuerpo del próximo intento va a llevar causa: es un intento
        // distinto, no un reintento de red del mismo — clave nueva.
        idempotencyKeyRef.current = newIdempotencyKey();
      }
      setError(errorMessage(err));
    },
  });

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!responsibleValid) {
      setError("Ingresá quién es el responsable de caja.");
      return;
    }
    setError(null);
    mutation.mutate({
      opening_cash: { denominations, total },
      cash_reserve: showReserve ? reserve ?? 0 : undefined,
      cash_responsible_id: responsibleId as number,
      opening_cause: needsCause && cause !== "" ? cause : undefined,
      opening_note: needsCause && note.trim() !== "" ? note.trim() : undefined,
    });
  }

  return (
    <form onSubmit={handleSubmit} className="mx-auto max-w-xl space-y-6">
      <div className="space-y-1">
        <h1 className="text-lg font-semibold">Abrir turno</h1>
        <p className="text-sm text-muted-foreground">
          Contá la base fija por denominaciones antes de empezar a operar.
        </p>
      </div>

      <DenominationsInput value={denominations} onChange={setDenominations} legend="Base contada" />

      {showReserve ? (
        <div className="space-y-1">
          <Label htmlFor="open-reserve">Reserva de caja</Label>
          <MoneyInput id="open-reserve" value={reserve} onChange={setReserve} />
          <p className="text-xs text-muted-foreground">
            Plata de emergencia en el cajón: no entra al cuadre ni al esperado.
          </p>
        </div>
      ) : null}

      <div className="space-y-2">
        <p className="text-sm font-medium">Responsable de caja</p>
        <EmployeePicker
          value={responsibleId}
          onChange={(id) => setResponsibleId(id)}
          label="Responsable de caja"
          disabled={mutation.isPending}
        />
        <p className="text-xs text-muted-foreground">
          Por defecto, quien está identificado ahora. Cambialo si otra persona va a responder por la caja.
        </p>
      </div>

      {needsCause ? (
        <div className="space-y-3 rounded-md border border-destructive/40 bg-destructive/5 p-3">
          <p className="text-sm font-medium text-destructive">
            La base contada no coincide con la base fija: elegí una causa para poder abrir.
          </p>
          <div className="space-y-1">
            <Label htmlFor="open-cause">Causa</Label>
            <Select value={cause || undefined} onValueChange={(v) => setCause(v as CashDifferenceCause)}>
              <SelectTrigger id="open-cause" className="h-11 w-full">
                <SelectValue placeholder="Elegí una causa" />
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
            <Label htmlFor="open-note">Nota</Label>
            <Textarea id="open-note" value={note} onChange={(event) => setNote(event.target.value)} />
          </div>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <Button type="submit" className="h-11 w-full" disabled={mutation.isPending}>
        {mutation.isPending ? "Abriendo…" : "Abrir turno"}
      </Button>
    </form>
  );
}
