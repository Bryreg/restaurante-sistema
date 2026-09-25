import { useState } from "react";

import { useSession } from "@/app/session";
import { EmptyState } from "@/components/EmptyState";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { errorMessage } from "@/lib/errors";

import { CashSwapPanel } from "./CashSwapPanel";
import { CloseWizard } from "./CloseWizard";
import { DeliverySettlementPanel } from "./DeliverySettlementPanel";
import { DepositDrawerPanel } from "./DepositDrawerPanel";
import { HandoverPanel } from "./HandoverPanel";
import { MovementsPanel } from "./MovementsPanel";
import { OpenShiftForm } from "./OpenShiftForm";
import { PickupsPanel } from "./PickupsPanel";
import { ShiftSummaryPanel } from "./ShiftSummaryPanel";
import { SingleStepCloseForm } from "./SingleStepCloseForm";
import { PasoPastilla, TarjetaTurnoCerrado, type ResultadoCierre } from "./closeUi";
import { useCurrentShift } from "./hooks";

/**
 * `/pos/turno` (spec § 9.1 "Turno"): sin turno abierto muestra `OpenShiftForm`;
 * con turno abierto, un tabbed panel con lo que la spec agrupa bajo "Turno" —
 * Resumen (con roster), Movimientos, Cambio, Retiros, Consignar, Relevo y Cierre. Cada
 * pestaña opcional se muestra sólo con su flag (AGENTS.md § funciones
 * opcionales): con `cash.handovers` apagado no existe "Relevo" (checklist del
 * pedido 1a).
 *
 * **Tercera pantalla: el turno recién cerrado.** El resultado del cierre lo
 * guarda esta página (`closeResult`), no el formulario que lo produjo —los
 * dos formularios sólo avisan por `onClosed`—. Mientras haya un resultado
 * sin acusar recibo se muestra `TarjetaTurnoCerrado` en lugar de
 * `OpenShiftForm`, con «A consignar» a la vista y una acción explícita para
 * seguir. Antes ese dato lo dibujaba el formulario, que la invalidación de
 * `CURRENT_SHIFT_QUERY_KEY` desmontaba en el mismo parpadeo: quien cerraba
 * la caja nunca llegaba a ver cuánto tenía que consignar.
 */
export default function ShiftPage(): React.JSX.Element {
  const { hasFeature } = useSession();
  const { data: shift, isLoading, isError, error, refetch } = useCurrentShift();
  const showBlindClose = hasFeature("cash.blind_close");

  /**
   * El resultado del último cierre hecho en esta pantalla. Vive acá y no en
   * el formulario **a propósito**: confirmar el cierre invalida
   * `CURRENT_SHIFT_QUERY_KEY`, `GET /shifts/current` pasa a devolver `null`
   * y el `if (!shift)` de más abajo desmontaba el formulario —con su
   * pantalla de «Turno cerrado» adentro— antes de que nadie alcanzara a
   * leer cuánto hay que consignar. La página no depende del turno para
   * seguir montada, así que el resultado sobrevive.
   */
  const [closeResult, setCloseResult] = useState<ResultadoCierre | null>(null);

  // Va ANTES que `isLoading`/`isError`/`!shift`: mientras haya un resultado
  // sin acusar recibo, manda él. Sólo lo borra el botón de continuar — ni el
  // refetch, ni el sondeo de 5 s, ni que el turno desaparezca.
  if (closeResult) {
    return (
      <TarjetaTurnoCerrado
        resultado={closeResult}
        pastilla={
          <PasoPastilla tono="listo">{showBlindClose ? "Paso 3 de 3 · hecho" : "Hecho"}</PasoPastilla>
        }
        etiquetaContinuar={shift ? "Listo" : "Abrir turno"}
        onContinuar={() => setCloseResult(null)}
      />
    );
  }

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
  const showDelivery = hasFeature("pos.delivery");
  // Consignar desde el POS (2026-09-24): la plata de días anteriores que
  // está en el cajón. El turno está abierto si se llegó hasta acá.
  const showDeposits = hasFeature("money.deposits");

  return (
    <div className="space-y-4">
      <Tabs defaultValue="resumen">
        {/* Sin clase de desborde acá: lo resuelve el primitivo
            (`components/ui/tabs.tsx`). Esta pantalla fue donde se descubrió
            —a 390 px sus seis pestañas miden 421 px y se salían de los 365
            del `<main>`, empujando la página 42 px— pero el defecto era de
            `TabsList`, no de acá, y las otras quince pantallas con pestañas
            lo tenían igual de latente. */}
        <TabsList>
          <TabsTrigger value="resumen">Resumen</TabsTrigger>
          <TabsTrigger value="movimientos">Movimientos</TabsTrigger>
          {showSwaps ? <TabsTrigger value="cambio">Cambio</TabsTrigger> : null}
          {showPickups ? <TabsTrigger value="retiros">Retiros</TabsTrigger> : null}
          {showDelivery ? <TabsTrigger value="domicilios">Domicilios</TabsTrigger> : null}
          {showDeposits ? <TabsTrigger value="consignar">Consignar</TabsTrigger> : null}
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
        {showDeposits ? (
          <TabsContent value="consignar">
            <DepositDrawerPanel shiftId={shift.id} />
          </TabsContent>
        ) : null}
        {showHandovers ? (
          <TabsContent value="relevo">
            <HandoverPanel shiftId={shift.id} />
          </TabsContent>
        ) : null}
        <TabsContent value="cierre">
          {showBlindClose ? (
            <CloseWizard shiftId={shift.id} onClosed={setCloseResult} />
          ) : (
            <SingleStepCloseForm shiftId={shift.id} onClosed={setCloseResult} />
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
