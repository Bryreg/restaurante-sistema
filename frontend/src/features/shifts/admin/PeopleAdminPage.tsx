import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { PageHeader } from "@/components/admin";

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
 */
export function PeopleAdminPage(): React.JSX.Element {
  return (
    <div className="space-y-4">
      <PageHeader
        name="Turnos y personal"
        question="Quién trabajó cuándo, quién respondió por la caja, y quién autorizó lo que otro no podía hacer solo."
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
