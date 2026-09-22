import { LayoutGrid, LogOut, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { NavLink, Navigate, Outlet, useNavigate } from "react-router-dom";
import { Store } from "lucide-react";
import { toast } from "sonner";

import { deviceDeactivate, deviceRelease } from "@/api/auth";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { inventoryFeature } from "@/features/inventory";
import { kitchenFeature } from "@/features/kitchen";
import { ordersFeature } from "@/features/orders";
import { recipesFeature } from "@/features/recipes";
import { reservationsFeature } from "@/features/reservations";
import { shiftsFeature } from "@/features/shifts";
import { errorMessage } from "@/lib/errors";
import { cn } from "@/lib/utils";

import type { NavItem } from "./nav";
import { useDensity } from "./density";
import { useSession } from "./session";

/** [...ordersFeature.posNav, ...shiftsFeature.posNav, ...recipesFeature.posNav,
 * ...inventoryFeature.posNav, ...kitchenFeature.posNav] (CONTRATO-INTERNO-1b-1.md
 * §6.2; los del medio, pedido 2a: "Producir" y "Merma"; el último, pedido 2c
 * (CONTRATO C8): "KDS", detrás de `kitchen.kds` — la vista mínima de 1b
 * ("Cocina", `kitchen.view`) sigue viniendo de `ordersFeature.posNav`, sin
 * tocar). */
/** «Martes 22 de septiembre, 8:41 p. m.» — hora de Bogotá, como en `m2b`. */
const RELOJ_BARRA = new Intl.DateTimeFormat("es-CO", {
  timeZone: "America/Bogota",
  weekday: "long",
  day: "numeric",
  month: "long",
  hour: "numeric",
  minute: "2-digit",
});

function buildPosNav(hasFeature: (key: string) => boolean): NavItem[] {
  const all: NavItem[] = [
    ...ordersFeature.posNav,
    ...shiftsFeature.posNav,
    ...recipesFeature.posNav,
    ...inventoryFeature.posNav,
    ...kitchenFeature.posNav,
    // Reservas: detrás de `pos.reservations`, que a su vez requiere
    // `pos.tables` (no se aparta una mesa en una sede sin mesas).
    ...reservationsFeature.posNav,
  ];
  return all.filter((item) => !item.feature || hasFeature(item.feature));
}

function PosNavBar({ hasFeature }: { hasFeature: (key: string) => boolean }): React.JSX.Element | null {
  const items = buildPosNav(hasFeature);
  if (items.length === 0) return null;

  return (
    <nav aria-label="Secciones del salón" className="flex gap-2 overflow-x-auto border-b bg-background px-3 py-2">
      {items.map((item) => {
        const Icon = item.icon ?? LayoutGrid;
        return (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) =>
              cn(
                "flex h-11 shrink-0 items-center gap-2 rounded-md px-3 text-sm font-medium transition-colors",
                isActive
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
              )
            }
          >
            <Icon className="size-4" aria-hidden="true" />
            {item.label}
          </NavLink>
        );
      })}
    </nav>
  );
}

/**
 * La otra salida del salón, la del dispositivo. «Cambiar de persona» libera
 * a la persona y el dispositivo sigue activado; esto desactiva el
 * dispositivo entero y exige el PIN de sede para volver — es lo que hay que
 * hacer para mover la tablet a otra sede, o cuando se activó la sede
 * equivocada, y hasta hoy no existía en ninguna pantalla.
 *
 * Va detrás de una confirmación y no pegado a «Cambiar de persona»: en una
 * tablet compartida, tocarlo por error deja al salón sin poder vender hasta
 * que aparezca alguien con el PIN de sede. El backend no pide PIN para
 * desactivar (`POST /auth/device/deactivate` sólo exige la sesión del
 * dispositivo) y la interfaz **no inventa un gate que el servidor no hace
 * cumplir** (AGENTS.md): la confirmación explica la consecuencia, no
 * autoriza.
 */
