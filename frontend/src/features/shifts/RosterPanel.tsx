import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

import { rosterAction, type RosterAction, type ShiftCurrent } from "@/api/shifts";
import { PinPad } from "@/components/PinPad";
import { EmployeePicker } from "@/components/EmployeePicker";
import { EmptyState } from "@/components/EmptyState";
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
 * Usa `EmployeePicker` (`GET /device/employees`, CONTRATO-INTERNO-1b-1.md
 * §6) para elegir a la persona en un toque, en vez de tipear su número.
 */
export function RosterPanel({ shift }: { shift: ShiftCurrent }): React.JSX.Element {
  const queryClient = useQueryClient();
  const [employeeId, setEmployeeId] = useState<number | null>(null);
  const [action, setAction] = useState<RosterAction>("in");
  const [error, setError] = useState<string | null>(null);

  const employeeIdValid = employeeId !== null;

  const mutation = useMutation({
    mutationFn: (pin: string) => rosterAction(shift.id, { employee_id: employeeId as number, action, pin }),
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
      <div className="space-y-4 rounded-md border p-4">
        <div className="space-y-2">
          <p className="text-sm font-medium">Persona</p>
          <EmployeePicker value={employeeId} onChange={(id) => setEmployeeId(id)} label="Persona" disabled={mutation.isPending} />
        </div>
        <div className="max-w-xs space-y-1">
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
          errorMessage={error ?? (!employeeIdValid ? "Elegí quién entra, sale o pausa primero." : null)}
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
