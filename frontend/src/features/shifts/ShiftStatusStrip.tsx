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
 *
 * `compacta` es para la barra de la tablet, donde esta cinta comparte
 * renglón con la sede, el reloj y la pastilla de quién opera (`m2b`: UNA
 * banda). Ahí el **día operativo se escribe sólo cuando dice algo**: si
 * coincide con la fecha de pared que ya está impresa dos centímetros a la
 * izquierda, repetirlo no informa, y era lo que empujaba la barra a un
 * segundo renglón. Cuando NO coincide —turno que cruzó la medianoche— se
 * escribe con todas las letras, porque entonces es la diferencia entre
 * cobrar en el día de ayer o en el de hoy.
 */
export function ShiftStatusStrip({ compacta = false }: { compacta?: boolean } = {}): React.JSX.Element | null {
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

  // ¿El día operativo es el de la fecha de pared en Bogotá? Se compara
  // contra `America/Bogota` y no contra la fecha local del aparato: una
  // tablet con la zona horaria mal puesta no puede cambiar qué día es para
  // el negocio.
  const hoyBogota = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Bogota",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  // Sin día operativo no hay nada que comparar, y en ese caso la cinta lo
  // escribe igual (que diga «—» es un dato: el turno llegó sin su día).
  const diaDistinto = (shift.business_date ?? "").slice(0, 10) !== hoyBogota;

  return (
    <div className="flex flex-wrap items-center gap-4 text-sm">
      {!compacta || diaDistinto ? (
        <span className="inline-flex items-center gap-1.5 font-medium">
          <Clock className="size-4" aria-hidden="true" />
          {compacta ? "Día operativo: " : ""}
          {formatBusinessDate(shift.business_date)}
        </span>
      ) : null}
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-muted-foreground">
        {compacta ? (
          <>Turno de {shift.cash_responsible?.name ?? "—"}</>
        ) : (
          <>Turno abierto · responsable {shift.cash_responsible?.name ?? "—"}</>
        )}
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
          {/* El aviso NOMBRA LA ACCIÓN (AGENTS.md), no sólo el estado. En la
              barra de la tablet comparte renglón con todo lo demás, así que
              ahí se escribe la acción sola: «por encima del umbral» describe
              una condición, «retirá efectivo» dice qué hacer. */}
          {compacta ? "Retirá efectivo del cajón" : "Efectivo por encima del umbral de retiro"}
        </span>
      ) : null}
      {shift.expected_cash !== undefined && shift.expected_cash !== null ? (
        <span className="text-muted-foreground">Esperado: {formatCOP(shift.expected_cash)}</span>
      ) : null}
    </div>
  );
}
