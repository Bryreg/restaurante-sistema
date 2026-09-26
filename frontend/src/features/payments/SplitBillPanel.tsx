import { useMutation } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { ApiError } from "@/api/client";
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
 * Clases de un botón de «elegir uno» (modo de cobro, número de partes): el
 * elegido se marca con borde y fondo, no con el color de acción. En la
 * pantalla hay UN botón principal a la vez (el que cobra o el que divide);
 * un selector pintado como principal competía con él.
 */
function segmentClass(selected: boolean): string {
  return cn(
    "min-h-11 rounded-lg border px-3 text-sm font-medium transition-colors",
    "focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none disabled:opacity-50",
    selected
      ? "border-foreground bg-secondary text-secondary-foreground ring-2 ring-foreground"
      : "bg-background hover:bg-muted",
  );
}

/**
 * División de cuenta (CONTRATO-INTERNO-1b-1.md §2.4 `POST
 * /orders/{id}/bill/split`): el modo (todo junto, partes iguales o por
 * ítems) y, por ítems, el armado de las sub-cuentas (cada una con
 * comprobante propio). Partes iguales vive en `EqualSplitPicker`, que
 * `CheckoutPage` pone DESPUÉS de la propina. Sin `pos.seats` esta pantalla
 * arma los grupos a mano; asiento automático queda declarado como gap (ver
 * entregable).
 */
export function SplitBillPanel({
  orderId,
  expectedVersion,
  items,
  mode,
  onModeChange,
  onItemsResult,
  hasParts = false,
  locked = false,
}: SplitBillPanelProps): React.JSX.Element {
  const [groupLabels, setGroupLabels] = useState<string[]>(["Cuenta 1", "Cuenta 2"]);
  const [assignment, setAssignment] = useState<Record<number, number | null>>({});
  const [error, setError] = useState<string | null>(null);
  const [rearmando, setRearmando] = useState(false);

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

  const modes: { value: SplitBillMode; label: string }[] = [
    { value: "none", label: "Cobrar todo junto" },
    { value: "equal", label: "Partes iguales" },
    { value: "items", label: "Por ítems" },
  ];

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-2" role="group" aria-label="Cómo se cobra la cuenta">
        {modes.map((m) => (
          <button
            key={m.value}
            type="button"
            aria-pressed={mode === m.value}
            className={segmentClass(mode === m.value)}
            onClick={() => onModeChange(m.value)}
          >
            {m.label}
          </button>
        ))}
      </div>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      {mode === "items" && hasParts && !rearmando ? (
        <Button type="button" variant="outline" onClick={() => setRearmando(true)}>
          Rehacer la división
        </Button>
      ) : null}

      {mode === "items" && (!hasParts || rearmando) ? (
        <div className="space-y-4 rounded-md border p-3">
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

export interface EqualSplitPickerProps {
  orderId: number;
  expectedVersion: number;
  /**
   * La propina ya respondida (0 o ausente = sin propina). Se manda al
   * dividir: el servidor reparte venta + propina y devuelve lo que paga cada
   * parte (`per_part_due`), así la última no queda en «faltan $X».
   */
  tipAmount: number | undefined;
  onResult: (result: BillSplitEqualOut) => void;
  /** La comanda cambió de versión en el servidor (p. ej. otra tablet). */
  onStale?: () => void;
}

const QUICK_PARTS = [2, 3, 4, 5];

/**
 * Partes iguales (un comprobante con N pagos): el número de partes es una
 * fila de botones «2 · 3 · 4 · 5 · +», y tocar uno ya divide — no hay un
 * segundo botón «Calcular». Cada monto llega del servidor y se pinta tal
 * cual; acá no se calcula ninguno. Si la propina cambia después de dividir,
 * se vuelve a pedir la división con la propina nueva.
 */
export function EqualSplitPicker({
  orderId,
  expectedVersion,
  tipAmount,
  onResult,
  onStale,
}: EqualSplitPickerProps): React.JSX.Element {
  const [parts, setParts] = useState<number | null>(null);
  const [result, setResult] = useState<BillSplitEqualOut | null>(null);
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (n: number) =>
      splitBill(orderId, {
        expected_version: expectedVersion,
        mode: "equal",
        parts: n,
        ...(tipAmount && tipAmount > 0 ? { tip_amount: tipAmount } : {}),
      }),
    onSuccess: (res) => {
      setError(null);
      const equal = res as BillSplitEqualOut;
      setResult(equal);
      onResult(equal);
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === "STALE_VERSION") onStale?.();
      setError(errorMessage(err));
    },
  });

  function pick(n: number) {
    setParts(n);
    mutation.mutate(n);
  }

  // Propina cambiada después de dividir: la división vieja ya no suma.
  const lastTipRef = useRef(tipAmount);
  useEffect(() => {
    if (lastTipRef.current === tipAmount) return;
    lastTipRef.current = tipAmount;
    if (parts !== null) mutation.mutate(parts);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tipAmount]);

  const extra = parts !== null && parts > QUICK_PARTS[QUICK_PARTS.length - 1]! ? parts : null;
  const due = result?.per_part_due && result.per_part_due.length > 0 ? result.per_part_due : result?.per_part;

  return (
    <div className="space-y-2 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Partes">
        <span className="text-sm font-medium">Partes</span>
        {QUICK_PARTS.map((n) => (
          <button
            key={n}
            type="button"
            aria-pressed={parts === n}
            className={cn(segmentClass(parts === n), "min-w-11 flex-1 text-base")}
            disabled={mutation.isPending}
            onClick={() => pick(n)}
          >
            {n}
          </button>
        ))}
        {extra !== null ? (
          <button type="button" aria-pressed className={cn(segmentClass(true), "min-w-11 flex-1 text-base")} disabled>
            {extra}
          </button>
        ) : null}
        <button
          type="button"
          aria-label="Una parte más"
          className={cn(segmentClass(false), "min-w-11 flex-1 text-base")}
          disabled={mutation.isPending}
          onClick={() => pick(parts !== null && parts >= QUICK_PARTS[QUICK_PARTS.length - 1]! ? parts + 1 : 6)}
        >
          +
        </button>
      </div>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {mutation.isPending ? <p className="text-sm text-muted-foreground">Dividiendo…</p> : null}

      {due && due.length > 0 ? (
        <>
          <SplitPartsList
            parts={due.map((amount, index) => ({
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
            {result?.tip_amount
              ? "Cada parte ya incluye su propina. Se cobran juntas, en un solo comprobante: elegí abajo el medio de cada una."
              : "Las partes se cobran juntas, en un solo comprobante: elegí abajo, en Pagos, el medio de cada una."}
          </p>
        </>
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
 * servidor (`per_part_due`/`per_part` o `totals.total` de la sub-cuenta).
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
