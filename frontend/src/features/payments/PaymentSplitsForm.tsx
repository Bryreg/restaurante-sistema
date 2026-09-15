import { useMutation } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { toast } from "sonner";

import { ApiError, newIdempotencyKey } from "@/api/client";
import type { OrderOut } from "@/api/orders";
import {
  PAYMENT_METHODS,
  PAYMENT_METHOD_LABEL,
  payOrder,
  type PaymentMethod,
  type PaymentOut,
  type PaymentSplitIn,
  type PaymentTipIn,
} from "@/api/payments";
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
function newRow(method: PaymentMethod = "cash", amount: number | null = null): SplitRow {
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

const REFERENCE_METHODS: PaymentMethod[] = ["card", "transfer", "platform", "voucher", "other"];
const CASH_SHORTCUTS = DENOMINATIONS.filter((value) => value >= 1000);

/**
 * Tabla de pagos (CONTRATO-INTERNO-1b-1.md §2.4 "Cobro y comprobante"):
 * medios configurables, pagos mixtos, cambio SOLO sobre efectivo (`change`
 * lo pinta `PaymentOut.change`, nunca se calcula acá), PIN propio con
 * `PinPad` antes de cobrar. Lo único que este componente suma es lo
 * tecleado en los splits (`sumTyped`) para la guía "faltan $X".
 *
 * GAP declarado en el entregable: no hay ruta de dispositivo para leer los
 * medios de pago habilitados de la sede (`StoreSalesSettings.payment_methods`);
 * se ofrecen los seis códigos del contrato y, si el servidor rechaza uno con
 * `400 PAYMENT_METHOD_INVALID`, se muestra su texto tal cual llega.
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
  const [splits, setSplits] = useState<SplitRow[]>(() =>
    initialSplits && initialSplits.length > 0
      ? initialSplits.map((s) => newRow(s.method, s.amount))
      : [newRow()],
  );
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
      const changeText = result.change ? ` · Cambio: ${formatCOP(result.change)}` : "";
      toast.success(`Cobro registrado.${changeText}`);
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

  return (
    <div className="space-y-4 rounded-md border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Pagos</h2>
        <Button
          type="button"
          variant="outline"
          className="h-11"
          onClick={() => setSplits((prev) => [...prev, newRow()])}
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
                  {PAYMENT_METHODS.map((method) => (
                    <SelectItem key={method} value={method}>
                      {PAYMENT_METHOD_LABEL[method]}
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

            {REFERENCE_METHODS.includes(row.method) ? (
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
