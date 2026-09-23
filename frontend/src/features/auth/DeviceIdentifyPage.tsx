import { useState } from "react";
import { useNavigate } from "react-router-dom";

import { useDensity } from "@/app/density";
import { useSalonTheme } from "@/app/theme";
import { useSession } from "@/app/session";
import { deviceIdentify } from "@/api/auth";
import type { DeviceEmployee } from "@/api/employees";
import { EmployeePicker } from "@/components/EmployeePicker";
import { PinPad } from "@/components/PinPad";
import { errorMessage } from "@/lib/errors";

/**
 * "Quién opera" (SPEC-NEGOCIO §9.1; CONTRATO-INTERNO-1b-1.md §6, cierra A-9
 * de la entrega de 1a): elegir la persona en un toque con `EmployeePicker`
 * (`GET /device/employees`) y después el PIN personal de 4 dígitos →
 * `POST /auth/device/identify {employee_id, pin}`. `PIN_LOCKED` u otro
 * error del servidor se muestra tal cual llega.
 */
export default function DeviceIdentifyPage(): React.JSX.Element {
  // Ídem `DeviceActivatePage`: vive fuera de `PosLayout` y es el otro
  // teclado de PIN de la tablet.
  useDensity("salon");
  useSalonTheme();
  const { refresh } = useSession();
  const navigate = useNavigate();
  const [employee, setEmployee] = useState<DeviceEmployee | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handlePin(pin: string) {
    if (!employee) {
      setError("Elegí quién opera antes del PIN.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await deviceIdentify({ employee_id: employee.id, pin });
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
        <p className="text-sm text-muted-foreground">
          {employee ? `Ingresá el PIN de ${employee.name}.` : "Elegí quién opera y después tecleá el PIN."}
        </p>
      </div>

      <div className="w-full max-w-md">
        <EmployeePicker
          value={employee?.id ?? null}
          onChange={(_id, next) => {
            setEmployee(next);
            setError(null);
          }}
          label="Quién opera"
          disabled={submitting}
        />
      </div>

      <PinPad
        length={4}
        label="PIN personal"
        onSubmit={handlePin}
        disabled={submitting || !employee}
        errorMessage={error}
      />
    </div>
  );
}
