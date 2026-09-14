import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

import { rosterAction, type RosterAction, type ShiftCurrent } from "@/api/shifts";
import { PinPad } from "@/components/PinPad";
import { EmptyState } from "@/components/EmptyState";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatInstant } from "@/lib/businessDate";
import { errorMessage } from "@/lib/errors";

import { CURRENT_SHIFT_QUERY_KEY, shiftSummaryQueryKey } from "./hooks";

const ACTION_LABEL: Record<RosterAction, string> = {
  in: "Entrada",
  out: "Salida",
  pause_start: "Inicio de pausa",
  pause_end: "Fin de pausa",
};

/**
 * Roster del turno abierto (spec § "Business day & shifts", `POST
 * /shifts/{id}/roster`): entrar, salir y pausar con PIN de la propia
 * persona. `identify` ya agrega al roster con hora de entrada
 * automáticamente (contrato interno § 2): este panel es para el resto de
 * los movimientos del roster.
 *
 * GAP compartido con `DeviceIdentifyPage` (frontend-auth): no hay una ruta
 * de dispositivo para listar el personal activo de la sede, así que se pide
 * el número de empleado a mano en vez de un selector con nombres.
 */
export function RosterPanel({ shift }: { shift: ShiftCurrent }): React.JSX.Element {
  const queryClient = useQueryClient();
  const [employeeId, setEmployeeId] = useState("");
  const [action, setAction] = useState<RosterAction>("in");
  const [error, setError] = useState<string | null>(null);

  const employeeIdNumber = Number(employeeId);
  const employeeIdValid = employeeId.trim() !== "" && Number.isInteger(employeeIdNumber) && employeeIdNumber > 0;

  const mutation = useMutation({
    mutationFn: (pin: string) => rosterAction(shift.id, { employee_id: employeeIdNumber, action, pin }),
    onSuccess: () => {
      toast.success(`${ACTION_LABEL[action]} registrada.`);
      setError(null);
      void queryClient.invalidateQueries({ queryKey: CURRENT_SHIFT_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: shiftSummaryQueryKey(shift.id) });
    },
    onError: (err) => setError(errorMessage(err)),
  });

  const roster = shift.roster ?? [];

  return (
    <div className="space-y-6">
      <div className="grid gap-4 rounded-md border p-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <div className="space-y-1">
          <Label htmlFor="roster-employee">Número de empleado</Label>
          <Input
            id="roster-employee"
            type="number"
            inputMode="numeric"
            min={1}
            className="h-11"
            value={employeeId}
            onChange={(event) => setEmployeeId(event.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="roster-action">Acción</Label>
          <Select value={action} onValueChange={(v) => setAction(v as RosterAction)}>
            <SelectTrigger id="roster-action" className="h-11 w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(ACTION_LABEL).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="flex flex-col items-center gap-3">
        <PinPad
          length={4}
          label={`PIN personal para ${ACTION_LABEL[action].toLowerCase()}`}
          disabled={!employeeIdValid || mutation.isPending}
          onSubmit={(pin) => mutation.mutate(pin)}
          errorMessage={error ?? (!employeeIdValid ? "Ingresá el número de empleado primero." : null)}
        />
      </div>

      {roster.length === 0 ? (
        <EmptyState title="Todavía no entró nadie a este turno" />
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Persona</TableHead>
                <TableHead>Entrada</TableHead>
                <TableHead>Salida</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {roster.map((entry, index) => (
                <TableRow key={`${entry.employee_id ?? "?"}-${index}`}>
                  <TableCell>{entry.employee_name ?? "—"}</TableCell>
                  <TableCell>{formatInstant(entry.in_at)}</TableCell>
                  <TableCell>{entry.out_at ? formatInstant(entry.out_at) : "En turno"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
