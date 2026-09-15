import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { ApiError, newIdempotencyKey } from "@/api/client";
import type { OrderOut } from "@/api/orders";
import {
  PAYMENT_METHOD_LABEL,
  listDevicePaymentMethods,
  payOrder,
  type DevicePaymentMethod,
  type PaymentMethod,
  type PaymentOut,
  type PaymentSplitIn,
  type PaymentTipIn,
} from "@/api/payments";
import { EmptyState } from "@/components/EmptyState";
import { MoneyInput } from "@/components/MoneyInput";
import { PinPad } from "@/components/PinPad";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { errorMessage } from "@/lib/errors";
import { DENOMINATIONS, formatCOP } from "@/lib/money";

import { sumTyped } from "./lib";

interface SplitRow {
  key: number;
  method: PaymentMethod;
  amount: number | null;
  tendered: number | null;
  reference: string;
}

let rowSeq = 0;
function newRow(method: PaymentMethod, amount: number | null = null): SplitRow {
  rowSeq += 1;
  return { key: rowSeq, method, amount, tendered: null, reference: "" };
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
}: PaymentSplitsFormProps): React.JSX.Element {
  const methodsQuery = useQuery({
    queryKey: ["device-payment-methods"],
    queryFn: listDevicePaymentMethods,
  });
  const methods: DevicePaymentMethod[] = methodsQuery.data ?? [];

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
        ? initialSplits.map((s) => newRow(s.method, s.amount))
        : [newRow(methods[0].code)],
    );
  }, [methods, initialSplits]);

  const [error, setError] = useState<string | null>(null);
  const idempotencyKeyRef = useRef(newIdempotencyKey());

  const typedTotal = sumTyped(splits.map((s) => ({ amount: s.amount })));
  const remaining = totalDue - typedTotal;

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
    return <p className="text-sm text-muted-foreground">Cargando medios de pago…</p>;
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

  return (
    <div className="space-y-4 rounded-md border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Pagos</h2>
        <Button
          type="button"
          variant="outline"
          className="h-11"
          onClick={() => setSplits((prev) => [...prev, newRow(methods[0].code)])}
        >
          Agregar pago
        </Button>
      </div>

      <div className="space-y-3">
        {splits.map((row) => (
          <div key={row.key} className="grid gap-3 rounded-md border p-3 sm:grid-cols-[1fr_1fr_auto]">
            <div className="space-y-1">
              <Label htmlFor={`method-${row.key}`}>Medio</Label>
              <Select value={row.method} onValueChange={(v) => updateRow(row.key, { method: v as PaymentMethod })}>
                <SelectTrigger id={`method-${row.key}`} className="h-11 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {methods.map((method) => (
                    <SelectItem key={method.code} value={method.code}>
                      {method.label || PAYMENT_METHOD_LABEL[method.code] || method.code}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor={`amount-${row.key}`}>Monto</Label>
              <MoneyInput
                id={`amount-${row.key}`}
                value={row.amount}
                onChange={(value) => updateRow(row.key, { amount: value })}
              />
            </div>
            <div className="flex items-end">
              <Button
                type="button"
                variant="ghost"
                className="h-11"
                aria-label="Quitar este pago"
                onClick={() => removeRow(row.key)}
              >
                Quitar
              </Button>
            </div>

            {row.method === "cash" ? (
              <div className="space-y-1 sm:col-span-3">
                <Label htmlFor={`tendered-${row.key}`}>Recibido</Label>
                <MoneyInput
                  id={`tendered-${row.key}`}
                  value={row.tendered}
                  onChange={(value) => updateRow(row.key, { tendered: value })}
                />
                <div className="flex flex-wrap gap-2 pt-1">
                  {CASH_SHORTCUTS.map((bill) => (
                    <Button
                      key={bill}
                      type="button"
                      variant="outline"
                      className="h-11"
                      onClick={() => updateRow(row.key, { tendered: (row.tendered ?? 0) + bill })}
                    >
                      +{formatCOP(bill)}
                    </Button>
                  ))}
                  <Button
                    type="button"
                    variant="ghost"
                    className="h-11"
                    onClick={() => updateRow(row.key, { tendered: null })}
                  >
                    Limpiar
                  </Button>
                </div>
              </div>
            ) : null}

            {methods.find((m) => m.code === row.method)?.requires_reference ? (
              <div className="space-y-1 sm:col-span-3">
                <Label htmlFor={`reference-${row.key}`}>Referencia (si aplica)</Label>
                <Input
                  id={`reference-${row.key}`}
                  className="h-11"
                  value={row.reference}
                  onChange={(event) => updateRow(row.key, { reference: event.target.value })}
                />
              </div>
            ) : null}
          </div>
        ))}
      </div>

      <p className="text-sm font-medium tabular-nums" role="status">
        {remaining > 0
          ? `Faltan ${formatCOP(remaining)}`
          : remaining < 0
            ? `Sobran ${formatCOP(-remaining)}`
            : "Completo"}
      </p>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <div className="flex flex-col items-center gap-3 border-t pt-4">
        <p className="text-sm text-muted-foreground">
          {remaining !== 0 ? "Completá los pagos para poder cobrar." : "Ingresá tu PIN para cobrar."}
        </p>
        {/*
         * `PinPad` escucha el teclado a nivel de `window` (componente
         * compartido de 1a, fuera de este territorio) sin importar qué
         * campo tiene el foco: si quedara habilitado mientras se tipean los
         * montos, cada dígito tecleado ahí se colaría como dígito de PIN.
         * Mantenerlo `disabled` hasta que los pagos suman exacto evita ese
         * cruce y de paso impide cobrar con montos incompletos.
         */}
        <PinPad
          length={4}
          label="PIN propio para cobrar"
          disabled={mutation.isPending || remaining !== 0}
          onSubmit={(pin) => mutation.mutate(pin)}
        />
      </div>
    </div>
  );
}
