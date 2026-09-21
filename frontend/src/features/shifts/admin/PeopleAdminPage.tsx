import { useQuery } from "@tanstack/react-query";

import { listEmployees } from "@/api/employees";
import { useSession } from "@/app/session";
import { PageHeader } from "@/components/admin";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { AuthorizationsTab } from "./AuthorizationsTab";
import { PersonActivityTab } from "./PersonActivityTab";

/**
 * Admin → Turnos y personal (spec § 9.3, núcleo — sin flag): actividad por
 * persona (turnos, entradas/salidas, diferencias y racha, autorizaciones
 * dadas) y autorizaciones por autorizador.
 *
 * La segunda pestaña **es el reporte que justifica que el supervisor tenga
 * PIN propio**: sin ella, la autorización deja de ser un control y pasa a
 * ser un trámite (`docs/INVENTARIO-CONTROLES.md` § 20).
 *
 * La franja de contexto (patrón 2) cuenta **cuántas personas pueden
 * autorizar**, que es lo que decide si este reporte va a tener algo adentro:
 * con `roles.supervisor` apagada, sólo los administradores autorizan y el
 * mecanismo entero se apoya en ellos. La misma consulta que ya hacen las dos
 * pestañas — react-query la comparte, no es un pedido nuevo.
 */
export function PeopleAdminPage(): React.JSX.Element {
  const { hasFeature } = useSession();
  const employeesQuery = useQuery({
    queryKey: ["admin-employees", "all"],
    queryFn: () => listEmployees({}),
  });

  const employees = employeesQuery.data ?? [];
  const activos = employees.filter((e) => e.active);
  const supervisorEnabled = hasFeature("roles.supervisor");
  const autorizadores = activos.filter(
    (e) => e.role === "admin" || (supervisorEnabled && e.role === "supervisor"),
  ).length;

  return (
    <div className="space-y-4">
      <PageHeader
        name="Turnos y personal"
        question="Quién trabajó cuándo, quién respondió por la caja, y quién autorizó lo que otro no podía hacer solo."
        context={
          employeesQuery.isSuccess
            ? [
                {
                  label: "Personas activas",
                  value: activos.length,
                  title: "Se dan de baja, nunca se borran: lo que firmaron sigue firmado por ellas.",
                },
                {
                  label: "Pueden autorizar",
                  value: autorizadores,
                  title: supervisorEnabled
                    ? "Administradores y supervisores activos: los PIN que habilitan lo que otro no puede hacer solo."
                    : "Sólo administradores: «roles.supervisor» está apagada, así que un supervisor no autoriza nada.",
                },
              ]
            : undefined
        }
      />
      <Tabs defaultValue="person">
        <TabsList>
          <TabsTrigger value="person">Por persona</TabsTrigger>
          <TabsTrigger value="authorizations">Autorizaciones por autorizador</TabsTrigger>
        </TabsList>
        <TabsContent value="person" className="pt-4">
          <PersonActivityTab />
        </TabsContent>
        <TabsContent value="authorizations" className="pt-4">
          <AuthorizationsTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
