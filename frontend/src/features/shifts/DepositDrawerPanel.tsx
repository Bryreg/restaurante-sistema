import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { toast } from "sonner";

import { ApiError, newIdempotencyKey } from "@/api/client";
import { createPosDeposit, getDepositDrawer, type DepositOut, type DrawerDayOut } from "@/api/banking";
import { Cargando } from "@/components/Cargando";
import { EmptyState } from "@/components/EmptyState";
import { MoneyInput } from "@/components/MoneyInput";
import { PhotoCaptureField } from "@/components/PhotoCaptureField";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { errorMessage } from "@/lib/errors";
import { formatFechaCorta } from "@/lib/format";
import { formatCOP } from "@/lib/money";

import { CURRENT_SHIFT_QUERY_KEY, DEPOSIT_DRAWER_QUERY_KEY, shiftSummaryQueryKey } from "./hooks";

/** Errores que dicen que lo que la pantalla creía del cajón quedó viejo: se recarga. */
const DRAWER_STALE_CODES = new Set(["DEPOSIT_NOT_IN_DRAWER", "DEPOSIT_EXCEEDS_DRAWER", "DEPOSIT_EXCEEDS_PENDING"]);

/**
 * El día por defecto: el más viejo al que todavía le queda algo. Las fechas
 * son ISO («2026-09-18»), así que compararlas como texto las ordena — no es
 * plata. `remaining > 0` es una comparación contra cero de una cifra del
 * servidor, no una cuenta.
 */
function defaultDay(days: DrawerDayOut[]): DrawerDayOut | null {
  const open = days.filter((d) => d.remaining > 0);
  if (open.length === 0) return null;
  return [...open].sort((a, b) => (a.business_date < b.business_date ? -1 : a.business_date > b.business_date ? 1 : 0))[0] ?? null;
}

/** El estado de una consignación, en palabras: la decide el servidor, no esta pantalla. */
function depositStatus(d: DepositOut): string {
  if (d.status === "reversed") return `Rechazada: ${d.reversed_reason ?? "sin motivo registrado"}`;
  if (d.needs_confirmation) return "Por confirmar";
  if (d.confirmed_at) return "Confirmada";
  return "—";
}

/**
 * **Consignar desde el POS** (decisión del dueño, 2026-09-24; `money.deposits`).
 *
 * La venta de días anteriores que todavía no se consignó se queda en el
 * cajón; quien abrió marcó qué días están acá. Durante el turno, quien tiene
 * la caja puede llevar esa plata al banco: elige el día, el monto viene
 * precargado con lo que queda de ese día (`remaining`, lo calcula el
 * servidor) y se puede cambiar para consignar en partes, y el comprobante es
 * **obligatorio**. La consignación queda «Por confirmar» hasta que el
 * administrador la confirma o la rechaza en Caja › Banco, pero descuenta del
 * saldo por consignar desde que se registra.
 *
 * Nada se resta acá: ni lo que queda de cada día ni el esperado del cajón.
 * Después de registrar se recargan el cajón y el turno, y el servidor dice
 * cómo quedaron.
 */
