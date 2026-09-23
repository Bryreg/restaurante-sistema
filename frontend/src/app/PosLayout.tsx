import { LayoutGrid, LogOut, Moon, Sun, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { NavLink, Navigate, Outlet, useLocation, useNavigate } from "react-router-dom";
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
import { shiftsFeature } from "@/features/shifts";
import { errorMessage } from "@/lib/errors";
import { cn } from "@/lib/utils";

import type { NavItem } from "./nav";
import { useDensity } from "./density";
import { useSalonTheme } from "./salonTheme";
import { useSession } from "./session";

/** [...ordersFeature.posNav, ...shiftsFeature.posNav, ...recipesFeature.posNav,
 * ...inventoryFeature.posNav, ...kitchenFeature.posNav] (CONTRATO-INTERNO-1b-1.md
 * §6.2; los del medio, pedido 2a: "Producir" y "Merma"; el último, pedido 2c
 * (CONTRATO C8): "KDS", detrás de `kitchen.kds` — la vista mínima de 1b
 * ("Cocina", `kitchen.view`) sigue viniendo de `ordersFeature.posNav`, sin
 * tocar). */
function buildPosNav(hasFeature: (key: string) => boolean): NavItem[] {
  const all: NavItem[] = [
    ...ordersFeature.posNav,
    ...shiftsFeature.posNav,
    ...recipesFeature.posNav,
    ...inventoryFeature.posNav,
    ...kitchenFeature.posNav,
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
      <Button
        type="button"
        variant="ghost"
        className="ml-2 h-11 gap-2 text-muted-foreground"
        onClick={() => setOpen(true)}
      >
        <LogOut className="size-4" aria-hidden="true" />
        Desactivar este dispositivo
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
  const [pantalla, setPantalla] = useSalonTheme();
  // En la cocina la pizarra es fija (`useCocinaPantalla`): ahí el botón no
  // cambiaría nada visible, así que no se ofrece.
  const enCocina = /^\/pos\/(kds|cocina)\b/.test(useLocation().pathname);
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

  return (
    <div className="salon flex min-h-screen flex-col bg-background text-foreground">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b p-3">
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">{me.store?.name ?? "Sede"}</p>
            <p className="truncate text-xs text-muted-foreground">
              {me.employee.name} · {ROLE_LABEL[me.employee.role] ?? me.employee.role}
            </p>
          </div>
          {expired ? (
            <span
              role="alert"
              className="rounded-md bg-destructive/10 px-2 py-1 text-xs font-medium text-destructive"
            >
              Tu sesión de persona venció por inactividad. Identificate de nuevo.
            </span>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* Por tablet: la de la terraza queda clara, la del bar oscura. */}
          {enCocina ? null : (
            <Button
              type="button"
              variant="ghost"
              className="h-11 gap-2"
              aria-pressed={pantalla === "oscuro"}
              onClick={() => setPantalla(pantalla === "oscuro" ? "claro" : "oscuro")}
            >
              {pantalla === "oscuro" ? (
                <Sun className="size-4" aria-hidden="true" />
              ) : (
                <Moon className="size-4" aria-hidden="true" />
              )}
              {pantalla === "oscuro" ? "Pantalla clara" : "Pantalla oscura"}
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            className="h-11 gap-2"
            onClick={handleChangePerson}
            disabled={releasing}
          >
            <Users className="size-4" aria-hidden="true" />
            Cambiar de persona
          </Button>
          <DeactivateDeviceButton storeName={me.store?.name ?? "Esta sede"} />
        </div>
      </header>
      <div className="border-b bg-muted/30 px-3 py-2">
        <shiftsFeature.ShiftStatusStrip />
      </div>
      <PosNavBar hasFeature={hasFeature} />
      <main className="flex-1 p-3">
        <Outlet />
      </main>
    </div>
  );
}
