import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRightLeft, ChevronDown, ChevronUp } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";

import { deviceIdentify } from "@/api/auth";
import { ApiError, newIdempotencyKey } from "@/api/client";
import {
  createHandover,
  getHandoverCandidates,
  type FrozenBreakdown,
  type Handover,
  type HandoverCandidate,
  type HandoverKind,
} from "@/api/shifts";
import { useSession } from "@/app/session";
import { Cargando } from "@/components/Cargando";
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
import { cn } from "@/lib/utils";

import { PhotoCaptureField } from "./PhotoCaptureField";
import { PasoPastilla, TarjetaCierre } from "./closeUi";
import { CURRENT_SHIFT_QUERY_KEY, shiftSummaryQueryKey, useShiftSummary } from "./hooks";

function emptyDenominations(): Denomination[] {
  return DENOMINATIONS.map((value) => ({ value, count: 0 }));
}

const BREAKDOWN_LABEL: Record<string, string> = {
  base: "Apertura",
  cash_sales: "Ventas en efectivo",
  incomes: "Ingresos",
  expenses: "Egresos",
  pickups: "Retiros",
  // 2026-09-24: lo consignado desde el cajón sale del esperado; lo traído de
  // días anteriores es informativo (ya está dentro de la base).
  deposits: "Consignado desde el cajón",
  carried_in: "De días anteriores (en la apertura)",
  reserve_loan: "Prestado por la base de respaldo",
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

function handoverCandidatesQueryKey(shiftId: number) {
  return ["shifts", "handover-candidates", shiftId] as const;
}

/**
 * A quién se le entrega el cajón (`GET /shifts/{id}/handover-candidates`):
 * sólo quien puede manejar caja (permiso de cobrar, supervisor o admin), sin
 * el responsable actual. Primero, en grande, los que están en el turno; los
 * demás, detrás de «Otra persona con permiso de cobrar».
 */
function CandidatosRelevo({
  shiftId,
  value,
  onChange,
  label,
  disabled,
}: {
  shiftId: number;
  value: number | null;
  onChange: (candidato: HandoverCandidate) => void;
  label: string;
  disabled: boolean;
}): React.JSX.Element {
  const [verOtras, setVerOtras] = useState(false);
  const query = useQuery({
    queryKey: handoverCandidatesQueryKey(shiftId),
    queryFn: () => getHandoverCandidates(shiftId),
  });

  if (query.isLoading) return <Cargando texto="Buscando quién puede recibir la caja…" />;
  if (query.isError) {
    return (
      <EmptyState
        role="alert"
        title="No se pudo cargar quién puede recibir la caja"
        description={errorMessage(query.error)}
        action={{ label: "Reintentar", onClick: () => void query.refetch() }}
      />
    );
  }

  const candidatos = query.data ?? [];
  if (candidatos.length === 0) {
    return (
      <EmptyState
        title="No hay nadie más que pueda recibir la caja"
        description="Sólo recibe la caja quien tiene permiso de cobrar, o un supervisor. El administrador lo da en Equipo."
      />
    );
  }

  const enTurno = candidatos.filter((c) => c.on_shift);
  const otras = candidatos.filter((c) => !c.on_shift);
  // Nunca se esconde a la persona elegida, ni a todos cuando nadie del turno puede.
  const mostrarOtras = enTurno.length === 0 || verOtras || otras.some((c) => c.id === value);

  function tarjeta(c: HandoverCandidate, grande: boolean): React.JSX.Element {
    const checked = value === c.id;
    return (
      <button
        key={c.id}
        type="button"
        role="radio"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(c)}
        className={cn(
          "flex min-h-14 items-center rounded-md border px-4 py-3 text-left font-medium break-words transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
          grande && "min-h-16 text-lg",
          checked ? "border-primary bg-primary/10" : "border-border bg-background hover:bg-muted",
          disabled && "pointer-events-none opacity-50",
        )}
      >
        {c.name}
      </button>
    );
  }

  return (
    <div role="radiogroup" aria-label={label} className="space-y-3">
      {enTurno.length > 0 ? (
        <div className="grid grid-cols-2 gap-3">{enTurno.map((c) => tarjeta(c, true))}</div>
      ) : (
        <p className="text-sm text-muted-foreground">Nadie más con permiso de cobrar marcó entrada en este turno.</p>
      )}
      {otras.length > 0 && enTurno.length > 0 ? (
        <button
          type="button"
          aria-expanded={mostrarOtras}
          disabled={disabled}
          onClick={() => setVerOtras((prev) => !prev)}
          className="inline-flex min-h-11 items-center gap-2 rounded-md px-3 text-sm font-medium text-primary hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {mostrarOtras ? (
            <ChevronUp className="size-4" aria-hidden="true" />
          ) : (
            <ChevronDown className="size-4" aria-hidden="true" />
          )}
          Otra persona con permiso de cobrar
        </button>
      ) : null}
      {otras.length > 0 && mostrarOtras ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">{otras.map((c) => tarjeta(c, false))}</div>
      ) : null}
    </div>
  );
}

