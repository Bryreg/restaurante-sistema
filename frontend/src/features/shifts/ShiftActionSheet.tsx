import { ArrowLeft } from "lucide-react";

import type { ShiftCurrent } from "@/api/shifts";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { AreaCountPanel } from "@/features/inventory/AreaCountPanel";
import { NoveltiesPanel } from "@/features/novelties";
import { ReceiveGoodsPanel } from "@/features/purchases";
import { RequestsPanel } from "@/features/requests";

import type { Accion, ClaveAccion } from "./acciones";
import { BASE_SLOT } from "./baseSlot";
import { CashSwapPanel } from "./CashSwapPanel";
import { CloseWizard } from "./CloseWizard";
import { DeliverySettlementPanel } from "./DeliverySettlementPanel";
import { DepositDrawerPanel } from "./DepositDrawerPanel";
import { HandoverPanel } from "./HandoverPanel";
import { MovementsPanel } from "./MovementsPanel";
import { PickupsPanel } from "./PickupsPanel";
import { RosterPanel } from "./RosterPanel";
import { SingleStepCloseForm } from "./SingleStepCloseForm";
import type { ResultadoCierre } from "./closeUi";

/**
 * La hoja lateral que abre una acción del turno, **la misma** desde el panel
 * del turno (`ShiftPage`) y desde la cinta de caja de Mesas (`CashRibbon`):
 * cabecera con «volver» + título + descripción, y debajo el panel de siempre
 * (`MovementsPanel`, `CashSwapPanel`, …), que no cambió. Quien la monta
 * decide qué acción está abierta (las dos usan `?accion=`) y qué dice el
 * botón de volver — «Resumen» en el turno, «Mesas» en Mesas.
 *
 * El cierre ocupa el ancho entero: es un asistente de tres pasos.
 */
export function ShiftActionSheet({
  accion,
  shift,
  showBlindClose,
  volver,
  onClose,
  onClosed,
}: {
  accion: Accion | null;
  shift: ShiftCurrent;
  showBlindClose: boolean;
  volver: { label: string; ariaLabel: string };
  onClose: () => void;
  onClosed: (resultado: ResultadoCierre) => void;
}): React.JSX.Element {
  return (
    <Sheet
      open={accion !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      {accion ? (
        <SheetContent
          side="right"
          showCloseButton={false}
          className={
            // Handoff `PosMesas`: una hoja lateral de 480 px encima de la
            // pantalla, fondo `card`. El cierre sigue a lo ancho: es un
            // asistente de tres pasos.
            accion.clave === "cierre"
              ? "gap-0 bg-card data-[side=right]:w-full data-[side=right]:sm:max-w-none"
              : "gap-0 bg-card data-[side=right]:w-full data-[side=right]:sm:max-w-[480px]"
          }
        >
          <div className="flex items-center gap-2.5 border-b p-3">
            <Button
              type="button"
              variant="outline"
              size="lg"
              className="h-[56px] gap-1.5 rounded-lg px-3.5 text-[16px] font-semibold [&_svg]:size-5"
              aria-label={volver.ariaLabel}
              onClick={onClose}
            >
              <ArrowLeft aria-hidden="true" />
              {volver.label}
            </Button>
            <SheetTitle className="min-w-0 text-[22px] leading-tight font-extrabold">{accion.label}</SheetTitle>
          </div>
          <div className="flex-1 space-y-4 overflow-y-auto p-4">
            <SheetDescription className="text-[16px] text-muted-foreground">{accion.descripcion}</SheetDescription>
            <PanelDeAccion
              clave={accion.clave}
              shift={shift}
              showBlindClose={showBlindClose}
              onClosed={onClosed}
              onDone={onClose}
            />
          </div>
        </SheetContent>
      ) : null}
    </Sheet>
  );
}

/** El panel de siempre para cada acción: se reusan tal cual. */
function PanelDeAccion({
  clave,
  shift,
  showBlindClose,
  onClosed,
  onDone,
}: {
  clave: ClaveAccion;
  shift: ShiftCurrent;
  showBlindClose: boolean;
  onClosed: (resultado: ResultadoCierre) => void;
  onDone: () => void;
}): React.JSX.Element | null {
  switch (clave) {
    case "entrada":
      return <RosterPanel shift={shift} />;
    case "movimientos":
      return <MovementsPanel shiftId={shift.id} />;
    case "cambio":
      return <CashSwapPanel shiftId={shift.id} />;
    case "retiros":
      return <PickupsPanel shiftId={shift.id} />;
    case "domicilios":
      return <DeliverySettlementPanel shiftId={shift.id} />;
    case "consignar":
      return <DepositDrawerPanel shiftId={shift.id} />;
    case "relevo":
      return <HandoverPanel shiftId={shift.id} />;
    case "recibir":
      return <ReceiveGoodsPanel />;
    case "solicitudes":
      return <RequestsPanel shiftId={shift.id} />;
    case "novedades":
      return <NoveltiesPanel />;
    case "conteo":
      return <AreaCountPanel />;
    case "base_tomar": {
      const Panel = BASE_SLOT.tomar;
      return Panel ? <Panel shiftId={shift.id} onDone={onDone} /> : null;
    }
    case "base_devolver": {
      const Panel = BASE_SLOT.devolver;
      return Panel ? <Panel shiftId={shift.id} onDone={onDone} /> : null;
    }
    case "base_verificar": {
      const Panel = BASE_SLOT.verificar;
      return Panel ? <Panel onDone={onDone} /> : null;
    }
    case "cierre":
      return showBlindClose ? (
        <CloseWizard shiftId={shift.id} onClosed={onClosed} />
      ) : (
        <SingleStepCloseForm shiftId={shift.id} onClosed={onClosed} />
      );
  }
}
