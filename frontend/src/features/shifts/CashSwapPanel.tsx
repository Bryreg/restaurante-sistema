import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

import { createCashSwap } from "@/api/shifts";
import { DenominationsInput, type Denomination } from "@/components/DenominationsInput";
import { Button } from "@/components/ui/button";
import { DENOMINATIONS } from "@/lib/money";
import { errorMessage } from "@/lib/errors";

import { shiftSummaryQueryKey } from "./hooks";

function emptyDenominations(): Denomination[] {
  return DENOMINATIONS.map((value) => ({ value, count: 0 }));
}

/**
 * Cambio de denominaciones (`cash.swaps`, `POST /shifts/{id}/cash-swaps`):
 * canje neto cero, nunca un egreso — no cambia el esperado. El servidor
 * responde `400 SWAP_NOT_ZERO` si lo que sale y lo que entra no suman igual;
 * ese mensaje se muestra tal cual, sin recalcular la diferencia acá.
 */
export function CashSwapPanel({ shiftId }: { shiftId: number }): React.JSX.Element {
  const queryClient = useQueryClient();
  const [out, setOut] = useState<Denomination[]>(emptyDenominations());
  const [inDenoms, setInDenoms] = useState<Denomination[]>(emptyDenominations());
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => {
      const outTotal = out.reduce((acc, d) => acc + d.value * d.count, 0);
      const inTotal = inDenoms.reduce((acc, d) => acc + d.value * d.count, 0);
      return createCashSwap(shiftId, {
        out: { denominations: out, total: outTotal },
        in: { denominations: inDenoms, total: inTotal },
      });
    },
    onSuccess: () => {
      toast.success("Cambio registrado.");
      setOut(emptyDenominations());
      setInDenoms(emptyDenominations());
      setError(null);
      void queryClient.invalidateQueries({ queryKey: shiftSummaryQueryKey(shiftId) });
    },
    onError: (err) => setError(errorMessage(err)),
  });

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        Canje de denominaciones (dar sencilla) con neto cero: no es un ingreso ni un egreso y no
        cambia el efectivo esperado.
      </p>
      <div className="grid gap-6 sm:grid-cols-2">
        <DenominationsInput value={out} onChange={setOut} legend="Sale (se entrega)" />
        <DenominationsInput value={inDenoms} onChange={setInDenoms} legend="Entra (se recibe)" />
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <Button type="button" className="h-11" disabled={mutation.isPending} onClick={() => mutation.mutate()}>
        {mutation.isPending ? "Registrando…" : "Registrar cambio"}
      </Button>
    </div>
  );
}
