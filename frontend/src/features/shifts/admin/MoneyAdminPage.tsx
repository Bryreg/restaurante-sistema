import { useStoreSelection } from "@/app/storeContext";
import { PageHeader } from "@/components/admin";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { HistoryTab } from "./HistoryTab";
import { OperationalTab } from "./OperationalTab";

/**
 * Admin → Dinero (spec § 9.3 "Dinero", núcleo — sin flag): dos pestañas,
 * Operacional (turnos abiertos y de hoy) e Historial (rango de fechas +
 * exportar CSV + detalle con timeline y rescates).
 */
export function MoneyAdminPage(): React.JSX.Element {
  const { activeStoreId, loading } = useStoreSelection();

  if (loading) {
    return <p className="p-4 text-sm text-muted-foreground">Cargando sedes…</p>;
  }
  if (activeStoreId === null) {
    return <p className="p-4 text-sm text-muted-foreground">Todavía no hay sedes creadas.</p>;
  }

  return (
    <div className="space-y-4">
      {/* § 2 · «Dinero» no se explica solo: la cabecera lleva la pregunta que
          la pantalla contesta. El período de cada pestaña vive en la pestaña;
          la sede, en la lateral (§ 1). */}
      <PageHeader
        name="Dinero"
        question="Cuánto debería haber en cada cajón, cuánto había de verdad y quién respondió por la diferencia."
        context={[
          { label: "Operacional muestra los turnos de hoy; Historial, cualquier rango." },
          {
            label: "Los rescates de administrador viven en el detalle de cada turno",
            title: "Cierre administrativo, Reabrir, Cancelar y Ajustar apertura se abren desde «Ver detalle» de una fila.",
          },
        ]}
      >
        <Tabs defaultValue="operational">
          <TabsList className="mt-1">
            <TabsTrigger value="operational">Operacional</TabsTrigger>
            <TabsTrigger value="history">Historial</TabsTrigger>
          </TabsList>
          <TabsContent value="operational" className="pt-4">
            <OperationalTab storeId={activeStoreId} />
          </TabsContent>
          <TabsContent value="history" className="pt-4">
            <HistoryTab storeId={activeStoreId} />
          </TabsContent>
        </Tabs>
      </PageHeader>
    </div>
  );
}
