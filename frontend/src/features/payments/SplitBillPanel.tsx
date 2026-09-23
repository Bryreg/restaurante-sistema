import { useMutation } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { useState } from "react";

import type { BillSplitEqualOut, BillSplitItemsOut, OrderItemOut, SplitGroupIn } from "@/api/orders";
import { splitBill } from "@/api/orders";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { errorMessage } from "@/lib/errors";
import { formatCOP } from "@/lib/money";
import { cn } from "@/lib/utils";

export type SplitBillMode = "none" | "equal" | "items";

export interface SplitBillPanelProps {
  orderId: number;
  expectedVersion: number;
  /** Ítems vivos de la comanda (ni anulados) — lo único que se puede repartir. */
  items: OrderItemOut[];
  mode: SplitBillMode;
  onModeChange: (mode: SplitBillMode) => void;
  onEqualResult: (result: BillSplitEqualOut) => void;
  onItemsResult: (result: BillSplitItemsOut) => void;
  /** Ya hay sub-cuentas de una división por ítems (la lista la pinta `CheckoutPage`). */
  hasParts?: boolean;
  /**
   * Alguna parte ya se cobró: el servidor no deja rehacer la división
   * («Ya hay sub-cuentas pagadas», `split_bill` en `app/orders/service.py`)
   * ni tiene sentido volver a cobrar todo junto — no se ofrece ninguna de
   * las dos cosas.
   */
  locked?: boolean;
}

const NO_GROUP = "__none__";

/**
 * División de cuenta (CONTRATO-INTERNO-1b-1.md §2.4 `POST
 * /orders/{id}/bill/split`): partes iguales (un comprobante con N pagos —
 * acá sólo se pide `parts` y se pinta `per_part` tal cual llega, nunca
 * calculado acá) o por ítems (crea N sub-cuentas con comprobante propio).
 * Sin `pos.seats` esta pantalla arma los grupos a mano; asiento automático
 * queda declarado como gap (ver entregable).
 */
