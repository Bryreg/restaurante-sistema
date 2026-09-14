import { useStoreSelection } from "@/app/storeContext";
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
      <h1 className="text-lg font-semibold">Dinero</h1>
      <Tabs defaultValue="operational">
        <TabsList>
          <TabsTrigger value="operational">Operacional</TabsTrigger>
          <TabsTrigger value="history">Historial</TabsTrigger>
        </TabsList>
        <TabsContent value="operational">
          <OperationalTab storeId={activeStoreId} />
        </TabsContent>
        <TabsContent value="history">
          <HistoryTab storeId={activeStoreId} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
