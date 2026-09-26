import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Mail } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";

import { useSession } from "@/app/session";
import { ApiError, newIdempotencyKey } from "@/api/client";
import {
  openShift,
  sealOpeningCount,
  type CashDifferenceCause,
  type OpeningCount,
  type OpeningInfo,
  type OpenShiftIn,
} from "@/api/shifts";
import { DenominationKeypad } from "@/components/DenominationKeypad";
import { type Denomination } from "@/components/DenominationsInput";
import { Diferencia } from "@/components/Diferencia";
import { EmployeePicker } from "@/components/EmployeePicker";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { errorMessage } from "@/lib/errors";
import { formatFechaCorta } from "@/lib/format";
import { DENOMINATIONS, formatCOP } from "@/lib/money";
import { cn } from "@/lib/utils";

import { CURRENT_SHIFT_QUERY_KEY, OPENING_INFO_QUERY_KEY } from "./hooks";

const CAUSE_LABEL: Record<CashDifferenceCause, string> = {
  change_error: "Error al dar cambio",
  expense_without_voucher: "Gasto sin comprobante",
  tips_mixed: "Propinas mezcladas en el sobre",
  unrecorded_sale: "Venta no registrada",
  counting_error: "Error de conteo",
  unknown: "Sin identificar",
};

/** El conteo sellado ya no sirve (se usó, se reemplazó o cambió un saldo): hay que volver a empezar. */
const STALE_CODES = new Set(["OPENING_COUNT_STALE", "OPENING_COUNT_USED", "CARRIED_SHIFT_NOT_PENDING"]);

type Paso = "elegir" | "contar" | "revelado";

function emptyDenominations(): Denomination[] {
  return DENOMINATIONS.map((value) => ({ value, count: 0 }));
}

function sumaTecleada(denoms: Denomination[]): number {
  // La suma de lo tecleado, la misma que muestra el teclado y que el
  // servidor vuelve a sumar y valida (`DENOMINATIONS_MISMATCH`). Nunca es un
  // esperado ni una diferencia.
  return denoms.reduce((acc, d) => acc + d.value * d.count, 0);
}

/**
 * **El cuadre de apertura por sobres** (decisión del dueño, 2026-09-26, a
 * imagen de café-sistema). Lo primero que hace quien va a tener la caja
 * cuando no hay turno abierto:
 *
 * 1. **Elegir** los sobres de días por consignar que va a trabajar en el
 *    turno —sólo se ve la FECHA de cada sobre, nunca su monto—. Ninguno
 *    viene marcado: afirmar que un sobre llegó lo hace una persona.
 * 2. **Contar** cada sobre aparte, con el teclado de denominaciones, sin ver
 *    cuánto debería tener (a ciegas).
 * 3. **Sellar** (`POST /shifts/opening-counts`): recién ahí el servidor
 *    revela, por sobre, lo esperado, lo contado y la diferencia, con quién
 *    contó. Si hay diferencia se elige la causa y se abre
 *    (`POST /shifts/open` con `opening_count_id`).
 *
 * El cajón abre SÓLO con esos sobres: no hay base fija. La base de respaldo
 * vive aparte y no entra al cuadre (la verifica su custodio). Esta pantalla
 * no suma ni resta plata: todo lo que muestra después de sellar lo calculó
 * el servidor.
 */
