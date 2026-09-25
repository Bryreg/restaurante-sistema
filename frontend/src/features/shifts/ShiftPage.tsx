import {
  ArrowLeft,
  ArrowRightLeft,
  Bike,
  Coins,
  Landmark,
  LockKeyhole,
  type LucideIcon,
  PiggyBank,
  UserCheck,
  Users,
} from "lucide-react";
import { useEffect, useId, useState } from "react";
import { useSearchParams } from "react-router-dom";

import type { ShiftCurrent } from "@/api/shifts";
import { useSession } from "@/app/session";
import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { errorMessage } from "@/lib/errors";

import { CashSwapPanel } from "./CashSwapPanel";
import { CloseWizard } from "./CloseWizard";
import { DeliverySettlementPanel } from "./DeliverySettlementPanel";
import { DepositDrawerPanel } from "./DepositDrawerPanel";
import { HandoverPanel } from "./HandoverPanel";
import { MovementsPanel } from "./MovementsPanel";
import { OpenShiftForm } from "./OpenShiftForm";
import { PickupsPanel } from "./PickupsPanel";
import { RosterPanel } from "./RosterPanel";
import { ShiftSummaryPanel } from "./ShiftSummaryPanel";
import { ShiftTeamCard } from "./ShiftTeamCard";
import { SingleStepCloseForm } from "./SingleStepCloseForm";
import { PasoPastilla, TarjetaTurnoCerrado, type ResultadoCierre } from "./closeUi";
import { useCurrentShift } from "./hooks";

/**
 * Las acciones del turno, en el orden en que se dibujan. `clave` es la que
 * va en `?accion=` (deep link: otra pantalla puede mandar directo a
 * `/pos/turno?accion=consignar`); `flag` es la función opcional que la
 * enciende — sin flag, siempre está. «Cierre» no entra a la grilla: va
 * aparte, al pie (ver `ShiftPage`).
 */
type ClaveAccion =
  | "entrada"
  | "movimientos"
  | "cambio"
  | "retiros"
  | "domicilios"
  | "consignar"
  | "relevo"
  | "cierre";

interface Accion {
  clave: ClaveAccion;
  label: string;
  descripcion: string;
  icono: LucideIcon;
  flag?: string;
}

const ACCIONES: Accion[] = [
  {
    clave: "entrada",
    label: "Entrada / Salida",
    descripcion: "Entrar, salir o pausar con tu PIN",
    icono: UserCheck,
  },
  { clave: "movimientos", label: "Movimientos", descripcion: "Ingreso o egreso de efectivo", icono: ArrowRightLeft },
  {
    clave: "cambio",
    label: "Cambio",
    descripcion: "Cambiar billetes por sencilla",
    icono: Coins,
    flag: "cash.swaps",
  },
  {
    clave: "retiros",
    label: "Retiros",
    descripcion: "Sacar efectivo del cajón a sobre",
    icono: PiggyBank,
    flag: "cash.pickups",
  },
  {
    clave: "domicilios",
    label: "Domicilios",
    descripcion: "Liquidar el efectivo de los domiciliarios",
    icono: Bike,
    flag: "pos.delivery",
  },
  {
    // Consignar desde el POS (2026-09-24): la plata de días anteriores que
    // está en el cajón. El turno está abierto si se llegó hasta acá.
    clave: "consignar",
    label: "Consignar",
    descripcion: "Llevar al banco la plata de días anteriores",
    icono: Landmark,
    flag: "money.deposits",
  },
  {
    clave: "relevo",
    label: "Relevo",
    descripcion: "Entregar la caja o hacer un arqueo sorpresa",
    icono: Users,
    flag: "cash.handovers",
  },
];

/** El cierre, aparte de la grilla pero con la misma forma, para el deep link y la hoja. */
const CIERRE: Accion = {
  clave: "cierre",
  label: "Cierre",
  descripcion: "Contar el cajón y cerrar la caja",
  icono: LockKeyhole,
};

/** Lo que muestra el botón de volver: el panel mismo, que antes era la pestaña «Resumen». */
const VOLVER = { label: "Resumen" } as const;

