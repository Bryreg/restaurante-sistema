import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { listEmployees } from "@/api/employees";
import { getEmployeeActivity } from "@/api/shifts";
import { EmptyState } from "@/components/EmptyState";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatBusinessDate, formatInstant } from "@/lib/businessDate";
import { errorMessage } from "@/lib/errors";
import { formatCOP } from "@/lib/money";

/**
 * Turnos y personal → Por persona (`GET /admin/employees/{id}/activity`):
 * turnos, entradas/salidas, diferencias y racha, autorizaciones dadas. Los
 * campos de venta llegan en 1b — se muestran "sin datos" acá porque esta
 * respuesta no los trae todavía, nunca como "0" (AGENTS.md § "null no es 0").
 */
export function PersonActivityTab(): React.JSX.Element {
  const [employeeId, setEmployeeId] = useState<number | null>(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const employeesQuery = useQuery({ queryKey: ["admin-employees", "all"], queryFn: () => listEmployees({}) });

  const activityQuery = useQuery({
    queryKey: ["admin-employee-activity", employeeId, from, to],
    queryFn: () => getEmployeeActivity(employeeId as number, { from: from || undefined, to: to || undefined }),
    enabled: employeeId !== null,
  });

  const employees = employeesQuery.data ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-56 space-y-1">
          <Label htmlFor="person-employee">Persona</Label>
          <Select
            value={employeeId === null ? undefined : String(employeeId)}
            onValueChange={(v) => setEmployeeId(Number(v))}
          >
            <SelectTrigger id="person-employee" className="h-10 w-full">
              <SelectValue placeholder="Elegí una persona" />
            </SelectTrigger>
            <SelectContent>
              {employees.map((employee) => (
                <SelectItem key={employee.id} value={String(employee.id)}>
                  {employee.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="person-from">Desde</Label>
          <Input id="person-from" type="date" className="h-10" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="person-to">Hasta</Label>
          <Input id="person-to" type="date" className="h-10" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
      </div>

      {employeeId === null ? (
        <EmptyState title="Elegí una persona para ver su actividad" />
      ) : activityQuery.isLoading ? (
        <p className="text-sm text-muted-foreground">Cargando actividad…</p>
      ) : activityQuery.isError ? (
        <EmptyState
          role="alert"
          title="No se pudo cargar la actividad"
          description={errorMessage(activityQuery.error)}
          action={{ label: "Reintentar", onClick: () => void activityQuery.refetch() }}
        />
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-4 rounded-md border p-3 text-sm">
            <p>
              Racha de cierres con diferencia:{" "}
              <span className="font-medium">{activityQuery.data?.difference_streak ?? "—"}</span>
            </p>
            <p className="text-muted-foreground">
              Ventas, ticket promedio y anulaciones: sin datos (llegan en el pedido 1b).
            </p>
          </div>

          <div className="space-y-2">
            <h3 className="text-sm font-semibold">Turnos</h3>
            {(activityQuery.data?.shifts ?? []).length === 0 ? (
              <EmptyState title="Sin turnos en este rango" />
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Día operativo</TableHead>
                      <TableHead>Entrada</TableHead>
                      <TableHead>Salida</TableHead>
                      <TableHead>Responsable de caja</TableHead>
                      <TableHead>Diferencia</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(activityQuery.data?.shifts ?? []).map((s, index) => (
                      <TableRow key={s.shift_id ?? index}>
                        <TableCell>{formatBusinessDate(s.business_date)}</TableCell>
                        <TableCell>{formatInstant(s.in_at)}</TableCell>
                        <TableCell>{s.out_at ? formatInstant(s.out_at) : "En turno"}</TableCell>
                        <TableCell>{s.was_cash_responsible ? "Sí" : "No"}</TableCell>
                        <TableCell className="tabular-nums">{formatCOP(s.difference)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>

          <div className="space-y-2">
            <h3 className="text-sm font-semibold">Autorizaciones dadas</h3>
            {(activityQuery.data?.authorizations_given ?? []).length === 0 ? (
              <EmptyState title="No dio autorizaciones en este rango" />
            ) : (
              <ul className="space-y-1 text-sm">
                {(activityQuery.data?.authorizations_given ?? []).map((a, index) => (
                  <li key={index} className="rounded-md border p-2">
                    {a.action ?? "—"} · {formatInstant(a.at)}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
