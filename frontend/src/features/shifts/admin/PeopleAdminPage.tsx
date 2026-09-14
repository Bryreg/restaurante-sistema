import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { AuthorizationsTab } from "./AuthorizationsTab";
import { PersonActivityTab } from "./PersonActivityTab";

/**
 * Admin → Turnos y personal (spec § 9.3, núcleo — sin flag): actividad por
 * persona (turnos, entradas/salidas, diferencias y racha, autorizaciones
 * dadas) y autorizaciones por autorizador.
 */
export function PeopleAdminPage(): React.JSX.Element {
  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">Turnos y personal</h1>
      <Tabs defaultValue="person">
        <TabsList>
          <TabsTrigger value="person">Por persona</TabsTrigger>
          <TabsTrigger value="authorizations">Autorizaciones por autorizador</TabsTrigger>
        </TabsList>
        <TabsContent value="person">
          <PersonActivityTab />
        </TabsContent>
        <TabsContent value="authorizations">
          <AuthorizationsTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
