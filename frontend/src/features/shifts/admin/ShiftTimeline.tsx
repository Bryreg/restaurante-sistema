import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { getAdminShiftTimeline } from "@/api/shifts";
import { formatClockTime } from "@/lib/businessDate";
import { errorMessage } from "@/lib/errors";

/**
 * **Cronología del turno** dentro de la tarjeta de Cuadres
 * (`GET /admin/shifts/{id}/timeline`): todo lo que pasó en el cajón, en
 * orden, con quién —apertura, entradas y salidas, movimientos, retiros,
 * relevos, la base de respaldo, cierre y rescates—. Plegada; se pide al
 * servidor recién cuando se abre. El servidor redacta cada renglón.
 */
export function ShiftTimeline({ shiftId }: { shiftId: number }): React.JSX.Element {
  const [abierta, setAbierta] = useState(false);
  const query = useQuery({
    queryKey: ["admin-shift-timeline", shiftId],
    queryFn: () => getAdminShiftTimeline(shiftId),
    enabled: abierta,
  });

  return (
    <details className="mt-3" onToggle={(e) => setAbierta(e.currentTarget.open)}>
      <summary className="cursor-pointer text-xs font-bold tracking-wide text-muted-foreground uppercase">
        Cronología del turno
      </summary>
      {query.isLoading ? (
        <p className="mt-1 text-sm text-muted-foreground">Cargando la cronología…</p>
      ) : query.isError ? (
        <p role="alert" className="mt-1 text-sm text-destructive">
          No se pudo cargar la cronología: {errorMessage(query.error)}
        </p>
      ) : query.data && query.data.length === 0 ? (
        <p className="mt-1 text-sm text-muted-foreground">Sin eventos todavía.</p>
      ) : query.data ? (
        <ol className="mt-2 space-y-1 text-sm">
          {query.data.map((e, i) => (
            <li key={`${e.kind}-${e.at}-${i}`} className="flex gap-3">
              <span className="w-20 shrink-0 text-muted-foreground tabular-nums">{formatClockTime(e.at)}</span>
              <span className="min-w-0">
                {e.summary}
                {e.employee_name ? <span className="text-muted-foreground"> · {e.employee_name}</span> : null}
              </span>
            </li>
          ))}
        </ol>
      ) : null}
    </details>
  );
}