export function SplitBillPanel({
  orderId,
  expectedVersion,
  items,
  mode,
  onModeChange,
  onEqualResult,
  onItemsResult,
  hasParts = false,
  locked = false,
}: SplitBillPanelProps): React.JSX.Element {
  const [parts, setParts] = useState(2);
  const [equalResult, setEqualResult] = useState<BillSplitEqualOut | null>(null);
  const [groupLabels, setGroupLabels] = useState<string[]>(["Cuenta 1", "Cuenta 2"]);
  const [assignment, setAssignment] = useState<Record<number, number | null>>({});
  const [error, setError] = useState<string | null>(null);
  const [rearmando, setRearmando] = useState(false);

  const equalMutation = useMutation({
    mutationFn: () => splitBill(orderId, { expected_version: expectedVersion, mode: "equal", parts }),
    onSuccess: (result) => {
      setError(null);
      const equal = result as BillSplitEqualOut;
      setEqualResult(equal);
      onEqualResult(equal);
    },
    onError: (err) => setError(errorMessage(err)),
  });

  const itemsMutation = useMutation({
    mutationFn: () => {
      const groups: SplitGroupIn[] = groupLabels.map((label) => ({ label, item_ids: [] }));
      for (const item of items) {
        const groupIndex = assignment[item.id];
        if (groupIndex === null || groupIndex === undefined) continue;
        groups[groupIndex]?.item_ids.push(item.id);
      }
      return splitBill(orderId, { expected_version: expectedVersion, mode: "items", groups });
    },
    onSuccess: (result) => {
      setError(null);
      setRearmando(false);
      onItemsResult(result as BillSplitItemsOut);
    },
    onError: (err) => setError(errorMessage(err)),
  });

  const unassigned = items.filter((item) => assignment[item.id] === null || assignment[item.id] === undefined);

  if (locked) {
    return (
      <p className="rounded-md border p-4 text-sm text-muted-foreground">
        Cuenta dividida por ítems. Ya hay partes cobradas: la división no se puede cambiar.
      </p>
    );
  }

  return (
    <div className="space-y-4 rounded-md border p-4">
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant={mode === "none" ? "default" : "outline"} className="h-11" onClick={() => onModeChange("none")}>
          Cobrar todo junto
        </Button>
        <Button type="button" variant={mode === "equal" ? "default" : "outline"} className="h-11" onClick={() => onModeChange("equal")}>
          Partes iguales
        </Button>
        <Button type="button" variant={mode === "items" ? "default" : "outline"} className="h-11" onClick={() => onModeChange("items")}>
          Por ítems
        </Button>
      </div>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      {mode === "equal" ? (
        <div className="space-y-3">
          <div className="max-w-40 space-y-1">
            <Label htmlFor="split-parts">Partes</Label>
            <Input
              id="split-parts"
              type="number"
              inputMode="numeric"
              min={2}
              className="h-11"
              value={parts}
              onChange={(event) => setParts(Math.max(2, Number(event.target.value) || 2))}
            />
          </div>
          <Button type="button" className="h-11" disabled={equalMutation.isPending} onClick={() => equalMutation.mutate()}>
            {equalMutation.isPending ? "Calculando…" : "Calcular partes"}
          </Button>
          {equalResult?.per_part ? (
            <div className="space-y-2">
              <SplitPartsList
                parts={equalResult.per_part.map((amount, index) => ({
                  key: index,
                  number: index + 1,
                  amount,
                  state: "pending" as const,
                }))}
              />
              {/* Partes iguales es UN cobro con N pagos (un comprobante): el
                  servidor exige que los pagos sumen el total de una vez, así
                  que acá no hay «cobrar parte 3» — cada parte es una fila de
                  Pagos, abajo, con su medio. */}
              <p className="text-sm text-muted-foreground">
                Las partes se cobran juntas, en un solo comprobante: elegí abajo, en Pagos, el medio de cada una.
              </p>
            </div>
          ) : null}
        </div>
      ) : null}

      {mode === "items" && hasParts && !rearmando ? (
        <Button type="button" variant="outline" onClick={() => setRearmando(true)}>
          Rehacer la división
        </Button>
      ) : null}

      {mode === "items" && (!hasParts || rearmando) ? (
        <div className="space-y-4">
          <div className="flex flex-wrap items-end gap-2">
            {groupLabels.map((label, index) => (
              <div key={index} className="space-y-1">
                <Label htmlFor={`group-label-${index}`}>Cuenta {index + 1}</Label>
                <Input
                  id={`group-label-${index}`}
                  className="h-11 w-40"
                  value={label}
                  onChange={(event) =>
                    setGroupLabels((prev) => prev.map((l, i) => (i === index ? event.target.value : l)))
                  }
                />
              </div>
            ))}
            <Button
              type="button"
              variant="outline"
              className="h-11"
              onClick={() => setGroupLabels((prev) => [...prev, `Cuenta ${prev.length + 1}`])}
            >
              Agregar cuenta
            </Button>
          </div>

          <div className="space-y-2">
            {items.map((item) => (
              <div key={item.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2">
                <span className="text-sm">
                  {item.qty ?? 1}× {item.name ?? "Ítem"}
                </span>
                <Select
                  value={assignment[item.id] != null ? String(assignment[item.id]) : NO_GROUP}
                  onValueChange={(value) =>
                    setAssignment((prev) => ({ ...prev, [item.id]: value === NO_GROUP ? null : Number(value) }))
                  }
                >
                  <SelectTrigger className="h-11 w-48" aria-label={`Cuenta de ${item.name ?? "ítem"}`}>
                    <SelectValue placeholder="Sin asignar" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_GROUP}>Sin asignar</SelectItem>
                    {groupLabels.map((label, index) => (
                      <SelectItem key={index} value={String(index)}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ))}
          </div>

          <p className="text-sm text-muted-foreground" role="status">
            {unassigned.length === 0 ? "Todos los ítems están asignados." : `${unassigned.length} ítem(s) sin asignar.`}
          </p>

          <Button
            type="button"
            className="h-11"
            disabled={itemsMutation.isPending || unassigned.length > 0 || items.length === 0}
            onClick={() => itemsMutation.mutate()}
          >
            {itemsMutation.isPending ? "Dividiendo…" : "Dividir cuenta"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export type SplitPartState = "paid" | "active" | "pending";

export interface SplitPart {
  key: number;
  /** El número que se dice en voz alta: «parte 3». */
  number: number;
  /** Nombre de la sub-cuenta si no es el de fábrica («Cuenta 3»); si no, nada. */
  label?: string | null;
  /** Tal cual lo manda el servidor; `null`/ausente se pinta «—», nunca «$0». */
  amount: number | null | undefined;
  state: SplitPartState;
  /** Sólo cobradas: con qué se pagó, del comprobante (`payments[].label`). */
  paidWith?: string | null;
  /** Sólo cobradas: el comprobante salió como factura electrónica. */
  withInvoice?: boolean;
}

export interface SplitPartsListProps {
  parts: SplitPart[];
  /** Si viene, una parte pendiente se toca para pasarla adelante. */
  onSelect?: (key: number) => void;
}

const STATE_TEXT: Record<SplitPartState, string> = {
  paid: "Cobrada",
  active: "Sigue",
  pending: "Pendiente",
};

/**
 * Las partes de una cuenta dividida como filas numeradas («Momento 2» de
 * `docs/diseno/propuesta.html`): la cajera avanza de arriba abajo y el
 * sistema nunca pierde qué falta. Cobrada = ✓ y apagada, con el medio y la
 * marca de factura si el comprobante los trae; la que sigue, con el borde de
 * acción (añil, `primary`); el resto, pendiente. El estado va con palabra y
 * no sólo con color. Ningún monto se calcula acá: cada uno llega del
 * servidor (`per_part` o `totals.total` de la sub-cuenta).
 */
export function SplitPartsList({ parts, onSelect }: SplitPartsListProps): React.JSX.Element {
  return (
    <ol aria-label="Partes de la cuenta" className="space-y-2">
      {parts.map((part) => {
        const detalle = [
          STATE_TEXT[part.state],
          part.label,
          part.state === "paid" ? part.paidWith : null,
          part.state === "paid" && part.withInvoice ? "con factura" : null,
        ]
          .filter(Boolean)
          .join(" · ");
        const contenido = (
          <>
            <span
              className={cn(
                "flex size-10 shrink-0 items-center justify-center rounded-full text-lg font-bold tabular-nums",
                part.state === "active" ? "bg-primary text-primary-foreground" : "bg-muted",
              )}
            >
              {part.state === "paid" ? <Check className="size-5" aria-hidden="true" /> : part.number}
            </span>
            <span className="min-w-0 flex-1 text-left">
              <span className="block font-semibold">Parte {part.number}</span>
              <span className="block truncate text-sm text-muted-foreground">{detalle}</span>
            </span>
            <span className="text-xl font-bold tabular-nums" style={{ fontStretch: "115%" }}>
              {formatCOP(part.amount)}
            </span>
          </>
        );
        const clases = cn(
          "flex min-h-14 w-full items-center gap-3 rounded-md border px-3 py-2",
          part.state === "paid" && "opacity-60",
          part.state === "active" && "border-2 border-primary bg-accent/40",
        );
        return (
          <li key={part.key} aria-current={part.state === "active" ? "step" : undefined}>
            {onSelect && part.state === "pending" ? (
              <button
                type="button"
                className={cn(clases, "transition-colors hover:bg-accent")}
                onClick={() => onSelect(part.key)}
              >
                {contenido}
              </button>
            ) : (
              <div className={clases}>{contenido}</div>
            )}
          </li>
        );
      })}
    </ol>
  );
}
