import { useStoreSelection } from "@/app/storeContext";
import { PeopleSection } from "@/features/people/PeopleSection";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { CashSection } from "./CashSection";
import { ChannelsSection } from "./ChannelsSection";
import { FiscalSection } from "./FiscalSection";
import { InventorySection } from "./InventorySection";
import { OrganizationSection } from "./OrganizationSection";
import { SalesSection } from "./SalesSection";
import { StoresSection } from "./StoresSection";
import { UvtSection } from "./UvtSection";
import { ZonesTablesSection } from "./ZonesTablesSection";

/**
 * Admin → Configuración. Cada pestaña pega contra un recurso distinto de
 * `/admin/stores/{id}/*`; la mayoría necesita la sede activa
 * (`useStoreSelection`), que ya resuelve `AdminLayout`.
 */
export default function SettingsPage(): React.JSX.Element {
  const { activeStoreId } = useStoreSelection();

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold">Configuración</h1>
        <p className="text-sm text-muted-foreground">Organización, sedes y sus parámetros.</p>
      </div>
      <Tabs defaultValue="organization">
        <TabsList className="h-auto flex-wrap">
          <TabsTrigger value="organization">Organización</TabsTrigger>
          <TabsTrigger value="stores">Sedes</TabsTrigger>
          <TabsTrigger value="fiscal">Fiscal</TabsTrigger>
          <TabsTrigger value="cash">Caja</TabsTrigger>
          <TabsTrigger value="sales">Ventas</TabsTrigger>
          <TabsTrigger value="channels">Canales y plataformas</TabsTrigger>
          <TabsTrigger value="uvt">UVT</TabsTrigger>
          <TabsTrigger value="zones">Zonas y mesas</TabsTrigger>
          <TabsTrigger value="inventory">Inventario</TabsTrigger>
          <TabsTrigger value="people">Empleados</TabsTrigger>
        </TabsList>
        <TabsContent value="organization" className="pt-4">
          <OrganizationSection />
        </TabsContent>
        <TabsContent value="stores" className="pt-4">
          <StoresSection />
        </TabsContent>
        <TabsContent value="fiscal" className="pt-4">
          <FiscalSection storeId={activeStoreId} />
        </TabsContent>
        <TabsContent value="cash" className="pt-4">
          <CashSection storeId={activeStoreId} />
        </TabsContent>
        <TabsContent value="sales" className="pt-4">
          <SalesSection storeId={activeStoreId} />
        </TabsContent>
        <TabsContent value="channels" className="pt-4">
          <ChannelsSection storeId={activeStoreId} />
        </TabsContent>
        <TabsContent value="uvt" className="pt-4">
          <UvtSection />
        </TabsContent>
        <TabsContent value="zones" className="pt-4">
          <ZonesTablesSection storeId={activeStoreId} />
        </TabsContent>
        <TabsContent value="inventory" className="pt-4">
          <InventorySection storeId={activeStoreId} />
        </TabsContent>
        <TabsContent value="people" className="pt-4">
          <PeopleSection storeId={activeStoreId} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