/** Lo que queda a la vista después de un relevo o un arqueo: no se vuelve solo al formulario vacío. */
interface ResultadoRelevo {
  handover: Handover;
  /** Sólo relevo: a quién pasó la caja. */
  recibe: HandoverCandidate | null;
  /** La tablet quedó a nombre de quien recibe (con el mismo PIN). */
  tabletCambio: boolean;
}

function TarjetaRelevo({
  resultado,
  onContinuar,
}: {
  resultado: ResultadoRelevo;
  onContinuar: () => void;
}): React.JSX.Element {
  const { handover, recibe, tabletCambio } = resultado;
  const esRelevo = handover.kind !== "spot_check";
  const nombreRecibe = handover.new_responsible?.name ?? recibe?.name ?? "quien recibe";
  return (
    <TarjetaCierre
      icono={<ArrowRightLeft />}
      titulo={esRelevo ? "Relevo registrado" : "Arqueo registrado"}
      acento="ok"
      pastilla={<PasoPastilla tono="listo">Hecho</PasoPastilla>}
      className="max-w-xl"
    >
      <div className="space-y-3 px-4 py-4">
        {esRelevo ? (
          <>
            <p className="text-lg font-semibold">
              La caja pasó de {handover.from_responsible?.name ?? "—"} a {nombreRecibe}.
            </p>
            <p className={cn("text-sm", tabletCambio ? "text-muted-foreground" : "font-medium")}>
              {tabletCambio
                ? `La tablet quedó a nombre de ${nombreRecibe}.`
                : `Que ${nombreRecibe} se identifique con su PIN antes de seguir.`}
            </p>
          </>
        ) : (
          <p className="text-lg font-semibold">Arqueo sorpresa registrado. El responsable sigue siendo el mismo.</p>
        )}
        <BreakdownCard breakdown={handover.breakdown} />
        <Button type="button" className="h-11" onClick={onContinuar}>
          Listo
        </Button>
      </div>
    </TarjetaCierre>
  );
}

/**
 * Relevo y arqueo sorpresa (`cash.handovers`, `POST /shifts/{id}/handovers`):
 * el relevo cambia de responsable, el arqueo sorpresa cuenta con PIN de
 * administrador sin cambiar a nadie. El desglose congelado que devuelve el
 * servidor (`breakdown`) se muestra tal cual — nunca se recalcula.
 *
 * **Inicio por rol** (2026-09-25):
 *
 * - «Nuevo responsable» lista sólo a quien puede recibir la caja
 *   (`CandidatosRelevo`), los del turno primero.
 * - **Quien recibe confirma con su PIN** (`new_responsible_pin`): el
 *   servidor lo verifica antes de escribir nada. Sin eso, cualquiera con la
 *   caja podía pasársela a otro sin que el otro se enterara.
 * - Al terminar queda una tarjeta con el resultado (como la del cierre), no
 *   el formulario vacío; y con ese mismo PIN la tablet pasa a nombre de
 *   quien recibe (`POST /auth/device/identify`). Si eso falla, la tarjeta
 *   pide que se identifique.
 */
