import { LayoutGrid, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { toast } from "sonner";

import { logout } from "@/api/auth";
import { errorMessage } from "@/lib/errors";

import { useDensity } from "./density";
import { useSession } from "./session";

const PUERTA_CLASS =
  "flex min-h-40 flex-1 flex-col items-center justify-center gap-3 rounded-xl border-2 bg-card p-6 text-center transition-colors hover:border-primary hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-50";

/**
 * **La puerta** (`/`): dos opciones grandes, «Operar (POS)» y «Administrar».
 *
 * Antes `/` y toda ruta desconocida mandaban a `/login`, y desde el POS no
 * había ningún camino al admin ni desde el admin al POS: quien estaba en la
 * tablet y quería administrar tecleaba `/login` a mano, y quien estaba en PC
 * y quería montar una tablet no sabía por dónde.
 *
 * - **Operar (POS)**: al salón si esta tablet ya está activada, a activarla
 *   si no. Si en esta tablet hay abierta una sesión corta de administrador
 *   (`me.on_device`), primero la cierra: el POS vuelve a «Quién opera».
 * - **Administrar**: al admin si ya hay sesión, al formulario si no.
 */
export default function HomePage(): React.JSX.Element {
  useDensity("oficina");
  const { me, loading, refresh } = useSession();
  const navigate = useNavigate();
  const [volviendo, setVolviendo] = useState(false);

  const adminEnTablet = me?.kind === "admin" && Boolean(me.on_device);
  const destinoPos = me?.kind === "device" ? "/pos" : "/pos/activate";
  const destinoAdmin = me?.kind === "admin" ? "/admin" : "/login";

  async function volverAlPos() {
    setVolviendo(true);
    try {
      await logout();
      await refresh();
      navigate("/pos/identify", { replace: true });
    } catch (err) {
      toast.error(errorMessage(err));
      setVolviendo(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4 text-foreground">
      <div className="w-full max-w-2xl space-y-6">
        <div className="space-y-1 text-center">
          <p className="text-xs tracking-wider text-muted-foreground uppercase">
            {me?.store?.name ?? me?.organization?.name ?? "Restaurante Sistema"}
          </p>
          <h1 className="text-2xl font-semibold">¿Qué vas a hacer?</h1>
        </div>
        {loading ? (
          <p className="text-center text-sm text-muted-foreground">Cargando…</p>
        ) : (
          <div className="flex flex-col gap-4 sm:flex-row">
            {adminEnTablet ? (
              <button
                type="button"
                className={PUERTA_CLASS}
                onClick={() => void volverAlPos()}
                disabled={volviendo}
              >
                <LayoutGrid className="size-10 text-primary" aria-hidden="true" />
                <span className="text-xl font-semibold">Operar (POS)</span>
                <span className="text-sm text-muted-foreground">
                  Cierra el administrador en esta tablet y vuelve a «Quién opera».
                </span>
              </button>
            ) : (
              <Link to={destinoPos} className={PUERTA_CLASS}>
                <LayoutGrid className="size-10 text-primary" aria-hidden="true" />
                <span className="text-xl font-semibold">Operar (POS)</span>
                <span className="text-sm text-muted-foreground">
                  {me?.kind === "device"
                    ? "Mesas, comanda, caja y cocina en esta tablet."
                    : "Activá esta tablet o PC del salón con el PIN de la sede."}
                </span>
              </Link>
            )}
            <Link to={destinoAdmin} className={PUERTA_CLASS}>
              <ShieldCheck className="size-10 text-primary" aria-hidden="true" />
              <span className="text-xl font-semibold">Administrar</span>
              <span className="text-sm text-muted-foreground">
                {me?.kind === "device"
                  ? "Con tu correo. En una tablet la sesión dura 15 minutos y vuelve sola al salón."
                  : "Ventas, dinero, carta, inventario y personal, con tu correo."}
              </span>
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
