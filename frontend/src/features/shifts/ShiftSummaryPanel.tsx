import { useSession } from "@/app/session";
import type { ShiftCurrent } from "@/api/shifts";
import { formatBusinessDate, formatInstant } from "@/lib/businessDate";
import { formatCOP } from "@/lib/money";

import { useShiftSummary } from "./hooks";

/**
 * Estado del turno abierto, arriba del panel de `ShiftPage`: día operativo,
 * responsable, base fija y reserva **mostradas aparte** (la reserva nunca se
 * suma a la base — spec § 3.2), esperado sólo si el servidor lo manda
 * (`expected_cash` ausente ≠ 0: se muestra «—», cierre a ciegas).
 *
 * Antes también dibujaba el roster con su consola de entrar/salir/pausar;
 * desde el panel único (2026-09-25) el equipo va en `ShiftTeamCard` y la
 * consola (`RosterPanel`) se abre desde el botón «Entrada / Salida».
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
    <section aria-labelledby="estado-turno" className="space-y-4 rounded-xl border bg-card p-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 id="estado-turno" className="text-lg font-semibold">
          Turno abierto
        </h2>
        {/* El día operativo va en el título: no se repite abajo. */}
        <span className="text-muted-foreground">{formatBusinessDate(shift.business_date)}</span>
      </div>

      <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
        <div>
          <p className="text-sm text-muted-foreground">Responsable de caja</p>
          <p className="font-semibold">{shift.cash_responsible?.name ?? "—"}</p>
        </div>
        <div>
          <p className="text-sm text-muted-foreground">Abierto</p>
          <p className="font-medium">{formatInstant(shift.opened_at)}</p>
        </div>
        <div>
          <p className="text-sm text-muted-foreground">Base fija</p>
          <p className="font-medium tabular-nums">{formatCOP(openingTotal)}</p>
        </div>
        <div>
          <p className="text-sm text-muted-foreground">Reserva (aparte, no entra al cuadre)</p>
          <p className="font-medium tabular-nums">{formatCOP(reserve)}</p>
        </div>
        <div>
          <p className="text-sm text-muted-foreground">Esperado</p>
          <p className="font-medium tabular-nums">{formatCOP(shift.expected_cash)}</p>
        </div>
        {hasFeature("pos.delivery") ? (
          <div className="col-span-2 sm:col-span-3">
            <p className="text-sm text-muted-foreground">
              Efectivo de domicilios pendiente de liquidar (aparte del cajón)
            </p>
            <p className="font-medium tabular-nums">{formatCOP(deliveryCashPending)}</p>
          </div>
        ) : null}
      </div>
    </section>
  );
}
