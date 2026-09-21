import { AlertTriangle, CircleDollarSign, Clock } from "lucide-react";
import { Link } from "react-router-dom";

import { formatBusinessDate } from "@/lib/businessDate";
import { formatCOP } from "@/lib/money";

import { useCurrentShift } from "./hooks";

/**
 * Barra de estado del salón (`PosLayout`, SPEC-NEGOCIO § 9.1): día operativo,
 * turno abierto/cerrado, responsable de caja, y los avisos que el negocio
 * pide con su acción correctiva — "Sin turno → Abrir turno" y "Turno
 * abandonado" (`is_stale`, pasada la hora de corte). Sondea `GET
 * /shifts/current` cada 5 s vía `useCurrentShift` — el mismo hook que usa
 * `ShiftPage`, así que ambos comparten la caché de `react-query` en vez de
 * duplicar el pedido.
 */
export function ShiftStatusStrip(): React.JSX.Element | null {
  const { data: shift, isLoading, isError } = useCurrentShift();

  if (isLoading) {
    return <p className="text-sm text-muted-foreground">Consultando el turno…</p>;
  }

  if (isError) {
    return (
      <p role="alert" className="text-sm text-destructive">
        No se pudo consultar el turno. Revisá la conexión.
      </p>
    );
  }

  if (!shift) {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm font-medium text-destructive">Sin turno abierto</span>
        <Link
          to="/pos/turno"
          className="inline-flex h-11 items-center rounded-lg border border-input bg-background px-3 text-sm font-medium hover:bg-muted"
        >
          Abrir turno →
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-4 text-sm">
      <span className="inline-flex items-center gap-1.5 font-medium">
        <Clock className="size-4" aria-hidden="true" />
        {formatBusinessDate(shift.business_date)}
      </span>
      <span className="inline-flex items-center gap-1.5 text-muted-foreground">
        Turno abierto · responsable {shift.cash_responsible?.name ?? "—"}
      </span>
      {shift.is_stale ? (
        <span
          role="alert"
          className="inline-flex items-center gap-1.5 rounded-md bg-destructive/10 px-2 py-1 font-medium text-destructive"
        >
          <AlertTriangle className="size-4" aria-hidden="true" />
          Turno abandonado (pasó la hora de corte)
        </span>
      ) : null}
      {shift.cash_over_threshold ? (
        <span
          role="alert"
          className="inline-flex items-center gap-1.5 rounded-md bg-warning/10 px-2 py-1 font-medium text-warning"
        >
          <CircleDollarSign className="size-4" aria-hidden="true" />
          Efectivo por encima del umbral de retiro
        </span>
      ) : null}
      {shift.expected_cash !== undefined && shift.expected_cash !== null ? (
        <span className="text-muted-foreground">Esperado: {formatCOP(shift.expected_cash)}</span>
      ) : null}
    </div>
  );
}
