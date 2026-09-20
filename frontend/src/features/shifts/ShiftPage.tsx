import { useSession } from "@/app/session";
import { EmptyState } from "@/components/EmptyState";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { errorMessage } from "@/lib/errors";

import { CashSwapPanel } from "./CashSwapPanel";
import { CloseWizard } from "./CloseWizard";
import { DeliverySettlementPanel } from "./DeliverySettlementPanel";
import { HandoverPanel } from "./HandoverPanel";
import { MovementsPanel } from "./MovementsPanel";
import { OpenShiftForm } from "./OpenShiftForm";
import { PickupsPanel } from "./PickupsPanel";
import { ShiftSummaryPanel } from "./ShiftSummaryPanel";
import { SingleStepCloseForm } from "./SingleStepCloseForm";
import { useCurrentShift } from "./hooks";

/**
 * `/pos/turno` (spec § 9.1 "Turno"): sin turno abierto muestra `OpenShiftForm`;
 * con turno abierto, un tabbed panel con lo que la spec agrupa bajo "Turno" —
 * Resumen (con roster), Movimientos, Cambio, Retiros, Relevo y Cierre. Cada
 * pestaña opcional se muestra sólo con su flag (AGENTS.md § funciones
 * opcionales): con `cash.handovers` apagado no existe "Relevo" (checklist del
 * pedido 1a).
 */
export default function ShiftPage(): React.JSX.Element {
  const { hasFeature } = useSession();
  const { data: shift, isLoading, isError, error, refetch } = useCurrentShift();

  if (isLoading) {
    return <p className="text-sm text-muted-foreground">Consultando el turno…</p>;
  }

  if (isError) {
    return (
      <EmptyState
        role="alert"
        title="No se pudo consultar el turno"
        description={errorMessage(error)}
        action={{ label: "Reintentar", onClick: () => void refetch() }}
      />
    );
  }

  if (!shift) {
    return <OpenShiftForm />;
  }

  const showSwaps = hasFeature("cash.swaps");
  const showPickups = hasFeature("cash.pickups");
  const showHandovers = hasFeature("cash.handovers");
  const showBlindClose = hasFeature("cash.blind_close");
  const showDelivery = hasFeature("pos.delivery");

  return (
    <div className="space-y-4">
      <Tabs defaultValue="resumen">
        <TabsList>
          <TabsTrigger value="resumen">Resumen</TabsTrigger>
          <TabsTrigger value="movimientos">Movimientos</TabsTrigger>
          {showSwaps ? <TabsTrigger value="cambio">Cambio</TabsTrigger> : null}
          {showPickups ? <TabsTrigger value="retiros">Retiros</TabsTrigger> : null}
          {showDelivery ? <TabsTrigger value="domicilios">Domicilios</TabsTrigger> : null}
          {showHandovers ? <TabsTrigger value="relevo">Relevo</TabsTrigger> : null}
          <TabsTrigger value="cierre">Cierre</TabsTrigger>
        </TabsList>

        <TabsContent value="resumen">
          <ShiftSummaryPanel shift={shift} />
        </TabsContent>
        <TabsContent value="movimientos">
          <MovementsPanel shiftId={shift.id} />
        </TabsContent>
        {showDelivery ? (
          <TabsContent value="domicilios">
            <DeliverySettlementPanel shiftId={shift.id} />
          </TabsContent>
        ) : null}
        {showSwaps ? (
          <TabsContent value="cambio">
            <CashSwapPanel shiftId={shift.id} />
          </TabsContent>
        ) : null}
        {showPickups ? (
          <TabsContent value="retiros">
            <PickupsPanel shiftId={shift.id} />
          </TabsContent>
        ) : null}
        {showHandovers ? (
          <TabsContent value="relevo">
            <HandoverPanel shiftId={shift.id} />
          </TabsContent>
        ) : null}
        <TabsContent value="cierre">
          {showBlindClose ? <CloseWizard shiftId={shift.id} /> : <SingleStepCloseForm shiftId={shift.id} />}
        </TabsContent>
      </Tabs>
    </div>
  );
}
