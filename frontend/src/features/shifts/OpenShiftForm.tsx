import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { toast } from "sonner";

import { useSession } from "@/app/session";
import { ApiError, newIdempotencyKey } from "@/api/client";
import { getCarryCandidates, openShift, type CashDifferenceCause, type OpenShiftIn } from "@/api/shifts";
import { Check } from "lucide-react";

import { Button } from "@/components/ui/button";
import { DenominationKeypad } from "@/components/DenominationKeypad";
import { type Denomination } from "@/components/DenominationsInput";
import { EmployeePicker } from "@/components/EmployeePicker";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { errorMessage } from "@/lib/errors";
import { formatFechaCorta } from "@/lib/format";
import { DENOMINATIONS, formatCOP } from "@/lib/money";
import { MoneyInput } from "@/components/MoneyInput";

import { CARRY_CANDIDATES_QUERY_KEY, CURRENT_SHIFT_QUERY_KEY } from "./hooks";

const CAUSE_LABEL: Record<CashDifferenceCause, string> = {
  change_error: "Error al dar cambio",
  expense_without_voucher: "Gasto sin comprobante",
  tips_mixed: "Propinas mezcladas con la base",
  unrecorded_sale: "Venta no registrada",
  counting_error: "Error de conteo",
  unknown: "Sin identificar",
};

/** Errores del servidor que dicen que la lista de días quedó vieja: se recarga. */
const CARRIED_STALE_CODES = new Set(["CARRIED_SHIFT_NOT_PENDING", "CARRIED_SHIFT_REPEATED"]);

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
 *
 * **La plata de días anteriores se queda en el cajón** (decisión del dueño,
 * 2026-09-24), en su sobre. Con «Consignaciones» encendida, `GET
 * /shifts/carry-candidates` trae los días con saldo por consignar.
 *
 * **Base y sobres van aparte** (auditoría de tablet): la base se cuenta por
 * denominaciones con el teclado en pantalla, y cada sobre se confirma
 * ENTERO con un botón grande «Está · $74.000» (el monto lo publica el
 * servidor). **Ninguno viene confirmado**: afirmar que la plata está lo hace
 * una persona mirando el cajón. Esta pantalla no suma la base con los
 * sobres: manda `carried_shift_ids` con `carried_counted_apart` y el
 * servidor hace la cuenta; si la base no cuadra con la fija, su `message`
 * lo dice, y el error se borra apenas se corrige el conteo. La causa se
 * elige con un toque (botones, no un desplegable).
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

  const depositsEnabled = hasFeature("money.deposits");
  const candidatesQuery = useQuery({
    queryKey: CARRY_CANDIDATES_QUERY_KEY,
    queryFn: getCarryCandidates,
    enabled: depositsEnabled,
  });
  const candidates = depositsEnabled ? candidatesQuery.data ?? [] : [];
  const [carriedIds, setCarriedIds] = useState<number[]>([]);
  // Sólo viaja lo marcado que sigue en la lista: si al recargar un día ya no
  // está (lo consignaron desde Banco), no se manda a ciegas.
  const carriedShiftIds = carriedIds.filter((id) => candidates.some((c) => c.shift_id === id));

  /** Se corrigió algo: el error viejo ya no dice la verdad, y el próximo intento es otro. */
  function corrigio() {
    setError(null);
    setNeedsCause(false);
    setCause("");
    idempotencyKeyRef.current = newIdempotencyKey();
  }

  function toggleCarried(shiftId: number, checked: boolean) {
    setCarriedIds((prev) => (checked ? [...prev.filter((id) => id !== shiftId), shiftId] : prev.filter((id) => id !== shiftId)));
    corrigio();
  }

  function cambiarBase(next: Denomination[]) {
    setDenominations(next);
    if (error !== null || needsCause) corrigio();
  }

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
      if (err instanceof ApiError && CARRIED_STALE_CODES.has(err.code)) {
        // La lista de días quedó vieja: se recarga y el próximo intento es otro.
        void queryClient.invalidateQueries({ queryKey: CARRY_CANDIDATES_QUERY_KEY });
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
      carried_shift_ids: carriedShiftIds,
      carried_counted_apart: true,
    });
  }

  return (
    <form onSubmit={handleSubmit} className="mx-auto max-w-4xl space-y-6">
      <div className="space-y-1">
        <h1 className="text-lg font-semibold">Abrir turno</h1>
        <p className="text-sm text-muted-foreground">
          Contá la base fija por denominaciones antes de empezar a operar. Los sobres de días anteriores van aparte.
        </p>
      </div>

      <DenominationKeypad value={denominations} onChange={cambiarBase} legend="Base contada" disabled={mutation.isPending} />

      {candidates.length > 0 ? (
        <fieldset className="space-y-2 rounded-md border p-3">
          <legend className="px-1 text-sm font-medium">Sobres de días anteriores</legend>
          <p className="text-xs text-muted-foreground">
            No se cuentan con la base: tocá «Está» sólo si el sobre de ese día está físicamente en la caja.
          </p>
          <ul className="space-y-2">
            {candidates.map((c) => {
              const esta = carriedIds.includes(c.shift_id);
              return (
                <li key={c.shift_id} className="flex flex-wrap items-center gap-3">
                  <span className="min-w-24 text-base font-medium">{formatFechaCorta(c.business_date)}</span>
                  <button
                    type="button"
                    aria-pressed={esta}
                    disabled={mutation.isPending}
                    onClick={() => toggleCarried(c.shift_id, !esta)}
                    className={cn(
                      "flex min-h-14 flex-1 items-center justify-center gap-2 rounded-lg px-4 text-base font-semibold ring-1 transition-colors",
                      esta ? "bg-foreground text-background ring-foreground" : "bg-card ring-border hover:bg-muted",
                    )}
                  >
                    {esta ? <Check aria-hidden="true" className="size-5" /> : null}
                    <span>
                      Está · <span className="tabular-nums">{formatCOP(c.outstanding)}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </fieldset>
      ) : null}

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
            La base contada no coincide con la base fija: volvé a contarla, o elegí una causa para poder abrir.
          </p>
          <div className="space-y-2">
            <p id="open-cause-label" className="text-sm font-medium">
              Causa
            </p>
            <div role="radiogroup" aria-labelledby="open-cause-label" className="grid gap-2 sm:grid-cols-2">
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

      <Button type="submit" className="h-12 w-full text-base" disabled={mutation.isPending || (needsCause && cause === "")}>
        {mutation.isPending ? "Abriendo…" : "Abrir turno"}
      </Button>
    </form>
  );
}
