import { useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { useState } from "react";

import { auditCsvUrl, listAudit, type AuditRow } from "@/api/audit";
import {
  DenseTable,
  DenseTableBar,
  FilterEmptyState,
  PageHeader,
  TimeAgo,
  type DenseColumn,
} from "@/components/admin";
import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
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

/**
 * El detalle de un cambio: **campo · antes · después**, más la hora exacta,
 * el actor y el motivo.
 *
 * Vive en un diálogo y no en un `<details>` dentro de la fila por la regla
 * dura del patrón 8: ninguna celda de datos hace crecer la fila. Un diff es
 * una tabla adentro de una tabla —lo que menos entra en 34 px— y es
 * exactamente el mismo caso que «Evidencia» en Documentos fiscales, que en
 * esta misma ola se resuelve igual.
 */
function ChangeDialog({ row, onOpenChange }: { row: AuditRow | null; onOpenChange: (open: boolean) => void }) {
  const diffs = row ? diffFields(row.before, row.after) : [];
  return (
    <Dialog open={row !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {row ? `${row.entity} #${row.entity_id} · ${row.action}` : ""}
          </DialogTitle>
        </DialogHeader>
        {row ? (
          <div className="space-y-3 text-sm">
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
                    <th className="pr-2 font-bold">Campo</th>
                    <th className="pr-2 font-bold">Antes</th>
                    <th className="font-bold">Después</th>
                  </tr>
                </thead>
                <tbody>
                  {diffs.map((diff) => (
                    <tr key={diff.field} className="border-t">
                      <td className="py-1 pr-2 font-mono">{diff.field}</td>
                      <td className="py-1 pr-2 text-muted-foreground line-through">{renderValue(diff.before)}</td>
                      <td className="py-1">{renderValue(diff.after)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/** Admin → Historial: `GET /admin/audit?from&to&entity&employee_id`. */
export default function AuditPage(): React.JSX.Element {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [entity, setEntity] = useState("");
  const [employeeId, setEmployeeId] = useState("");
  const [detail, setDetail] = useState<AuditRow | null>(null);

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

  // Los filtros puestos, **en palabras**: es lo que el vacío tiene que
  // nombrar, porque el dueño pudo llegar acá desde un enlace y no saber qué
  // se aplicó (patrón 13).
  const filtrosPuestos: string[] = [];
  if (from) filtrosPuestos.push(`desde ${from}`);
  if (to) filtrosPuestos.push(`hasta ${to}`);
  if (entity) filtrosPuestos.push(`entidad «${entity}»`);
  if (employeeId.trim() !== "") filtrosPuestos.push(`empleado #${employeeId}`);

  function quitarFiltro(filtro: string) {
    if (filtro.startsWith("desde")) setFrom("");
    else if (filtro.startsWith("hasta")) setTo("");
    else if (filtro.startsWith("entidad")) setEntity("");
    else setEmployeeId("");
  }

  const columns: readonly DenseColumn<AuditRow>[] = [
    {
      key: "at",
      header: "Cuándo",
      kind: "secondary",
      widthPx: 110,
      cell: (row) => <TimeAgo iso={row.at} />,
      cellTitle: (row) => formatInstant(row.at),
    },
    { key: "entity", header: "Entidad", kind: "name", cell: (row) => row.entity },
    { key: "entity_id", header: "#", kind: "id", cell: (row) => `#${row.entity_id}` },
    { key: "action", header: "Acción", cell: (row) => row.action },
    {
      key: "actor",
      header: "Quién",
      cell: (row) => row.actor_employee_name ?? "Sistema",
    },
    {
      key: "reason",
      header: "Motivo",
      kind: "secondary",
      // Cortado, con el motivo entero en el `title`: un motivo largo no puede
      // decidir el ancho de la tabla entera.
      cell: (row) => <span className="block max-w-[260px] truncate">{row.reason ?? "—"}</span>,
      cellTitle: (row) => row.reason ?? undefined,
    },
    {
      key: "fields",
      header: "Campos",
      kind: "secondary",
      widthPx: 120,
      cell: (row) => {
        const n = diffFields(row.before, row.after).length;
        return n === 0 ? "creación o baja" : `${n} ${n === 1 ? "campo" : "campos"}`;
      },
    },
    {
      key: "actions",
      header: "",
      kind: "actions",
      cell: (row) => (
        <Button type="button" variant="outline" size="sm" onClick={() => setDetail(row)}>
          Ver cambios
        </Button>
      ),
    },
  ];

  return (
    <div className="space-y-3">
      <PageHeader
        name="Historial"
        question="¿Quién cambió qué, cuándo y con qué motivo — y qué decía antes de cambiarlo?"
        context={[
          {
            label: "Sin flag: es auditoría",
            title: "No se apaga desde Funciones y no se borra: es la prueba de quién tocó qué.",
          },
          { label: "Cambios listados", value: `${rows.length}` },
          {
            label: "Se lee con el filtro puesto",
            value: filtrosPuestos.length > 0 ? `${filtrosPuestos.length}` : "sin filtros",
            title: "Desde, hasta, entidad y empleado se aplican también al CSV.",
          },
        ]}
        actions={
          <Button
            render={<a href={auditCsvUrl(filters)} target="_blank" rel="noreferrer" />}
            variant="outline"
            className="gap-2"
          >
            <Download className="size-4" aria-hidden="true" />
            Exportar CSV
          </Button>
        }
      />

      {query.isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : query.isError ? (
        <EmptyState
          role="alert"
          reason="error"
          title="No se pudo cargar el historial"
          description={errorMessage(query.error)}
          action={{ label: "Reintentar", onClick: () => void query.refetch() }}
        />
      ) : (
        <DenseTable
          caption="Cambios registrados, con quién los hizo y qué decía antes"
          columns={columns}
          rows={rows}
          rowKey={(row) => String(row.id)}
          // Con alto máximo la cabecera fija del patrón 8 pega de verdad:
          // `sticky` se agarra del ancestro que scrollea, y sin esto el que
          // scrollea es la página entera y la cabecera se va con ella.
          maxBodyHeightPx={560}
          bar={
            <DenseTableBar
              shown={rows.length}
              total={rows.length}
              noun="cambios"
              hidden={filtrosPuestos.length > 0 ? `filtrados por ${filtrosPuestos.join(" · ")}` : undefined}
            >
              <div className="flex flex-wrap items-center gap-2">
                <Label htmlFor="audit-from" className="text-xs text-muted-foreground">
                  Desde
                </Label>
                <Input
                  id="audit-from"
                  type="date"
                  className="h-9 w-36"
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                />
                <Label htmlFor="audit-to" className="text-xs text-muted-foreground">
                  Hasta
                </Label>
                <Input
                  id="audit-to"
                  type="date"
                  className="h-9 w-36"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                />
                <Label htmlFor="audit-entity" className="text-xs text-muted-foreground">
                  Entidad
                </Label>
                <Input
                  id="audit-entity"
                  placeholder="store, employee, zone…"
                  className="h-9 w-40"
                  value={entity}
                  onChange={(e) => setEntity(e.target.value)}
                />
                <Label htmlFor="audit-employee" className="text-xs text-muted-foreground">
                  Empleado (ID)
                </Label>
                <Input
                  id="audit-employee"
                  type="number"
                  className="h-9 w-24"
                  value={employeeId}
                  onChange={(e) => setEmployeeId(e.target.value)}
                />
              </div>
            </DenseTableBar>
          }
          legend={[
            {
              term: "Creación o baja",
              meaning:
                "no hay campo que comparar: la fila nació o se dio de baja entera. No es que el cambio se haya perdido.",
            },
            {
              term: "Sistema",
              meaning: "lo hizo el servidor, no una persona: un cierre automático, una migración, un vencimiento.",
            },
            {
              term: "Desactivar no es borrar",
              meaning:
                "los empleados y las sedes se desactivan; por eso acá se ve el cambio de estado y no una desaparición.",
            },
          ]}
          note="El historial no se edita ni se borra desde ninguna pantalla: para eso existe."
          empty={
            filtrosPuestos.length > 0 ? (
              <FilterEmptyState
                title="Sin cambios para estos filtros"
                filters={filtrosPuestos as [string, ...string[]]}
                onRemove={quitarFiltro}
              />
            ) : (
              <EmptyState
                title="Sin cambios para estos filtros"
                description="Todavía no hay nada registrado en el período que se está mirando."
              />
            )
          }
        />
      )}

      <ChangeDialog row={detail} onOpenChange={(open) => !open && setDetail(null)} />
    </div>
  );
}
