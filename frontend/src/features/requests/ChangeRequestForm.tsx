import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

import { createChangeRequest } from "@/api/requests";
import { DenominationsInput, type Denomination } from "@/components/DenominationsInput";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { errorMessage } from "@/lib/errors";

import { fullDenominations, REQUESTS_QUERY_KEYS, typedTotal } from "./lib";

/**
 * Pedido de sencilla: cuántos billetes o monedas de cada denominación, con
 * motivo obligatorio. **No mueve plata**: es un pedido. Cuando el
 * administrador la trae, se registra con el Cambio del turno desde «Mis
 * solicitudes».
 */
export function ChangeRequestForm(): React.JSX.Element {
  const queryClient = useQueryClient();
  const [denoms, setDenoms] = useState<Denomination[]>(fullDenominations(null));
  const [motivo, setMotivo] = useState("");
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () =>
      createChangeRequest({
        denominations: { denominations: denoms.filter((d) => d.count > 0), total: typedTotal(denoms) },
        reason: motivo.trim(),
      }),
    onSuccess: () => {
      toast.success("Pedido de sencilla enviado al administrador.");
      setDenoms(fullDenominations(null));
      setMotivo("");
      setError(null);
      void queryClient.invalidateQueries({ queryKey: REQUESTS_QUERY_KEYS.mine });
    },
    onError: (err) => setError(errorMessage(err)),
  });

  const sinPiezas = denoms.every((d) => d.count === 0);
  const sinMotivo = motivo.trim() === "";

  return (
    <div className="space-y-5">
      <DenominationsInput value={denoms} onChange={setDenoms} legend="Sencilla que necesitás" />
      <div className="space-y-2">
        <Label htmlFor="motivo-sencilla">Motivo</Label>
        <Textarea
          id="motivo-sencilla"
          placeholder="Ej.: se acabaron las monedas de $500"
          value={motivo}
          onChange={(event) => setMotivo(event.target.value)}
        />
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <Button
        type="button"
        className="h-11"
        disabled={mutation.isPending || sinPiezas || sinMotivo}
        onClick={() => mutation.mutate()}
      >
        {mutation.isPending ? "Enviando…" : "Pedir sencilla"}
      </Button>
    </div>
  );
}
