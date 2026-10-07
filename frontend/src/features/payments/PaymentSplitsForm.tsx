import { keepPreviousData, useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { useSession } from "@/app/session";
import { ApiError, newIdempotencyKey } from "@/api/client";
import type { OrderOut } from "@/api/orders";
import {
  PAYMENT_METHOD_LABEL,
  getTenderSuggestions,
  listDevicePaymentMethods,
  payOrder,
  previewChange,
  type DevicePaymentMethod,
  type PaymentMethod,
  type PaymentOut,
  type PaymentSplitIn,
  type PaymentTipIn,
} from "@/api/payments";
import { Cargando } from "@/components/Cargando";
import { EmptyState } from "@/components/EmptyState";
import { MoneyInput } from "@/components/MoneyInput";
import { PinPad } from "@/components/PinPad";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { errorMessage } from "@/lib/errors";
import { DENOMINATIONS, formatCOP } from "@/lib/money";
import { cn } from "@/lib/utils";

import { sumTyped } from "./lib";

interface SplitRow {
  key: number;
  method: PaymentMethod;
  amount: number | null;
  tendered: number | null;
  reference: string;
  /** `true` en cuanto alguien escribe el monto: deja de seguir al total. */
  amountTouched: boolean;
}

let rowSeq = 0;
function newRow(method: PaymentMethod, amount: number | null = null, amountTouched = false): SplitRow {
  rowSeq += 1;
  return { key: rowSeq, method, amount, tendered: null, reference: "", amountTouched };
}

export interface InitialSplit {
  method: PaymentMethod;
  amount: number;
}

export interface PaymentSplitsFormProps {
  orderId: number;
  expectedVersion?: number;
  subAccountId?: number;
  /** `totals.total + tip.amount` de lo que se está cobrando — el total grande y la guía "faltan $X". */
  totalDue: number;
  /** El rótulo sobre el total grande. Por defecto «Total a cobrar». */
  rotuloTotal?: string;
  /**
   * Por qué todavía no se puede cobrar (p. ej. falta responder la propina).
   * La tabla se ve igual —el handoff la quiere siempre a la vista— pero
   * «Cobrar» queda deshabilitado y lo dice.
   */
  bloqueo?: string | null;
  tip?: PaymentTipIn;
  /** Prellena filas (p. ej. desde `bill/split` en partes iguales). Sólo se usa al montar. */
  initialSplits?: InitialSplit[];
  onPaid: (result: PaymentOut) => void;
  onStale: (order: OrderOut) => void;
  onAlreadyPaid: () => void;
}

const CASH_SHORTCUTS = DENOMINATIONS.filter((value) => value >= 1000);

/**
 * El cobro (handoff `design_handoff_pos_burbujas`, 9d; CONTRATO-INTERNO-1b-1.md
 * §2.4), en DOS burbujas que `CheckoutPage` pone al lado de la cuenta:
 *
 * - **Pago**: el total en 64/500, el medio en un segmentado de 60 px (los
 *   **habilitados en la sede**, `GET /device/payment-methods`), «Recibido»
 *   en un pozo de 64 px con «Exacto» y los billetes siguientes del servidor
 *   (`GET /payments/tender-suggestions`) al lado, y al pie el pozo del vuelto
 *   (rojo suave si falta). «Sumar billetes» y «Agregar pago» (pago mixto, una
 *   fila por medio) van chicos, como segunda mano.
 * - **PIN**: «PIN de Ana para cobrar», los puntos, el teclado de 60 px y
 *   «Cobrar $ X» de 72 px, que se pinta en `primary` sólo con el pago
 *   completo, el vuelto en cero o más y el PIN.
 *
 * **Nada de plata se calcula acá** salvo la excepción declarada: lo tecleado
 * en los `splits` (`sumTyped`) para la guía "faltan $X". El vuelto y lo que
 * falta recibir los dice el servidor (`POST /payments/change-preview`, la
 * misma cuenta del cobro); con un medio distinto de efectivo el vuelto «No
 * aplica». Pagos mixtos: «Agregar pago» abre una fila por medio.
 */
export function PaymentSplitsForm({
  orderId,
  expectedVersion,
  subAccountId,
  totalDue,
  rotuloTotal = "Total a cobrar",
  bloqueo = null,
  tip,
  initialSplits,
  onPaid,
  onStale,
  onAlreadyPaid,
}: PaymentSplitsFormProps): React.JSX.Element {
  const { me } = useSession();
  const chargerName = me?.employee?.name ?? null;
  const methodsQuery = useQuery({
    queryKey: ["device-payment-methods"],
    queryFn: listDevicePaymentMethods,
  });
  const methods: DevicePaymentMethod[] = useMemo(() => methodsQuery.data ?? [], [methodsQuery.data]);

  const [splits, setSplits] = useState<SplitRow[]>([]);
  const seededRef = useRef(false);

  // Se siembra la primera fila recién cuando se sabe qué medios ofrecer
  // (nunca "cash" a ciegas): con `initialSplits` (p. ej. partes iguales de
  // `bill/split`) se respeta el medio que ya trae cada parte.
  useEffect(() => {
    if (seededRef.current || methods.length === 0) return;
    seededRef.current = true;
    setSplits(
      initialSplits && initialSplits.length > 0
        ? initialSplits.map((s) => newRow(s.method, s.amount, true))
        : // La primera fila arranca con lo que hay que cobrar: el sistema ya
          // lo sabe, y es el número que más fácil se teclea mal con cola en
          // la caja. Sigue siendo editable (pago dividido).
          [newRow(methods[0].code, totalDue > 0 ? totalDue : null)],
    );
  }, [methods, initialSplits, totalDue]);

  // Si el total cambia después de sembrar (p. ej. se modifica la propina), la
  // fila que nadie tocó lo sigue; una que ya se editó a mano, nunca.
  useEffect(() => {
    if (!seededRef.current) return;
    setSplits((prev) => {
      if (prev.length !== 1 || prev[0]!.amountTouched) return prev;
      const fila = prev[0]!;
      const monto = totalDue > 0 ? totalDue : null;
      return fila.amount === monto ? prev : [{ ...fila, amount: monto }];
    });
  }, [totalDue]);

  const [error, setError] = useState<string | null>(null);
  const idempotencyKeyRef = useRef(newIdempotencyKey());
  // El PIN se retiene hasta tocar «Cobrar»; para empezar de cero se vuelve a
  // montar el teclado (`pinKey`).
  const [pin, setPin] = useState("");
  const [pinKey, setPinKey] = useState(0);
  const [showBills, setShowBills] = useState(false);

  const typedTotal = sumTyped(splits.map((s) => ({ amount: s.amount })));
  const remaining = totalDue - typedTotal;
  const complete = remaining === 0;

  // El vuelto lo calcula el SERVIDOR (`POST /payments/change-preview`, la
  // misma cuenta del cobro): así lo que la cajera le dice al cliente antes de
  // cobrar es exactamente lo que queda en el comprobante. Sólo las filas de
  // efectivo con monto y recibido.
  const filasConRecibido = splits.filter(
    (row) => row.method === "cash" && row.amount !== null && row.amount > 0 && row.tendered !== null,
  );
  const cuerpoVuelto = filasConRecibido.map((row) => ({ amount: row.amount ?? 0, tendered: row.tendered ?? 0 }));
  // Se pregunta cuando la cajera deja de teclear (300 ms), no en cada dígito.
  // Mientras llega la nueva respuesta queda la anterior, atenuada.
  const claveVuelto = JSON.stringify(cuerpoVuelto);
  const [claveDiferida, setClaveDiferida] = useState(claveVuelto);
  useEffect(() => {
    const id = window.setTimeout(() => setClaveDiferida(claveVuelto), 300);
    return () => window.clearTimeout(id);
  }, [claveVuelto]);
  const cuerpoDiferido = JSON.parse(claveDiferida) as { amount: number; tendered: number }[];
  const vueltoQuery = useQuery({
    queryKey: ["payments", "change-preview", claveDiferida],
    queryFn: () => previewChange(cuerpoDiferido),
    enabled: cuerpoDiferido.length > 0 && cuerpoVuelto.length > 0,
    staleTime: Infinity,
    placeholderData: keepPreviousData,
  });
  const vueltoViejo = vueltoQuery.isPlaceholderData || claveDiferida !== claveVuelto;
  const vueltoDeFila = new Map(
    filasConRecibido.map((row, index) => [row.key, vueltoQuery.data?.splits[index]] as const),
  );
  const hayVuelto = cuerpoVuelto.length > 0 && vueltoQuery.data !== undefined;

  const filasEfectivo = splits.filter((row) => row.method === "cash" && row.amount !== null && row.amount > 0);
  const faltantes = filasConRecibido
    .map((row) => vueltoDeFila.get(row.key))
    .filter((preview) => preview !== undefined && preview.change === null);
  const efectivoListo =
    filasEfectivo.every((row) => row.tendered !== null) &&
    (filasEfectivo.length === 0 || (hayVuelto && !vueltoViejo && faltantes.length === 0));

  function updateRow(key: number, patch: Partial<SplitRow>) {
    setSplits((prev) => prev.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  }

  function removeRow(key: number) {
    setSplits((prev) => prev.filter((row) => row.key !== key));
  }

  const mutation = useMutation({
    mutationFn: (pinCobro: string) => {
      const body = {
        expected_version: expectedVersion,
        sub_account_id: subAccountId,
        pin: pinCobro,
        tip,
        splits: splits
          .filter((row) => row.amount !== null && row.amount > 0)
          .map<PaymentSplitIn>((row) => ({
            method: row.method,
            amount: row.amount ?? 0,
            tendered: row.method === "cash" && row.tendered !== null ? row.tendered : undefined,
            reference: row.reference.trim() === "" ? undefined : row.reference.trim(),
          })),
      };
      return payOrder(orderId, body, idempotencyKeyRef.current);
    },
    onSuccess: (result) => {
      setError(null);
      // A-10: `amount_due` (venta + propina) llega ya sumado por el
      // servidor — se pinta tal cual, nunca se recalcula acá.
      const dueText = result.amount_due != null ? ` Cobrado: ${formatCOP(result.amount_due)}.` : "";
      const changeText = result.change ? ` Cambio: ${formatCOP(result.change)}.` : "";
      toast.success(`Cobro registrado.${dueText}${changeText}`);
      onPaid(result);
    },
    onError: (err) => {
      // El cuerpo del próximo intento puede cambiar (otro PIN, otros
      // splits, otra versión): clave nueva — la cuenta se conserva tal cual
      // estaba (AGENTS.md, "un cobro que falla conserva la cuenta"). El PIN
      // se vuelve a teclear.
      idempotencyKeyRef.current = newIdempotencyKey();
      setPin("");
      setPinKey((k) => k + 1);
      if (err instanceof ApiError && err.code === "STALE_VERSION" && err.extra.order) {
        onStale(err.extra.order as OrderOut);
      } else if (err instanceof ApiError && err.code === "ORDER_ALREADY_PAID") {
        onAlreadyPaid();
      }
      setError(errorMessage(err));
    },
  });

  if (methodsQuery.isLoading) {
    return <Cargando texto="Cargando medios de pago…" />;
  }

  if (methodsQuery.isError) {
    return (
      <EmptyState
        role="alert"
        title="No se pudieron cargar los medios de pago de la sede"
        description={errorMessage(methodsQuery.error)}
        action={{ label: "Reintentar", onClick: () => void methodsQuery.refetch() }}
      />
    );
  }

  if (methods.length === 0) {
    return (
      <EmptyState
        role="alert"
        title="Esta sede no tiene medios de pago habilitados"
        description="Configurá al menos un medio de pago en Admin → Configuración antes de cobrar."
      />
    );
  }

  const single = splits.length === 1 ? splits[0]! : null;
  const pinListo = pin.length === 4;
  const puedeCobrar = complete && efectivoListo && pinListo && !mutation.isPending && !bloqueo && splits.length > 0;

  // El pozo del vuelto, al pie de la burbuja de pago: «Vuelto», «Falta
  // recibir» (rojo) o «Vuelto · no aplica».
  let estado: { rotulo: string; valor: string; tono: "neutro" | "ok" | "falta" };
  if (filasEfectivo.length === 0) {
    estado = { rotulo: "Vuelto · no aplica", valor: "—", tono: "neutro" };
  } else if (faltantes.length === 1) {
    estado = { rotulo: "Falta recibir", valor: formatCOP(faltantes[0]!.short_by), tono: "falta" };
  } else if (faltantes.length > 1) {
    estado = { rotulo: "Falta recibir", valor: `en ${faltantes.length} pagos`, tono: "falta" };
  } else if (complete && hayVuelto && vueltoQuery.data && filasEfectivo.every((row) => row.tendered !== null)) {
    estado = { rotulo: "Vuelto", valor: formatCOP(vueltoQuery.data.change_total), tono: "ok" };
  } else {
    estado = { rotulo: "Vuelto", valor: "—", tono: "neutro" };
  }

  const ayuda = bloqueo
    ? bloqueo
    : !complete
      ? "Completá los pagos para poder cobrar."
      : !efectivoListo
        ? "Tocá cuánto te entregó el cliente."
        : !pinListo
          ? "Falta tu PIN para confirmar."
          : "Listo para cobrar.";

  const nombrePin = chargerName ? chargerName.split(" ")[0] : null;

  return (
    <>
      <section aria-label="Pago" className="flex min-w-0 flex-col gap-5 rounded-[24px] bg-card p-6 lg:min-h-0 lg:overflow-y-auto">
        <h2 className="sr-only">Pagos</h2>
        <div className="flex flex-col gap-1">
          <span className="text-sm text-muted-foreground">{rotuloTotal}</span>
          <b className="text-[64px] leading-none font-medium tracking-[-0.035em] tabular-nums">{formatCOP(totalDue)}</b>
        </div>

        {single ? (
          <>
            <div className="flex flex-col gap-2">
              <span className="text-sm text-muted-foreground">Medio de pago</span>
              <MethodButtons
                label="Medio"
                methods={methods}
                value={single.method}
                onChange={(method) => updateRow(single.key, { method })}
              />
            </div>
            <div className="flex flex-col gap-2">
              {single.method === "cash" ? (
                <Label htmlFor={`tendered-${single.key}`} className="text-sm font-normal text-muted-foreground">
                  Recibido
                </Label>
              ) : (
                <span className="text-sm text-muted-foreground">Recibido</span>
              )}
              <div className="flex items-center gap-2">
                <div className="flex h-16 min-w-0 flex-1 items-center rounded-[18px] bg-muted px-5">
                  {single.method === "cash" ? (
                    <MoneyInput
                      id={`tendered-${single.key}`}
                      value={single.tendered}
                      onChange={(value) => updateRow(single.key, { tendered: value })}
                      placeholder="$ 0"
                      className="h-12 min-w-0 border-0 bg-transparent px-0 text-[26px] font-medium shadow-none placeholder:text-muted-foreground focus-visible:ring-2 md:text-[26px] dark:bg-transparent"
                    />
                  ) : (
                    <b className="text-[26px] font-medium tabular-nums">{formatCOP(single.amount)}</b>
                  )}
                </div>
                {single.method === "cash" ? (
                  <TenderShortcuts
                    amount={single.amount}
                    tendered={single.tendered}
                    onPick={(value) => updateRow(single.key, { tendered: value })}
                  />
                ) : null}
              </div>
            </div>
            {methods.find((m) => m.code === single.method)?.requires_reference ? (
              <ReferenceField row={single} onChange={(patch) => updateRow(single.key, patch)} />
            ) : null}
          </>
        ) : (
          <div className="flex flex-col gap-2">
            {splits.map((row, index) => (
              <PaymentRow
                key={row.key}
                row={row}
                index={index}
                methods={methods}
                onChange={(patch) => updateRow(row.key, patch)}
                onRemove={() => removeRow(row.key)}
                vuelto={
                  row.method === "cash" && row.tendered !== null && hayVuelto ? (
                    <VueltoDeFila preview={vueltoDeFila.get(row.key)} viejo={vueltoViejo} />
                  ) : null
                }
              />
            ))}
          </div>
        )}

        {/* Lo de segunda mano, en una fila chica: sumar billetes distintos y
            dividir el pago entre medios. */}
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            {single?.method === "cash" ? (
              <button
                type="button"
                className={botonChico}
                aria-expanded={showBills}
                onClick={() => setShowBills((v) => !v)}
              >
                {showBills ? "Ocultar billetes" : "Sumar billetes"}
              </button>
            ) : null}
            <button
              type="button"
              className={botonChico}
              onClick={() =>
                // Lo que falta, que es lo que casi siempre va en la fila nueva.
                setSplits((prev) => [...prev, newRow(methods[0].code, remaining > 0 ? remaining : null)])
              }
            >
              Agregar pago
            </button>
            {single ? null : (
              <p className="ml-auto text-sm font-medium text-muted-foreground tabular-nums" role="status">
                {remaining > 0
                  ? `Faltan ${formatCOP(remaining)}`
                  : remaining < 0
                    ? `Sobran ${formatCOP(-remaining)}`
                    : "Completo"}
              </p>
            )}
          </div>
          {single?.method === "cash" && showBills ? (
            <BillAdders tendered={single.tendered} onChange={(value) => updateRow(single.key, { tendered: value })} />
          ) : null}
        </div>

        <div
          role="status"
          data-testid="cobro-vuelto"
          className={cn(
            "mt-auto flex items-baseline justify-between gap-3 rounded-[20px] px-5 py-[18px]",
            estado.tono === "falta" ? "bg-destructive-soft text-destructive" : "bg-muted",
            vueltoViejo && estado.tono !== "neutro" && "opacity-50",
          )}
        >
          <span className="text-base font-semibold">{estado.rotulo}</span>
          <b className="text-[40px] leading-none font-medium tracking-[-0.02em] tabular-nums">{estado.valor}</b>
        </div>
      </section>

      {/* Cobrar pide el PIN aunque haya persona activa (SPEC-NEGOCIO §2.1:
          una tablet abandonada no vende a nombre de quien la dejó). El
          teclado ignora las teclas que van a otro campo (`PinPad`). */}
      <section aria-label="PIN" className="flex flex-col gap-3.5 rounded-[24px] bg-card p-5">
        <span className="text-center text-sm text-muted-foreground">
          {nombrePin ? (
            <>
              PIN de <b className="font-normal">{nombrePin}</b> para cobrar
            </>
          ) : (
            "PIN de quien cobra"
          )}
        </span>
        <PinPad
          key={pinKey}
          length={4}
          label="PIN propio para cobrar"
          burbuja="cobro"
          holdValue
          onChange={setPin}
          onSubmit={() => {}}
          disabled={mutation.isPending}
        />
        {error ? (
          <p role="alert" className="text-center text-sm font-medium text-destructive">
            {error}
          </p>
        ) : null}
        <div className="mt-auto flex flex-col gap-2">
          <button
            type="button"
            className={cn(
              "h-[72px] rounded-[20px] text-lg font-semibold transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
              puedeCobrar ? "bg-primary text-primary-foreground hover:bg-primary/90" : "bg-muted text-muted-foreground",
            )}
            disabled={!puedeCobrar}
            onClick={() => mutation.mutate(pin)}
          >
            {mutation.isPending ? "Cobrando…" : `Cobrar ${formatCOP(totalDue)}`}
          </button>
          <p className="text-center text-[13px] text-muted-foreground">{ayuda}</p>
        </div>
      </section>
    </>
  );
}

/** Los botones de segunda mano del pago: pastilla gris de 44 px. */
const botonChico =
  "h-11 rounded-full bg-muted px-4 text-sm font-semibold transition-colors hover:bg-fill-strong focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none";

/**
 * Los medios de pago de la sede en un interruptor segmentado (radio): un
 * toque, no dos. Hasta cinco por fila, de 60 px (56 en un pago mixto).
 */
function MethodButtons({
  label,
  methods,
  value,
  chico = false,
  onChange,
}: {
  label: string;
  methods: DevicePaymentMethod[];
  value: PaymentMethod;
  chico?: boolean;
  onChange: (method: PaymentMethod) => void;
}): React.JSX.Element {
  const labelId = useId();
  return (
    <>
      <span id={labelId} className="sr-only">
        {label}
      </span>
      <div
        role="radiogroup"
        aria-labelledby={labelId}
        className={cn("grid gap-1 p-1", chico ? "rounded-2xl bg-card" : "rounded-[18px] bg-muted")}
        style={{ gridTemplateColumns: `repeat(${Math.min(methods.length, 5)}, minmax(0, 1fr))` }}
      >
        {methods.map((method) => {
          const selected = value === method.code;
          return (
            <button
              key={method.code}
              type="button"
              role="radio"
              aria-checked={selected}
              className={cn(
                "min-w-0 truncate rounded-[14px] px-2 text-sm transition-colors",
                "focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                chico ? "h-12" : "h-[60px]",
                selected
                  ? cn("font-semibold text-foreground shadow-[0_1px_2px_rgb(0_0_0/8%)]", chico ? "bg-muted" : "bg-card")
                  : "font-medium text-foreground",
              )}
              onClick={() => onChange(method.code)}
            >
              {method.label || PAYMENT_METHOD_LABEL[method.code] || method.code}
            </button>
          );
        })}
      </div>
    </>
  );
}

function ReferenceField({ row, onChange }: { row: SplitRow; onChange: (patch: Partial<SplitRow>) => void }) {
  return (
    <div className="space-y-1">
      <Label htmlFor={`reference-${row.key}`} className="text-sm font-normal text-muted-foreground">
        Referencia (si aplica)
      </Label>
      <Input
        id={`reference-${row.key}`}
        className="h-12 rounded-[14px] border-0 bg-muted text-base"
        value={row.reference}
        onChange={(event) => onChange({ reference: event.target.value })}
      />
    </div>
  );
}

/** Los billetes que se van sumando: para cuando el cliente entrega varios distintos. */
function BillAdders({
  tendered,
  onChange,
}: {
  tendered: number | null;
  onChange: (value: number | null) => void;
}): React.JSX.Element {
  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label="Sumar billetes a lo recibido">
      {CASH_SHORTCUTS.map((bill) => (
        <button
          key={bill}
          type="button"
          className={cn(botonChico, "px-3 tabular-nums")}
          onClick={() => onChange((tendered ?? 0) + bill)}
        >
          +{formatCOP(bill)}
        </button>
      ))}
      <button type="button" className={cn(botonChico, "bg-transparent px-3")} onClick={() => onChange(null)}>
        Limpiar
      </button>
    </div>
  );
}

/**
 * Una fila de pago de un cobro mixto: el medio, el monto y, en efectivo, lo
 * recibido con sus atajos. Con una sola fila la pantalla usa la forma grande
 * del handoff; esta es la de varias.
 */
function PaymentRow({
  row,
  index,
  methods,
  onChange,
  onRemove,
  vuelto,
}: {
  row: SplitRow;
  index: number;
  methods: DevicePaymentMethod[];
  onChange: (patch: Partial<SplitRow>) => void;
  onRemove: () => void;
  vuelto: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2.5 rounded-[18px] bg-muted p-3.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[15px] font-semibold">Pago {index + 1}</span>
        <button type="button" className={cn(botonChico, "bg-card")} aria-label="Quitar este pago" onClick={onRemove}>
          Quitar
        </button>
      </div>
      <MethodButtons
        label={`Pago ${index + 1} · medio`}
        methods={methods}
        value={row.method}
        chico
        onChange={(method) => onChange({ method })}
      />
      <div className={cn("grid gap-2", row.method === "cash" && "grid-cols-2")}>
        <div className="space-y-1">
          <Label htmlFor={`amount-${row.key}`} className="text-[13px] font-normal text-muted-foreground">
            Monto
          </Label>
          <MoneyInput
            id={`amount-${row.key}`}
            value={row.amount}
            onChange={(value) => onChange({ amount: value, amountTouched: true })}
          />
        </div>
        {row.method === "cash" ? (
          <div className="space-y-1">
            <Label htmlFor={`tendered-${row.key}`} className="text-[13px] font-normal text-muted-foreground">
              Recibido
            </Label>
            <MoneyInput
              id={`tendered-${row.key}`}
              value={row.tendered}
              onChange={(value) => onChange({ tendered: value })}
            />
          </div>
        ) : null}
      </div>
      {row.method === "cash" ? (
        <>
          <TenderShortcuts
            compact
            amount={row.amount}
            tendered={row.tendered}
            onPick={(value) => onChange({ tendered: value })}
          />
          {vuelto}
        </>
      ) : null}
      {methods.find((m) => m.code === row.method)?.requires_reference ? (
        <ReferenceField row={row} onChange={onChange} />
      ) : null}
    </div>
  );
}

/**
 * «Exacto · $ 160.000 · $ 200.000»: lo que el cliente entrega casi siempre,
 * a un toque, en botones de 64 px al lado de «Recibido»; el elegido va en
 * tinta. Las cifras redondas las calcula el servidor (`GET
 * /payments/tender-suggestions`); «Exacto» es el monto de la fila tal cual,
 * sin cuenta.
 */
function TenderShortcuts({
  compact = false,
  amount,
  tendered,
  onPick,
}: {
  compact?: boolean;
  amount: number | null;
  tendered: number | null;
  onPick: (value: number) => void;
}): React.JSX.Element | null {
  const [deferred, setDeferred] = useState(amount);
  useEffect(() => {
    const id = window.setTimeout(() => setDeferred(amount), 300);
    return () => window.clearTimeout(id);
  }, [amount]);
  const query = useQuery({
    queryKey: ["payments", "tender-suggestions", deferred],
    queryFn: () => getTenderSuggestions(deferred ?? 0),
    enabled: deferred !== null && deferred > 0,
    staleTime: Infinity,
  });
  if (amount === null || amount <= 0) return null;
  // Sugerencias de otro monto (todavía se está tecleando) no se ofrecen.
  const suggestions = deferred === amount ? (query.data?.suggestions ?? []).slice(0, 2) : [];
  const botonClass = (on: boolean) =>
    cn(
      "shrink-0 px-4 text-sm font-semibold whitespace-nowrap tabular-nums transition-colors",
      "focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
      compact ? "h-12 rounded-[14px]" : "h-16 rounded-[18px]",
      on ? "bg-foreground text-card" : compact ? "bg-card text-foreground" : "bg-muted text-foreground hover:bg-fill-strong",
    );
  return (
    <div className="flex flex-wrap gap-2" role="group" aria-label="Recibido en un toque">
      <button
        type="button"
        aria-pressed={tendered === amount}
        className={botonClass(tendered === amount)}
        onClick={() => onPick(amount)}
      >
        Exacto
      </button>
      {suggestions.map((value) => (
        <button
          key={value}
          type="button"
          aria-pressed={tendered === value}
          className={botonClass(tendered === value)}
          onClick={() => onPick(value)}
        >
          {formatCOP(value)}
        </button>
      ))}
    </div>
  );
}

/** El vuelto de una fila de efectivo (cobro mixto), tal como lo devolvió el servidor. */
function VueltoDeFila({
  preview,
  viejo,
}: {
  preview: { change: number | null; short_by: number | null } | undefined;
  /** La respuesta es de lo tecleado hace un momento: se atenúa hasta que llegue la nueva. */
  viejo: boolean;
}): React.JSX.Element | null {
  if (!preview) {
    return <p className="pt-1 text-sm text-muted-foreground">Calculando el vuelto…</p>;
  }
  if (preview.change === null) {
    return (
      <p className={cn("pt-1 text-sm font-semibold text-destructive", viejo && "opacity-50")} role="alert">
        Lo recibido no alcanza: faltan {formatCOP(preview.short_by)}
      </p>
    );
  }
  return (
    <p className={cn("flex items-baseline gap-2 pt-1", viejo && "opacity-50")}>
      <span className="text-sm text-muted-foreground">Vuelto</span>
      <span className="text-xl font-bold tabular-nums">{formatCOP(preview.change)}</span>
    </p>
  );
}
