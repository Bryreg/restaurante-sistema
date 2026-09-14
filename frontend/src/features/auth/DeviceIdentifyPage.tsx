import { useState } from "react";
import { useNavigate } from "react-router-dom";

import { useSession } from "@/app/session";
import { deviceIdentify } from "@/api/auth";
import { PinPad } from "@/components/PinPad";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { errorMessage } from "@/lib/errors";

/**
 * "Quién opera": identificarse con PIN personal de 4 dígitos →
 * `POST /auth/device/identify {employee_id, pin}` (spec § "Auth &
 * identity"). `PIN_LOCKED` se muestra tal cual llega del servidor.
 *
 * GAP (bloqueante para la UX prevista en SPEC-NEGOCIO § 9.1 "Quién opera"):
 * la spec no lista una ruta de **dispositivo** para listar el personal
 * activo de la sede (sólo hay `GET /admin/employees`, que exige sesión de
 * admin y por lo tanto un dispositivo no puede llamar) y `GET /auth/me`
 * sólo devuelve la persona ya activa, no un roster. Sin esos datos no se
 * puede pintar la grilla de avatares/nombres que pide el negocio; en vez de
 * inventar una ruta, este campo pide el número de empleado a mano. Ver
 * detalle y la ruta que se necesitaría en el entregable.
 */
export default function DeviceIdentifyPage(): React.JSX.Element {
  const { refresh } = useSession();
  const navigate = useNavigate();
  const [employeeId, setEmployeeId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const parsedEmployeeId = Number(employeeId);
  const employeeIdValid =
    employeeId.trim() !== "" && Number.isInteger(parsedEmployeeId) && parsedEmployeeId > 0;

  async function handlePin(pin: string) {
    if (!employeeIdValid) {
      setError("Ingresá tu número de empleado antes del PIN.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await deviceIdentify({ employee_id: parsedEmployeeId, pin });
      await refresh();
      navigate("/pos", { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-background p-4 text-foreground">
      <div className="space-y-1 text-center">
        <h1 className="text-xl font-semibold">Quién opera</h1>
        <p className="text-sm text-muted-foreground">Identificate con tu PIN personal.</p>
      </div>
      <div className="w-full max-w-xs space-y-2">
        <Label htmlFor="employee-id">Número de empleado</Label>
        <Input
          id="employee-id"
          type="number"
          inputMode="numeric"
          min={1}
          className="h-11"
          value={employeeId}
          onChange={(event) => setEmployeeId(event.target.value)}
          disabled={submitting}
        />
        <p className="text-xs text-muted-foreground">
          Provisional: no hay todavía una ruta de dispositivo para mostrar avatares del personal
          activo (ver gaps del entregable).
        </p>
      </div>
      <PinPad
        length={4}
        label="PIN personal"
        onSubmit={handlePin}
        disabled={submitting || !employeeIdValid}
        errorMessage={error}
      />
    </div>
  );
}
