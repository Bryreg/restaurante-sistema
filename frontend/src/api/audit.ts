/**
 * Admin → Historial: auditoría con antes y después.
 * `GET /admin/audit?from&to&entity&employee_id` (spec § "Employees & audit").
 */
import { api } from "./client";

export interface AuditRow {
  id: number;
  entity: string;
  entity_id: string;
  action: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  reason: string | null;
  actor_employee_id: number | null;
  actor_employee_name: string | null;
  actor_kind: string | null;
  at: string;
}

export interface AuditFilters {
  from?: string;
  to?: string;
  entity?: string;
  employeeId?: number;
}

export function listAudit(filters: AuditFilters = {}): Promise<AuditRow[]> {
  return api<AuditRow[]>("/admin/audit", {
    query: {
      from: filters.from,
      to: filters.to,
      entity: filters.entity,
      employee_id: filters.employeeId,
    },
  });
}

/** Construye la URL de exportación CSV con los mismos filtros aplicados. */
export function auditCsvUrl(filters: AuditFilters = {}): string {
  const params = new URLSearchParams();
  params.set("format", "csv");
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  if (filters.entity) params.set("entity", filters.entity);
  if (filters.employeeId !== undefined) params.set("employee_id", String(filters.employeeId));
  return `/api/v1/admin/audit?${params.toString()}`;
}
