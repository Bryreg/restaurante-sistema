import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, ChevronRight, HandCoins, Lock, Mail, Vault } from "lucide-react";
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
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { formatClockTime } from "@/lib/businessDate";
import { errorMessage } from "@/lib/errors";
import { formatFechaCorta } from "@/lib/format";
import { DENOMINATIONS, formatCOP } from "@/lib/money";
import { cn } from "@/lib/utils";

import { CURRENT_SHIFT_QUERY_KEY, OPENING_INFO_QUERY_KEY } from "./hooks";
import { VerifyReservePanel } from "./ReservePanels";

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
  const { me, hasFeature } = useSession();
  const [contarBase, setContarBase] = useState(false);
  const queryClient = useQueryClient();

  const [paso, setPaso] = useState<Paso>(info.pending_count ? "revelado" : "elegir");
  // Con un conteo ya sellado (se recargó la pantalla), los sobres elegidos son los que se sellaron.
  const [elegidos, setElegidos] = useState<number[]>(() => (info.pending_count?.envelopes ?? []).map((s) => s.shift_id));
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
  const enCurso = paso === "contar" ? elegidosEnOrden[actual] : undefined;
  const ultimo = actual >= elegidosEnOrden.length - 1;
  const reveladoPorSobre = new Map((sellado?.envelopes ?? []).map((s) => [s.shift_id, s]));
  const conBase = Boolean(info.reserve_available) && hasFeature("cash.reserve");

  return (
    <div className="mx-auto flex max-w-[820px] flex-col gap-[18px]">
      <h1 className="sr-only">Apertura de caja</h1>
      <Pasos paso={paso} />

      <section aria-labelledby="sobres-elegir" className="flex flex-col gap-2.5">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <h2 id="sobres-elegir" className="text-[22px] font-extrabold [font-stretch:108%]">
            Consignaciones pendientes
          </h2>
          <span className="text-[15px] text-muted-foreground">Solo fecha · el monto lo ves después de sellar</span>
        </div>
        {sobres.length === 0 ? (
          <p className="rounded-[12px] border bg-card p-4 text-[16px] text-muted-foreground">
            No hay sobres por consignar: el cajón abre vacío.
          </p>
        ) : (
          <ul className="flex flex-col gap-2.5">
            {sobres.map((s) => {
              const recibido = elegidos.includes(s.shift_id);
              const indice = elegidosEnOrden.findIndex((e) => e.shift_id === s.shift_id);
              const contando = enCurso?.shift_id === s.shift_id;
              const revelado = paso === "revelado" && recibido ? reveladoPorSobre.get(s.shift_id) : undefined;
              let sub: string;
              let estado: EstadoSobre;
              if (revelado) {
                sub = `Contó ${sellado?.counted_by?.name ?? "—"} · ${formatClockTime(sellado?.counted_at)}`;
                estado = { tipo: "sellado", diferencia: revelado.difference };
              } else if (contando) {
                sub = "Abierto · contando ahora";
                estado = { tipo: "contando" };
              } else if (recibido && paso === "contar" && indice < actual) {
                sub = "Contado · se sella con los demás";
                estado = { tipo: "contado" };
              } else if (recibido) {
                sub = paso === "elegir" ? "Lo tenés en la mano" : "Falta contarlo";
                estado = { tipo: "por-contar" };
              } else {
                sub = paso === "elegir" ? "Tocá si lo tenés en la mano" : "No lo elegiste para hoy";
                estado = { tipo: "por-contar" };
              }
              return (
                <li key={s.shift_id}>
                  <button
                    type="button"
                    aria-pressed={recibido}
                    disabled={paso === "revelado" || pending}
                    onClick={() => toggle(s.shift_id)}
                    className={cn(
                      "flex min-h-[64px] w-full items-center gap-[14px] rounded-[12px] bg-card px-[14px] py-2 text-left transition-colors",
                      "focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none enabled:hover:bg-muted/60",
                      contando ? "border-2 border-primary" : "border",
                    )}
                  >
                    {/* La casilla y el sobre no tienen texto: el nombre
                        accesible empieza por la fecha. */}
                    <span
                      aria-hidden="true"
                      className={cn(
                        "grid size-[32px] shrink-0 place-items-center rounded-[8px] border-2 border-foreground",
                        recibido ? "bg-foreground text-background" : "bg-transparent text-transparent",
                      )}
                    >
                      <Check className="size-5" />
                    </span>
                    <Mail aria-hidden="true" className="size-6 shrink-0 text-muted-foreground" />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="text-[18px] font-bold">Sobre del {formatFechaCorta(s.business_date)}</span>
                      <span className="text-[14px] text-muted-foreground">{sub}</span>
                    </span>
                    <PastillaSobre estado={estado} />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {paso === "elegir" && elegidosEnOrden.length > 0 ? (
          <Button
            type="button"
            className="h-[64px] w-full rounded-[12px] text-[19px] font-bold"
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

      {paso === "contar" && enCurso ? (
        <section
          aria-labelledby="sobres-contar"
          className="flex flex-col gap-3 rounded-[14px] border-2 border-primary bg-card p-4"
        >
          <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
            <h2 id="sobres-contar" className="text-[22px] font-extrabold [font-stretch:108%]">
              Contando: sobre del {formatFechaCorta(enCurso.business_date)}
            </h2>
            <span className="text-[15px] text-muted-foreground">
              {elegidosEnOrden.length > 1 ? `${actual + 1} de ${elegidosEnOrden.length} · ` : ""}empezá por el billete
              grande
            </span>
          </div>
          <DenominationKeypad
            key={enCurso.shift_id}
            legend={`Sobre del ${formatFechaCorta(enCurso.business_date)}`}
            legendVisible={false}
            totalLabel="Total contado"
            nota="La diferencia de este sobre aparece al sellarlo, no antes."
            value={conteos[enCurso.shift_id] ?? emptyDenominations()}
            onChange={(next) => setConteos((prev) => ({ ...prev, [enCurso.shift_id]: next }))}
            disabled={pending}
            accion={
              <div className="flex flex-col gap-2">
                {ultimo ? (
                  <Button
                    type="button"
                    className="h-[64px] rounded-[12px] text-[19px] font-bold"
                    disabled={pending}
                    onClick={() => sealMutation.mutate()}
                  >
                    <Lock aria-hidden="true" className="size-[22px]" />
                    {sealMutation.isPending
                      ? "Sellando…"
                      : elegidosEnOrden.length === 1
                        ? "Sellar sobre"
                        : `Sellar los ${elegidosEnOrden.length} sobres`}
                  </Button>
                ) : (
                  <Button
                    type="button"
                    className="h-[64px] rounded-[12px] text-[19px] font-bold"
                    onClick={() => setActual(actual + 1)}
                  >
                    Siguiente sobre
                    <ChevronRight aria-hidden="true" className="size-[22px]" />
                  </Button>
                )}
                <Button
                  type="button"
                  variant="outline"
                  className="h-[56px] rounded-[12px] text-[16px]"
                  disabled={pending}
                  onClick={() => (actual === 0 ? setPaso("elegir") : setActual(actual - 1))}
                >
                  <ArrowLeft aria-hidden="true" className="size-5" />
                  {actual === 0 ? "Cambiar sobres" : "Sobre anterior"}
                </Button>
              </div>
            }
          />
        </section>
      ) : null}

      {paso === "revelado" && sellado ? <Revelacion count={sellado} /> : null}

      {paso === "revelado" && sellado?.requires_cause ? (
        <div className="space-y-3 rounded-[14px] border border-destructive/40 bg-destructive/5 p-4">
          <p className="text-[16px] font-semibold text-destructive">
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
            <Label htmlFor="envelope-open-note">Nota</Label>
            <Textarea id="envelope-open-note" value={note} onChange={(event) => setNote(event.target.value)} />
          </div>
        </div>
      ) : null}

      {paso === "revelado" || (paso === "elegir" && elegidosEnOrden.length === 0) ? (
        <div className="space-y-2">
          <p className="text-[16px] font-semibold">Responsable de caja</p>
          <EmployeePicker
            value={responsibleId}
            onChange={(id) => setResponsibleId(id)}
            label="Responsable de caja"
            disabled={pending}
          />
          <p className="text-[14px] text-muted-foreground">
            Por defecto, quien está identificado. Si abrís por alguien que todavía no llegó, después se la entregás
            con un relevo.
          </p>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="text-[15px] font-semibold text-destructive">
          {error}
        </p>
      ) : null}

      {paso === "revelado" ? (
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            className="h-[64px] rounded-[12px] px-5 text-[17px]"
            disabled={pending}
            onClick={() => reiniciar(null)}
          >
            Volver a contar
          </Button>
          <Button
            type="button"
            className="h-[64px] flex-1 rounded-[12px] text-[19px] font-bold"
            disabled={pending || (Boolean(sellado?.requires_cause) && cause === "")}
            onClick={abrir}
          >
            {openMutation.isPending ? "Abriendo…" : "Abrir turno"}
          </Button>
        </div>
      ) : null}

      {paso === "elegir" && elegidosEnOrden.length === 0 ? (
        <Button
          type="button"
          className="h-[64px] w-full rounded-[12px] text-[19px] font-bold"
          disabled={pending}
          onClick={abrir}
        >
          {openMutation.isPending ? "Abriendo…" : sobres.length === 0 ? "Abrir turno" : "Abrir sin sobres"}
        </Button>
      ) : null}

      <section
        aria-labelledby="base-respaldo"
        className="flex items-center gap-[14px] rounded-[14px] border border-dashed border-input px-4 py-[14px]"
      >
        <Vault aria-hidden="true" className="size-[26px] shrink-0 text-muted-foreground" />
        <div className="flex min-w-0 flex-1 flex-col">
          <h2 id="base-respaldo" className="text-[17px] font-bold">
            Base de respaldo
          </h2>
          <span className="text-[14px] text-muted-foreground">
            Va aparte y no entra al cuadre del turno. Se cuenta, se sella y se guarda.
          </span>
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

const PASOS = ["Elegir sobres", "Contar y sellar", "Ver diferencias"] as const;
const ORDEN_PASO: Record<Paso, number> = { elegir: 0, contar: 1, revelado: 2 };

/** Los tres pasos, arriba: hecho (✓), el de ahora (añil) y los que siguen. */
function Pasos({ paso }: { paso: Paso }): React.JSX.Element {
  const ahora = ORDEN_PASO[paso];
  return (
    <ol aria-label="Pasos de la apertura" className="flex gap-2">
      {PASOS.map((texto, i) => {
        const hecho = i < ahora;
        const actual = i === ahora;
        return (
          <li
            key={texto}
            aria-current={actual ? "step" : undefined}
            className={cn(
              "flex min-h-[52px] flex-1 items-center gap-2.5 rounded-[12px] px-[14px] text-[16px] font-semibold",
              actual ? "border-2 border-primary bg-accent" : "border bg-card",
            )}
          >
            <span
              aria-hidden="true"
              className={cn(
                "grid size-[28px] shrink-0 place-items-center rounded-full text-[14px] font-extrabold",
                hecho && "bg-success text-success-foreground",
                actual && "bg-primary text-primary-foreground",
                !hecho && !actual && "bg-muted text-muted-foreground",
              )}
            >
              {hecho ? <Check className="size-4" /> : i + 1}
            </span>
            <span>
              {texto}
              {hecho ? <span className="sr-only"> (hecho)</span> : null}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

type EstadoSobre =
  | { tipo: "por-contar" }
  | { tipo: "contando" }
  | { tipo: "contado" }
  | { tipo: "sellado"; diferencia: number | undefined };

/**
 * La pastilla de cada sobre. **Antes de sellar nunca lleva plata** (a
 * ciegas): «Por contar», «Contando», «Contado». Después de sellar dice lo
 * que reveló el servidor: «▼ Faltan $ 2.000», «▲ Sobran $ 500» o «Cuadra ·
 * $ 0». La palabra sale del signo que mandó el servidor y la cifra es ese
 * mismo valor escrito sin el signo (la palabra ya lo dice); no se resta ni
 * se suma nada. Sin diferencia del servidor, no se inventa un «cuadra».
 */
function PastillaSobre({ estado }: { estado: EstadoSobre }): React.JSX.Element {
  const base =
    "inline-flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-[15px] font-bold whitespace-nowrap";
  if (estado.tipo === "contando") {
    return (
      <span className={cn(base, "bg-accent text-accent-foreground")}>
        <HandCoins aria-hidden="true" className="size-4" />
        Contando
      </span>
    );
  }
  if (estado.tipo === "contado") {
    return (
      <span className={cn(base, "bg-muted text-muted-foreground")}>
        <Check aria-hidden="true" className="size-4" />
        Contado
      </span>
    );
  }
  if (estado.tipo === "por-contar") {
    return (
      <span className={cn(base, "bg-muted text-muted-foreground")}>
        <Mail aria-hidden="true" className="size-4" />
        Por contar
      </span>
    );
  }
  const d = estado.diferencia;
  if (d === undefined || d === null) {
    return (
      <span className={cn(base, "bg-muted text-muted-foreground")}>
        <Lock aria-hidden="true" className="size-4" />
        Sellado
      </span>
    );
  }
  if (d === 0) {
    return (
      <span className={cn(base, "bg-success/15 text-success")}>
        <Lock aria-hidden="true" className="size-4" />
        Cuadra · {formatCOP(0)}
      </span>
    );
  }
  const falta = d < 0;
  const cifra = formatCOP(d).replace("-", "");
  return (
    <span className={cn(base, falta ? "bg-destructive/15 text-destructive" : "bg-warning/20 text-warning")}>
      <Lock aria-hidden="true" className="size-4" />
      <span aria-hidden="true">{falta ? "▼" : "▲"}</span>
      {falta ? `Faltan ${cifra}` : `Sobran ${cifra}`}
    </span>
  );
}

/** Lo que el servidor reveló al sellar: por sobre, esperado, contado y diferencia, con quién contó. */
function Revelacion({ count }: { count: OpeningCount }): React.JSX.Element {
  const sobres = count.envelopes ?? [];
  return (
    <section aria-labelledby="sobres-revelado" className="space-y-3 rounded-[14px] border bg-card p-4">
      <h2 id="sobres-revelado" className="text-[22px] font-extrabold [font-stretch:108%]">
        Ver diferencias
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
