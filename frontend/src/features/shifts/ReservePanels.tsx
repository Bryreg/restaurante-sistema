import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { toast } from "sonner";

import { newIdempotencyKey } from "@/api/client";
import {
  getShiftReserve,
  returnToReserve,
  takeFromReserve,
  verifyReserve,
  type ReserveCheck,
  type ReserveStatus,
} from "@/api/shifts";
import { Cargando } from "@/components/Cargando";
import { DenominationKeypad } from "@/components/DenominationKeypad";
import { type Denomination } from "@/components/DenominationsInput";
import { DesdeHacia } from "@/components/DesdeHacia";
import { Diferencia } from "@/components/Diferencia";
import { EmptyState } from "@/components/EmptyState";
import { MoneyInput } from "@/components/MoneyInput";
import { PinPad } from "@/components/PinPad";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { formatInstant } from "@/lib/businessDate";
import { errorMessage } from "@/lib/errors";
import { DENOMINATIONS, formatCOP } from "@/lib/money";

import { CURRENT_SHIFT_QUERY_KEY, reserveQueryKey, shiftSummaryQueryKey } from "./hooks";

/**
 * **La base de respaldo** (`cash.reserve`, decisión del dueño 2026-09-26).
 *
 * «Base» significa una sola cosa: la plata que se guarda APARTE del cajón,
 * con un monto fijo por sede, por si la plata de los sobres no alcanza. No
 * entra al cuadre de apertura ni al de cierre. Lo que sí pasa por el cajón es
 * lo que se le presta:
 *
 * - `TakeFromReservePanel` — «Tomar de la base», con PIN de supervisor o
 *   administrador. Entra al cajón como préstamo.
 * - `ReturnToReservePanel` — «Devolver a la base», lo hace quien tiene la
 *   caja. El préstamo vuelve **el mismo día, antes del conteo de cierre**.
 * - `VerifyReservePanel` — «Verificar base», del custodio (supervisor o
 *   administrador), a ciegas: se cuenta y recién después el servidor revela
 *   lo esperado y la diferencia.
 *
 * Los tres se pueden colgar de cualquier hoja (la cinta de Mesas los usa):
 * props `{ shiftId, onDone? }`, y `onDone` se llama después de guardar para
 * que quien los contiene cierre su hoja. Ninguno suma ni resta plata: lo
 * disponible, lo que se debe y la diferencia los calcula el servidor.
 */
export interface ReservePanelProps {
  shiftId: number;
  /** Se llama después de guardar con éxito: quien contiene el panel cierra su hoja. */
  onDone?: () => void;
}

function useReserve(shiftId: number) {
  return useQuery({ queryKey: reserveQueryKey(shiftId), queryFn: () => getShiftReserve(shiftId) });
}

function useInvalidateReserve(shiftId: number) {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: reserveQueryKey(shiftId) });
    void queryClient.invalidateQueries({ queryKey: CURRENT_SHIFT_QUERY_KEY });
    void queryClient.invalidateQueries({ queryKey: shiftSummaryQueryKey(shiftId) });
  };
}

/** Por qué no se puede usar la base, o `null` si se puede. */
function motivoSinBase(status: ReserveStatus): string | null {
  if (!status.enabled) return "La base de respaldo está apagada en esta sede.";
  if (!status.configured) return "Esta sede no tiene monto de base de respaldo: el administrador lo define en Ajustes › Caja.";
  return null;
}

function EstadoReserva({ query }: { query: ReturnType<typeof useReserve> }): React.JSX.Element {
  if (query.isLoading) return <Cargando texto="Consultando la base de respaldo…" />;
  if (query.isError) {
    return (
      <EmptyState
        role="alert"
        title="No se pudo consultar la base de respaldo"
        description={errorMessage(query.error)}
        action={{ label: "Reintentar", onClick: () => void query.refetch() }}
      />
    );
  }
  return <></>;
}

