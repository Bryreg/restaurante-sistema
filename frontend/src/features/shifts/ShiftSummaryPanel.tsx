import { useSession } from "@/app/session";
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
 *
 * **Pedido 2c**: el efectivo de domicilios sin liquidar es un renglón
 * PROPIO, no una resta ni una suma sobre "Esperado" — nunca se combinan
 * (`app/shifts/service.py::compute_breakdown`, la razón exacta está en su
 * docstring: sumarlo sería una segunda matemática del esperado y además
 * mentiría, el billete no está en el cajón todavía).
 */
export function ShiftSummaryPanel({ shift }: { shift: ShiftCurrent }): React.JSX.Element {
  const { hasFeature } = useSession();
  const summary = useShiftSummary(shift.id);
  const openingTotal = summary.data?.opening_cash_total;
  const reserve = summary.data?.cash_reserve;
  // `shift.delivery_cash_pending` (sondeo cada 5 s) y `summary.data.
  // delivery_cash_pending` (resumen completo) son el MISMO campo servido
  // por dos rutas (`GET /shifts/current` y `GET /shifts/{id}`); se prefiere
  // el del resumen cuando ya llegó, y se cae al del turno actual mientras
  // tanto, sin inventar un tercer valor.
  const deliveryCashPending = summary.data?.delivery_cash_pending ?? shift.delivery_cash_pending;

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
        {hasFeature("pos.delivery") ? (
          <div>
            <p className="text-sm text-muted-foreground">
              Efectivo de domicilios pendiente de liquidar (aparte del cajón)
            </p>
            <p className="font-medium tabular-nums">{formatCOP(deliveryCashPending)}</p>
          </div>
        ) : null}
      </div>

      <div className="space-y-2">
        <h2 className="text-sm font-semibold">Personal en turno</h2>
        <RosterPanel shift={shift} />
      </div>
    </div>
  );
}
