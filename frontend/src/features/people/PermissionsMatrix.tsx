/**
 * «¿Quién puede qué?» (auditoría e11): la matriz de permisos por rol, tal
 * como la arma el servidor a partir de las reglas que de verdad aplica
 * (`app/auth/permissions.py`). No se edita acá: es para que el dueño vea
 * de un vistazo qué rol darle a cada persona.
 */
import { useQuery } from "@tanstack/react-query";

import { api } from "@/api/client";
import { Cargando } from "@/components/Cargando";
import { DenseTable, DenseTableBar } from "@/components/admin";

interface PermissionRow {
  area: string;
  capability: string;
  operator: string;
  supervisor: string;
  admin: string;
  accountant: string;
}

const NIVEL: Record<string, string> = {
  si: "Sí",
  no: "—",
  autoriza: "Sí, y autoriza",
  con_autorizacion: "Con PIN de quien autoriza",
  solo_ver: "Sólo ver",
  si_puede_cobrar: "Si «puede cobrar»",
};

const nivel = (v: string): string => NIVEL[v] ?? v;

export function PermissionsMatrix(): React.JSX.Element {
  const query = useQuery({
    queryKey: ["permissions"],
    queryFn: () => api<PermissionRow[]>("/admin/permissions"),
  });
  if (query.isLoading) return <Cargando texto="Cargando permisos…" />;
  const rows = query.data ?? [];
  return (
    <details className="text-sm">
      <summary className="cursor-pointer py-1 font-medium select-none">¿Quién puede qué? Matriz de permisos por rol</summary>
      <div className="mt-2">
        <DenseTable
          caption="Lo que cada rol puede hacer, tal como lo aplica el sistema."
          columns={[
            { key: "area", header: "Área", cell: (r) => r.area },
            { key: "cap", header: "Qué", kind: "name", cell: (r) => r.capability },
            { key: "op", header: "Operador", cell: (r) => nivel(r.operator) },
            { key: "sup", header: "Supervisor", cell: (r) => nivel(r.supervisor) },
            { key: "adm", header: "Administrador", cell: (r) => nivel(r.admin) },
            { key: "acc", header: "Contador", cell: (r) => nivel(r.accountant) },
          ]}
          rows={rows}
          rowKey={(r) => `${r.area}-${r.capability}`}
          maxBodyHeightPx={420}
          bar={<DenseTableBar shown={rows.length} total={rows.length} noun="permisos" />}
        />
      </div>
    </details>
  );
}
