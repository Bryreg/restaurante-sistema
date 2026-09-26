import { useQuery } from "@tanstack/react-query";
import { LockKeyhole } from "lucide-react";
import { useEffect, useId, useState } from "react";

import { getDeviceAreaCount } from "@/api/areaCounts";
import { puedeManejarCaja } from "@/app/puesto";
import { useSession } from "@/app/session";
import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui/button";
import { AREA_COUNT_QUERY_KEY } from "@/features/inventory/areaCountLib";
import { errorMessage } from "@/lib/errors";

import { type Accion, accionesHabilitadas } from "./acciones";
import { OpeningScreen } from "./OpeningScreen";
import { ShiftActionSheet } from "./ShiftActionSheet";
import { ShiftSummaryPanel } from "./ShiftSummaryPanel";
import { ShiftTeamCard } from "./ShiftTeamCard";
import { PasoPastilla, TarjetaTurnoCerrado, type ResultadoCierre } from "./closeUi";
import { useAccionEnUrl, useCurrentShift } from "./hooks";

/*
 * Las acciones (rótulos, flags, quién ve cuál) viven en `acciones.ts` y la
 * hoja que abre cada una en `ShiftActionSheet.tsx`: las comparte la cinta de
 * caja de Mesas (`CashRibbon`), que abre las mismas hojas sin salir de Mesas.
 */

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
 * mismos, en `ACCIONES` y `CIERRE` (`acciones.ts`) y en `VOLVER`.
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
  const { me, hasFeature } = useSession();
  const { data: shift, isLoading, isError, error, refetch } = useCurrentShift();
  const persona = me?.kind === "device" ? me.employee : null;
  const conCaja = puedeManejarCaja(persona, shift?.cash_responsible?.id);
  // «Conteo de mi área» sólo si la persona es de un área. Comparte la caché
  // con `AreaCountPanel`; mientras no se sabe (cargando o error) se muestra:
  // sólo se esconde cuando el servidor dice que no tiene área.
  const conteoEncendido = hasFeature("inventory.shift_counts");
  const area = useQuery({ queryKey: AREA_COUNT_QUERY_KEY, queryFn: getDeviceAreaCount, enabled: conteoEncendido });
  const sinArea = area.data !== undefined && area.data.area_id === null;
  const showBlindClose = hasFeature("cash.blind_close");
  const { claveAbierta, abrir, cerrar: cerrarAccion } = useAccionEnUrl();

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

  // Sin turno no hay acción que abrir: si la URL trae una (un enlace viejo,
  // o el `?accion=cierre` del cierre que se acaba de hacer), se descarta
  // para que no salte sola apenas alguien abra el turno siguiente.
  const sinTurno = !isLoading && !isError && !shift && !closeResult;
  useEffect(() => {
    if (sinTurno && claveAbierta !== null) cerrarAccion();
  }, [sinTurno, claveAbierta, cerrarAccion]);

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
        etiquetaContinuar={shift || !conCaja ? "Listo" : "Abrir turno"}
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
    if (!conCaja) {
      return (
        <EmptyState
          title="Todavía no hay turno abierto"
          description="Lo abre quien va a tener la caja. Cuando esté abierto, acá marcás tu entrada y tu salida."
        />
      );
    }
    // El cuadre de apertura (sobres por consignar o base fija, según la sede).
    return <OpeningScreen />;
  }

  const habilitadas = accionesHabilitadas({ hasFeature, conCaja, sinArea });
  // La grilla lleva todas menos el cierre, que va aparte, al pie.
  const grilla = habilitadas.filter((a) => a.clave !== "cierre");
  const abierta = habilitadas.find((a) => a.clave === claveAbierta) ?? null;

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6">
      {/* 1. El estado: cómo está la caja y quién está adentro. */}
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <ShiftSummaryPanel shift={shift} conCaja={conCaja} />
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
          {grilla.map((accion) => (
            <BotonAccion key={accion.clave} accion={accion} onClick={() => abrir(accion.clave)} />
          ))}
        </div>
      </section>

      {/* 3. El cierre, aparte: se separa con una línea y aire para que no se
          toque por error buscando otra acción. Azul como toda acción —el
          rojo es de estado (docs/DISENO.md)—, pero lleno: es la acción que
          termina el turno. */}
      {conCaja ? (
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
      ) : null}

      <ShiftActionSheet
        accion={abierta}
        shift={shift}
        showBlindClose={showBlindClose}
        volver={{ label: VOLVER.label, ariaLabel: "Volver al resumen del turno" }}
        onClose={cerrarAccion}
        onClosed={setCloseResult}
      />
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
