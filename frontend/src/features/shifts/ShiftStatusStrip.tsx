import { AlertTriangle, CircleDollarSign, Clock } from "lucide-react";
import { Link } from "react-router-dom";

import { puedeManejarCaja } from "@/app/puesto";
import { useSession } from "@/app/session";
import { formatBusinessDate, formatBusinessDateShort, formatClockTime } from "@/lib/businessDate";
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
 * **Inicio por rol**: «Turno abandonado» y «Abrir turno →» son avisos de
 * caja; los ve quien puede manejarla (`puedeManejarCaja`). Al mesero o al
 * cocinero no le sirve una alarma roja que no puede resolver.
 */
export function ShiftStatusStrip({
  variante = "franja",
}: {
  /**
   * `franja` (por defecto): la barra de estado de siempre, en su renglón.
   * `subtitulo`: el renglón de contexto de la cabecera unificada del salón
   * (`PosBarra`, handoff § POS) — sede · día · turno · caja en 14 px, en una
   * sola línea; los avisos de caja van como pastillas chicas al final. Los
   * mismos datos y las mismas reglas: sólo cambia la forma.
   */
  variante?: "franja" | "subtitulo";
} = {}): React.JSX.Element | null {
  const { data: shift, isLoading, isError } = useCurrentShift();
  const { me } = useSession();
  const conCaja = puedeManejarCaja(me?.kind === "device" ? me.employee : null, shift?.cash_responsible?.id);

  if (variante === "subtitulo") {
    const sede = me?.kind === "device" ? (me.store?.name ?? null) : null;
    const entrada = me?.kind === "device" ? (me.employee_attendance?.in_at ?? null) : null;
    const partes: string[] = sede ? [sede] : [];
    if (isLoading) {
      return <p className="truncate text-[14px] text-muted-foreground">{[...partes, "Consultando el turno…"].join(" · ")}</p>;
    }
    if (isError) {
      return (
        <p role="alert" className="truncate text-[14px] text-destructive">
          No se pudo consultar el turno. Revisá la conexión.
        </p>
      );
    }
    if (!shift) {
      return (
        <p className="flex min-w-0 items-center gap-1.5 truncate text-[14px] text-muted-foreground">
          {partes.length > 0 ? <span className="truncate">{partes.join(" · ")} ·</span> : null}
          <span className="font-semibold text-destructive">Sin turno abierto</span>
          {conCaja ? (
            <Link
              to="/pos/turno"
              className="shrink-0 rounded-md px-1 font-semibold text-accent-foreground underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              Abrir turno →
            </Link>
          ) : (
            <span className="truncate">· Lo abre quien va a tener la caja.</span>
          )}
        </p>
      );
    }
    partes.push(formatBusinessDateShort(shift.business_date));
    // Quien maneja la caja lee el turno y su responsable; el resto, su
    // propia entrada (el dato que le sirve a un mesero o a la cocina).
    if (conCaja || !entrada) {
      partes.push("Turno abierto");
      if (shift.cash_responsible?.name) partes.push(`caja: ${shift.cash_responsible.name}`);
    } else {
      partes.push(`Entrada ${formatClockTime(entrada)}`);
    }
    return (
      // El contexto manda: no se recorta; si no cabe todo, se recortan los avisos.
      <p className="flex min-w-0 items-center gap-2 overflow-hidden text-[14px] whitespace-nowrap text-muted-foreground">
        <span className="shrink-0">{partes.join(" · ")}</span>
        {shift.is_stale && conCaja ? (
          <span
            role="alert"
            className="inline-flex min-w-0 items-center gap-1 rounded-full bg-destructive/10 px-2 font-semibold text-destructive"
          >
            <AlertTriangle className="size-3.5 shrink-0" aria-hidden="true" />
            <span className="truncate">Turno abandonado (pasó la hora de corte)</span>
          </span>
        ) : null}
        {shift.cash_over_threshold && conCaja ? (
          <span
            role="alert"
            className="inline-flex min-w-0 items-center gap-1 rounded-full bg-warning/15 px-2 font-semibold text-warning"
          >
            <CircleDollarSign className="size-3.5 shrink-0" aria-hidden="true" />
            <span className="truncate">Efectivo por encima del umbral de retiro</span>
          </span>
        ) : null}
        {shift.expected_cash !== undefined && shift.expected_cash !== null ? (
          <span className="shrink-0">Esperado: {formatCOP(shift.expected_cash)}</span>
        ) : null}
      </p>
    );
  }

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
        {conCaja ? (
          <Link
            to="/pos/turno"
            className="inline-flex h-11 items-center rounded-lg border border-input bg-background px-3 text-sm font-medium hover:bg-muted"
          >
            Abrir turno →
          </Link>
        ) : (
          <span className="text-sm text-muted-foreground">Lo abre quien va a tener la caja.</span>
        )}
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
      {shift.is_stale && conCaja ? (
        <span
          role="alert"
          className="inline-flex items-center gap-1.5 rounded-md bg-destructive/10 px-2 py-1 font-medium text-destructive"
        >
          <AlertTriangle className="size-4" aria-hidden="true" />
          Turno abandonado (pasó la hora de corte)
        </span>
      ) : null}
      {shift.cash_over_threshold && conCaja ? (
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
