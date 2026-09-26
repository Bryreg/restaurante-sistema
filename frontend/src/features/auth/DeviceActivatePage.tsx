import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { useDensity } from "@/app/density";
import { useSalonTheme } from "@/app/theme";
import { useSession } from "@/app/session";
import { deviceActivate } from "@/api/auth";
import { PinPad } from "@/components/PinPad";
import { buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { errorMessage } from "@/lib/errors";

/**
 * Activar dispositivo (una vez por tablet/PC): sede + PIN de sede de 6
 * dígitos → `POST /auth/device/activate` (spec § "Auth & identity").
 *
 * GAP: la spec no define una ruta pública para listar sedes antes de
 * activar (todo `GET /admin/stores*` exige sesión de admin). Sin eso no se
 * puede pintar un selector por nombre; se pide el número de sede a mano y
 * se documenta en el entregable.
 */
export default function DeviceActivatePage(): React.JSX.Element {
  // Fuera de `PosLayout`, así que la densidad del salón no llega sola: esta
  // pantalla es un teclado de PIN en una tablet y necesita el objetivo
  // táctil de 52 px tanto como las de adentro.
  useDensity("salon");
  useSalonTheme();
  const { me, refresh } = useSession();
  const navigate = useNavigate();
  const [storeId, setStoreId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const parsedStoreId = Number(storeId);
  const storeIdValid = storeId.trim() !== "" && Number.isInteger(parsedStoreId) && parsedStoreId > 0;

  async function handlePin(pin: string) {
    if (!storeIdValid) {
      setError("Ingresá el número de sede antes del PIN.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await deviceActivate({ store_id: parsedStoreId, store_pin: pin });
      await refresh();
      navigate("/pos/identify", { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-background p-4 text-foreground">
      <div className="space-y-1 text-center">
        <h1 className="text-xl font-semibold">Activar este dispositivo</h1>
        <p className="text-sm text-muted-foreground">Se hace una sola vez por tablet o PC del salón.</p>
      </div>
      {me?.kind === "admin" ? (
        <p role="status" className="w-full max-w-xs rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
          Este navegador tiene abierta la sesión de administrador de {me.user?.name ?? "la organización"}. Activarlo
          como punto de venta la cierra acá: para volver al admin, entrá de nuevo con tu correo.
        </p>
      ) : null}
      <div className="w-full max-w-xs space-y-2">
        <Label htmlFor="store-id">Número de sede</Label>
        <Input
          id="store-id"
          type="number"
          inputMode="numeric"
          min={1}
          className="h-11"
          value={storeId}
          onChange={(event) => setStoreId(event.target.value)}
          disabled={submitting}
        />
        <p className="text-xs text-muted-foreground">
          El número de la sede, no el PIN. Te lo da el administrador; el PIN va en el teclado de
          abajo.
        </p>
      </div>
      <PinPad
        length={6}
        label="PIN de sede"
        onSubmit={handlePin}
        disabled={submitting || !storeIdValid}
        errorMessage={error}
      />
      {/* Secundario: quien llegó acá buscando el admin tiene su puerta. */}
      <div className="flex flex-wrap items-center justify-center gap-2 text-sm">
        <Link to="/login" className={buttonVariants({ variant: "ghost", className: "h-11 text-muted-foreground" })}>
          Entrar como administrador
        </Link>
        <Link to="/" className={buttonVariants({ variant: "ghost", className: "h-11 text-muted-foreground" })}>
          Inicio
        </Link>
      </div>
    </div>
  );
}