export function DepositDrawerPanel({ shiftId }: { shiftId: number }): React.JSX.Element {
  const queryClient = useQueryClient();
  const drawer = useQuery({ queryKey: DEPOSIT_DRAWER_QUERY_KEY, queryFn: getDepositDrawer });

  const days = drawer.data?.days ?? [];
  const deposits = drawer.data?.deposits ?? [];

  // `null` = todavía nadie eligió: manda el día por defecto. Una vez que la
  // persona toca un día, esa elección queda aunque el cajón se recargue.
  const [chosenDayId, setChosenDayId] = useState<number | null>(null);
  const [amount, setAmount] = useState<number | null>(null);
  const [amountTouched, setAmountTouched] = useState(false);
  const [bankName, setBankName] = useState("");
  const [bankReference, setBankReference] = useState("");
  const [note, setNote] = useState("");
  const [photo, setPhoto] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const idempotencyKeyRef = useRef(newIdempotencyKey());

  const selectedDay =
    days.find((d) => d.source_shift_id === chosenDayId && d.remaining > 0) ?? defaultDay(days);
  // El monto se precarga con lo que queda del día elegido hasta que la
  // persona lo cambia: es la cifra del servidor, tal cual.
  const shownAmount = amountTouched ? amount : selectedDay?.remaining ?? null;

  function chooseDay(day: DrawerDayOut) {
    setChosenDayId(day.source_shift_id);
    setAmountTouched(false);
    idempotencyKeyRef.current = newIdempotencyKey();
  }

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: DEPOSIT_DRAWER_QUERY_KEY });
    void queryClient.invalidateQueries({ queryKey: shiftSummaryQueryKey(shiftId) });
    void queryClient.invalidateQueries({ queryKey: CURRENT_SHIFT_QUERY_KEY });
  }

  const mutation = useMutation({
    mutationFn: () =>
      createPosDeposit(
        {
          source_shift_id: (selectedDay as DrawerDayOut).source_shift_id,
          amount: shownAmount as number,
          bank_name: bankName.trim() === "" ? null : bankName.trim(),
          bank_reference: bankReference.trim() === "" ? null : bankReference.trim(),
          receipt_photo: photo as string,
          note: note.trim() === "" ? null : note.trim(),
        },
        idempotencyKeyRef.current,
      ),
    onSuccess: () => {
      toast.success("Consignación registrada. Queda por confirmar.");
      setChosenDayId(null);
      setAmount(null);
      setAmountTouched(false);
      setBankReference("");
      setNote("");
      setPhoto(null);
      setError(null);
      idempotencyKeyRef.current = newIdempotencyKey();
      invalidate();
    },
    onError: (err) => {
      if (err instanceof ApiError && DRAWER_STALE_CODES.has(err.code)) {
        void queryClient.invalidateQueries({ queryKey: DEPOSIT_DRAWER_QUERY_KEY });
      }
      // La respuesta del servidor es final: el próximo intento es otro.
      idempotencyKeyRef.current = newIdempotencyKey();
      setError(errorMessage(err));
    },
  });

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!selectedDay) return;
    if (shownAmount === null || shownAmount <= 0) {
      setError("Ingresá el monto que vas a consignar.");
      return;
    }
    if (!photo) {
      setError("Tomale una foto al comprobante del banco: es obligatoria.");
      return;
    }
    setError(null);
    mutation.mutate();
  }

  if (drawer.isLoading) {
    return <Cargando texto="Consultando el cajón…" />;
  }
  if (drawer.isError) {
    return (
      <EmptyState
        reason="error"
        title="No se pudo consultar el cajón"
        description={errorMessage(drawer.error)}
        action={{ label: "Reintentar", onClick: () => void drawer.refetch() }}
      />
    );
  }

  return (
    <div className="space-y-6">
      {selectedDay === null ? (
        <EmptyState
          reason="all-clear"
          title="No hay plata de días anteriores para consignar"
          description="Al abrir no se marcó ningún día, o lo que se trajo ya se consignó."
        />
      ) : (
        <form onSubmit={handleSubmit} className="space-y-4 rounded-md border p-4">
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">¿De qué día es la plata?</legend>
            <div className="flex flex-wrap gap-2">
              {days
                .filter((d) => d.remaining > 0)
                .map((d) => {
                  const selected = d.source_shift_id === selectedDay.source_shift_id;
                  return (
                    <Button
                      key={d.source_shift_id}
                      type="button"
                      variant={selected ? "default" : "outline"}
                      className="h-auto min-h-11 flex-col items-start gap-0 py-1.5"
                      aria-pressed={selected}
                      onClick={() => chooseDay(d)}
                    >
                      <span>{formatFechaCorta(d.business_date)}</span>
                      <span className="text-xs font-normal tabular-nums">queda {formatCOP(d.remaining)}</span>
                    </Button>
                  );
                })}
            </div>
          </fieldset>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="pos-deposit-amount">Monto a consignar</Label>
              <MoneyInput
                id="pos-deposit-amount"
                value={shownAmount}
                onChange={(v) => {
                  setAmount(v);
                  setAmountTouched(true);
                }}
                disabled={mutation.isPending}
              />
              <p className="text-xs text-muted-foreground">Podés consignar una parte y el resto después.</p>
            </div>
            <div className="space-y-1">
              <Label htmlFor="pos-deposit-bank">Banco</Label>
              <Input
                id="pos-deposit-bank"
                className="h-11"
                value={bankName}
                onChange={(event) => setBankName(event.target.value)}
                disabled={mutation.isPending}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="pos-deposit-reference">Referencia (opcional)</Label>
              <Input
                id="pos-deposit-reference"
                className="h-11"
                value={bankReference}
                onChange={(event) => setBankReference(event.target.value)}
                disabled={mutation.isPending}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="pos-deposit-note">Nota (opcional)</Label>
              <Textarea
                id="pos-deposit-note"
                value={note}
                onChange={(event) => setNote(event.target.value)}
                disabled={mutation.isPending}
              />
            </div>
            <div className="sm:col-span-2">
              <PhotoCaptureField
                value={photo}
                onChange={setPhoto}
                label="Foto del comprobante"
                // Obligatoria por contrato (`POST /deposits`), no por config de sede.
                required
                disabled={mutation.isPending}
              />
            </div>
          </div>

          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}

          <Button type="submit" className="h-11 w-full" disabled={mutation.isPending}>
            {mutation.isPending ? "Registrando…" : "Registrar consignación"}
          </Button>
          <p className="text-xs text-muted-foreground">
            Queda por confirmar hasta que el administrador la revise en Banco.
          </p>
        </form>
      )}

      <section className="space-y-2">
        <h2 className="text-sm font-medium">Consignaciones de este turno</h2>
        {deposits.length === 0 ? (
          <p className="text-sm text-muted-foreground">Todavía no se consignó nada desde este cajón.</p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Monto</TableHead>
                  <TableHead>Día</TableHead>
                  <TableHead>Estado</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {deposits.map((d) => (
                  <TableRow key={d.id}>
                    <TableCell className="tabular-nums">{formatCOP(d.amount ?? null)}</TableCell>
                    <TableCell>{dayOfDeposit(d, days)}</TableCell>
                    <TableCell>{depositStatus(d)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>
    </div>
  );
}

/**
 * El día de origen de una consignación del POS: el servidor la imputa entera
 * al turno de origen (`allocations[0].shift_id`), y ese turno es uno de los
 * días del cajón. Si no aparece, se dice «—», nunca se inventa una fecha.
 */
function dayOfDeposit(d: DepositOut, days: DrawerDayOut[]): string {
  const sourceShiftId = d.allocations?.[0]?.shift_id;
  const day = days.find((x) => x.source_shift_id === sourceShiftId);
  return day ? formatFechaCorta(day.business_date) : "—";
}

export default DepositDrawerPanel;
