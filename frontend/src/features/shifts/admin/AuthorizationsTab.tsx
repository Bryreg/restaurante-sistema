import { useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { useState } from "react";

import { listEmployees } from "@/api/employees";
import { authorizationsCsvUrl, listAuthorizations } from "@/api/shifts";
import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui/button";
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
import { formatInstant } from "@/lib/businessDate";
import { errorMessage } from "@/lib/errors";

/**
 * Turnos y personal → Autorizaciones por autorizador
 * (`GET /admin/authorizations?from&to&authorizer_id`): quién autorizó qué —
 * el control contra la colusión mesero-encargado (SPEC-NEGOCIO § 2.2).
 */
export function AuthorizationsTab(): React.JSX.Element {
  const [authorizerId, setAuthorizerId] = useState<number | null>(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const employeesQuery = useQuery({ queryKey: ["admin-employees", "all"], queryFn: () => listEmployees({}) });
  const filters = { authorizerId: authorizerId ?? undefined, from: from || undefined, to: to || undefined };

  const query = useQuery({
    queryKey: ["admin-authorizations", filters],
    queryFn: () => listAuthorizations(filters),
  });

  const employees = employeesQuery.data ?? [];
  const rows = query.data ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-56 space-y-1">
            <Label htmlFor="auth-employee">Autorizador</Label>
            <Select
              value={authorizerId === null ? undefined : String(authorizerId)}
              onValueChange={(v) => setAuthorizerId(Number(v))}
            >
              <SelectTrigger id="auth-employee" className="h-10 w-full">
                <SelectValue placeholder="Todos" />
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
            <Label htmlFor="auth-from">Desde</Label>
            <Input id="auth-from" type="date" className="h-10" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="auth-to">Hasta</Label>
            <Input id="auth-to" type="date" className="h-10" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
        </div>
        <Button
          render={<a href={authorizationsCsvUrl(filters)} target="_blank" rel="noreferrer" />}
          variant="outline"
          className="gap-2"
        >
          <Download className="size-4" aria-hidden="true" />
          Exportar CSV
        </Button>
      </div>

      {query.isLoading ? (
        <p className="text-sm text-muted-foreground">Cargando autorizaciones…</p>
      ) : query.isError ? (
        <EmptyState
          role="alert"
          title="No se pudieron cargar las autorizaciones"
          description={errorMessage(query.error)}
          action={{ label: "Reintentar", onClick: () => void query.refetch() }}
        />
      ) : rows.length === 0 ? (
        <EmptyState title="Sin autorizaciones para estos filtros" />
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Hora</TableHead>
                <TableHead>Autorizador</TableHead>
                <TableHead>Acción</TableHead>
                <TableHead>Referencia</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>{formatInstant(row.at)}</TableCell>
                  <TableCell>{row.authorizer_name ?? "—"}</TableCell>
                  <TableCell>{row.action ?? "—"}</TableCell>
                  <TableCell>
                    {row.reference_type ? `${row.reference_type} #${row.reference_id ?? "—"}` : "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