export function HandoverPanel({ shiftId }: { shiftId: number }): React.JSX.Element {
  const queryClient = useQueryClient();
  const { refresh } = useSession();
  const summary = useShiftSummary(shiftId);

  const [kind, setKind] = useState<HandoverKind>("handover");
  const [counted, setCounted] = useState<Denomination[]>(emptyDenominations());
  const [countedCard, setCountedCard] = useState<number | null>(null);
  const [countedTransfer, setCountedTransfer] = useState<number | null>(null);
  const [recibe, setRecibe] = useState<HandoverCandidate | null>(null);
  const [handoverPin, setHandoverPin] = useState("");
  const [photo, setPhoto] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resultado, setResultado] = useState<ResultadoRelevo | null>(null);

  const idempotencyKeyRef = useRef(newIdempotencyKey());

  const mutation = useMutation({
    mutationFn: async (pins: { authorizerPin?: string; incomingPin?: string }): Promise<ResultadoRelevo> => {
      const total = counted.reduce((acc, d) => acc + d.value * d.count, 0);
      const handover = await createHandover(
        shiftId,
        {
          kind,
          counted_cash: { denominations: counted, total },
          counted_card: countedCard,
          counted_transfer: countedTransfer,
          new_responsible_id: kind === "handover" ? recibe?.id ?? undefined : undefined,
          new_responsible_pin: kind === "handover" ? pins.incomingPin : undefined,
          authorizer_pin: pins.authorizerPin,
          photo,
        },
        idempotencyKeyRef.current,
      );
      // Con el PIN que quien recibe acaba de teclear, la tablet pasa a su
      // nombre. Si no se puede, la tarjeta le pide que se identifique.
      let tabletCambio = false;
      if (kind === "handover" && recibe && pins.incomingPin) {
        try {
          await deviceIdentify({ employee_id: recibe.id, pin: pins.incomingPin });
          tabletCambio = true;
        } catch {
          tabletCambio = false;
        }
      }
      return { handover, recibe: kind === "handover" ? recibe : null, tabletCambio };
    },
    onSuccess: (result) => {
      toast.success(kind === "handover" ? "Relevo registrado." : "Arqueo sorpresa registrado.");
      setResultado(result);
      setError(null);
      idempotencyKeyRef.current = newIdempotencyKey();
      void queryClient.invalidateQueries({ queryKey: shiftSummaryQueryKey(shiftId) });
      void queryClient.invalidateQueries({ queryKey: CURRENT_SHIFT_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: handoverCandidatesQueryKey(shiftId) });
      if (result.tabletCambio) void refresh();
    },
    onError: (err) => {
      // El servidor ya contestó (PIN equivocado, falta permiso…): esa clave
      // quedó con su respuesta, y el próximo intento lleva otro cuerpo.
      if (err instanceof ApiError) idempotencyKeyRef.current = newIdempotencyKey();
      setError(errorMessage(err));
    },
  });

  function reiniciar() {
    setResultado(null);
    setCounted(emptyDenominations());
    setCountedCard(null);
    setCountedTransfer(null);
    setRecibe(null);
    setHandoverPin("");
    setPhoto(null);
    setError(null);
  }

  function handleIncomingPin(pin: string) {
    setError(null);
    if (!recibe) {
      setError("Elegí quién va a ser el nuevo responsable.");
      return;
    }
    // El PIN de autorización es opcional en un relevo normal.
    mutation.mutate({
      incomingPin: pin,
      authorizerPin: handoverPin.trim() === "" ? undefined : handoverPin.trim(),
    });
  }

  if (resultado) {
    return <TarjetaRelevo resultado={resultado} onContinuar={reiniciar} />;
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
          <div className="space-y-2">
            <p className="text-sm font-medium">Nuevo responsable</p>
            <CandidatosRelevo
              shiftId={shiftId}
              value={recibe?.id ?? null}
              onChange={(c) => {
                setRecibe(c);
                setError(null);
              }}
              label="Nuevo responsable"
              disabled={mutation.isPending}
            />
          </div>
        ) : null}

        <PhotoCaptureField value={photo} onChange={setPhoto} label="Foto (opcional)" />

        {kind === "handover" ? (
          <div className="space-y-4">
            <div className="space-y-1">
              <Label htmlFor="handover-auth-pin">PIN de autorización (opcional)</Label>
              <Input
                id="handover-auth-pin"
                type="password"
                inputMode="numeric"
                className="h-11 max-w-40"
                value={handoverPin}
                onChange={(event) => setHandoverPin(event.target.value)}
              />
            </div>
            <div className="flex flex-col items-center gap-3 rounded-md border p-4">
              <p className="text-center text-sm text-muted-foreground">
                {recibe
                  ? `${recibe.name} confirma que recibe la caja con su PIN. Así queda registrado el relevo.`
                  : "Elegí quién recibe la caja; después esa persona confirma con su PIN."}
              </p>
              <PinPad
                length={4}
                label="PIN de quien recibe la caja"
                disabled={mutation.isPending || !recibe}
                onSubmit={handleIncomingPin}
                errorMessage={error}
              />
              {mutation.isPending ? <p className="text-sm text-muted-foreground">Registrando…</p> : null}
            </div>
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
              onSubmit={(pin) => mutation.mutate({ authorizerPin: pin })}
              errorMessage={error}
            />
          </div>
        )}
      </div>

      {summary.isLoading ? (
        <Cargando texto="Cargando relevos…" />
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
