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
 *
 * **Inicio por rol**: con `conCaja` en `false` (mesero, cocinero: no cobra ni
 * tiene la caja) no se muestran la base fija, la reserva, el esperado ni el
 * efectivo de domicilios — la plata del cajón no es asunto de su pantalla.
 */
export function ShiftSummaryPanel({
  shift,
  conCaja = true,
}: {
  shift: ShiftCurrent;
  conCaja?: boolean;
}): React.JSX.Element {
  const { hasFeature } = useSession();
  const summary = useShiftSummary(conCaja ? shift.id : null);
  const openingTotal = summary.data?.opening_cash_total;
  const reserve = summary.data?.cash_reserve;
  // 2026-09-26: con la regla de sobres el cajón abrió con los sobres (no hay
  // base fija), y la base de respaldo vive aparte: sólo se muestra lo que el
  // cajón le debe, tal como lo publica el servidor (`reserve_loan`).
  const sobres = shift.opening_mode === "envelopes";
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
        {conCaja ? (
          <>
            <div>
              <p className="text-sm text-muted-foreground">{sobres ? "Apertura (sobres)" : "Base fija"}</p>
              <p className="font-medium tabular-nums">{formatCOP(openingTotal)}</p>
            </div>
            {sobres ? (
              shift.reserve_loan !== null && shift.reserve_loan !== undefined ? (
                <div>
                  <p className="text-sm text-muted-foreground">Le debe a la base de respaldo</p>
                  <p className="font-medium tabular-nums">{formatCOP(shift.reserve_loan)}</p>
                </div>
              ) : null
            ) : (
              <div>
                <p className="text-sm text-muted-foreground">Reserva (aparte, no entra al cuadre)</p>
                <p className="font-medium tabular-nums">{formatCOP(reserve)}</p>
              </div>
            )}
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
          </>
        ) : null}
      </div>
    </section>
  );
}