/**
 * `/pos/turno` (spec § 9.1 "Turno"): sin turno abierto muestra `OpenShiftForm`;
 * con turno abierto, **un solo panel** (pedido del dueño, 2026-09-25, a
 * imagen de la «Gestión de turno» del café): arriba el estado del turno
 * (`ShiftSummaryPanel`) y el equipo (`ShiftTeamCard`); debajo, una grilla de
 * botones grandes, uno por acción; y al pie, separado, «Cerrar turno». Cada
 * botón abre el panel de siempre (`MovementsPanel`, `CashSwapPanel`, …) en
 * una hoja lateral — los paneles no cambiaron, cambió desde dónde se llega.
 * Cada acción opcional se muestra sólo con su flag (AGENTS.md § funciones
 * opcionales): con `cash.handovers` apagado no existe "Relevo" (checklist del
 * pedido 1a), tampoco por `?accion=relevo`.
 *
 * Antes eran hasta ocho pestañas (Resumen, Movimientos, Cambio, Retiros,
 * Domicilios, Consignar, Relevo, Cierre); los rótulos siguen siendo los
 * mismos, en `ACCIONES`, `CIERRE` y `VOLVER`.
 *
 * **Tercera pantalla: el turno recién cerrado.** El resultado del cierre lo
 * guarda esta página (`closeResult`), no el formulario que lo produjo —los
 * dos formularios sólo avisan por `onClosed`—. Mientras haya un resultado
 * sin acusar recibo se muestra `TarjetaTurnoCerrado` en lugar de
 * `OpenShiftForm`, con «A consignar» a la vista y una acción explícita para
 * seguir. Antes ese dato lo dibujaba el formulario, que la invalidación de
 * `CURRENT_SHIFT_QUERY_KEY` desmontaba en el mismo parpadeo: quien cerraba
 * la caja nunca llegaba a ver cuánto tenía que consignar. Con la hoja pasa
 * lo mismo: el resultado reemplaza la página entera, hoja incluida.
 */
