import { useMutation } from "@tanstack/react-query";
import { useState } from "react";

import type { BillSplitEqualOut, BillSplitItemsOut, OrderItemOut, SplitGroupIn } from "@/api/orders";
import { splitBill } from "@/api/orders";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { errorMessage } from "@/lib/errors";
import { formatCOP } from "@/lib/money";

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
}: SplitBillPanelProps): React.JSX.Element {
  const [parts, setParts] = useState(2);
  const [equalResult, setEqualResult] = useState<BillSplitEqualOut | null>(null);
  const [groupLabels, setGroupLabels] = useState<string[]>(["Cuenta 1", "Cuenta 2"]);
  const [assignment, setAssignment] = useState<Record<number, number | null>>({});
  const [error, setError] = useState<string | null>(null);

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
      onItemsResult(result as BillSplitItemsOut);
    },
    onError: (err) => setError(errorMessage(err)),
  });

  const unassigned = items.filter((item) => assignment[item.id] === null || assignment[item.id] === undefined);

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
            <ul className="space-y-1 text-sm">
              {equalResult.per_part.map((amount, index) => (
                <li key={index}>
                  Parte {index + 1}: {formatCOP(amount)}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {mode === "items" ? (
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
