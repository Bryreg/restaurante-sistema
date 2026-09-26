import { keepPreviousData, useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
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
  /** `totals.total + tip.amount` de lo que se está cobrando — sólo para la guía "faltan $X". */
  totalDue: number;
  tip?: PaymentTipIn;
  /** Prellena filas (p. ej. desde `bill/split` en partes iguales). Sólo se usa al montar. */
  initialSplits?: InitialSplit[];
  onPaid: (result: PaymentOut) => void;
  onStale: (order: OrderOut) => void;
  onAlreadyPaid: () => void;
  /**
   * Dónde dibujar el cierre del cobro (estado, vuelto, quién cobra y el
   * PIN). En la tablet horizontal `CheckoutPage` le da la columna derecha,
   * para que el teclado quede siempre a la vista; sin él, va debajo de los
   * pagos.
   */
  confirmSlot?: HTMLElement | null;
}

const CASH_SHORTCUTS = DENOMINATIONS.filter((value) => value >= 1000);

/**
 * Tabla de pagos (CONTRATO-INTERNO-1b-1.md §2.4 "Cobro y comprobante"):
 * medios configurables, pagos mixtos, cambio SOLO sobre efectivo (`change`
 * lo pinta `PaymentOut.change`, nunca se calcula acá), PIN propio con
 * `PinPad` antes de cobrar. Lo único que este componente suma es lo
 * tecleado en los splits (`sumTyped`) para la guía "faltan $X".
 *
 * **Medios de pago de la sede** (gap cerrado en este pedido, declarado en
 * `outputs-1b-1/*.md`: antes de esto el POS ofrecía siempre los mismos seis
 * códigos fijos del contrato, sin importar cuáles había deshabilitado la
 * sede — "ofrecer un medio que la sede deshabilitó produce un documento con
 * un medio inválido"). Ahora consume `GET /device/payment-methods` y sólo
 * ofrece los medios habilitados; el campo "Referencia" sólo se muestra para
 * los que el servidor marca `requires_reference`. Si la lista todavía no
 * cargó, falló, o la sede no tiene ningún medio habilitado, la tabla de
 * pagos no se dibuja (no hay con qué cobrar sin inventar códigos).
 *
 * **Tablet** (auditoría de UX en 820×1180 y 1280×800): el medio es una fila
 * de botones y no una lista desplegable; lo recibido tiene «Exacto» y los
 * billetes redondos siguientes a un toque (cifras del servidor), con los
 * «+billete» como segunda opción; y el cierre (estado, vuelto, quién cobra,
 * PIN) puede ir en otra columna (`confirmSlot`) para que el teclado nunca
 * quede debajo del pliegue.
 */
