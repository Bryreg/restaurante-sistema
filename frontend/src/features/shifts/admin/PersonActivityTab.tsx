import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { listEmployees } from "@/api/employees";
import { getEmployeeActivity } from "@/api/shifts";
import { DenseTable, DenseTableBar, GroupLabel, TimeAgo, type DenseColumn } from "@/components/admin";
import { EmptyState } from "@/components/EmptyState";
import { StatTile } from "@/components/StatTile";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatBusinessDate } from "@/lib/businessDate";
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
    queryFn: () =>
      getEmployeeActivity(employeeId as number, { from: from || undefined, to: to || undefined }),
    enabled: employeeId !== null,
  });

  const employees = employeesQuery.data ?? [];

  const pickers = (
    <>
      <div className="flex items-center gap-2">
        <Label htmlFor="person-employee">Persona</Label>
        <Select
          value={employeeId === null ? undefined : String(employeeId)}
          onValueChange={(v) => setEmployeeId(Number(v))}
        >
          <SelectTrigger id="person-employee" className="h-8 w-44">
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
      <div className="flex items-center gap-2">
        <Label htmlFor="person-from">Desde</Label>
        <Input
          id="person-from"
          type="date"
          className="h-8"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
        />
      </div>
      <div className="flex items-center gap-2">
        <Label htmlFor="person-to">Hasta</Label>
        <Input
          id="person-to"
          type="date"
          className="h-8"
          value={to}
          onChange={(e) => setTo(e.target.value)}
        />
      </div>
    </>
  );

  const shifts = activityQuery.data?.shifts ?? [];
  const given = activityQuery.data?.authorizations_given ?? [];

  const shiftColumns: readonly DenseColumn<(typeof shifts)[number]>[] = [
    { key: "day", header: "Día operativo", kind: "name", cell: (r) => formatBusinessDate(r.business_date) },
    { key: "in", header: "Entrada", kind: "secondary", cell: (r) => <TimeAgo iso={r.in_at} /> },
    {
      key: "out",
      header: "Salida",
      kind: "secondary",
      cell: (r) => (r.out_at ? <TimeAgo iso={r.out_at} /> : "En turno"),
    },
    {
      key: "cash",
      header: "Responsable de caja",
      cell: (r) => (r.was_cash_responsible ? "Sí" : "No"),
    },
    {
      key: "diff",
      header: "Diferencia",
      kind: "number",
      // `null` no es `0`: un cierre sin diferencia registrada no es un cierre
      // que cuadró. `formatCOP` ya lo dice con «—».
      cell: (r) => formatCOP(r.difference),
    },
  ];

  const givenColumns: readonly DenseColumn<(typeof given)[number]>[] = [
    { key: "action", header: "Acción", kind: "name", cell: (a) => a.action ?? "—" },
    { key: "at", header: "Cuándo", kind: "secondary", cell: (a) => <TimeAgo iso={a.at} /> },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-card px-3 py-2">{pickers}</div>

      {employeeId === null ? (
        <EmptyState
          title="Elegí una persona para ver su actividad"
          description="Esta pestaña es siempre la de UNA persona: sus turnos, su racha de diferencias y lo que autorizó."
        />
      ) : activityQuery.isError ? (
        <EmptyState
          role="alert"
          title="No se pudo cargar la actividad"
          description={errorMessage(activityQuery.error)}
          action={{ label: "Reintentar", onClick: () => void activityQuery.refetch() }}
        />
      ) : (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <StatTile
              label="Racha de cierres con diferencia"
              {...(activityQuery.data?.difference_streak === null ||
              activityQuery.data?.difference_streak === undefined
                ? {
                    value: null,
                    nullNote: "Todavía no hay cierres de esta persona en el rango con qué armar una racha.",
                  }
                : { value: String(activityQuery.data.difference_streak) })}
              hint="Cierres seguidos con diferencia. No acusa a nadie: señala dónde mirar."
            />
            <StatTile
              label="Ventas y ticket promedio"
              value={null}
              nullNote="Sin datos: esta respuesta todavía no los trae. No es cero — es que no se están midiendo acá."
            />
          </div>

          <GroupLabel
            label="Turnos"
            says="cerrados, ya no cambian: qué día trabajó y con qué diferencia cerró"
          >
            <DenseTable
              caption="Turnos de la persona"
              columns={shiftColumns}
              rows={shifts}
              rowKey={(r) => String(r.shift_id ?? `${r.business_date}-${r.in_at}`)}
              bar={
                <DenseTableBar
                  shown={shifts.length}
                  total={shifts.length}
                  noun="turnos en el rango"
                  hidden={activityQuery.isLoading ? "contando…" : undefined}
                />
              }
              empty={
                activityQuery.isLoading ? undefined : (
                  <EmptyState
                    title="Sin turnos en este rango"
                    description="Ampliá el rango de fechas, o revisá si esta persona trabajó en otra sede."
                  />
                )
              }
            />
          </GroupLabel>

          <GroupLabel
            label="Autorizaciones dadas"
            says="lo que esta persona habilitó para que otro pudiera hacerlo"
          >
            <DenseTable
              caption="Autorizaciones dadas por la persona"
              columns={givenColumns}
              rows={given}
              rowKey={(a) => `${a.action ?? "?"}-${a.at ?? "?"}`}
              bar={
                <DenseTableBar
                  shown={given.length}
                  total={given.length}
                  noun="autorizaciones dadas"
                  hidden={activityQuery.isLoading ? "contando…" : undefined}
                />
              }
              empty={
                activityQuery.isLoading ? undefined : (
                  <EmptyState
                    title="No dio autorizaciones en este rango"
                    description="Es una noticia, no una ausencia: nadie necesitó su PIN para saltarse un límite."
                  />
                )
              }
            />
          </GroupLabel>
        </div>
      )}
    </div>
  );
}
