import { useSearchParams } from "react-router-dom";

import { useStoreSelection } from "@/app/storeContext";
import { Cargando } from "@/components/Cargando";
import { PageHeader } from "@/components/admin";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { HistoryTab } from "./HistoryTab";
import { moneyTabFromParam } from "./lib";
import { OperationalTab } from "./OperationalTab";

/**
 * Admin → Dinero (spec § 9.3 "Dinero", núcleo — sin flag): dos pestañas,
 * Operacional (turnos abiertos y de hoy) e Historial (rango de fechas +
 * exportar CSV + detalle con timeline y rescates).
 */
export function MoneyAdminPage(): React.JSX.Element {
  const { activeStoreId, loading } = useStoreSelection();
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = moneyTabFromParam(searchParams.get("tab"));

  if (loading) {
    return <Cargando texto="Cargando sedes…" className="p-4" />;
  }
  if (activeStoreId === null) {
    return <p className="p-4 text-sm text-muted-foreground">Todavía no hay sedes creadas.</p>;
  }

  return (
    <div className="space-y-4">
      {/* § 2 · «Dinero» no se explica solo: la cabecera lleva la pregunta que
          la pantalla contesta, plegada en «¿Qué es esto?». Lo que antes iba
          en la franja de contexto eran dos frases que explicaban la pantalla
          —qué muestra cada pestaña, dónde viven los rescates— y no datos que
          caducan: pasaron a la pregunta (mapa de pantallas, regla 2). El
          período de cada pestaña vive en la pestaña; la sede, en la lateral
          (§ 1). */}
      <PageHeader
        name="Dinero"
        question="Cuánto debería haber en cada cajón, cuánto había de verdad y quién respondió por la diferencia. Operacional muestra los turnos de hoy; Historial, cualquier rango. Los rescates de administrador —cierre administrativo, reabrir, cancelar y ajustar apertura— se abren desde «Ver detalle» de cada turno."
      >
        <Tabs
          value={tab}
          onValueChange={(value) => {
            const next = new URLSearchParams(searchParams);
            next.set("tab", String(value));
            setSearchParams(next, { replace: true });
          }}
        >
          <TabsList className="mt-1">
            <TabsTrigger value="operacional">Operacional</TabsTrigger>
            <TabsTrigger value="historial">Historial</TabsTrigger>
          </TabsList>
          <TabsContent value="operacional" className="pt-4">
            <OperationalTab storeId={activeStoreId} />
          </TabsContent>
          <TabsContent value="historial" className="pt-4">
            <HistoryTab storeId={activeStoreId} />
          </TabsContent>
        </Tabs>
      </PageHeader>
    </div>
  );
}
