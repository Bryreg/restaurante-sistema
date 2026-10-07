import { useMutation } from "@tanstack/react-query";
import { CircleCheck, Clock, HandCoins, Split, Wallet } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { ApiError } from "@/api/client";
import type { BillSplitEqualOut, BillSplitItemsOut, OrderItemOut, SplitGroupIn } from "@/api/orders";
import { splitBill } from "@/api/orders";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { errorMessage } from "@/lib/errors";
import { formatCOP } from "@/lib/money";
import { cn } from "@/lib/utils";

/**
 * Cómo se cobra la cuenta: toda junta, por asiento (sub-cuentas armadas con
 * el asiento de cada plato), en partes iguales o por plato (sub-cuentas
 * armadas a mano). Por asiento y por plato terminan en las mismas
 * sub-cuentas del servidor (`bill/split` con `mode: "items"`).
 */
export type SplitBillMode = "none" | "seat" | "equal" | "items";

export interface SplitBillPanelProps {
  orderId: number;
  expectedVersion: number;
  /** Ítems vivos de la comanda (ni anulados) — lo único que se puede repartir. */
  items: OrderItemOut[];
  mode: SplitBillMode;
  onModeChange: (mode: SplitBillMode) => void;
  onItemsResult: (result: BillSplitItemsOut) => void;
  /** Ya hay sub-cuentas de una división por asiento o por plato (la lista la pinta `CheckoutPage`). */
  hasParts?: boolean;
  /**
   * Alguna parte ya se cobró: el servidor no deja rehacer la división
   * («Ya hay sub-cuentas pagadas», `split_bill` en `app/orders/service.py`)
   * ni tiene sentido volver a cobrar todo junto — no se ofrece ninguna de
   * las dos cosas.
   */
  locked?: boolean;
  /** `pos.seats` encendida y algún plato tiene asiento: se ofrece «Por asiento». */
  seatsAvailable?: boolean;
}

const NO_GROUP = "__none__";

/**
 * Botón de «elegir uno» de 56 px (modo de cobro, número de partes; handoff
 * `PosCobro` B): el elegido en `foreground` lleno, no con el color de acción.
 * En la pantalla hay UN botón principal a la vez («Cobrar $ X»); un
 * selector pintado como principal competía con él.
 */
function segmentClass(selected: boolean): string {
  return cn(
    "h-12 min-w-0 rounded-xl px-2 text-[15px] transition-colors",
    "focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-50",
    selected ? "bg-card font-semibold shadow-[0_1px_2px_rgb(0_0_0/8%)]" : "font-medium hover:text-foreground",
  );
}

/** El contenedor del segmentado (handoff POS «Burbujas» § 2). */
const SEGMENTADO = "grid gap-1 rounded-2xl bg-muted p-1";

/** Un botón de segunda mano: pastilla gris de 44 px. */
const BOTON_CHICO =
  "inline-flex h-11 shrink-0 items-center gap-1.5 rounded-full bg-muted px-4 text-sm font-semibold transition-colors hover:bg-fill-strong focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-50 [&_svg]:size-4";

/** «Asiento 2» o, sin asiento, «Sin asiento»: los grupos de «Por asiento». */
function seatGroups(items: OrderItemOut[]): { seat: number | null; items: OrderItemOut[] }[] {
  const bySeat = new Map<number | null, OrderItemOut[]>();
  for (const item of items) {
    const seat = item.seat ?? null;
    const bucket = bySeat.get(seat);
    if (bucket) bucket.push(item);
    else bySeat.set(seat, [item]);
  }
  return [...bySeat.entries()]
    .map(([seat, list]) => ({ seat, items: list }))
    .sort((a, b) => (a.seat ?? Number.MAX_SAFE_INTEGER) - (b.seat ?? Number.MAX_SAFE_INTEGER));
}

