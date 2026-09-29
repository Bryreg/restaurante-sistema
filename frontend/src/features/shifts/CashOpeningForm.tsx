import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, Vault, Wallet } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { useSession } from "@/app/session";
import { newIdempotencyKey } from "@/api/client";
import {
  openShift,
  previewOpening,
  type CashDifferenceCause,
  type OpeningInfo,
  type OpeningPreview,
  type OpenShiftIn,
} from "@/api/shifts";
import { DenominationKeypad } from "@/components/DenominationKeypad";
import { type Denomination } from "@/components/DenominationsInput";
import { EmployeePicker } from "@/components/EmployeePicker";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { errorMessage } from "@/lib/errors";
import { formatFechaCorta } from "@/lib/format";
import { DENOMINATIONS, formatCOP } from "@/lib/money";
import { cn } from "@/lib/utils";

import { CURRENT_SHIFT_QUERY_KEY, OPENING_INFO_QUERY_KEY } from "./hooks";
import { VerifyReservePanel } from "./ReservePanels";

const CAUSE_LABEL: Record<CashDifferenceCause, string> = {
  change_error: "Error al dar cambio",
  expense_without_voucher: "Gasto sin comprobante",
  tips_mixed: "Propinas mezcladas",
  unrecorded_sale: "Venta no registrada",
  counting_error: "Error de conteo",
  unknown: "Sin identificar",
};

function emptyDenominations(): Denomination[] {
  return DENOMINATIONS.map((value) => ({ value, count: 0 }));
}

function sumaTecleada(denoms: Denomination[]): number {
  // La suma de lo tecleado, la misma que muestra el teclado y que el
  // servidor vuelve a sumar y valida (`DENOMINATIONS_MISMATCH`). Nunca es un
  // esperado ni una diferencia: esas las manda el servidor.
  return denoms.reduce((acc, d) => acc + d.value * d.count, 0);
}

/**
 * **La apertura «igual al café»** (decisión del dueño, 2026-09-29). Lo primero
 * que hace quien va a tener la caja cuando no hay turno abierto:
 *
 * 1. Ve **«Debería haber en la registradora»**: la suma de los días por
 *    consignar que están en el cajón. **Todos vienen marcados** —si no se
 *    consignó, la plata debería estar— y se desmarca el que no está.
 * 2. Cuenta **el cajón entero una vez** con el teclado de denominaciones.
 * 3. Ve la diferencia **en vivo**: «✓ Cuadra», «Sobran $X» o «Faltan $X».
 *    Con diferencia, causa y motivo escrito obligatorios.
 *
 * Todas las cifras de plata —lo que debería haber, la diferencia, el
 * sobrante que se consigna con el turno— las calcula el servidor
 * (`POST /shifts/opening/preview`), y el mismo servidor las vuelve a validar
 * al abrir. Esta pantalla no suma ni resta. La base de respaldo va aparte y
 * no entra al cuadre.
 */
