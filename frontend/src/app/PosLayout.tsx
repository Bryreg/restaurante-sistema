import { LayoutGrid, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { NavLink, Navigate, Outlet, useNavigate } from "react-router-dom";
import { toast } from "sonner";

import { deviceRelease } from "@/api/auth";
import { Button } from "@/components/ui/button";
import { inventoryFeature } from "@/features/inventory";
import { ordersFeature } from "@/features/orders";
import { recipesFeature } from "@/features/recipes";
import { shiftsFeature } from "@/features/shifts";
import { errorMessage } from "@/lib/errors";
import { cn } from "@/lib/utils";

import type { NavItem } from "./nav";
import { useSession } from "./session";

/** [...ordersFeature.posNav, ...shiftsFeature.posNav, ...recipesFeature.posNav,
 * ...inventoryFeature.posNav] (CONTRATO-INTERNO-1b-1.md §6.2; los últimos
 * dos, pedido 2a: "Producir" y "Merma"). */
function buildPosNav(hasFeature: (key: string) => boolean): NavItem[] {
  const all: NavItem[] = [
    ...ordersFeature.posNav,
    ...shiftsFeature.posNav,
    ...recipesFeature.posNav,
    ...inventoryFeature.posNav,
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

const POLL_MS = 5_000;

const ROLE_LABEL: Record<string, string> = {
  operator: "Operador",
  supervisor: "Supervisor",
  admin: "Administrador",
};

/**
 * Barra superior del salón: persona activa, "Cambiar de persona" y el aviso
 * de expiración por inactividad; sondea `GET /auth/me` cada 5 s
 * (SPEC-NEGOCIO § 9.1). El día operativo y el estado del turno los pinta
 * `<shiftsFeature.ShiftStatusStrip/>` — ese dato vive en `GET
 * /shifts/current`, fuera del contrato que este agente puede consumir.
 */
export default function PosLayout(): React.JSX.Element | null {
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
    <div className="flex min-h-screen flex-col bg-background text-foreground">
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
