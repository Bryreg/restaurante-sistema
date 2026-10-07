import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, BellRing, CircleCheck, MoreHorizontal } from "lucide-react";
import { Fragment, useEffect, useId, useState } from "react";

import { getDeviceAreaCount } from "@/api/areaCounts";
import { listMyRequests } from "@/api/requests";
import { puedeManejarCaja } from "@/app/puesto";
import { useSession } from "@/app/session";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { AREA_COUNT_QUERY_KEY } from "@/features/inventory/areaCountLib";
import { REQUESTS_QUERY_KEYS } from "@/features/requests/lib";
import { cn } from "@/lib/utils";

import { type Accion, type ClaveAccion, accionesHabilitadas } from "./acciones";
import {
  detalleCinta,
  domiciliariosPorLiquidar,
  haySencillaPorRecibir,
  type Momento,
  momentoDelTurno,
  repartirCinta,
  solicitudesPorAtender,
} from "./cinta";
import { PasoPastilla, TarjetaTurnoCerrado, type ResultadoCierre } from "./closeUi";
import { useAccionEnUrl, useCurrentShift, usePendingDeliveryCash } from "./hooks";
import { ShiftActionSheet } from "./ShiftActionSheet";

const SOLICITUDES_POLL_MS = 15_000;

/**
 * Botón de la cinta (handoff `PosMesas`): 56 px exactos, radio de 14 px,
 * borde `input`, 16 px / 600, ícono de 20 px + rótulo en una línea.
 */
const BOTON_CINTA =
  "relative h-[56px] shrink-0 gap-2 rounded-[14px] border-input px-4 text-[16px] font-semibold whitespace-nowrap focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-5";

/**
 * **La cinta de caja** de Mesas (pedido del dueño, 2026-09-26, a imagen del
 * dock del barista en café-sistema): las acciones del turno a un toque desde
 * el mapa de mesas, sin ir a `/pos/turno`. Cada una abre **la misma hoja**
 * que el panel del turno (`ShiftActionSheet`) encima de Mesas; al volver,
 * Mesas sigue ahí.
 *
 * Una sola fila: «Domicilios», «Cambio», «Gasto / Ingreso», el botón «del
 * momento» (`momentoDelTurno`: el aviso que el turno tiene ahora, o «Sin
 * avisos» quieto para que los botones no salten de lugar) y «Más» con el
 * resto. En la tablet vertical (820 px) cabe; si no cabe, la fila se
 * desliza de lado — nunca se parte en dos.
 *
 * **Sólo para quien puede manejar la caja** (`puedeManejarCaja`) y con turno
 * abierto; sin eso no dibuja nada (el aviso «Abrir turno →» ya lo da la
 * barra de estado). La cinta **no muestra plata**: ni esperado ni saldo —
 * el cierre es a ciegas —; los contadores son de cosas (domiciliarios,
 * solicitudes), y el «Retiro sugerido» dice que hay de más, no cuánto.
 *
 * La acción abierta vive en `?accion=` igual que en el turno: se puede
 * enlazar `/pos/mesas?accion=retiros`.
 */