export default function ShiftPage(): React.JSX.Element {
  const { hasFeature } = useSession();
  const { data: shift, isLoading, isError, error, refetch } = useCurrentShift();
  const showBlindClose = hasFeature("cash.blind_close");
  const [searchParams, setSearchParams] = useSearchParams();

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

  // La acción abierta vive en la URL (`?accion=`), no en un estado: así se
  // puede enlazar desde otra pantalla. Una clave desconocida o apagada por
  // flag se ignora (más abajo, al buscarla entre las habilitadas).
  const claveAbierta = searchParams.get("accion");

  function abrir(clave: ClaveAccion): void {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set("accion", clave);
        return next;
      },
      { replace: true },
    );
  }

  function cerrarAccion(): void {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete("accion");
        return next;
      },
      { replace: true },
    );
  }

  // Sin turno no hay acción que abrir: si la URL trae una (un enlace viejo,
  // o el `?accion=cierre` del cierre que se acaba de hacer), se descarta
  // para que no salte sola apenas alguien abra el turno siguiente.
  const sinTurno = !isLoading && !isError && !shift && !closeResult;
  useEffect(() => {
    if (sinTurno && claveAbierta !== null) setSearchParams({}, { replace: true });
  }, [sinTurno, claveAbierta, setSearchParams]);

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
        onContinuar={() => {
          setCloseResult(null);
          cerrarAccion();
        }}
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

  const habilitadas = ACCIONES.filter((a) => !a.flag || hasFeature(a.flag));
  const abierta = [...habilitadas, CIERRE].find((a) => a.clave === claveAbierta) ?? null;

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6">
      {/* 1. El estado: cómo está la caja y quién está adentro. */}
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <ShiftSummaryPanel shift={shift} />
        <ShiftTeamCard shift={shift} />
      </div>

      {/* 2. Las acciones: botones grandes, 2 columnas en la tablet vertical
          y 4 en horizontal (`lg` son 64 rem: 1088 px con la raíz de 17 px
          del salón). */}
      <section aria-labelledby="acciones-turno" className="space-y-3">
        <h2 id="acciones-turno" className="text-lg font-semibold">
          Acciones del turno
        </h2>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {habilitadas.map((accion) => (
            <BotonAccion key={accion.clave} accion={accion} onClick={() => abrir(accion.clave)} />
          ))}
        </div>
      </section>

      {/* 3. El cierre, aparte: se separa con una línea y aire para que no se
          toque por error buscando otra acción. Azul como toda acción —el
          rojo es de estado (docs/DISENO.md)—, pero lleno: es la acción que
          termina el turno. */}
      <section aria-label="Cerrar el turno" className="border-t pt-6">
        <Button
          type="button"
          size="lg"
          className="h-auto min-h-16 w-full gap-3 px-6 text-lg font-semibold sm:w-auto"
          onClick={() => abrir("cierre")}
        >
          <LockKeyhole className="size-6" aria-hidden="true" />
          Cerrar turno
        </Button>
        <p className="mt-2 text-sm text-muted-foreground">
          {showBlindClose
            ? "Cierre a ciegas en 3 pasos: contás el cajón antes de ver lo esperado."
            : "Contás el cajón y cerrás en un paso."}
        </p>
      </section>

      <Sheet
        open={abierta !== null}
        onOpenChange={(open) => {
          if (!open) cerrarAccion();
        }}
      >
        {abierta ? (
          <SheetContent
            side="right"
            showCloseButton={false}
            className={
              abierta.clave === "cierre"
                ? "gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-none"
                : "gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-2xl"
            }
          >
            <div className="flex items-center gap-3 border-b p-3">
              <Button
                type="button"
                variant="outline"
                size="lg"
                className="gap-2 px-4 text-base"
                aria-label="Volver al resumen del turno"
                onClick={cerrarAccion}
              >
                <ArrowLeft className="size-5" aria-hidden="true" />
                {VOLVER.label}
              </Button>
              <div className="min-w-0">
                <SheetTitle className="text-xl font-semibold">
                  {abierta.label}
                </SheetTitle>
                <SheetDescription>{abierta.descripcion}</SheetDescription>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-4">
              <PanelDeAccion clave={abierta.clave} shift={shift} showBlindClose={showBlindClose} onClosed={setCloseResult} />
            </div>
          </SheetContent>
        ) : null}
      </Sheet>
    </div>
  );
}

/** Tarjeta táctil de la grilla: ícono, rótulo y una línea de qué hace. */
function BotonAccion({ accion, onClick }: { accion: Accion; onClick: () => void }): React.JSX.Element {
  const Icono = accion.icono;
  const idDescripcion = useId();
  // El nombre accesible es el rótulo solo (la línea de abajo va como
  // descripción): «Movimientos», no «Movimientos Ingreso o egreso…».
  return (
    <Button
      type="button"
      variant="outline"
      aria-label={accion.label}
      aria-describedby={idDescripcion}
      className="h-auto min-h-28 flex-col items-start justify-start gap-2 rounded-xl bg-card p-4 text-left whitespace-normal hover:bg-accent"
      onClick={onClick}
    >
      <span className="flex size-11 items-center justify-center rounded-lg bg-accent text-primary">
        <Icono className="size-6" aria-hidden="true" />
      </span>
      <span className="text-lg font-semibold">{accion.label}</span>
      <span id={idDescripcion} className="text-sm font-normal text-muted-foreground">
        {accion.descripcion}
      </span>
    </Button>
  );
}

/** El panel de siempre para cada acción: se reusan tal cual. */
function PanelDeAccion({
  clave,
  shift,
  showBlindClose,
  onClosed,
}: {
  clave: ClaveAccion;
  shift: ShiftCurrent;
  showBlindClose: boolean;
  onClosed: (resultado: ResultadoCierre) => void;
}): React.JSX.Element {
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
    case "cierre":
      return showBlindClose ? (
        <CloseWizard shiftId={shift.id} onClosed={onClosed} />
      ) : (
        <SingleStepCloseForm shiftId={shift.id} onClosed={onClosed} />
      );
  }
}
