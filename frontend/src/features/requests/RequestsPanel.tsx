import { useSession } from "@/app/session";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { ChangeRequestForm } from "./ChangeRequestForm";
import { MyRequestsList } from "./MyRequestsList";
import { SupplyRequestForm } from "./SupplyRequestForm";

/**
 * Solicitudes al administrador desde el POS (`pos.requests`): dos pestañas
 * —Insumos (exige además el inventario) y Sencilla (exige el Cambio)— y
 * debajo «Mis solicitudes» con su estado. Se monta como una acción más del
 * panel del turno (`?accion=solicitudes`), con el turno abierto.
 */
export function RequestsPanel({ shiftId }: { shiftId: number }): React.JSX.Element {
  const { hasFeature } = useSession();
  const insumos = hasFeature("inventory.perpetual");
  const sencilla = hasFeature("cash.swaps");

  return (
    <div className="space-y-8">
      {insumos || sencilla ? (
        <Tabs defaultValue={insumos ? "insumos" : "sencilla"}>
          <TabsList>
            {insumos ? <TabsTrigger value="insumos">Insumos</TabsTrigger> : null}
            {sencilla ? <TabsTrigger value="sencilla">Sencilla</TabsTrigger> : null}
          </TabsList>
          {insumos ? (
            <TabsContent value="insumos" className="pt-4">
              <SupplyRequestForm />
            </TabsContent>
          ) : null}
          {sencilla ? (
            <TabsContent value="sencilla" className="pt-4">
              <ChangeRequestForm />
            </TabsContent>
          ) : null}
        </Tabs>
      ) : (
        <p className="text-sm text-muted-foreground">
          Esta sede no lleva inventario ni cambio de sencilla: no hay nada para pedir desde acá.
        </p>
      )}
      <section aria-labelledby="mis-solicitudes" className="space-y-3">
        <h3 id="mis-solicitudes" className="text-lg font-semibold">
          Mis solicitudes
        </h3>
        <MyRequestsList shiftId={shiftId} />
      </section>
    </div>
  );
}