/** «Tomar de la base»: monto + PIN de supervisor o administrador. */
export function TakeFromReservePanel({ shiftId, onDone }: ReservePanelProps): React.JSX.Element {
  const query = useReserve(shiftId);
  const invalidate = useInvalidateReserve(shiftId);
  const [amount, setAmount] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const keyRef = useRef(newIdempotencyKey());

  const mutation = useMutation({
    mutationFn: (pin: string) =>
      takeFromReserve(
        shiftId,
        { amount: amount ?? 0, authorizer_pin: pin, note: note.trim() === "" ? null : note.trim() },
        keyRef.current,
      ),
    onSuccess: () => {
      toast.success("Se tomó de la base de respaldo. Devolvela antes de contar el cierre.");
      keyRef.current = newIdempotencyKey();
      setAmount(null);
      setNote("");
      setError(null);
      invalidate();
      onDone?.();
    },
    onError: (err) => {
      keyRef.current = newIdempotencyKey();
      setError(errorMessage(err));
    },
  });

  if (query.isLoading || query.isError || !query.data) return <EstadoReserva query={query} />;
  const status = query.data;
  const motivo = motivoSinBase(status);
  if (motivo) return <EmptyState title="No se puede tomar de la base" description={motivo} />;

  const valido = amount !== null && amount > 0;
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Disponible en la base: <b className="tabular-nums text-foreground">{formatCOP(status.available ?? null)}</b>.
        Lo que tomes entra al cajón y se devuelve hoy, antes de contar el cierre.
      </p>
      <div className="space-y-1">
        <Label htmlFor="reserve-take-amount">Monto a tomar</Label>
        <MoneyInput id="reserve-take-amount" value={amount} onChange={setAmount} />
      </div>
      <div className="space-y-1">
        <Label htmlFor="reserve-take-note">Para qué (opcional)</Label>
        <Textarea id="reserve-take-note" value={note} onChange={(event) => setNote(event.target.value)} />
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {valido ? (
        <div className="flex flex-col items-center gap-3 rounded-md border p-4">
          <DesdeHacia
            className="w-full max-w-md"
            desde="La base de respaldo"
            hacia={`El cajón del turno ${shiftId}`}
            monto={amount}
            autoriza="PIN de supervisor o administrador"
          />
          <PinPad
            length={4}
            label="PIN de supervisor o administrador"
            disabled={mutation.isPending}
            onSubmit={(pin) => mutation.mutate(pin)}
          />
        </div>
      ) : null}
    </div>
  );
}

/** «Devolver a la base»: lo hace quien tiene la caja; no más de lo que el cajón debe. */
export function ReturnToReservePanel({ shiftId, onDone }: ReservePanelProps): React.JSX.Element {
  const query = useReserve(shiftId);
  const invalidate = useInvalidateReserve(shiftId);
  const [amount, setAmount] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const keyRef = useRef(newIdempotencyKey());

  const mutation = useMutation({
    mutationFn: (monto: number) =>
      returnToReserve(shiftId, { amount: monto, note: note.trim() === "" ? null : note.trim() }, keyRef.current),
    onSuccess: () => {
      toast.success("Devuelto a la base de respaldo.");
      keyRef.current = newIdempotencyKey();
      setAmount(null);
      setNote("");
      setError(null);
      invalidate();
      onDone?.();
    },
    onError: (err) => {
      keyRef.current = newIdempotencyKey();
      setError(errorMessage(err));
    },
  });

  if (query.isLoading || query.isError || !query.data) return <EstadoReserva query={query} />;
  const status = query.data;
  if (!status.enabled) return <EmptyState title="No hay base de respaldo" description="La base de respaldo está apagada en esta sede." />;
  if (status.loan <= 0) {
    return (
      <EmptyState
        title="El cajón no le debe nada a la base"
        description="Este turno no tomó plata de la base de respaldo, o ya la devolvió toda."
      />
    );
  }

  // El monto sugerido es lo que el servidor dice que se debe: tocar el botón
  // lo manda tal cual, sin cuentas en esta pantalla.
  const monto = amount ?? status.loan;
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        El cajón le debe a la base <b className="tabular-nums text-foreground">{formatCOP(status.loan)}</b>. Devolvelo
        antes de contar el cierre.
      </p>
      <div className="space-y-1">
        <Label htmlFor="reserve-return-amount">Monto a devolver</Label>
        <MoneyInput id="reserve-return-amount" value={monto} onChange={setAmount} />
      </div>
      <div className="space-y-1">
        <Label htmlFor="reserve-return-note">Nota (opcional)</Label>
        <Textarea id="reserve-return-note" value={note} onChange={(event) => setNote(event.target.value)} />
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <DesdeHacia
        className="w-full max-w-md"
        desde={`El cajón del turno ${shiftId}`}
        hacia="La base de respaldo"
        monto={monto}
      />
      <Button
        type="button"
        className="h-12 w-full text-base"
        disabled={mutation.isPending || !(monto > 0)}
        onClick={() => mutation.mutate(monto)}
      >
        {mutation.isPending ? "Devolviendo…" : `Devolver ${formatCOP(monto)} a la base`}
      </Button>
    </div>
  );
}