export function CashOpeningForm({ info }: { info: OpeningInfo }): React.JSX.Element {
  const { me, hasFeature } = useSession();
  const queryClient = useQueryClient();
  const dias = info.envelopes;

  const [marcados, setMarcados] = useState<number[]>(() => dias.map((d) => d.shift_id));
  const [denominations, setDenominations] = useState<Denomination[]>(emptyDenominations);
  const [contado, setContado] = useState(false);
  const [responsibleId, setResponsibleId] = useState<number | null>(
    me?.kind === "device" && me.employee ? me.employee.id : null,
  );
  const [cause, setCause] = useState<CashDifferenceCause | "">("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [contarBase, setContarBase] = useState(false);
  const openKeyRef = useRef(newIdempotencyKey());

  const seleccion = useMemo(
    () => dias.filter((d) => marcados.includes(d.shift_id)).map((d) => d.shift_id),
    [dias, marcados],
  );
  const total = sumaTecleada(denominations);
  // Sin días marcados, un cajón vacío ya es un conteo (no debería haber
  // nada): no hace falta tocar el teclado para abrir en $0.
  const conConteo = contado || seleccion.length === 0;
  const counted = conConteo ? { denominations, total } : undefined;

  const previewQuery = useQuery({
    queryKey: ["shifts", "opening-preview", seleccion, conConteo ? denominations.map((d) => d.count) : null],
    queryFn: () => previewOpening({ carried_shift_ids: seleccion, counted }),
    placeholderData: keepPreviousData,
  });
  const preview = previewQuery.data;

  const openMutation = useMutation({
    mutationFn: (body: OpenShiftIn) => openShift(body, openKeyRef.current),
    onSuccess: () => {
      toast.success("Turno abierto.");
      void queryClient.invalidateQueries({ queryKey: CURRENT_SHIFT_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: OPENING_INFO_QUERY_KEY });
    },
    onError: (err) => {
      openKeyRef.current = newIdempotencyKey();
      setError(errorMessage(err));
      void queryClient.invalidateQueries({ queryKey: OPENING_INFO_QUERY_KEY });
    },
  });

  function toggle(shiftId: number) {
    setMarcados((prev) => (prev.includes(shiftId) ? prev.filter((id) => id !== shiftId) : [...prev, shiftId]));
    setError(null);
  }

  const requiereMotivo = Boolean(conConteo && preview?.requires_justification);
  const listo = Boolean(preview) && conConteo && !previewQuery.isFetching && preview?.counted === total;
  const bloqueo: string | null = !conConteo
    ? "Contá el efectivo primero"
    : preview?.blocks_empty
      ? "Contá el efectivo primero"
      : requiereMotivo && cause === ""
        ? "Elegí la causa de la diferencia"
        : requiereMotivo && note.trim() === ""
          ? "Escribí el motivo de la diferencia"
          : responsibleId === null
            ? "Elegí quién es el responsable de caja"
            : null;

  function abrir() {
    if (bloqueo || responsibleId === null) {
      setError(bloqueo);
      return;
    }
    setError(null);
    openMutation.mutate({
      carried_shift_ids: seleccion,
      opening_cash: { denominations, total },
      cash_responsible_id: responsibleId,
      opening_cause: requiereMotivo && cause !== "" ? cause : undefined,
      opening_note: requiereMotivo ? note.trim() : undefined,
    });
  }

  const conBase = Boolean(info.reserve_available) && hasFeature("cash.reserve");
  const pending = openMutation.isPending;

  return (
    <div className="mx-auto flex max-w-[820px] flex-col gap-[18px]">
      <h1 className="text-[22px] font-extrabold [font-stretch:108%]">Cuadre inicial de caja</h1>

      <section aria-labelledby="deberia-haber" className="flex flex-col gap-3 rounded-[14px] border bg-card p-4">
        <p id="deberia-haber" className="flex items-center gap-1.5 text-[14px] font-bold tracking-wide text-muted-foreground uppercase">
          <Wallet aria-hidden="true" className="size-4" />
          Debería haber en la registradora
        </p>
        <p data-testid="opening-expected" className="text-[34px] leading-none font-extrabold tabular-nums">
          {preview ? formatCOP(preview.expected) : "—"}
        </p>
        {dias.length === 0 ? (
          <p className="text-[15px] text-muted-foreground">
            No hay días por consignar: la registradora debería estar vacía.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            <p className="text-[15px] font-bold">¿La plata de qué días está en la caja?</p>
            <ul className="flex flex-col gap-2">
              {dias.map((d) => {
                const marcado = marcados.includes(d.shift_id);
                return (
                  <li key={d.shift_id}>
                    <button
                      type="button"
                      aria-pressed={marcado}
                      disabled={pending}
                      onClick={() => toggle(d.shift_id)}
                      className={cn(
                        "flex min-h-[56px] w-full items-center gap-3 rounded-[12px] px-3 text-left transition-colors",
                        "focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                        marcado ? "border-2 border-success bg-success/5" : "border bg-transparent",
                      )}
                    >
                      <span
                        aria-hidden="true"
                        className={cn(
                          "grid size-[26px] shrink-0 place-items-center rounded-[7px]",
                          marcado ? "bg-success text-success-foreground" : "border-2 border-muted-foreground",
                        )}
                      >
                        {marcado ? <Check className="size-4" /> : null}
                      </span>
                      <span className="flex-1 text-[17px] font-semibold capitalize">
                        {formatFechaCorta(d.business_date)}
                      </span>
                      <span
                        className={cn(
                          "text-[17px] font-bold tabular-nums",
                          marcado ? "text-success" : "text-muted-foreground",
                        )}
                      >
                        {formatCOP(d.outstanding ?? null)}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
            <p className="text-[14px] text-muted-foreground">
              Dejá marcados sólo los días cuya plata está físicamente acá. Si un día ya se consignó o está apartado,
              desmarcalo.
            </p>
          </div>
        )}
      </section>

      <section aria-labelledby="contar-cajon" className="flex flex-col gap-3 rounded-[14px] border bg-card p-4">
        <h2 id="contar-cajon" className="text-[19px] font-bold">
          Contá todo el efectivo de la registradora
        </h2>
        <DenominationKeypad
          legend="Efectivo de la registradora"
          legendVisible={false}
          totalLabel="Total contado"
          value={denominations}
          onChange={(next) => {
            setDenominations(next);
            setContado(true);
            setError(null);
          }}
          disabled={pending}
        />
      </section>

      {conConteo && preview ? <DiferenciaApertura preview={preview} /> : null}

      {requiereMotivo ? (
        <div className="space-y-3 rounded-[14px] border border-warning/50 bg-warning/5 p-4">
          <p className="text-[16px] font-semibold">Hay diferencia con lo que debería haber: elegí la causa y escribí el motivo.</p>
          <div role="radiogroup" aria-label="Causa" className="grid gap-2 sm:grid-cols-2">
            {(Object.entries(CAUSE_LABEL) as [CashDifferenceCause, string][]).map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={cause === value}
                onClick={() => setCause(value)}
                className={cn(
                  "min-h-[56px] rounded-[12px] px-4 text-left text-[16px] font-semibold ring-1 transition-colors",
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
            <Label htmlFor="opening-note">Motivo (obligatorio)</Label>
            <Textarea id="opening-note" value={note} onChange={(event) => setNote(event.target.value)} />
          </div>
        </div>
      ) : null}

      <div className="space-y-2">
        <p className="text-[16px] font-semibold">Responsable de caja</p>
        <EmployeePicker
          value={responsibleId}
          onChange={(id) => setResponsibleId(id)}
          label="Responsable de caja"
          disabled={pending}
        />
      </div>

      {error ? (
        <p role="alert" className="text-[15px] font-semibold text-destructive">
          {error}
        </p>
      ) : null}

      <Button
        type="button"
        className="h-[64px] w-full rounded-[12px] text-[19px] font-bold"
        disabled={pending || bloqueo !== null || !listo}
        onClick={abrir}
      >
        <Check aria-hidden="true" className="size-[22px]" />
        {pending ? "Abriendo…" : (bloqueo ?? "Confirmar cuadre y abrir el turno")}
      </Button>

      <section
        aria-labelledby="base-respaldo"
        className="flex items-center gap-[14px] rounded-[14px] border border-dashed border-input px-4 py-[14px]"
      >
        <Vault aria-hidden="true" className="size-[26px] shrink-0 text-muted-foreground" />
        <div className="flex min-w-0 flex-1 flex-col">
          <h2 id="base-respaldo" className="text-[17px] font-bold">
            Base de respaldo
          </h2>
          <span className="text-[14px] text-muted-foreground">Va aparte y no entra al cuadre del turno.</span>
        </div>
        {conBase ? (
          <Button
            type="button"
            variant="outline"
            className="h-[56px] rounded-[12px] bg-card px-[18px] text-[16px] font-semibold"
            onClick={() => setContarBase(true)}
          >
            Contar base
          </Button>
        ) : null}
      </section>

      {conBase ? (
        <Sheet open={contarBase} onOpenChange={setContarBase}>
          <SheetContent
            side="right"
            showCloseButton={false}
            className="gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-2xl"
          >
            <div className="flex items-center gap-3 border-b p-3">
              <Button
                type="button"
                variant="outline"
                size="lg"
                className="min-h-14 gap-2 px-4 text-base"
                aria-label="Volver a la apertura"
                onClick={() => setContarBase(false)}
              >
                <ArrowLeft className="size-5" aria-hidden="true" />
                Apertura
              </Button>
              <div className="min-w-0">
                <SheetTitle className="text-xl font-semibold">Contar la base de respaldo</SheetTitle>
                <SheetDescription>La cuenta su custodio, a ciegas. No entra al cuadre del turno.</SheetDescription>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-4">
              <VerifyReservePanel onDone={() => setContarBase(false)} />
            </div>
          </SheetContent>
        </Sheet>
      ) : null}
    </div>
  );
}

/**
 * «✓ Cuadra», «Sobran $X» o «Faltan $X», con la cifra que mandó el servidor
 * (sin el signo: la palabra ya lo dice). Un sobrante se consigna con este
 * turno; un faltante queda como novedad. Nada se calcula acá.
 */
function DiferenciaApertura({ preview }: { preview: OpeningPreview }): React.JSX.Element {
  const d = preview.difference;
  if (d === null) return <></>;
  const cifra = formatCOP(d).replace("-", "");
  if (d === 0) {
    return (
      <p role="status" className="rounded-[12px] bg-success/15 px-4 py-3 text-[18px] font-bold text-success">
        ✓ Cuadra
      </p>
    );
  }
  const falta = d < 0;
  return (
    <div
      role="status"
      className={cn(
        "rounded-[12px] px-4 py-3",
        falta ? "bg-destructive/10 text-destructive" : "bg-warning/15 text-warning",
      )}
    >
      <p className="text-[18px] font-bold">
        <span aria-hidden="true">{falta ? "▼ " : "▲ "}</span>
        {falta ? `Faltan ${cifra}` : `Sobran ${cifra}`}
      </p>
      <p className="text-[14px]">
        {falta
          ? "El faltante queda como novedad justificada: los días anteriores lo siguen pidiendo."
          : "El sobrante se consigna con este turno."}
      </p>
    </div>
  );
}