/**
 * División de cuenta (CONTRATO-INTERNO-1b-1.md §2.4 `POST
 * /orders/{id}/bill/split`), como la dibuja el handoff (`PosCobro` B):
 * «Todo junto · Por asiento · Partes iguales · Por plato» en botones de
 * 56 px. Por asiento arma las sub-cuentas con el asiento que cada plato ya
 * trae de la comanda (agrupar platos no es plata: los montos de cada parte
 * los calcula el servidor); por plato, a mano. Partes iguales vive en
 * `EqualSplitPicker`, que `CheckoutPage` pone DESPUÉS de la propina.
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
  seatsAvailable = false,
}: SplitBillPanelProps): React.JSX.Element {
  const [groupLabels, setGroupLabels] = useState<string[]>(["Cuenta 1", "Cuenta 2"]);
  const [assignment, setAssignment] = useState<Record<number, number | null>>({});
  const [error, setError] = useState<string | null>(null);
  const [rearmando, setRearmando] = useState(false);

  const itemsMutation = useMutation({
    mutationFn: (groups: SplitGroupIn[]) =>
      splitBill(orderId, { expected_version: expectedVersion, mode: "items", groups }),
    onSuccess: (result) => {
      setError(null);
      setRearmando(false);
      onItemsResult(result as BillSplitItemsOut);
    },
    onError: (err) => setError(errorMessage(err)),
  });

  function splitByItems() {
    const groups: SplitGroupIn[] = groupLabels.map((label) => ({ label, item_ids: [] }));
    for (const item of items) {
      const groupIndex = assignment[item.id];
      if (groupIndex === null || groupIndex === undefined) continue;
      groups[groupIndex]?.item_ids.push(item.id);
    }
    itemsMutation.mutate(groups);
  }

  function splitBySeat() {
    itemsMutation.mutate(
      seatGroups(items).map(({ seat, items: list }) =>
        seat === null
          ? { label: "Sin asiento", item_ids: list.map((item) => item.id) }
          : { label: `Asiento ${seat}`, seat, item_ids: list.map((item) => item.id) },
      ),
    );
  }

  const unassigned = items.filter((item) => assignment[item.id] === null || assignment[item.id] === undefined);

  // Cuenta entera (handoff `PosCobro` A): no hay selector, sólo la puerta a
  // dividir. Dividida (B): los tres modos, y la vuelta a «todo junto».
  if (mode === "none" && !locked) {
    return (
      <button type="button" className={BOTON_CHICO} onClick={() => onModeChange(seatsAvailable ? "seat" : "equal")}>
        <Split aria-hidden="true" />
        Dividir la cuenta
      </button>
    );
  }

  const modes: { value: SplitBillMode; label: string }[] = [
    ...(seatsAvailable ? [{ value: "seat" as const, label: "Por asiento" }] : []),
    { value: "equal", label: "Partes iguales" },
    { value: "items", label: "Por plato" },
  ];
  const building = !locked && (mode === "items" || mode === "seat") && (!hasParts || rearmando);

  return (
    <div className="flex flex-col gap-2.5">
      <div
        className={SEGMENTADO}
        style={{ gridTemplateColumns: `repeat(${modes.length}, minmax(0, 1fr))` }}
        role="group"
        aria-label="Cómo se cobra la cuenta"
      >
        {modes.map((m) => (
          <button
            key={m.value}
            type="button"
            aria-pressed={mode === m.value}
            disabled={locked}
            className={cn(segmentClass(mode === m.value), locked && mode === m.value && "disabled:opacity-100")}
            onClick={() => onModeChange(m.value)}
          >
            {m.label}
          </button>
        ))}
      </div>

      {locked ? (
        <p className="px-1 text-sm text-muted-foreground">Ya hay partes cobradas: la división no se puede cambiar.</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          <button type="button" className={BOTON_CHICO} onClick={() => onModeChange("none")}>
            Cobrar todo junto
          </button>
          {(mode === "items" || mode === "seat") && hasParts && !rearmando ? (
            <button type="button" className={BOTON_CHICO} onClick={() => setRearmando(true)}>
              Rehacer la división
            </button>
          ) : null}
        </div>
      )}

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      {building && mode === "seat" ? (
        <div className="flex flex-col gap-2.5 rounded-[18px] bg-muted p-3.5">
          <ul className="flex flex-col gap-1.5 text-[15px]">
            {seatGroups(items).map(({ seat, items: list }) => (
              <li key={seat ?? "sin-asiento"} className="flex gap-2">
                <b className="w-24 shrink-0">{seat === null ? "Sin asiento" : `Asiento ${seat}`}</b>
                <span className="text-muted-foreground">
                  {list.map((item) => `${item.qty ?? 1}× ${item.name ?? "Ítem"}`).join(", ")}
                </span>
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="h-14 rounded-2xl bg-card text-[15px] font-semibold disabled:opacity-50"
            disabled={itemsMutation.isPending || items.length === 0}
            onClick={splitBySeat}
          >
            {itemsMutation.isPending ? "Dividiendo…" : "Dividir por asiento"}
          </button>
        </div>
      ) : null}

      {building && mode === "items" ? (
        <div className="flex flex-col gap-3 rounded-[18px] bg-muted p-3.5">
          <div className="flex flex-wrap items-end gap-2">
            {groupLabels.map((label, index) => (
              <div key={index} className="space-y-1">
                <Label htmlFor={`group-label-${index}`}>Cuenta {index + 1}</Label>
                <Input
                  id={`group-label-${index}`}
                  className="h-11 w-36"
                  value={label}
                  onChange={(event) =>
                    setGroupLabels((prev) => prev.map((l, i) => (i === index ? event.target.value : l)))
                  }
                />
              </div>
            ))}
            <button
              type="button"
              className={cn(BOTON_CHICO, "bg-card")}
              onClick={() => setGroupLabels((prev) => [...prev, `Cuenta ${prev.length + 1}`])}
            >
              Agregar cuenta
            </button>
          </div>

          <div className="space-y-2">
            {items.map((item) => (
              <div key={item.id} className="flex flex-wrap items-center justify-between gap-2 rounded-2xl bg-card p-2 pl-3">
                <span className="text-sm">
                  {item.qty ?? 1}× {item.name ?? "Ítem"}
                </span>
                <Select
                  value={assignment[item.id] != null ? String(assignment[item.id]) : NO_GROUP}
                  onValueChange={(value) =>
                    setAssignment((prev) => ({ ...prev, [item.id]: value === NO_GROUP ? null : Number(value) }))
                  }
                >
                  <SelectTrigger className="h-11 w-44" aria-label={`Cuenta de ${item.name ?? "ítem"}`}>
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

          <button
            type="button"
            className="h-14 rounded-2xl bg-card text-[15px] font-semibold disabled:opacity-50"
            disabled={itemsMutation.isPending || unassigned.length > 0 || items.length === 0}
            onClick={splitByItems}
          >
            {itemsMutation.isPending ? "Dividiendo…" : "Dividir cuenta"}
          </button>
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
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-1 rounded-2xl bg-muted p-1" role="group" aria-label="Partes">
        <span className="px-2 text-sm text-muted-foreground">Partes</span>
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
          <p className="px-1 text-[13px] text-muted-foreground">
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
  /** Nombre de la sub-cuenta si no es el de fábrica («Cuenta 3»): «Asiento 1», «Constructora». */
  label?: string | null;
  /** Tal cual lo manda el servidor; `null`/ausente se pinta «—», nunca «$0». */
  amount: number | null | undefined;
  state: SplitPartState;
  /** Los platos de la parte, en una línea («Ajiaco santafereño, Obleas»). */
  dishes?: string | null;
  /** La línea de detalle bajo los platos (p. ej. la propina sugerida de la parte, del servidor). */
  detail?: string | null;
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
  paid: "Pagada",
  active: "Cobrando",
  pending: "Pendiente",
};

