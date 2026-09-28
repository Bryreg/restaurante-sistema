import { keepPreviousData, useMutation, useQuery } from "@tanstack/react-query";
import { Banknote, Check, CreditCard, Landmark, Smartphone, Ticket, Wallet } from "lucide-react";
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
import { Button } from "@/components/ui/button";
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

/** El ícono del medio: por código, y las billeteras del celular por su nombre en la sede. */
function methodIcon(method: DevicePaymentMethod): typeof Banknote {
  if (/nequi|daviplata|billetera/i.test(method.label)) return Smartphone;
  switch (method.code) {
    case "cash":
      return Banknote;
    case "card":
      return CreditCard;
    case "transfer":
      return Landmark;
    case "voucher":
      return Ticket;
    default:
      return Wallet;
  }
}

function methodLabel(methods: DevicePaymentMethod[], code: PaymentMethod): string {
  const found = methods.find((m) => m.code === code);
  return found?.label || PAYMENT_METHOD_LABEL[code] || code;
}

/**
 * El cobro (handoff `PosCobro`, columna derecha; CONTRATO-INTERNO-1b-1.md
 * §2.4): el total grande de 60 px, la caja de «Vuelto» o «Falta recibir», los
 * medios de pago **habilitados en la sede** (`GET /device/payment-methods`,
 * botones de 64 px), los montos rápidos (`GET /payments/tender-suggestions`:
 * «Exacto» y los billetes siguientes, del servidor), y siempre a la vista
 * «Recibido», el teclado de PIN de 3 × 56 y «Cobrar $ X» de 72 px, que se
 * habilita sólo con el pago completo y el PIN.
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

  // La caja de arriba a la derecha: «Vuelto», «Falta recibir» (roja) o «No aplica».
  let estado: { rotulo: string; valor: string; tono: "neutro" | "ok" | "falta" };
  if (filasEfectivo.length === 0) {
    estado = { rotulo: "Vuelto", valor: "No aplica", tono: "neutro" };
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

  return (
    <div className="flex flex-col gap-3">
      <h2 className="sr-only">Pagos</h2>

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex min-w-0 flex-col">
          <span className="text-[14px] tracking-[0.08em] text-muted-foreground uppercase">{rotuloTotal}</span>
          <b className="text-[60px] leading-none font-extrabold tracking-[-0.02em] tabular-nums [font-stretch:108%]">
            {formatCOP(totalDue)}
          </b>
        </div>
        <div
          role="status"
          className={cn(
            "flex min-w-[230px] flex-col items-end gap-0.5 rounded-lg border px-3.5 py-2.5",
            estado.tono === "ok" && "border-success bg-success/14",
            estado.tono === "falta" && "border-destructive bg-destructive/10",
            estado.tono === "neutro" && "border-border bg-card",
            vueltoViejo && estado.tono !== "neutro" && "opacity-50",
          )}
        >
          <span className="text-[14px] text-muted-foreground">{estado.rotulo}</span>
          <b
            className={cn(
              "text-[30px] leading-tight tabular-nums",
              estado.tono === "falta" && "text-destructive",
              estado.tono === "neutro" && "text-muted-foreground",
            )}
          >
            {estado.valor}
          </b>
        </div>
      </div>

      {single ? (
        <>
          <MethodButtons
            label="Medio"
            methods={methods}
            value={single.method}
            size="grande"
            onChange={(method) => updateRow(single.key, { method })}
          />
          <TenderShortcuts
            enabled={single.method === "cash"}
            amount={single.amount}
            tendered={single.tendered}
            onPick={(value) => updateRow(single.key, { tendered: value })}
          />
        </>
      ) : null}

      <div className="grid min-h-0 flex-1 gap-4 md:grid-cols-[minmax(0,1fr)_256px]">
        <div className="flex min-w-0 flex-col justify-end gap-2.5">
          {single ? null : (
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

          <div className="flex flex-wrap items-end gap-2">
            {single ? (
              <div className="min-w-0 flex-1 space-y-1">
                <Label htmlFor={`amount-${single.key}`} className="text-[14px] text-muted-foreground">
                  Monto
                </Label>
                <MoneyInput
                  id={`amount-${single.key}`}
                  value={single.amount}
                  onChange={(value) => updateRow(single.key, { amount: value, amountTouched: true })}
                />
              </div>
            ) : null}
            <Button
              type="button"
              variant="outline"
              className="h-[56px] px-4 text-[15px]"
              onClick={() =>
                // Lo que falta, que es lo que casi siempre va en la fila nueva.
                setSplits((prev) => [...prev, newRow(methods[0].code, remaining > 0 ? remaining : null)])
              }
            >
              Agregar pago
            </Button>
            <p className="ml-auto self-center text-[14px] font-medium text-muted-foreground tabular-nums" role="status">
              {remaining > 0
                ? `Faltan ${formatCOP(remaining)}`
                : remaining < 0
                  ? `Sobran ${formatCOP(-remaining)}`
                  : "Completo"}
            </p>
          </div>

          {single ? (
            <>
              <RecibidoBox row={single} methods={methods} onChange={(patch) => updateRow(single.key, patch)} />
              {single.method === "cash" ? (
                <div className="flex flex-col gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    className="h-11 self-start px-2 text-[14px]"
                    aria-expanded={showBills}
                    onClick={() => setShowBills((v) => !v)}
                  >
                    {showBills ? "Ocultar billetes" : "Sumar billetes"}
                  </Button>
                  {showBills ? (
                    <BillAdders
                      tendered={single.tendered}
                      onChange={(value) => updateRow(single.key, { tendered: value })}
                    />
                  ) : null}
                </div>
              ) : null}
              {methods.find((m) => m.code === single.method)?.requires_reference ? (
                <ReferenceField row={single} onChange={(patch) => updateRow(single.key, patch)} />
              ) : null}
            </>
          ) : null}

          {error ? (
            <p role="alert" className="text-center text-[15px] text-destructive">
              {error}
            </p>
          ) : null}

          <Button
            type="button"
            className="h-[72px] gap-2.5 rounded-[14px] text-[22px] font-extrabold [&_svg]:size-[26px]"
            disabled={!puedeCobrar}
            onClick={() => mutation.mutate(pin)}
          >
            <Check aria-hidden="true" />
            {mutation.isPending ? "Cobrando…" : `Cobrar ${formatCOP(totalDue)}`}
          </Button>
          <p className="text-center text-[14px] text-muted-foreground">{ayuda}</p>
        </div>

        {/* Cobrar pide el PIN aunque haya persona activa (SPEC-NEGOCIO §2.1:
            una tablet abandonada no vende a nombre de quien la dejó). El
            teclado ignora las teclas que van a otro campo (`PinPad`). */}
        <div
          className={cn(
            "flex flex-col gap-2 self-start rounded-[14px] border bg-card p-2.5",
            "[&_.grid]:w-full [&_.grid]:gap-1.5 [&_.grid_button]:h-[56px] [&_.grid_button]:w-full [&_.grid_button]:rounded-[10px] [&_.grid_button]:text-[22px] [&_.grid_button]:font-semibold",
          )}
        >
          <PinPad
            key={pinKey}
            length={4}
            label="PIN propio para cobrar"
            heading="PIN de quien cobra"
            holdValue
            onChange={setPin}
            onSubmit={() => {}}
            disabled={mutation.isPending}
          />
          {chargerName ? (
            <p className="text-center text-[13px] text-muted-foreground">
              Cobra <b className="text-foreground">{chargerName}</b>
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** Los medios de pago de la sede como fila de botones (radio): un toque, no dos. */
function MethodButtons({
  label,
  methods,
  value,
  size,
  onChange,
}: {
  label: string;
  methods: DevicePaymentMethod[];
  value: PaymentMethod;
  size: "grande" | "chico";
  onChange: (method: PaymentMethod) => void;
}): React.JSX.Element {
  const labelId = useId();
  return (
    <div className="flex flex-col gap-1">
      <span id={labelId} className="sr-only">
        {label}
      </span>
      <div
        role="radiogroup"
        aria-labelledby={labelId}
        className="grid gap-2"
        style={{ gridTemplateColumns: `repeat(${Math.min(methods.length, 5)}, minmax(0, 1fr))` }}
      >
        {methods.map((method) => {
          const selected = value === method.code;
          const Icon = methodIcon(method);
          return (
            <button
              key={method.code}
              type="button"
              role="radio"
              aria-checked={selected}
              className={cn(
                "flex min-w-0 items-center justify-center gap-2 rounded-lg border-2 px-2 font-bold transition-colors",
                "focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                size === "grande" ? "h-[64px] text-[16px] [&_svg]:size-5" : "h-[56px] text-[15px] [&_svg]:size-[18px]",
                selected
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border bg-card text-foreground hover:bg-muted",
              )}
              onClick={() => onChange(method.code)}
            >
              <Icon aria-hidden="true" />
              <span className="truncate">{method.label || PAYMENT_METHOD_LABEL[method.code] || method.code}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** «Recibido · Efectivo  $ 150.000»: siempre a la vista. En efectivo se teclea; con otro medio es el monto. */
function RecibidoBox({
  row,
  methods,
  onChange,
}: {
  row: SplitRow;
  methods: DevicePaymentMethod[];
  onChange: (patch: Partial<SplitRow>) => void;
}): React.JSX.Element {
  const medio = methodLabel(methods, row.method);
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border bg-card px-3.5 py-2">
      <span className="shrink-0 text-[16px] text-muted-foreground">
        {row.method === "cash" ? (
          <Label htmlFor={`tendered-${row.key}`} className="inline text-[16px] font-normal text-muted-foreground">
            Recibido
          </Label>
        ) : (
          "Recibido"
        )}{" "}
        · {medio}
      </span>
      {row.method === "cash" ? (
        <MoneyInput
          id={`tendered-${row.key}`}
          value={row.tendered}
          onChange={(value) => onChange({ tendered: value })}
          placeholder="—"
          className="h-[44px] min-w-0 border-0 bg-transparent text-right text-[26px] font-bold shadow-none placeholder:text-foreground focus-visible:ring-2 md:text-[26px]"
        />
      ) : (
        <b className="text-[26px] tabular-nums">{formatCOP(row.amount)}</b>
      )}
    </div>
  );
}

function ReferenceField({ row, onChange }: { row: SplitRow; onChange: (patch: Partial<SplitRow>) => void }) {
  return (
    <div className="space-y-1">
      <Label htmlFor={`reference-${row.key}`}>Referencia (si aplica)</Label>
      <Input
        id={`reference-${row.key}`}
        className="h-11"
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
    <div className="flex flex-wrap gap-1" role="group" aria-label="Sumar billetes a lo recibido">
      {CASH_SHORTCUTS.map((bill) => (
        <Button
          key={bill}
          type="button"
          variant="outline"
          className="h-11 px-2 text-[13px]"
          onClick={() => onChange((tendered ?? 0) + bill)}
        >
          +{formatCOP(bill)}
        </Button>
      ))}
      <Button type="button" variant="ghost" className="h-11 px-2 text-[13px]" onClick={() => onChange(null)}>
        Limpiar
      </Button>
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
    <div className="space-y-2 rounded-lg border bg-card p-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[14px] font-semibold">Pago {index + 1}</span>
        <Button type="button" variant="ghost" className="h-11" aria-label="Quitar este pago" onClick={onRemove}>
          Quitar
        </Button>
      </div>
      <MethodButtons
        label={`Pago ${index + 1} · medio`}
        methods={methods}
        value={row.method}
        size="chico"
        onChange={(method) => onChange({ method })}
      />
      <div className={cn("grid gap-2", row.method === "cash" && "grid-cols-2")}>
        <div className="space-y-1">
          <Label htmlFor={`amount-${row.key}`}>Monto</Label>
          <MoneyInput
            id={`amount-${row.key}`}
            value={row.amount}
            onChange={(value) => onChange({ amount: value, amountTouched: true })}
          />
        </div>
        {row.method === "cash" ? (
          <div className="space-y-1">
            <Label htmlFor={`tendered-${row.key}`}>Recibido</Label>
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
            enabled
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
 * «Exacto $ 135.000 · Recibe $ 140.000 · $ 150.000 · $ 200.000»: lo que el
 * cliente entrega casi siempre, a un toque. Las cifras redondas las calcula
 * el servidor (`GET /payments/tender-suggestions`); «Exacto» es el monto de
 * la fila tal cual, sin cuenta. Con otro medio que no es efectivo se atenúa:
 * lo recibido es el total.
 */
function TenderShortcuts({
  enabled,
  compact = false,
  amount,
  tendered,
  onPick,
}: {
  enabled: boolean;
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
    enabled: enabled && deferred !== null && deferred > 0,
    staleTime: Infinity,
  });
  if (amount === null || amount <= 0) return null;
  // Sugerencias de otro monto (todavía se está tecleando) no se ofrecen.
  const suggestions = deferred === amount ? (query.data?.suggestions ?? []).slice(0, 3) : [];
  const botonClass = (on: boolean) =>
    cn(
      "flex min-w-0 flex-col items-center justify-center rounded-lg border-2 leading-tight font-bold tabular-nums transition-colors",
      "focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:pointer-events-none",
      compact ? "h-[56px] text-[16px]" : "h-[64px] text-[19px]",
      on ? "border-primary bg-accent" : "border-border bg-card hover:bg-muted",
    );
  return (
    <div
      className={cn("grid grid-cols-4 gap-2", !enabled && "opacity-45")}
      role="group"
      aria-label="Recibido en un toque"
    >
      <button
        type="button"
        aria-pressed={enabled && tendered === amount}
        disabled={!enabled}
        className={botonClass(enabled && tendered === amount)}
        onClick={() => onPick(amount)}
      >
        <span className="text-[13px] font-semibold text-muted-foreground">Exacto</span>
        <span aria-hidden="true">{formatCOP(amount)}</span>
      </button>
      {suggestions.map((value) => (
        <button
          key={value}
          type="button"
          aria-pressed={enabled && tendered === value}
          disabled={!enabled}
          className={botonClass(enabled && tendered === value)}
          onClick={() => onPick(value)}
        >
          <span aria-hidden="true" className="text-[13px] font-semibold text-muted-foreground">
            Recibe
          </span>
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
