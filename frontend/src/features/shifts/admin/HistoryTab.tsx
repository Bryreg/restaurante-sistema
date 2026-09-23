import { useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { useState } from "react";

import { adminShiftsCsvUrl, listAdminShifts, type AdminShiftListItem } from "@/api/shifts";
import { Cargando } from "@/components/Cargando";
import { DenseTable, DenseTableBar } from "@/components/admin";
import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatBusinessDate } from "@/lib/businessDate";
import { errorMessage } from "@/lib/errors";

import { SHIFT_LEGEND, shiftColumns } from "./OperationalTab";
import { ShiftDetailDialog } from "./ShiftDetailDialog";

/** Dinero → Historial: `GET /admin/shifts?from&to&store_id`, con exportar CSV. */
export function HistoryTab({ storeId }: { storeId: number }): React.JSX.Element {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [detailShift, setDetailShift] = useState<AdminShiftListItem | null>(null);

  const filters = { storeId, from: from || undefined, to: to || undefined };
  const query = useQuery({
    queryKey: ["admin-shifts", "history", filters],
    queryFn: () => listAdminShifts(filters),
  });

  const rows = query.data ?? [];
  const hasRange = from !== "" || to !== "";
  const rangeLabel = hasRange ? `${from || "el inicio"} a ${to || "hoy"}` : "todo el historial";

  return (
    <div className="space-y-4">
      {/* El período gobierna toda la pestaña: vive arriba, pegado a la
          cabecera de pantalla, no en la barra de la tabla (§ 1 y § 2). */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label htmlFor="history-from">Desde</Label>
          <Input id="history-from" type="date" className="h-10" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="history-to">Hasta</Label>
          <Input id="history-to" type="date" className="h-10" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
      </div>

      {query.isLoading ? (
        <Cargando texto="Cargando historial…" />
      ) : query.isError ? (
        <EmptyState
          reason="error"
          title="No se pudo cargar el historial"
          description={errorMessage(query.error)}
          action={{ label: "Reintentar", onClick: () => void query.refetch() }}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          reason="filter"
          title="Sin turnos para estos filtros"
          description={`El filtro puesto es el período: ${rangeLabel}. Quitalo para ver el resto.`}
          action={
            hasRange
              ? {
                  label: "Quitar el período y ver todo el historial",
                  onClick: () => {
                    setFrom("");
                    setTo("");
                  },
                }
              : undefined
          }
        />
      ) : (
        <DenseTable
          caption="Turnos del período, con esperado, contado y diferencia."
          columns={shiftColumns(setDetailShift, [
            {
              key: "date",
              header: "Día operativo",
              kind: "name",
              cell: (s) => formatBusinessDate(s.business_date),
            },
          ])}
          rows={rows}
          rowKey={(s) => String(s.id)}
          maxBodyHeightPx={460}
          bar={
            <DenseTableBar shown={rows.length} total={rows.length} noun="turnos" hidden={`del período: ${rangeLabel}`}>
              <Button
                render={<a href={adminShiftsCsvUrl(filters)} target="_blank" rel="noreferrer" />}
                variant="outline"
                size="sm"
                className="gap-2"
              >
                <Download className="size-4" aria-hidden="true" />
                Exportar CSV
              </Button>
            </DenseTableBar>
          }
          legend={SHIFT_LEGEND}
        />
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
