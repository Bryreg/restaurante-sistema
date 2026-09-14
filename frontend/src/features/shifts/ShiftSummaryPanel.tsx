import type { ShiftCurrent } from "@/api/shifts";
import { formatBusinessDate, formatInstant } from "@/lib/businessDate";
import { formatCOP } from "@/lib/money";

import { RosterPanel } from "./RosterPanel";
import { useShiftSummary } from "./hooks";

/**
 * "Resumen" del turno abierto: día operativo, responsable, base fija y
 * reserva **mostradas aparte** (la reserva nunca se suma a la base — spec §
 * 3.2), esperado sólo si el servidor lo manda (`expected_cash` ausente ≠ 0),
 * y el roster completo con la mini-consola para entrar/salir/pausar.
 */
export function ShiftSummaryPanel({ shift }: { shift: ShiftCurrent }): React.JSX.Element {
  const summary = useShiftSummary(shift.id);
  const openingTotal = summary.data?.opening_cash_total;
  const reserve = summary.data?.cash_reserve;

  return (
    <div className="space-y-6">
      <div className="grid gap-3 rounded-md border p-4 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <p className="text-sm text-muted-foreground">Día operativo</p>
          <p className="font-medium">{formatBusinessDate(shift.business_date)}</p>
        </div>
        <div>
          <p className="text-sm text-muted-foreground">Abierto</p>
          <p className="font-medium">{formatInstant(shift.opened_at)}</p>
        </div>
        <div>
          <p className="text-sm text-muted-foreground">Responsable de caja</p>
          <p className="font-medium">{shift.cash_responsible?.name ?? "—"}</p>
        </div>
        <div>
          <p className="text-sm text-muted-foreground">Esperado</p>
          <p className="font-medium tabular-nums">{formatCOP(shift.expected_cash)}</p>
        </div>
        <div>
          <p className="text-sm text-muted-foreground">Base fija</p>
          <p className="font-medium tabular-nums">{formatCOP(openingTotal)}</p>
        </div>
        <div>
          <p className="text-sm text-muted-foreground">Reserva (aparte, no entra al cuadre)</p>
          <p className="font-medium tabular-nums">{formatCOP(reserve)}</p>
        </div>
      </div>

      <div className="space-y-2">
        <h2 className="text-sm font-semibold">Personal en turno</h2>
        <RosterPanel shift={shift} />
      </div>
    </div>
  );
}
