import { Users } from "lucide-react";
import { useEffect, useState } from "react";
import { Navigate, Outlet, useNavigate } from "react-router-dom";
import { toast } from "sonner";

import { deviceRelease } from "@/api/auth";
import { Button } from "@/components/ui/button";
import { shiftsFeature } from "@/features/shifts";
import { errorMessage } from "@/lib/errors";

import { useSession } from "./session";

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
  const { me, refresh } = useSession();
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
      <main className="flex-1 p-3">
        <Outlet />
      </main>
    </div>
  );
}