/** «Verificar base»: el custodio cuenta a ciegas; el servidor revela lo esperado y la diferencia. */
export function VerifyReservePanel({ onDone }: { onDone?: () => void }): React.JSX.Element {
  const queryClient = useQueryClient();
  const [denominations, setDenominations] = useState<Denomination[]>(DENOMINATIONS.map((value) => ({ value, count: 0 })));
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [resultado, setResultado] = useState<ReserveCheck | null>(null);
  const keyRef = useRef(newIdempotencyKey());

  const mutation = useMutation({
    mutationFn: () =>
      verifyReserve(
        {
          counted: { denominations, total: denominations.reduce((acc, d) => acc + d.value * d.count, 0) },
          note: note.trim() === "" ? null : note.trim(),
        },
        keyRef.current,
      ),
    onSuccess: (check) => {
      keyRef.current = newIdempotencyKey();
      setResultado(check);
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ["shifts", "reserve"] });
    },
    onError: (err) => {
      keyRef.current = newIdempotencyKey();
      setError(errorMessage(err));
    },
  });

  if (resultado) {
    return (
      <div className="space-y-4">
        <p className="text-sm">
          Esperado <b className="tabular-nums">{formatCOP(resultado.expected ?? null)}</b> (monto fijo{" "}
          {formatCOP(resultado.reserve_amount ?? null)} menos {formatCOP(resultado.loans_outstanding ?? null)} prestado
          al cajón) · contado <b className="tabular-nums">{formatCOP(resultado.counted ?? null)}</b>
        </p>
        <Diferencia valor={resultado.difference} />
        <Button type="button" className="h-12 w-full text-base" onClick={() => onDone?.()}>
          Listo
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Contá la base de respaldo por denominaciones. Lo que debería haber se ve después de guardar.
      </p>
      <DenominationKeypad
        value={denominations}
        onChange={setDenominations}
        legend="Base de respaldo contada"
        disabled={mutation.isPending}
      />
      <div className="space-y-1">
        <Label htmlFor="reserve-check-note">Nota (opcional)</Label>
        <Textarea id="reserve-check-note" value={note} onChange={(event) => setNote(event.target.value)} />
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <Button type="button" className="h-12 w-full text-base" disabled={mutation.isPending} onClick={() => mutation.mutate()}>
        {mutation.isPending ? "Guardando…" : "Guardar la verificación"}
      </Button>
    </div>
  );
}

type Vista = "estado" | "tomar" | "devolver" | "verificar";

/**
 * La acción «Base de respaldo» del panel del turno: el estado (monto fijo,
 * disponible, lo que debe el cajón, los movimientos) y los tres paneles.
 */
export function ReservePanel({ shiftId }: { shiftId: number }): React.JSX.Element {
  const query = useReserve(shiftId);
  const [vista, setVista] = useState<Vista>("estado");

  if (vista === "tomar") return <TakeFromReservePanel shiftId={shiftId} onDone={() => setVista("estado")} />;
  if (vista === "devolver") return <ReturnToReservePanel shiftId={shiftId} onDone={() => setVista("estado")} />;
  if (vista === "verificar") return <VerifyReservePanel onDone={() => setVista("estado")} />;

  if (query.isLoading || query.isError || !query.data) return <EstadoReserva query={query} />;
  const status = query.data;
  const motivo = motivoSinBase(status);

  return (
    <div className="space-y-5">
      <p className="text-sm text-muted-foreground">
        Plata aparte del cajón, por si los sobres no alcanzan. No entra al cuadre: lo que se toma entra al cajón y
        se devuelve hoy, antes de contar el cierre.
      </p>
      {motivo ? (
        <p className="rounded-md border p-3 text-sm">{motivo}</p>
      ) : (
        <dl className="grid gap-3 sm:grid-cols-3">
          <div className="rounded-md border p-3">
            <dt className="text-xs text-muted-foreground">Monto fijo</dt>
            <dd className="text-lg font-semibold tabular-nums">{formatCOP(status.amount ?? null)}</dd>
          </div>
          <div className="rounded-md border p-3">
            <dt className="text-xs text-muted-foreground">Disponible</dt>
            <dd className="text-lg font-semibold tabular-nums">{formatCOP(status.available ?? null)}</dd>
          </div>
          <div className="rounded-md border p-3">
            <dt className="text-xs text-muted-foreground">El cajón debe</dt>
            <dd className="text-lg font-semibold tabular-nums">{formatCOP(status.loan)}</dd>
          </div>
        </dl>
      )}
      {!motivo ? (
        <div className="grid gap-2 sm:grid-cols-3">
          <Button type="button" className="h-12 text-base" onClick={() => setVista("tomar")}>
            Tomar de la base
          </Button>
          <Button
            type="button"
            variant="outline"
            className="h-12 text-base"
            disabled={status.loan <= 0}
            onClick={() => setVista("devolver")}
          >
            Devolver a la base
          </Button>
          {status.can_verify ? (
            <Button type="button" variant="outline" className="h-12 text-base" onClick={() => setVista("verificar")}>
              Verificar base
            </Button>
          ) : null}
        </div>
      ) : null}
      {status.last_check_at ? (
        <p className="text-xs text-muted-foreground">
          Última verificación: {formatInstant(status.last_check_at)} por {status.last_check_by ?? "—"} ·{" "}
          {status.last_check_matched ? "cuadró" : "con diferencia"}
        </p>
      ) : null}
      {status.movements.length > 0 ? (
        <ul className="divide-y rounded-md border text-sm">
          {status.movements.map((m) => (
            <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 p-3">
              <span>
                {m.kind === "take" ? "Se tomó" : "Se devolvió"} {formatCOP(m.amount ?? null)} · {m.employee_name}
                {m.authorized_by_employee_name ? ` · autorizó ${m.authorized_by_employee_name}` : ""}
              </span>
              <span className="text-muted-foreground">
                {m.at ? formatInstant(m.at) : ""}
                {m.reversed_at ? ` · reversado: ${m.reversed_reason ?? ""}` : ""}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
