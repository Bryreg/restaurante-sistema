import { useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { useState } from "react";

import { listEmployees } from "@/api/employees";
import { authorizationsCsvUrl, listAuthorizations } from "@/api/shifts";
import { DenseTable, DenseTableBar, TimeAgo, type DenseColumn, type LegendEntry } from "@/components/admin";
import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { errorMessage } from "@/lib/errors";

/** La leyenda del pie: qué es y qué no es una autorización. */
const AUTHORIZATIONS_LEGEND: readonly LegendEntry[] = [
  {
    term: "Autorizador",
    meaning:
      "quien puso su PIN para habilitar lo que otro no podía hacer solo. No es quien ejecutó la acción: son dos personas distintas, y ésa es la idea.",
  },
  {
    term: "Referencia",
    meaning:
      "sobre qué se autorizó — la comanda, el turno o el retiro. Lleva a dónde mirar si algo no cuadra.",
  },
];

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

  const filters_ = (
    <>
      <div className="flex items-center gap-2">
        <Label htmlFor="auth-employee">Autorizador</Label>
        <Select
          value={authorizerId === null ? undefined : String(authorizerId)}
          onValueChange={(v) => setAuthorizerId(Number(v))}
        >
          <SelectTrigger id="auth-employee" className="h-8 w-44">
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
      <div className="flex items-center gap-2">
        <Label htmlFor="auth-from">Desde</Label>
        <Input
          id="auth-from"
          type="date"
          className="h-8"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
        />
      </div>
      <div className="flex items-center gap-2">
        <Label htmlFor="auth-to">Hasta</Label>
        <Input id="auth-to" type="date" className="h-8" value={to} onChange={(e) => setTo(e.target.value)} />
      </div>
      <Button
        render={<a href={authorizationsCsvUrl(filters)} target="_blank" rel="noreferrer" />}
        variant="outline"
        size="sm"
        className="gap-2"
      >
        <Download className="size-4" aria-hidden="true" />
        Exportar CSV
      </Button>
    </>
  );

  const columns: readonly DenseColumn<(typeof rows)[number]>[] = [
    { key: "at", header: "Hora", kind: "secondary", cell: (r) => <TimeAgo iso={r.at} /> },
    { key: "who", header: "Autorizador", kind: "name", cell: (r) => r.authorizer_name ?? "—" },
    { key: "action", header: "Acción", cell: (r) => r.action ?? "—" },
    {
      key: "ref",
      header: "Referencia",
      kind: "id",
      cell: (r) => (r.reference_type ? `${r.reference_type} #${r.reference_id ?? "—"}` : "—"),
    },
  ];

  if (query.isError) {
    return (
      <EmptyState
        role="alert"
        title="No se pudieron cargar las autorizaciones"
        description={errorMessage(query.error)}
        action={{ label: "Reintentar", onClick: () => void query.refetch() }}
      />
    );
  }

  return (
    <DenseTable
      caption="Autorizaciones por autorizador"
      columns={columns}
      rows={rows}
      rowKey={(r) => String(r.id)}
      legend={AUTHORIZATIONS_LEGEND}
      bar={
        <DenseTableBar
          shown={rows.length}
          total={rows.length}
          noun="autorizaciones"
          hidden={
            query.isLoading ? "contando…" : authorizerId !== null ? "de un solo autorizador" : undefined
          }
        >
          {filters_}
        </DenseTableBar>
      }
      note={
        <>
          Éste es el reporte que hace que el PIN de supervisor <b>sea un control y no un trámite</b>: cada
          autorización queda con quién la dio, cuándo y sobre qué. Sin este listado, un PIN compartido y uno
          propio se parecen demasiado.
        </>
      }
      empty={
        query.isLoading ? undefined : (
          <EmptyState
            title="Sin autorizaciones para estos filtros"
            description="Nadie autorizó nada en este rango — o el filtro de autorizador deja afuera a quien sí lo hizo."
          />
        )
      }
    />
  );
}
