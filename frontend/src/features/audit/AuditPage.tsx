import { useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { useState } from "react";

import { auditCsvUrl, listAudit, type AuditRow } from "@/api/audit";
import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { formatInstant } from "@/lib/businessDate";
import { errorMessage } from "@/lib/errors";

interface FieldDiff {
  field: string;
  before: unknown;
  after: unknown;
}

function diffFields(before: Record<string, unknown> | null, after: Record<string, unknown> | null): FieldDiff[] {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  const rows: FieldDiff[] = [];
  for (const key of keys) {
    const beforeValue = before ? before[key] : undefined;
    const afterValue = after ? after[key] : undefined;
    if (JSON.stringify(beforeValue) !== JSON.stringify(afterValue)) {
      rows.push({ field: key, before: beforeValue, after: afterValue });
    }
  }
  return rows.sort((a, b) => a.field.localeCompare(b.field));
}

function renderValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function AuditRowDetail({ row }: { row: AuditRow }) {
  const diffs = diffFields(row.before, row.after);
  return (
    <details className="rounded-md border p-2">
      <summary className="cursor-pointer text-sm font-medium">
        {row.entity} #{row.entity_id} · {row.action}
      </summary>
      <div className="mt-2 space-y-2 text-sm">
        <p className="text-muted-foreground">
          {formatInstant(row.at)} · {row.actor_employee_name ?? "Sistema"}
          {row.reason ? ` · Motivo: ${row.reason}` : ""}
        </p>
        {diffs.length === 0 ? (
          <p className="text-muted-foreground">Sin cambios de campo (creación o baja).</p>
        ) : (
          <table className="w-full text-left text-xs">
            <thead>
              <tr>
                <th className="pr-2 font-medium">Campo</th>
                <th className="pr-2 font-medium">Antes</th>
                <th className="font-medium">Después</th>
              </tr>
            </thead>
            <tbody>
              {diffs.map((diff) => (
                <tr key={diff.field}>
                  <td className="pr-2 font-mono">{diff.field}</td>
                  <td className="pr-2 text-muted-foreground">{renderValue(diff.before)}</td>
                  <td>{renderValue(diff.after)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </details>
  );
}

/** Admin → Historial: `GET /admin/audit?from&to&entity&employee_id`. */
export default function AuditPage(): React.JSX.Element {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [entity, setEntity] = useState("");
  const [employeeId, setEmployeeId] = useState("");

  const filters = {
    from: from || undefined,
    to: to || undefined,
    entity: entity || undefined,
    employeeId: employeeId.trim() !== "" ? Number(employeeId) : undefined,
  };

  const query = useQuery({
    queryKey: ["admin-audit", filters],
    queryFn: () => listAudit(filters),
  });

  const rows = query.data ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold">Historial</h1>
          <p className="text-sm text-muted-foreground">Quién cambió qué, con antes y después.</p>
        </div>
        <Button asChild variant="outline" className="gap-2">
          <a href={auditCsvUrl(filters)} target="_blank" rel="noreferrer">
            <Download className="size-4" aria-hidden="true" />
            Exportar CSV
          </a>
        </Button>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label htmlFor="audit-from">Desde</Label>
          <Input id="audit-from" type="date" className="h-10" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="audit-to">Hasta</Label>
          <Input id="audit-to" type="date" className="h-10" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="audit-entity">Entidad</Label>
          <Input
            id="audit-entity"
            placeholder="store, employee, zone…"
            className="h-10 w-40"
            value={entity}
            onChange={(e) => setEntity(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="audit-employee">Empleado (ID)</Label>
          <Input
            id="audit-employee"
            type="number"
            className="h-10 w-32"
            value={employeeId}
            onChange={(e) => setEmployeeId(e.target.value)}
          />
        </div>
      </div>

      {query.isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : query.isError ? (
        <EmptyState
          role="alert"
          title="No se pudo cargar el historial"
          description={errorMessage(query.error)}
          action={{ label: "Reintentar", onClick: () => void query.refetch() }}
        />
      ) : rows.length === 0 ? (
        <EmptyState title="Sin cambios para estos filtros" />
      ) : (
        <div className="space-y-2">
          {rows.map((row) => (
            <AuditRowDetail key={row.id} row={row} />
          ))}
        </div>
      )}
    </div>
  );
}
