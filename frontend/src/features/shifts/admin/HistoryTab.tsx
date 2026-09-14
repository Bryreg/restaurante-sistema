import { useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { useState } from "react";

import { adminShiftsCsvUrl, listAdminShifts, type AdminShiftListItem } from "@/api/shifts";
import { EmptyState } from "@/components/EmptyState";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatBusinessDate } from "@/lib/businessDate";
import { errorMessage } from "@/lib/errors";
import { formatCOP } from "@/lib/money";

import { ShiftDetailDialog } from "./ShiftDetailDialog";

const STATUS_LABEL: Record<string, string> = { open: "Abierto", closed: "Cerrado" };

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

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
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
        <Button
          render={<a href={adminShiftsCsvUrl(filters)} target="_blank" rel="noreferrer" />}
          variant="outline"
          className="gap-2"
        >
          <Download className="size-4" aria-hidden="true" />
          Exportar CSV
        </Button>
      </div>

      {query.isLoading ? (
        <p className="text-sm text-muted-foreground">Cargando historial…</p>
      ) : query.isError ? (
        <EmptyState
          role="alert"
          title="No se pudo cargar el historial"
          description={errorMessage(query.error)}
          action={{ label: "Reintentar", onClick: () => void query.refetch() }}
        />
      ) : rows.length === 0 ? (
        <EmptyState title="Sin turnos para estos filtros" />
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Día operativo</TableHead>
                <TableHead>Estado</TableHead>
                <TableHead>Responsable</TableHead>
                <TableHead>Esperado</TableHead>
                <TableHead>Contado</TableHead>
                <TableHead>Diferencia</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((shift) => (
                <TableRow key={shift.id} className="cursor-pointer" onClick={() => setDetailShift(shift)}>
                  <TableCell>{formatBusinessDate(shift.business_date)}</TableCell>
                  <TableCell>
                    <Badge variant={shift.status === "open" ? "default" : "secondary"}>
                      {shift.status ? STATUS_LABEL[shift.status] ?? shift.status : "—"}
                    </Badge>
                  </TableCell>
                  <TableCell>{shift.cash_responsible?.name ?? "—"}</TableCell>
                  <TableCell className="tabular-nums">{formatCOP(shift.expected_cash)}</TableCell>
                  <TableCell className="tabular-nums">{formatCOP(shift.counted_cash)}</TableCell>
                  <TableCell className="tabular-nums">{formatCOP(shift.difference)}</TableCell>
                  <TableCell className="text-right text-xs text-muted-foreground">Ver detalle →</TableCell>
                </TableRow>
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
