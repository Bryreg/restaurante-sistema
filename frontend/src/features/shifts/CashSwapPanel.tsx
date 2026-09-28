import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowDownToLine, ArrowUpFromLine, CircleCheck, Minus, Plus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { createCashSwap, previewCashSwap } from "@/api/shifts";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/errors";
import { formatCOP } from "@/lib/money";
import { cn } from "@/lib/utils";

import { shiftSummaryQueryKey } from "./hooks";

/** Lo que el cliente trae para cambiar: el billete grande. */
const ENTRA = [100_000, 50_000, 20_000] as const;
/** Lo que sale del cajón: el sencillo, de mayor a menor. */
const SALE = [50_000, 20_000, 10_000, 5_000] as const;

type Conteo = Record<number, number>;

function piezas(conteo: Conteo): { value: number; count: number }[] {
  return Object.entries(conteo)
    .map(([value, count]) => ({ value: Number(value), count }))
    .filter((d) => d.count > 0);
}

/**
 * Cambio de denominaciones (`cash.swaps`, `POST /shifts/{id}/cash-swaps`),
 * como lo dibuja el handoff (`PosMesas`, hoja «Cambio»): arriba el billete
 * grande que **entra** a la caja (un toque por billete), abajo el sencillo que
 * **sale** con −/+ de 56 px, y el cuadre «Entra $ 100.000 · sale $ 100.000 ·
 * cuadra».
 *
 * **Las dos sumas las hace el servidor** (`POST /cash-swaps/preview`, la
 * misma matemática que valida el registro): esta pantalla sólo cuenta
 * billetes. «Registrar cambio» se habilita cuando el servidor dice que cuadra,
 * y manda los totales que el servidor devolvió. Canje neto cero: no cambia
 * el esperado, y si igual no cuadrara el registro responde `SWAP_NOT_ZERO`,
 * que se muestra tal cual.
 */
export function CashSwapPanel({ shiftId }: { shiftId: number }): React.JSX.Element {
  const queryClient = useQueryClient();
  const [entra, setEntra] = useState<Conteo>({});
  const [sale, setSale] = useState<Conteo>({});
  const [error, setError] = useState<string | null>(null);

  const cuerpo = { in: piezas(entra), out: piezas(sale) };
  const hayAlgo = cuerpo.in.length > 0 || cuerpo.out.length > 0;
  const cuadre = useQuery({
    queryKey: ["cash-swaps", "preview", cuerpo],
    queryFn: () => previewCashSwap(cuerpo),
    enabled: hayAlgo,
    placeholderData: keepPreviousData,
    staleTime: Infinity,
  });
  // Mientras llega la respuesta de lo último tocado, la anterior no habilita
  // nada: no se registra sobre un cuadre viejo.
  const vigente = hayAlgo && !cuadre.isPlaceholderData ? cuadre.data : undefined;

  const mutation = useMutation({
    mutationFn: () => {
      if (!vigente) throw new Error("Esperá el cuadre del cambio.");
      return createCashSwap(shiftId, {
        out: { denominations: cuerpo.out, total: vigente.out_total },
        in: { denominations: cuerpo.in, total: vigente.in_total },
      });
    },
    onSuccess: () => {
      toast.success("Cambio registrado.");
      setEntra({});
      setSale({});
      setError(null);
      void queryClient.invalidateQueries({ queryKey: shiftSummaryQueryKey(shiftId) });
    },
    onError: (err) => setError(errorMessage(err)),
  });

  function sumar(set: typeof setEntra, value: number, delta: number) {
    set((prev) => ({ ...prev, [value]: Math.max(0, (prev[value] ?? 0) + delta) }));
  }

  return (
    <div className="flex min-h-full flex-col gap-4">
      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <h3 className="flex items-center gap-1.5 text-[16px] font-bold">
            <ArrowDownToLine className="size-[18px]" aria-hidden="true" />
            Entra a la caja
          </h3>
          {cuerpo.in.length > 0 ? (
            <Button type="button" variant="ghost" className="h-11 px-2 text-[14px]" onClick={() => setEntra({})}>
              Volver a elegir
            </Button>
          ) : null}
        </div>
        <div className="grid grid-cols-3 gap-2" role="group" aria-label="Entra a la caja">
          {ENTRA.map((value) => {
            const n = entra[value] ?? 0;
            return (
              <button
                key={value}
                type="button"
                aria-label={`Entra un billete de ${formatCOP(value)}${n > 0 ? `, van ${n}` : ""}`}
                className={cn(
                  "flex h-[64px] flex-col items-center justify-center rounded-lg border-2 transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                  n > 0 ? "border-primary bg-accent" : "border-border bg-background hover:bg-muted",
                )}
                onClick={() => sumar(setEntra, value, 1)}
              >
                <b className="text-[18px] tabular-nums">{formatCOP(value)}</b>
                <span className="text-[13px] text-muted-foreground">
                  {n === 0 ? "—" : `${n} ${n === 1 ? "billete" : "billetes"}`}
                </span>
              </button>
            );
          })}
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="flex items-center gap-1.5 text-[16px] font-bold">
          <ArrowUpFromLine className="size-[18px]" aria-hidden="true" />
          Sale de la caja
        </h3>
        {SALE.map((value) => {
          const n = sale[value] ?? 0;
          return (
            <div key={value} className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                className="size-[56px] rounded-[10px] [&_svg]:size-5"
                aria-label={`Una menos de ${formatCOP(value)}`}
                disabled={n === 0}
                onClick={() => sumar(setSale, value, -1)}
              >
                <Minus aria-hidden="true" />
              </Button>
              <div className="flex h-[56px] flex-1 items-center justify-between rounded-[10px] border px-3.5">
                <b className="text-[17px] tabular-nums">{formatCOP(value)}</b>
                <b className="text-[24px] tabular-nums">
                  {n}
                </b>
              </div>
              <Button
                type="button"
                variant="outline"
                className="size-[56px] rounded-[10px] [&_svg]:size-5"
                aria-label={`Una más de ${formatCOP(value)}`}
                onClick={() => sumar(setSale, value, 1)}
              >
                <Plus aria-hidden="true" />
              </Button>
            </div>
          );
        })}
      </section>

      {vigente && cuerpo.in.length > 0 && cuerpo.out.length > 0 ? (
        <p
          role="status"
          className={cn(
            "flex items-center gap-2.5 rounded-lg border px-3.5 py-3 text-[16px] font-semibold",
            vigente.balanced ? "border-success bg-success/12" : "border-warning bg-warning/15",
          )}
        >
          {vigente.balanced ? (
            <CircleCheck className="size-[22px] shrink-0 text-success" aria-hidden="true" />
          ) : (
            <AlertTriangle className="size-[22px] shrink-0 text-warning" aria-hidden="true" />
          )}
          Entra {formatCOP(vigente.in_total)} · sale {formatCOP(vigente.out_total)} ·{" "}
          {vigente.balanced ? "cuadra" : "no cuadra"}
        </p>
      ) : (
        <p className="text-[15px] text-muted-foreground">
          Tocá el billete que entra y el sencillo que sale.
        </p>
      )}

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <div className="sticky bottom-0 mt-auto -mx-4 -mb-4 border-t bg-card p-3">
        <Button
          type="button"
          className="h-[64px] w-full text-[18px] font-bold"
          disabled={mutation.isPending || !vigente?.balanced}
          onClick={() => mutation.mutate()}
        >
          {mutation.isPending ? "Registrando…" : "Registrar cambio"}
        </Button>
      </div>
    </div>
  );
}