export function CashRibbon({
  variante = "fila",
}: {
  /**
   * `fila` (por defecto): la cinta de siempre, una fila a lo ancho.
   * `columna`: la columna «Caja» de 260 px a la derecha de Mesas (handoff
   * «Burbujas», 9b/9e): cada acción en un pozo de 64 px con su detalle y el
   * pie «Efectivo en caja». Mismos datos, mismas reglas: sólo cambia la forma.
   */
  variante?: "fila" | "columna";
} = {}): React.JSX.Element | null {
  const { me, hasFeature } = useSession();
  const { data: shift } = useCurrentShift();
  const persona = me?.kind === "device" ? me.employee : null;
  const conCaja = puedeManejarCaja(persona, shift?.cash_responsible?.id);
  const visible = Boolean(shift) && conCaja;
  const { claveAbierta, abrir, cerrar } = useAccionEnUrl();

  // Lo mismo que mira el panel del turno para esconder «Conteo de mi área».
  const conteoEncendido = visible && hasFeature("inventory.shift_counts");
  const area = useQuery({ queryKey: AREA_COUNT_QUERY_KEY, queryFn: getDeviceAreaCount, enabled: conteoEncendido });
  const sinArea = area.data !== undefined && area.data.area_id === null;

  // Contadores de cosas, de endpoints que ya existen y comparten caché con
  // sus paneles: domiciliarios por liquidar y sencillas aprobadas.
  const domicilios = usePendingDeliveryCash(visible && hasFeature("pos.delivery"));
  const solicitudes = useQuery({
    queryKey: REQUESTS_QUERY_KEYS.mine,
    queryFn: listMyRequests,
    enabled: visible && hasFeature("pos.requests"),
    refetchInterval: SOLICITUDES_POLL_MS,
  });

  // El resultado del cierre hecho desde la cinta: igual que en el turno,
  // vive acá y no en el formulario, porque cerrar deja `shift` en `null` y
  // la cinta desaparecería antes de que alguien leyera cuánto consignar.
  const [closeResult, setCloseResult] = useState<ResultadoCierre | null>(null);

  // Sin turno (o sin caja) no hay acción que abrir: una `?accion=` vieja se
  // descarta para que no salte sola apenas se abra el turno siguiente.
  const sinCinta = shift === null && !closeResult;
  useEffect(() => {
    if (sinCinta && claveAbierta !== null) cerrar();
  }, [sinCinta, claveAbierta, cerrar]);

  if (closeResult) {
    return (
      <Sheet open onOpenChange={(open) => !open && setCloseResult(null)}>
        <SheetContent
          side="right"
          showCloseButton={false}
          className="gap-0 overflow-y-auto p-4 data-[side=right]:w-full data-[side=right]:sm:max-w-none"
        >
          <SheetTitle className="sr-only">Turno cerrado</SheetTitle>
          <TarjetaTurnoCerrado
            resultado={closeResult}
            pastilla={
              <PasoPastilla tono="listo">Paso 3 de 3 · hecho</PasoPastilla>
            }
            etiquetaContinuar="Volver a Mesas"
            onContinuar={() => {
              setCloseResult(null);
              cerrar();
            }}
          />
        </SheetContent>
      </Sheet>
    );
  }

  if (!shift || !visible) return null;

  const habilitadas = accionesHabilitadas({ hasFeature, conCaja, sinArea });
  const { principales, mas } = repartirCinta(habilitadas);
  const momento = momentoDelTurno({
    shift,
    habilitadas,
    sencillaPorRecibir: haySencillaPorRecibir(solicitudes.data),
  });
  const badges: Partial<Record<ClaveAccion, number>> = {
    domicilios: domiciliariosPorLiquidar(domicilios.data),
    solicitudes: solicitudesPorAtender(solicitudes.data),
  };
  const badgeMas = mas.reduce((n, a) => n + (badges[a.clave] ?? 0), 0);
  // La hoja lleva el rótulo con que se tocó («Gasto / Ingreso», no «Movimientos»).
  const abierta = [...principales, ...mas].find((a) => a.clave === claveAbierta) ?? null;

  const hoja = (
    <ShiftActionSheet
      accion={abierta}
      shift={shift}
      volver={{ label: "Mesas", ariaLabel: "Volver a Mesas" }}
      onClose={cerrar}
      onClosed={setCloseResult}
    />
  );

  if (variante === "columna") {
    return (
      <>
        <ColumnaCaja
          principales={principales}
          mas={mas}
          momento={momento}
          badges={badges}
          badgeMas={badgeMas}
          sobreUmbral={shift.cash_over_threshold}
          onAbrir={abrir}
        />
        {hoja}
      </>
    );
  }

  return (
    <>
      <nav aria-label="Acciones de caja" className="overflow-x-auto overscroll-x-contain border-b">
        <div className="flex w-max min-w-full items-center gap-2 px-3 py-2.5">
          {principales.map((accion) => (
            <BotonCinta
              key={accion.clave}
              accion={accion}
              badge={badges[accion.clave] ?? 0}
              onClick={() => abrir(accion.clave)}
            />
          ))}
          <BotonMomento momento={momento} onClick={abrir} />
          {mas.length > 0 ? (
            <DropdownMenu>
              <DropdownMenuTrigger
                aria-label={badgeMas > 0 ? `Más acciones de caja, ${badgeMas} por atender` : "Más acciones de caja"}
                className={cn(
                  BOTON_CINTA,
                  "inline-flex items-center border border-input bg-background hover:bg-accent focus-visible:outline-none",
                )}
              >
                <MoreHorizontal className="size-5" aria-hidden="true" />
                Más
                <Contador valor={badgeMas} />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-auto min-w-60">
                {mas.map((accion) => {
                  const Icono = accion.icono;
                  const n = badges[accion.clave] ?? 0;
                  return (
                    <Fragment key={accion.clave}>
                      {accion.clave === "cierre" ? <DropdownMenuSeparator /> : null}
                      <DropdownMenuItem className="min-h-14 gap-3 text-base" onClick={() => abrir(accion.clave)}>
                        <Icono className="size-5" aria-hidden="true" />
                        <span className="flex-1">{accion.label}</span>
                        {n > 0 ? <Contador valor={n} enLinea /> : null}
                      </DropdownMenuItem>
                    </Fragment>
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
      </nav>

      {hoja}
    </>
  );
}

/** Un contador de cosas (nunca de plata). Rojo de estado: hay algo por atender. */
function Contador({ valor, enLinea = false }: { valor: number; enLinea?: boolean }): React.JSX.Element | null {
  if (valor <= 0) return null;
  return (
    <span
      aria-hidden="true"
      className={cn(
        "grid h-6 min-w-6 place-items-center rounded-full bg-destructive px-1.5 text-[13px] font-bold text-destructive-foreground",
        !enLinea && "absolute -top-[7px] -right-[7px]",
      )}
    >
      {valor > 9 ? "9+" : valor}
    </span>
  );
}

function BotonCinta({
  accion,
  badge,
  onClick,
}: {
  accion: Accion;
  badge: number;
  onClick: () => void;
}): React.JSX.Element {
  const Icono = accion.icono;
  return (
    <Button
      type="button"
      variant="outline"
      aria-label={badge > 0 ? `${accion.label}, ${badge} por atender` : accion.label}
      className={BOTON_CINTA}
      onClick={onClick}
    >
      <Icono className="size-5" aria-hidden="true" />
      {accion.label}
      <Contador valor={badge} />
    </Button>
  );
}

/**
 * El botón «del momento». Sin aviso queda un rótulo quieto, «Sin avisos»,
 * del mismo tamaño: la fila no cambia de forma cuando llega uno, y el dedo
 * encuentra «Más» siempre en el mismo lugar.
 */
function BotonMomento({
  momento,
  onClick,
}: {
  momento: Momento | null;
  onClick: (clave: ClaveAccion) => void;
}): React.JSX.Element {
  const idDescripcion = useId();
  if (!momento) {
    return (
      <span
        className={cn(
          BOTON_CINTA,
          "inline-flex items-center border border-dashed border-border text-muted-foreground",
        )}
        data-testid="momento-vacio"
      >
        <CircleCheck className="size-5" aria-hidden="true" />
        Sin avisos
      </span>
    );
  }
  const Icono = momento.tono === "alerta" ? AlertTriangle : BellRing;
  return (
    <>
      <Button
        type="button"
        variant="outline"
        aria-label={momento.label}
        aria-describedby={idDescripcion}
        className={cn(
          BOTON_CINTA,
          momento.tono === "alerta"
            ? "border-2 border-destructive bg-destructive/10 text-foreground hover:bg-destructive/20"
            : "border-2 border-warning bg-warning/20 text-foreground hover:bg-warning/30",
        )}
        onClick={() => onClick(momento.clave)}
      >
        <Icono className="size-5" aria-hidden="true" />
        {momento.label}
      </Button>
      <span id={idDescripcion} className="sr-only">
        {momento.descripcion}
      </span>
    </>
  );
}

/** El pozo de 64 px de cada acción de la columna «Caja» (handoff «Burbujas», 9b). */
const POZO_CAJA =
  "flex min-h-[64px] w-full items-center gap-3 rounded-[18px] px-3.5 text-left text-foreground transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none";

/** El cuadro de 38 px, en `card`, donde va el ícono de 18 px. */
const CUADRO_ICONO = "grid size-[38px] shrink-0 place-items-center rounded-xl bg-card [&_svg]:size-[18px]";

/** Contador de cosas de la columna: pastilla roja de 24 px, texto blanco 12/600. */
function ContadorColumna({ valor }: { valor: number }): React.JSX.Element | null {
  if (valor <= 0) return null;
  return (
    <span
      aria-hidden="true"
      className="grid h-6 min-w-6 shrink-0 place-items-center rounded-full bg-destructive px-[7px] text-[12px] font-semibold text-white"
    >
      {valor > 9 ? "9+" : valor}
    </span>
  );
}

function TextoPozo({ titulo, detalle, claseDetalle }: { titulo: string; detalle?: string | null; claseDetalle?: string }) {
  return (
    <span className="flex min-w-0 flex-1 flex-col">
      <b className="text-[15px] leading-tight font-semibold">{titulo}</b>
      {detalle ? <span className={cn("text-[12px] leading-snug", claseDetalle ?? "text-muted-foreground")}>{detalle}</span> : null}
    </span>
  );
}

/**
 * **La columna «Caja»** de Mesas (handoff «Burbujas», 9b/9e): reemplaza la
 * cinta de arriba con las mismas acciones (`repartirCinta`), el mismo aviso
 * «del momento» (`momentoDelTurno`) y los mismos contadores de cosas. El
 * aviso va primero, en `warning-soft` (o `destructive-soft` si es una
 * alerta); al pie, el efectivo en caja contra el umbral **sin montos**: la
 * caja es a ciegas, así que sólo se dice de qué lado de la raya está (el
 * dato `cash_over_threshold` del servidor), nunca cuánto.
 */
function ColumnaCaja({
  principales,
  mas,
  momento,
  badges,
  badgeMas,
  sobreUmbral,
  onAbrir,
}: {
  principales: Accion[];
  mas: Accion[];
  momento: Momento | null;
  badges: Partial<Record<ClaveAccion, number>>;
  badgeMas: number;
  sobreUmbral: boolean | undefined;
  onAbrir: (clave: ClaveAccion) => void;
}): React.JSX.Element {
  const idDescripcion = useId();
  const alerta = momento?.tono === "alerta";
  const IconoMomento = alerta ? AlertTriangle : BellRing;
  return (
    <aside
      aria-label="Caja"
      className="flex w-[260px] shrink-0 flex-col gap-2 overflow-y-auto rounded-[24px] bg-card px-3.5 pt-[18px] pb-3.5"
    >
      <b className="px-1.5 pb-1 text-[16px] font-semibold">Caja</b>
      <nav aria-label="Acciones de caja" className="flex flex-col gap-2">
        {momento ? (
          <>
            <button
              type="button"
              aria-label={momento.label}
              aria-describedby={idDescripcion}
              className={cn(
                POZO_CAJA,
                alerta ? "bg-destructive-soft hover:bg-destructive-soft/80" : "bg-warning-soft hover:bg-warning-soft/80",
              )}
              onClick={() => onAbrir(momento.clave)}
            >
              <span className={cn(CUADRO_ICONO, alerta ? "text-destructive" : "text-warning")}>
                <IconoMomento aria-hidden="true" />
              </span>
              <TextoPozo
                titulo={momento.label}
                detalle={momento.descripcion}
                claseDetalle={alerta ? "text-destructive" : "text-warning"}
              />
            </button>
            <span id={idDescripcion} className="sr-only">
              {momento.descripcion}
            </span>
          </>
        ) : (
          // Sin aviso queda el lugar quieto: las acciones no saltan cuando llega uno.
          <span className={cn(POZO_CAJA, "bg-muted text-muted-foreground")} data-testid="momento-vacio">
            <span className={CUADRO_ICONO}>
              <CircleCheck aria-hidden="true" />
            </span>
            <TextoPozo titulo="Sin avisos" />
          </span>
        )}
        {principales.map((accion) => {
          const Icono = accion.icono;
          const n = badges[accion.clave] ?? 0;
          return (
            <button
              key={accion.clave}
              type="button"
              aria-label={n > 0 ? `${accion.label}, ${n} por atender` : accion.label}
              className={cn(POZO_CAJA, "bg-muted hover:bg-fill-strong")}
              onClick={() => onAbrir(accion.clave)}
            >
              <span className={CUADRO_ICONO}>
                <Icono aria-hidden="true" />
              </span>
              <TextoPozo titulo={accion.label} detalle={detalleCinta(accion.clave, n)} />
              <ContadorColumna valor={n} />
            </button>
          );
        })}
        {mas.length > 0 ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label={badgeMas > 0 ? `Más acciones de caja, ${badgeMas} por atender` : "Más acciones de caja"}
              className={cn(POZO_CAJA, "bg-muted hover:bg-fill-strong")}
            >
              <span className={CUADRO_ICONO}>
                <MoreHorizontal aria-hidden="true" />
              </span>
              <TextoPozo titulo="Más" />
              <ContadorColumna valor={badgeMas} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-auto min-w-60">
              {mas.map((accion) => {
                const Icono = accion.icono;
                const n = badges[accion.clave] ?? 0;
                return (
                  <Fragment key={accion.clave}>
                    {accion.clave === "cierre" ? <DropdownMenuSeparator /> : null}
                    <DropdownMenuItem className="min-h-14 gap-3 text-base" onClick={() => onAbrir(accion.clave)}>
                      <Icono className="size-5" aria-hidden="true" />
                      <span className="flex-1">{accion.label}</span>
                      {n > 0 ? <Contador valor={n} enLinea /> : null}
                    </DropdownMenuItem>
                  </Fragment>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </nav>
      <div className="mt-auto flex flex-col gap-1.5 rounded-[18px] bg-muted p-3.5" data-testid="caja-efectivo">
        <span className="flex items-baseline justify-between gap-2 text-[12px]">
          <span className="text-muted-foreground">Efectivo en caja</span>
          {sobreUmbral === true ? (
            <b className="font-semibold text-warning">Pasó el umbral</b>
          ) : sobreUmbral === false ? (
            <b className="font-semibold">Bajo el umbral</b>
          ) : (
            <b className="font-semibold text-muted-foreground">sin dato</b>
          )}
        </span>
        <span className="text-[12px] text-muted-foreground">Sin montos: el cierre es a ciegas</span>
      </div>
    </aside>
  );
}
