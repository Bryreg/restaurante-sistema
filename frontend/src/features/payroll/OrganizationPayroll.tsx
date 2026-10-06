/**
 * La nómina del período en todas las sedes (auditoría e8): por sede y por
 * persona, calculada por el servidor con el mismo motor que la liquidación.
 * Sólo aparece si la organización tiene más de una sede.
 */
import { useQuery } from "@tanstack/react-query"

import { api } from "@/api/client"
import { useStoreSelection } from "@/app/storeContext"
import { Cargando } from "@/components/Cargando"
import { DenseTable, DenseTableBar } from "@/components/admin"
import { errorMessage } from "@/lib/errors"
import { formatCOP } from "@/lib/money"

interface OrgPayroll {
  total: number | null
  employer_total: number | null
  stores: { store_id: number; store_name: string; people: number; total: number | null; employer_total: number | null; reason: string | null }[]
  people: { employee_id: number; employee_name: string; stores: string[]; total: number | null; employer_total: number | null }[]
}

export function OrganizationPayroll({ from, to }: { from: string; to: string }): React.JSX.Element | null {
  const { stores } = useStoreSelection()
  const many = (stores ?? []).length > 1
  const query = useQuery({
    queryKey: ["payroll", "organization", from, to],
    queryFn: () => api<OrgPayroll>("/admin/payroll/organization", { query: { from, to } }),
    enabled: many,
  })
  if (!many) return null
  return (
    <details className="text-sm">
      <summary className="cursor-pointer py-1 font-medium select-none">Toda la organización en este período</summary>
      <div className="mt-2 space-y-3">
        {query.isLoading ? (
          <Cargando texto="Sumando las sedes…" />
        ) : query.isError ? (
          <p role="alert" className="text-destructive">{errorMessage(query.error)}</p>
        ) : query.data ? (
          <>
            <p>
              Pagado <b>{formatCOP(query.data.total)}</b> · costo para el negocio{" "}
              <b>{formatCOP(query.data.employer_total)}</b>
            </p>
            <DenseTable
              caption="Nómina por sede."
              columns={[
                { key: "store", header: "Sede", kind: "name", cell: (s) => s.store_name },
                { key: "people", header: "Personas", kind: "number", cell: (s) => String(s.people) },
                { key: "total", header: "Pagado", kind: "number", cell: (s) => (s.total == null ? (s.reason ?? "—") : formatCOP(s.total)) },
                { key: "emp", header: "Costo", kind: "number", cell: (s) => (s.employer_total == null ? "—" : formatCOP(s.employer_total)) },
              ]}
              rows={query.data.stores}
              rowKey={(s) => String(s.store_id)}
              bar={<DenseTableBar shown={query.data.stores.length} total={query.data.stores.length} noun="sedes" />}
            />
            <DenseTable
              caption="Por persona, sumando todas sus sedes."
              columns={[
                { key: "name", header: "Persona", kind: "name", cell: (p) => p.employee_name },
                { key: "stores", header: "Sedes", cell: (p) => p.stores.join(", ") },
                { key: "total", header: "Pagado", kind: "number", cell: (p) => formatCOP(p.total) },
                { key: "emp", header: "Costo", kind: "number", cell: (p) => formatCOP(p.employer_total) },
              ]}
              rows={query.data.people}
              rowKey={(p) => String(p.employee_id)}
              maxBodyHeightPx={320}
              bar={<DenseTableBar shown={query.data.people.length} total={query.data.people.length} noun="personas" />}
            />
          </>
        ) : null}
      </div>
    </details>
  )
}