const STATE_ICON = { paid: CircleCheck, active: HandCoins, pending: Clock } as const;

const STATE_CHIP: Record<SplitPartState, string> = {
  paid: "bg-success-soft text-success",
  active: "bg-foreground text-card",
  pending: "bg-card text-muted-foreground",
};

/**
 * Las partes de una cuenta dividida como pozos (handoff POS «Burbujas»):
 * «Parte 2 · Asiento 2», el chip de estado con palabra e ícono (Pagada /
 * Cobrando / Pendiente), los platos, el monto y, cobrada, con qué se pagó.
 * La que se está cobrando lleva un anillo de tinta; la cajera avanza de arriba abajo y el sistema nunca pierde qué
 * falta. Ningún monto se calcula acá: cada uno llega del servidor
 * (`per_part_due`/`per_part` o `totals.total` de la sub-cuenta).
 */
export function SplitPartsList({ parts, onSelect }: SplitPartsListProps): React.JSX.Element {
  return (
    <ol aria-label="Partes de la cuenta" className="flex flex-col gap-2">
      {parts.map((part) => {
        const Icon = STATE_ICON[part.state];
        const contenido = (
          <>
            <span className="flex w-full items-center gap-2">
              <b className="flex-1 text-base font-semibold">
                Parte {part.number}
                {part.label ? ` · ${part.label}` : ""}
              </b>
              <span
                className={cn(
                  "inline-flex h-[26px] items-center gap-1 rounded-full px-2.5 text-xs font-semibold",
                  STATE_CHIP[part.state],
                )}
              >
                <Icon className="size-3.5" aria-hidden="true" />
                {STATE_TEXT[part.state]}
              </span>
            </span>
            {part.dishes ? <span className="text-[13px] text-muted-foreground">{part.dishes}</span> : null}
            <span className="flex w-full items-baseline justify-between gap-2 text-[13px]">
              <span className="text-muted-foreground">{part.detail ?? ""}</span>
              <b className="text-base font-semibold tabular-nums">{formatCOP(part.amount)}</b>
            </span>
            {part.state === "paid" && part.paidWith ? (
              <span className="flex items-center gap-1.5 text-[13px]">
                <Wallet className="size-4" aria-hidden="true" />
                {part.paidWith}
                {part.withInvoice ? " · con factura" : ""}
              </span>
            ) : null}
          </>
        );
        const clases = cn(
          "flex w-full flex-col items-start gap-1 rounded-[18px] bg-muted px-3.5 py-3 text-left",
          part.state === "active" && "shadow-[inset_0_0_0_2px_var(--foreground)]",
        );
        return (
          <li key={part.key} aria-current={part.state === "active" ? "step" : undefined}>
            {onSelect && part.state === "pending" ? (
              <button
                type="button"
                className={cn(clases, "transition-colors hover:bg-fill-strong focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none")}
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