export function PaymentSplitsForm({
  orderId,
  expectedVersion,
  subAccountId,
  totalDue,
  tip,
  initialSplits,
  onPaid,
  onStale,
  onAlreadyPaid,
  confirmSlot,
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
        : // La primera fila arranca con lo que hay que cobrar. El sistema ya
          // sabe el total: obligar a teclearlo de nuevo en cada venta de
          // mostrador es un paso de más, y es el número que más fácil se
          // teclea mal con cola en la caja. Sigue siendo editable — un pago
          // dividido se arma bajándolo y agregando otra fila.
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
  // Se pregunta cuando la cajera deja de teclear (300 ms), no en cada dígito:
  // «100000» serían seis consultas. Mientras llega la nueva respuesta queda
  // la anterior, atenuada, en vez de que el vuelto parpadee.
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

  function updateRow(key: number, patch: Partial<SplitRow>) {
    setSplits((prev) => prev.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  }

  function removeRow(key: number) {
    setSplits((prev) => prev.filter((row) => row.key !== key));
  }

  const mutation = useMutation({
    mutationFn: (pin: string) => {
      const body = {
        expected_version: expectedVersion,
        sub_account_id: subAccountId,
        pin,
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
      // estaba (AGENTS.md, "un cobro que falla conserva la cuenta").
      idempotencyKeyRef.current = newIdempotencyKey();
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

  const confirm = (
    <div className="flex flex-col items-center gap-3 rounded-md border p-3">
      <p className="text-sm font-medium tabular-nums" role="status">
        {remaining > 0
          ? `Faltan ${formatCOP(remaining)}`
          : remaining < 0
            ? `Sobran ${formatCOP(-remaining)}`
            : "Completo"}
      </p>
      {/* El vuelto total se dice recién con el pago completo: con montos a
          medio teclear es una cifra que todavía no es verdad. */}
      {complete && hayVuelto && vueltoQuery.data && vueltoQuery.data.change_total > 0 ? (
        <p className={vueltoViejo ? "text-center opacity-50" : "text-center"} role="status">
          <span className="block text-sm text-muted-foreground">Vuelto a entregar</span>
          <span className="text-3xl font-extrabold tabular-nums" style={{ fontStretch: "115%" }}>
            {formatCOP(vueltoQuery.data.change_total)}
          </span>
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-center text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {/* Cobrar pide el PIN aunque haya persona activa (SPEC-NEGOCIO §2.1:
          una tablet abandonada no vende a nombre de quien la dejó). Lo que
          sí se ahorra es adivinar de quién es el PIN que se pide. */}
      <p className="text-center text-sm text-muted-foreground">
        {!complete ? (
          "Completá los pagos para poder cobrar."
        ) : chargerName ? (
          <>
            Cobra <b className="text-foreground">{chargerName}</b>: tecleá tu PIN.
          </>
        ) : (
          "Ingresá tu PIN para cobrar."
        )}
      </p>
      {/*
       * `PinPad` escucha el teclado a nivel de `window` (componente
       * compartido de 1a, fuera de este territorio) sin importar qué
       * campo tiene el foco: si quedara habilitado mientras se tipean los
       * montos, cada dígito tecleado ahí se colaría como dígito de PIN.
       * Mantenerlo `disabled` hasta que los pagos suman exacto evita ese
       * cruce y de paso impide cobrar con montos incompletos. Se dibuja
       * siempre (deshabilitado), para que no aparezca de golpe más abajo.
       */}
      <PinPad
        length={4}
        label="PIN propio para cobrar"
        disabled={mutation.isPending || !complete}
        onSubmit={(pin) => mutation.mutate(pin)}
      />
    </div>
  );

  return (
    <div className="space-y-3">
      <div className="space-y-3 rounded-md border p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">Pagos</h2>
          <Button
            type="button"
            variant="outline"
            className="h-11"
            onClick={() =>
              // Lo que falta, que es lo que casi siempre va en la fila nueva.
              setSplits((prev) => [...prev, newRow(methods[0].code, remaining > 0 ? remaining : null)])
            }
          >
            Agregar pago
          </Button>
        </div>

        <div className="space-y-3">
          {splits.map((row, index) => (
            <PaymentRow
              key={row.key}
              row={row}
              index={index}
              single={splits.length === 1}
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
      </div>

      {confirmSlot ? createPortal(confirm, confirmSlot) : confirm}
    </div>
  );
}

/**
 * Una fila de pago: el medio como fila de botones (uno por medio habilitado
 * de la sede, no una lista desplegable: en la tablet es un toque, no dos), el
 * monto y, en efectivo, lo recibido con sus atajos.
 */
function PaymentRow({
  row,
  index,
  single,
  methods,
  onChange,
  onRemove,
  vuelto,
}: {
  row: SplitRow;
  index: number;
  single: boolean;
  methods: DevicePaymentMethod[];
  onChange: (patch: Partial<SplitRow>) => void;
  onRemove: () => void;
  vuelto: React.ReactNode;
}): React.JSX.Element {
  const methodLabelId = useId();
  return (
    <div className="space-y-2 rounded-md border p-2.5">
      <div className="flex items-center justify-between gap-2">
        <span id={methodLabelId} className="text-sm font-medium">
          {single ? "Medio" : `Pago ${index + 1} · medio`}
        </span>
        <Button type="button" variant="ghost" className="h-11" aria-label="Quitar este pago" onClick={onRemove}>
          Quitar
        </Button>
      </div>
      <div role="radiogroup" aria-labelledby={methodLabelId} className="flex flex-wrap gap-2">
        {methods.map((method) => {
          const selected = row.method === method.code;
          return (
            <button
              key={method.code}
              type="button"
              role="radio"
              aria-checked={selected}
              className={cn(
                "min-h-11 flex-1 basis-24 rounded-lg border px-3 text-sm font-medium transition-colors",
                "focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
                selected
                  ? "border-foreground bg-secondary text-secondary-foreground ring-2 ring-foreground"
                  : "bg-background hover:bg-muted",
              )}
              onClick={() => onChange({ method: method.code })}
            >
              {method.label || PAYMENT_METHOD_LABEL[method.code] || method.code}
            </button>
          );
        })}
      </div>

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
          <TenderShortcuts amount={row.amount} tendered={row.tendered} onPick={(value) => onChange({ tendered: value })} />
          {/* Los billetes que se van sumando quedan como segunda opción:
              sirven cuando el cliente entrega varios billetes distintos. */}
          <div className="flex flex-wrap gap-1" role="group" aria-label="Sumar billetes a lo recibido">
            {CASH_SHORTCUTS.map((bill) => (
              <Button
                key={bill}
                type="button"
                variant="ghost"
                className="h-11 px-2 text-xs"
                onClick={() => onChange({ tendered: (row.tendered ?? 0) + bill })}
              >
                +{formatCOP(bill)}
              </Button>
            ))}
            <Button type="button" variant="ghost" className="h-11 px-2 text-xs" onClick={() => onChange({ tendered: null })}>
              Limpiar
            </Button>
          </div>
          {vuelto}
        </>
      ) : null}

      {methods.find((m) => m.code === row.method)?.requires_reference ? (
        <div className="space-y-1">
          <Label htmlFor={`reference-${row.key}`}>Referencia (si aplica)</Label>
          <Input
            id={`reference-${row.key}`}
            className="h-11"
            value={row.reference}
            onChange={(event) => onChange({ reference: event.target.value })}
          />
        </div>
      ) : null}
    </div>
  );
}

/**
 * «Exacto · $135.000 · $140.000 · $150.000»: lo que el cliente entrega casi
 * siempre, a un toque. Las cifras redondas las calcula el servidor
 * (`GET /payments/tender-suggestions`); «Exacto» es el monto de la fila tal
 * cual, sin cuenta. Se pregunta cuando se deja de teclear el monto.
 */
function TenderShortcuts({
  amount,
  tendered,
  onPick,
}: {
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
  const suggestions = deferred === amount ? (query.data?.suggestions ?? []) : [];
  return (
    <div className="flex flex-wrap gap-2" role="group" aria-label="Recibido en un toque">
      <Button
        type="button"
        variant="outline"
        aria-pressed={tendered === amount}
        className="h-11 flex-1 basis-20 font-semibold aria-pressed:ring-2 aria-pressed:ring-foreground"
        onClick={() => onPick(amount)}
      >
        Exacto
      </Button>
      {suggestions.map((value) => (
        <Button
          key={value}
          type="button"
          variant="outline"
          aria-pressed={tendered === value}
          className="h-11 flex-1 basis-20 font-semibold tabular-nums aria-pressed:ring-2 aria-pressed:ring-foreground"
          onClick={() => onPick(value)}
        >
          {formatCOP(value)}
        </Button>
      ))}
    </div>
  );
}

/** El vuelto de una fila de efectivo, tal como lo devolvió el servidor. */
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
      <p className={viejo ? "pt-1 text-sm font-semibold text-destructive opacity-50" : "pt-1 text-sm font-semibold text-destructive"} role="alert">
        Lo recibido no alcanza: faltan {formatCOP(preview.short_by)}
      </p>
    );
  }
  return (
    <p className={viejo ? "flex items-baseline gap-2 pt-1 opacity-50" : "flex items-baseline gap-2 pt-1"}>
      <span className="text-sm text-muted-foreground">Vuelto</span>
      <span className="text-xl font-bold tabular-nums">{formatCOP(preview.change)}</span>
    </p>
  );
}
