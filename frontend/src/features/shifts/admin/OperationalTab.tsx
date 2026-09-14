import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { listAdminShifts, type AdminShiftListItem } from "@/api/shifts";
import { EmptyState } from "@/components/EmptyState";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { errorMessage } from "@/lib/errors";
import { formatCOP } from "@/lib/money";

import { ShiftDetailDialog } from "./ShiftDetailDialog";

/**
 * "Hoy" en la zona de la sede, sólo como valor inicial de un filtro de
 * pantalla (nunca como fecha operativa de un registro: esa la sella el
 * servidor con la hora de corte de la sede — `core/tz.py`). Usar
 * `Intl.DateTimeFormat` acá es intencional y distinto de las trampas
 * prohibidas en `lib/businessDate.ts` (`new Date("YYYY-MM-DD")` o
 * `toISOString().slice(0, 10)`): esto parte de "ahora", no de un
 * `business_date` ya guardado.
 */
function todayInBogota(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Bogota" }).format(new Date());
}

const STATUS_LABEL: Record<string, string> = { open: "Abierto", closed: "Cerrado" };

/** Dinero → Operacional: turnos abiertos y de hoy, por sede. */
export function OperationalTab({ storeId }: { storeId: number }): React.JSX.Element {
  const [detailShift, setDetailShift] = useState<AdminShiftListItem | null>(null);
  const today = todayInBogota();

  const query = useQuery({
    queryKey: ["admin-shifts", "operational", storeId, today],
    queryFn: () => listAdminShifts({ storeId, from: today, to: today }),
  });

  if (query.isLoading) {
    return <p className="text-sm text-muted-foreground">Cargando turnos de hoy…</p>;
  }
  if (query.isError) {
    return (
      <EmptyState
        role="alert"
        title="No se pudieron cargar los turnos"
        description={errorMessage(query.error)}
        action={{ label: "Reintentar", onClick: () => void query.refetch() }}
      />
    );
  }

  const rows = [...(query.data ?? [])].sort((a, b) => (a.status === "open" ? -1 : b.status === "open" ? 1 : 0));

  return (
    <div className="space-y-4">
      {rows.length === 0 ? (
        <EmptyState title="Sin turnos hoy en esta sede" description="Todavía no se abrió ningún turno." />
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Estado</TableHead>
                <TableHead>Responsable</TableHead>
                <TableHead>Esperado</TableHead>
                <TableHead>Contado</TableHead>
                <TableHead>Diferencia</TableHead>
                <TableHead>Revisión</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((shift) => (
                <OperationalRow key={shift.id} shift={shift} onOpenDetail={() => setDetailShift(shift)} />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {detailShift ? (
        <ShiftDetailDialog
          shift={detailShift}
          open
          onOpenChange={(open) => {
            if (!open) setDetailShift(null);
          }}
          onChanged={() => void query.refetch()}
        />
      ) : null}
    </div>
  );
}

function OperationalRow({ shift, onOpenDetail }: { shift: AdminShiftListItem; onOpenDetail: () => void }) {
  return (
    <TableRow className="cursor-pointer" onClick={onOpenDetail}>
      <TableCell>
        <Badge variant={shift.status === "open" ? "default" : "secondary"}>
          {shift.status ? STATUS_LABEL[shift.status] ?? shift.status : "—"}
        </Badge>
        {shift.is_stale ? (
          <Badge variant="destructive" className="ml-1">
            Abandonado
          </Badge>
        ) : null}
      </TableCell>
      <TableCell>{shift.cash_responsible?.name ?? "—"}</TableCell>
      <TableCell className="tabular-nums">{formatCOP(shift.expected_cash)}</TableCell>
      <TableCell className="tabular-nums">{formatCOP(shift.counted_cash)}</TableCell>
      <TableCell className="tabular-nums">{formatCOP(shift.difference)}</TableCell>
      <TableCell>{shift.reviewed_at ? "Revisado" : "Sin revisar"}</TableCell>
      <TableCell className="text-right text-xs text-muted-foreground">Ver detalle →</TableCell>
    </TableRow>
  );
}