export function EnvelopeOpeningForm({ info }: { info: OpeningInfo }): React.JSX.Element {
  const { me } = useSession();
  const queryClient = useQueryClient();

  const [paso, setPaso] = useState<Paso>(info.pending_count ? "revelado" : "elegir");
  const [elegidos, setElegidos] = useState<number[]>([]);
  const [conteos, setConteos] = useState<Record<number, Denomination[]>>({});
  const [actual, setActual] = useState(0);
  const [sellado, setSellado] = useState<OpeningCount | null>(info.pending_count ?? null);
  const [responsibleId, setResponsibleId] = useState<number | null>(
    me?.kind === "device" && me.employee ? me.employee.id : null,
  );
  const [cause, setCause] = useState<CashDifferenceCause | "">("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  const sealKeyRef = useRef(newIdempotencyKey());
  const openKeyRef = useRef(newIdempotencyKey());

  const sobres = info.envelopes;
  const elegidosEnOrden = sobres.filter((s) => elegidos.includes(s.shift_id));

  function reiniciar(mensaje: string | null) {
    setPaso("elegir");
    setSellado(null);
    setConteos({});
    setActual(0);
    setCause("");
    setNote("");
    setError(mensaje);
    sealKeyRef.current = newIdempotencyKey();
    openKeyRef.current = newIdempotencyKey();
    void queryClient.invalidateQueries({ queryKey: OPENING_INFO_QUERY_KEY });
  }

  function toggle(shiftId: number) {
    setElegidos((prev) => (prev.includes(shiftId) ? prev.filter((id) => id !== shiftId) : [...prev, shiftId]));
    setError(null);
  }

  const sealMutation = useMutation({
    mutationFn: () =>
      sealOpeningCount(
        {
          envelopes: elegidosEnOrden.map((s) => {
            const denominations = conteos[s.shift_id] ?? emptyDenominations();
            return { shift_id: s.shift_id, counted: { denominations, total: sumaTecleada(denominations) } };
          }),
        },
        sealKeyRef.current,
      ),
    onSuccess: (count) => {
      setSellado(count);
      setPaso("revelado");
      setError(null);
      sealKeyRef.current = newIdempotencyKey();
      openKeyRef.current = newIdempotencyKey();
    },
    onError: (err) => {
      sealKeyRef.current = newIdempotencyKey();
      if (err instanceof ApiError && STALE_CODES.has(err.code)) {
        reiniciar(errorMessage(err));
        return;
      }
      setError(errorMessage(err));
    },
  });

  const openMutation = useMutation({
    mutationFn: (body: OpenShiftIn) => openShift(body, openKeyRef.current),
    onSuccess: () => {
      toast.success("Turno abierto.");
      void queryClient.invalidateQueries({ queryKey: CURRENT_SHIFT_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: OPENING_INFO_QUERY_KEY });
    },
    onError: (err) => {
      openKeyRef.current = newIdempotencyKey();
      if (err instanceof ApiError && STALE_CODES.has(err.code)) {
        reiniciar(errorMessage(err));
        return;
      }
      setError(errorMessage(err));
    },
  });

  function abrir() {
    if (responsibleId === null) {
      setError("Elegí quién es el responsable de caja.");
      return;
    }
    setError(null);
    openMutation.mutate({
      opening_count_id: sellado?.id,
      cash_responsible_id: responsibleId,
      opening_cause: sellado?.requires_cause && cause !== "" ? cause : undefined,
      opening_note: sellado?.requires_cause && note.trim() !== "" ? note.trim() : undefined,
    });
  }

  const pending = sealMutation.isPending || openMutation.isPending;

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="space-y-1">
        <h1 className="text-lg font-semibold">Abrir turno</h1>
        <p className="text-sm text-muted-foreground">
          Cuadre de apertura: el cajón abre sólo con los sobres por consignar que recibís. La base de respaldo no
          se cuenta acá: la guarda y la verifica su custodio.
        </p>
      </div>

      {paso === "elegir" ? (
        <section aria-labelledby="sobres-elegir" className="space-y-3">
          <h2 id="sobres-elegir" className="text-base font-semibold">
            1 · ¿Qué sobres recibís?
          </h2>
          {sobres.length === 0 ? (
            <p className="rounded-md border p-3 text-sm text-muted-foreground">
              No hay sobres por consignar: el cajón abre vacío.
            </p>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                Tocá cada sobre que tenés en la mano. Su monto no se muestra: lo vas a contar.
              </p>
              <ul className="grid gap-2 sm:grid-cols-2">
                {sobres.map((s) => {
                  const recibido = elegidos.includes(s.shift_id);
                  return (
                    <li key={s.shift_id}>
                      <button
                        type="button"
                        aria-pressed={recibido}
                        onClick={() => toggle(s.shift_id)}
                        className={cn(
                          "flex min-h-14 w-full items-center gap-3 rounded-lg px-4 text-left text-base font-semibold ring-1 transition-colors",
                          recibido ? "bg-foreground text-background ring-foreground" : "bg-card ring-border hover:bg-muted",
                        )}
                      >
                        {recibido ? (
                          <Check aria-hidden="true" className="size-5" />
                        ) : (
                          <Mail aria-hidden="true" className="size-5" />
                        )}
                        <span>Sobre del {formatFechaCorta(s.business_date)}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
          {elegidosEnOrden.length > 0 ? (
            <Button
              type="button"
              className="h-12 w-full text-base"
              onClick={() => {
                setActual(0);
                setPaso("contar");
                setError(null);
              }}
            >
              Contar {elegidosEnOrden.length === 1 ? "el sobre" : `los ${elegidosEnOrden.length} sobres`}
            </Button>
          ) : null}
        </section>
      ) : null}

      {paso === "contar" && elegidosEnOrden.length > 0 ? (
        <section aria-labelledby="sobres-contar" className="space-y-3">
          <h2 id="sobres-contar" className="text-base font-semibold">
            2 · Sobre del {formatFechaCorta(elegidosEnOrden[actual]?.business_date)} ({actual + 1} de{" "}
            {elegidosEnOrden.length})
          </h2>
          <p className="text-sm text-muted-foreground">
            Contá este sobre solo, por denominaciones. Lo que debería tener se ve después de sellar.
          </p>
          <DenominationKeypad
            key={elegidosEnOrden[actual]!.shift_id}
            legend={`Sobre del ${formatFechaCorta(elegidosEnOrden[actual]?.business_date)}`}
            value={conteos[elegidosEnOrden[actual]!.shift_id] ?? emptyDenominations()}
            onChange={(next) => setConteos((prev) => ({ ...prev, [elegidosEnOrden[actual]!.shift_id]: next }))}
            disabled={pending}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              className="h-12 text-base"
              disabled={pending}
              onClick={() => (actual === 0 ? setPaso("elegir") : setActual(actual - 1))}
            >
              {actual === 0 ? "Cambiar sobres" : "Sobre anterior"}
            </Button>
            {actual < elegidosEnOrden.length - 1 ? (
              <Button type="button" className="h-12 flex-1 text-base" onClick={() => setActual(actual + 1)}>
                Siguiente sobre
              </Button>
            ) : (
              <Button
                type="button"
                className="h-12 flex-1 text-base"
                disabled={pending}
                onClick={() => sealMutation.mutate()}
              >
                {sealMutation.isPending ? "Sellando…" : "Sellar el conteo"}
              </Button>
            )}
          </div>
        </section>
      ) : null}

      {paso === "revelado" && sellado ? <Revelacion count={sellado} /> : null}

      {paso === "revelado" && sellado?.requires_cause ? (
        <div className="space-y-3 rounded-md border border-destructive/40 bg-destructive/5 p-3">
          <p className="text-sm font-medium text-destructive">
            Algún sobre no tiene lo que debería: elegí la causa para poder abrir.
          </p>
          <div role="radiogroup" aria-label="Causa" className="grid gap-2 sm:grid-cols-2">
            {(Object.entries(CAUSE_LABEL) as [CashDifferenceCause, string][]).map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={cause === value}
                onClick={() => setCause(value)}
                className={cn(
                  "min-h-14 rounded-lg px-4 text-left text-base font-semibold ring-1 transition-colors",
                  cause === value
                    ? "bg-foreground text-background ring-foreground"
                    : "bg-card text-foreground ring-border hover:bg-muted",
                )}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="space-y-1">
            <Label htmlFor="envelope-open-note">Nota</Label>
            <Textarea id="envelope-open-note" value={note} onChange={(event) => setNote(event.target.value)} />
          </div>
        </div>
      ) : null}

      {paso === "revelado" || (paso === "elegir" && elegidosEnOrden.length === 0) ? (
        <div className="space-y-2">
          <p className="text-sm font-medium">Responsable de caja</p>
          <EmployeePicker
            value={responsibleId}
            onChange={(id) => setResponsibleId(id)}
            label="Responsable de caja"
            disabled={pending}
          />
          <p className="text-xs text-muted-foreground">
            Por defecto, quien está identificado. Si abrís por alguien que todavía no llegó, después se la entregás
            con un relevo.
          </p>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      {paso === "revelado" ? (
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            className="h-12 text-base"
            disabled={pending}
            onClick={() => reiniciar(null)}
          >
            Volver a contar
          </Button>
          <Button
            type="button"
            className="h-12 flex-1 text-base"
            disabled={pending || (Boolean(sellado?.requires_cause) && cause === "")}
            onClick={abrir}
          >
            {openMutation.isPending ? "Abriendo…" : "Abrir turno"}
          </Button>
        </div>
      ) : null}

      {paso === "elegir" && elegidosEnOrden.length === 0 ? (
        <Button type="button" className="h-12 w-full text-base" disabled={pending} onClick={abrir}>
          {openMutation.isPending ? "Abriendo…" : sobres.length === 0 ? "Abrir turno" : "Abrir sin sobres"}
        </Button>
      ) : null}
    </div>
  );
}

/** Lo que el servidor reveló al sellar: por sobre, esperado, contado y diferencia, con quién contó. */
function Revelacion({ count }: { count: OpeningCount }): React.JSX.Element {
  const sobres = count.envelopes ?? [];
  return (
    <section aria-labelledby="sobres-revelado" className="space-y-3">
      <h2 id="sobres-revelado" className="text-base font-semibold">
        3 · Conteo sellado
      </h2>
      <p className="text-sm text-muted-foreground">
        Contó {count.counted_by?.name ?? "—"}. Lo esperado de cada sobre es su saldo por consignar.
      </p>
      {sobres.length === 0 ? (
        <p className="rounded-md border p-3 text-sm text-muted-foreground">Sin sobres: el cajón abre vacío.</p>
      ) : (
        <ul className="divide-y rounded-md border">
          {sobres.map((s) => (
            <li key={s.shift_id} className="grid gap-1 p-3 sm:grid-cols-[minmax(0,1fr)_auto_auto_auto] sm:items-center sm:gap-4">
              <span className="font-medium">Sobre del {formatFechaCorta(s.business_date)}</span>
              <span className="text-sm">
                Esperado <b className="tabular-nums">{formatCOP(s.expected ?? null)}</b>
              </span>
              <span className="text-sm">
                Contado <b className="tabular-nums">{formatCOP(s.counted ?? null)}</b>
              </span>
              <Diferencia valor={s.difference} />
            </li>
          ))}
        </ul>
      )}
      {sobres.length > 1 ? (
        <p className="text-sm">
          El cajón abre con <b className="tabular-nums">{formatCOP(count.counted_total ?? null)}</b> · diferencia
          total <Diferencia valor={count.difference_total} className="inline-flex" />
        </p>
      ) : null}
    </section>
  );
}
