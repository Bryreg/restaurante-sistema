import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

import { markChangeReceived, type StaffRequest } from "@/api/requests";
import { createCashSwap } from "@/api/shifts";
import { DenominationsInput, type Denomination } from "@/components/DenominationsInput";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/errors";
import { formatCOP } from "@/lib/money";
import { shiftSummaryQueryKey } from "@/features/shifts/hooks";

import { fullDenominations, REQUESTS_QUERY_KEYS, typedTotal } from "./lib";

/**
 * Llegó la sencilla aprobada: se registra con **el Cambio que ya existe**
 * (`POST /shifts/{id}/cash-swaps`, neto cero), precargado con lo que el
 * administrador aprobó en «Entra». Quien tiene la caja cuenta lo que
 * entrega a cambio en «Sale». Si el servidor dice que no es neto cero
 * (`SWAP_NOT_ZERO`), el mensaje se muestra tal cual.
 *
 * Sólo cuando el Cambio quedó registrado se marca la solicitud recibida,
 * atada a ese Cambio. Si esa segunda llamada falla, el Cambio ya está hecho:
 * el botón reintenta sólo la marca, nunca un segundo Cambio.
 */
export function ReceiveChangeForm({
  shiftId,
  request,
  onDone,
}: {
  shiftId: number;
  request: StaffRequest;
  onDone: () => void;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const [entra, setEntra] = useState<Denomination[]>(fullDenominations(request.approved_denominations));
  const [sale, setSale] = useState<Denomination[]>(fullDenominations(null));
  const [swapId, setSwapId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: async () => {
      let id = swapId;
      if (id === null) {
        const swap = await createCashSwap(shiftId, {
          out: { denominations: sale.filter((d) => d.count > 0), total: typedTotal(sale) },
          in: { denominations: entra.filter((d) => d.count > 0), total: typedTotal(entra) },
        });
        id = swap.id;
        setSwapId(id);
        void queryClient.invalidateQueries({ queryKey: shiftSummaryQueryKey(shiftId) });
      }
      return markChangeReceived(request.id, id);
    },
    onSuccess: () => {
      toast.success("Sencilla recibida y registrada en el cajón.");
      setError(null);
      void queryClient.invalidateQueries({ queryKey: REQUESTS_QUERY_KEYS.mine });
      onDone();
    },
    onError: (err) => setError(errorMessage(err)),
  });

  return (
    <div className="space-y-4 rounded-lg border p-3">
      <p className="text-sm text-muted-foreground">
        Aprobado: {formatCOP(request.approved_total)}. Es un Cambio neto cero: no es un ingreso y no cambia
        el efectivo esperado.
      </p>
      {swapId === null ? (
        <div className="grid gap-6 sm:grid-cols-2">
          <DenominationsInput value={sale} onChange={setSale} legend="Sale (se entrega)" columns={1} />
          <DenominationsInput value={entra} onChange={setEntra} legend="Entra (se recibe)" columns={1} />
        </div>
      ) : (
        <p className="text-sm">El Cambio ya quedó registrado; falta marcar la sencilla como recibida.</p>
      )}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <Button type="button" className="h-11" disabled={mutation.isPending} onClick={() => mutation.mutate()}>
        {mutation.isPending
          ? "Registrando…"
          : swapId === null
            ? "Registrar cambio y marcar recibida"
            : "Marcar recibida"}
      </Button>
    </div>
  );
}