function DeactivateDeviceButton({ storeName }: { storeName: string }): React.JSX.Element {
  const { clear } = useSession();
  const [open, setOpen] = useState(false);
  const [saliendo, setSaliendo] = useState(false);

  async function handleDeactivate() {
    setSaliendo(true);
    try {
      await deviceDeactivate();
      // El guard `RequireDevice` de `router.tsx` redirige a `/pos/activate`.
      clear();
    } catch (err) {
      toast.error(errorMessage(err));
      setSaliendo(false);
      setOpen(false);
    }
  }

  return (
    <>
      {/* Sólo el icono: el rótulo entero («Desactivar este dispositivo»)
          ocupaba un cuarto de la barra para una acción que se usa una vez
          cada mudanza de tablet, y era lo que empujaba la pastilla de quién
          opera a un segundo renglón. El nombre sigue estando para quien
          navega con teclado o lector (`aria-label`) y al pasar el cursor
          (`title`); la confirmación explica la consecuencia. */}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-10 shrink-0 text-muted-foreground"
        title="Desactivar este dispositivo"
        aria-label="Desactivar este dispositivo"
        onClick={() => setOpen(true)}
      >
        <LogOut className="size-4" aria-hidden="true" />
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Desactivar este dispositivo?</AlertDialogTitle>
            <AlertDialogDescription>
              {storeName} deja de estar activada acá y no se puede vender hasta activarlo de nuevo
              con el PIN de sede. Si sólo querés que atienda otra persona, usá «Cambiar de persona».
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            {/* `h-11`: es una tablet, y el botón de confirmar no puede ser
                más chico que el dedo que lo toca. */}
            <AlertDialogCancel className="h-11" disabled={saliendo}>
              Cancelar
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              className="h-11"
              disabled={saliendo}
              onClick={() => void handleDeactivate()}
            >
              Desactivar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

const POLL_MS = 5_000;

const ROLE_LABEL: Record<string, string> = {
  operator: "Operador",
  supervisor: "Supervisor",
  admin: "Administrador",
};

/**
 * Barra superior del salón: persona activa, "Cambiar de persona",
 * "Desactivar este dispositivo" y el aviso
 * de expiración por inactividad; sondea `GET /auth/me` cada 5 s
 * (SPEC-NEGOCIO § 9.1). El día operativo y el estado del turno los pinta
 * `<shiftsFeature.ShiftStatusStrip/>` — ese dato vive en `GET
 * /shifts/current`, fuera del contrato que este agente puede consumir.
 */
export default function PosLayout(): React.JSX.Element | null {
  // Tablet del salón: cuerpo 17 px y objetivo táctil de 52 px (m2b `.salon`).
  useDensity("salon");
  const { me, refresh, hasFeature } = useSession();
  const navigate = useNavigate();
  const [releasing, setReleasing] = useState(false);

  useEffect(() => {
    const id = window.setInterval(() => {
      void refresh();
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, [refresh]);

  if (!me || me.kind !== "device") {
    // El router ya exige `kind === "device"` para llegar acá; esto es sólo
    // una guarda defensiva mientras se resuelve la primera carga de sesión.
    return null;
  }

  if (!me.employee) {
    return <Navigate to="/pos/identify" replace />;
  }

  const expired = me.employee_expires_at
    ? new Date(me.employee_expires_at).getTime() <= Date.now()
    : false;

  async function handleChangePerson() {
    setReleasing(true);
    try {
      await deviceRelease();
      await refresh();
      navigate("/pos/identify");
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setReleasing(false);
    }
  }

  // El reloj de la barra, en hora de Bogotá: «Martes 22 de septiembre, 8:41
  // p. m.». Es la misma hora que sella las ventas, y verla en la barra es
  // parte de lo que hace que el turno cuadre.
  const reloj = RELOJ_BARRA.format(new Date());

  return (
    /* **El POS ocupa la pantalla, no la estira.** Es una tablet montada en el
       salón: la cabecera, la cinta del turno y la barra de secciones no se van
       para arriba al desplazarse, y cada pantalla maneja su propio scroll
       adentro de `main`. Con `min-h-screen` la página crecía con el contenido
       y el botón de mandar a cocina terminaba debajo del pliegue apenas una
       mesa pedía seis platos. */
    <div className="salon flex h-dvh flex-col overflow-hidden bg-background text-foreground">
      {/* **La barra de la tablet** (`m2b`): UNA banda, no tres. A la izquierda
          la sede y el reloj; a la derecha, en pastilla, quién está operando —
          que es la pregunta de atribución que gobierna todo el sistema.

          Antes eran tres bandas apiladas (cabecera con botones, cinta de
          turno, barra de secciones) y se comían 188 px de una pantalla de
          tablet: por eso la cuenta mostraba dos renglones donde la maqueta
          muestra cinco. El turno y las acciones de dispositivo no
          desaparecen — viven adentro de la pastilla, que es de donde se
          cambia de persona. */}
      <header className="flex items-center gap-3.5 overflow-x-auto border-b bg-card px-4 py-2.5">
        <div className="flex min-w-0 shrink-0 items-center gap-2.5">
          <Store className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <p className="min-w-0 truncate">
            <b className="text-[0.94rem]">{me.store?.name ?? "Sede"}</b>{" "}
            <span className="text-[0.82rem] text-muted-foreground">· Tablet del salón</span>
          </p>
        </div>

        <span className="shrink-0 text-[0.84rem] whitespace-nowrap text-muted-foreground">{reloj}</span>

        {/* `compacta`: la cinta comparte renglón, así que no repite la fecha
            que el reloj de al lado ya escribió. */}
        <div className="shrink-0">
          <shiftsFeature.ShiftStatusStrip compacta />
        </div>

        {expired ? (
          <span
            role="alert"
            className="rounded-md bg-destructive/10 px-2 py-1 text-xs font-medium text-destructive"
          >
            Tu sesión venció por inactividad. Identificate de nuevo.
          </span>
        ) : null}

        {/* La pastilla de quién opera. Es también el control para cambiar de
            persona: en la maqueta el nombre ES el botón, porque cambiar de
            persona y saber quién está operando son la misma pregunta. */}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <Button
            type="button"
            variant="outline"
            className="h-10 gap-2 rounded-full px-3.5"
            onClick={handleChangePerson}
            disabled={releasing}
            aria-label={`${me.employee.name}, ${ROLE_LABEL[me.employee.role] ?? me.employee.role}. Tocar para cambiar de persona`}
          >
            <Users className="size-4 shrink-0" aria-hidden="true" />
            <span className="text-left leading-tight">
              <b className="block text-[0.86rem]">{me.employee.name}</b>
              <span className="block text-[0.72rem] font-normal text-muted-foreground">
                {ROLE_LABEL[me.employee.role] ?? me.employee.role} · cambiar
              </span>
            </span>
          </Button>
          <DeactivateDeviceButton storeName={me.store?.name ?? "Esta sede"} />
        </div>
      </header>
      <PosNavBar hasFeature={hasFeature} />
      <main className="min-h-0 flex-1 overflow-y-auto p-3">
        <Outlet />
      </main>
    </div>
  );
}
