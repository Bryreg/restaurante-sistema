import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { toast } from "sonner";

import { newIdempotencyKey } from "@/api/client";
import { createHandover, type FrozenBreakdown, type Handover, type HandoverKind } from "@/api/shifts";
import { EmptyState } from "@/components/EmptyState";
import { DenominationsInput, type Denomination } from "@/components/DenominationsInput";
import { MoneyInput } from "@/components/MoneyInput";
import { PinPad } from "@/components/PinPad";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatInstant } from "@/lib/businessDate";
import { errorMessage } from "@/lib/errors";
import { DENOMINATIONS, formatCOP } from "@/lib/money";

import { PhotoCaptureField } from "./PhotoCaptureField";
import { CURRENT_SHIFT_QUERY_KEY, shiftSummaryQueryKey, useShiftSummary } from "./hooks";

function emptyDenominations(): Denomination[] {
  return DENOMINATIONS.map((value) => ({ value, count: 0 }));
}

const BREAKDOWN_LABEL: Record<string, string> = {
  base: "Base",
  cash_sales: "Ventas en efectivo",
  incomes: "Ingresos",
  expenses: "Egresos",
  pickups: "Retiros",
  expected: "Esperado",
  counted: "Contado",
  difference: "Diferencia",
};

function BreakdownCard({ breakdown }: { breakdown: FrozenBreakdown | null | undefined }) {
  // `!breakdown` cubre tanto `undefined` (campo ausente en un backend viejo)
  // como `null` (el servidor lo oculta a propósito porque quien mira no es
  // el responsable de caja ni admin) — en los dos casos no se muestra nada,
  // nunca "$0" ni "NaN".
  if (!breakdown) return null;
  const entries = Object.entries(BREAKDOWN_LABEL).filter(([key]) => breakdown[key as keyof FrozenBreakdown] !== undefined);
  if (entries.length === 0) return null;
  return (
    <dl className="grid grid-cols-2 gap-2 rounded-md border bg-muted/30 p-3 text-sm sm:grid-cols-4">
      {entries.map(([key, label]) => (
        <div key={key}>
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="tabular-nums font-medium">{formatCOP(breakdown[key as keyof FrozenBreakdown] as number)}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Relevo y arqueo sorpresa (`cash.handovers`, `POST /shifts/{id}/handovers`):
 * el relevo cambia de responsable, el arqueo sorpresa cuenta con PIN de
 * administrador sin cambiar a nadie. El desglose congelado que devuelve el
 * servidor (`breakdown`) se muestra tal cual — nunca se recalcula.
 *
 * GAP compartido: elegir el "nuevo responsable" en un relevo pide su número
 * de empleado a mano (no hay ruta de dispositivo que liste el personal —
 * ver `RosterPanel` y `DeviceIdentifyPage`).
 */
export function HandoverPanel({ shiftId }: { shiftId: number }): React.JSX.Element {
  const queryClient = useQueryClient();
  const summary = useShiftSummary(shiftId);

  const [kind, setKind] = useState<HandoverKind>("handover");
  const [counted, setCounted] = useState<Denomination[]>(emptyDenominations());
  const [countedCard, setCountedCard] = useState<number | null>(null);
  const [countedTransfer, setCountedTransfer] = useState<number | null>(null);
  const [newResponsibleId, setNewResponsibleId] = useState("");
  const [handoverPin, setHandoverPin] = useState("");
  const [photo, setPhoto] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<Handover | null>(null);

  const idempotencyKeyRef = useRef(newIdempotencyKey());

  const mutation = useMutation({
    mutationFn: (authorizerPin?: string) => {
      const total = counted.reduce((acc, d) => acc + d.value * d.count, 0);
      const responsibleIdNumber = Number(newResponsibleId);
      return createHandover(
        shiftId,
        {
          kind,
          counted_cash: { denominations: counted, total },
          counted_card: countedCard,
          counted_transfer: countedTransfer,
          new_responsible_id: kind === "handover" ? responsibleIdNumber : undefined,
          authorizer_pin: authorizerPin,
          photo,
        },
        idempotencyKeyRef.current,
      );
    },
    onSuccess: (result) => {
      toast.success(kind === "handover" ? "Relevo registrado." : "Arqueo sorpresa registrado.");
      setLastResult(result);
      setError(null);
      setCounted(emptyDenominations());
      setCountedCard(null);
      setCountedTransfer(null);
      setNewResponsibleId("");
      setHandoverPin("");
      setPhoto(null);
      idempotencyKeyRef.current = newIdempotencyKey();
      void queryClient.invalidateQueries({ queryKey: shiftSummaryQueryKey(shiftId) });
      void queryClient.invalidateQueries({ queryKey: CURRENT_SHIFT_QUERY_KEY });
    },
    onError: (err) => setError(errorMessage(err)),
  });

  const responsibleIdNumber = Number(newResponsibleId);
  const responsibleValid = kind !== "handover" || (newResponsibleId.trim() !== "" && Number.isInteger(responsibleIdNumber) && responsibleIdNumber > 0);

  function handleContinue() {
    setError(null);
    if (!responsibleValid) {
      setError("Ingresá el número de empleado del nuevo responsable.");
      return;
    }
    if (kind === "handover") {
      // El PIN de autorización es opcional en un relevo normal.
      mutation.mutate(handoverPin.trim() === "" ? undefined : handoverPin.trim());
    }
  }

  const handovers = summary.data?.handovers ?? [];

  return (
    <div className="space-y-6">
      <Tabs value={kind} onValueChange={(v) => setKind(v as HandoverKind)}>
        <TabsList>
          <TabsTrigger value="handover">Relevo</TabsTrigger>
          <TabsTrigger value="spot_check">Arqueo sorpresa</TabsTrigger>
        </TabsList>
      </Tabs>

      <div className="space-y-4">
        <DenominationsInput value={counted} onChange={setCounted} legend="Efectivo contado" />
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="handover-card">Datáfono contado</Label>
            <MoneyInput id="handover-card" value={countedCard} onChange={setCountedCard} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="handover-transfer">Transferencias contadas</Label>
            <MoneyInput id="handover-transfer" value={countedTransfer} onChange={setCountedTransfer} />
          </div>
        </div>

        {kind === "handover" ? (
          <div className="space-y-1">
            <Label htmlFor="handover-responsible">Nuevo responsable (número de empleado)</Label>
            <Input
              id="handover-responsible"
              type="number"
              inputMode="numeric"
              min={1}
              className="h-11"
              value={newResponsibleId}
              onChange={(event) => setNewResponsibleId(event.target.value)}
            />
          </div>
        ) : null}

        <PhotoCaptureField value={photo} onChange={setPhoto} label="Foto (opcional)" />

        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}

        {kind === "handover" ? (
          <div className="space-y-2">
            <Label htmlFor="handover-auth-pin">PIN de autorización (opcional)</Label>
            <Input
              id="handover-auth-pin"
              type="password"
              inputMode="numeric"
              className="h-11 max-w-40"
              value={handoverPin}
              onChange={(event) => setHandoverPin(event.target.value)}
            />
            <Button type="button" className="h-11" disabled={mutation.isPending} onClick={handleContinue}>
              {mutation.isPending ? "Registrando…" : "Registrar relevo"}
            </Button>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-3 rounded-md border p-4">
            <p className="text-sm text-muted-foreground">
              El arqueo sorpresa exige PIN de administrador y no cambia al responsable.
            </p>
            <PinPad
              length={4}
              label="PIN de administrador"
              disabled={mutation.isPending}
              onSubmit={(pin) => mutation.mutate(pin)}
            />
          </div>
        )}
      </div>

      {lastResult ? (
        <div className="space-y-2 rounded-md border p-3">
          <p className="text-sm font-medium">Desglose congelado del último {lastResult.kind === "handover" ? "relevo" : "arqueo"}</p>
          <BreakdownCard breakdown={lastResult.breakdown} />
        </div>
      ) : null}

      {summary.isLoading ? (
        <p className="text-sm text-muted-foreground">Cargando relevos…</p>
      ) : handovers.length === 0 ? (
        <EmptyState title="Todavía no hay relevos ni arqueos en este turno" />
      ) : (
        <ul className="space-y-2">
          {handovers.map((h) => (
            <li key={h.id} className="rounded-md border p-3 text-sm">
              <p className="font-medium">
                {h.kind === "handover" ? "Relevo" : "Arqueo sorpresa"} · {formatInstant(h.at)}
              </p>
              <p className="text-muted-foreground">
                {h.from_responsible?.name ?? "—"}
                {h.new_responsible ? ` → ${h.new_responsible.name}` : ""}
              </p>
              <div className="mt-2">
                <BreakdownCard breakdown={h.breakdown} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
