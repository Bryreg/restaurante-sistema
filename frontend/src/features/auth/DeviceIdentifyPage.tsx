import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

import { useDensity } from "@/app/density";
import { destinoSeguro } from "@/app/puesto";
import { useSalonTheme } from "@/app/theme";
import { useSession } from "@/app/session";
import { deviceIdentify } from "@/api/auth";
import type { DeviceEmployee } from "@/api/employees";
import { EmployeePicker } from "@/components/EmployeePicker";
import { PinPad } from "@/components/PinPad";
import { useCurrentShift } from "@/features/shifts/hooks";
import { errorMessage } from "@/lib/errors";

/**
 * "Quién opera" (SPEC-NEGOCIO §9.1; CONTRATO-INTERNO-1b-1.md §6, cierra A-9
 * de la entrega de 1a): elegir la persona en un toque con `EmployeePicker`
 * (`GET /device/employees`) y después el PIN personal de 4 dígitos →
 * `POST /auth/device/identify {employee_id, pin}`. `PIN_LOCKED` u otro
 * error del servidor se muestra tal cual llega.
 *
 * **Inicio por rol** (2026-09-25):
 *
 * - Primero, en grande, la última persona que usó esta tablet
 *   (`me.last_employee_id`, lo guarda el servidor) y quienes están adentro
 *   del turno (el roster de `GET /shifts/current`); el resto, detrás de
 *   «Otra persona».
 * - En horizontal el teclado va al lado de la grilla, para que nunca quede
 *   debajo del borde de la pantalla.
 * - Después del PIN se vuelve a la pantalla de la que se venía (`?next=`:
 *   la sesión venció o alguien tocó «Cambiar de persona»); si no se venía de
 *   ninguna, `/pos` decide por el puesto de la persona (`PosHome`).
 */
export default function DeviceIdentifyPage(): React.JSX.Element {
  // Ídem `DeviceActivatePage`: vive fuera de `PosLayout` y es el otro
  // teclado de PIN de la tablet.
  useDensity("salon");
  useSalonTheme();
  const { me, refresh } = useSession();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const siguiente = destinoSeguro(searchParams.get("next"));
  const turno = useCurrentShift();
  const [employee, setEmployee] = useState<DeviceEmployee | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const destacados: number[] = [];
  const ultima = me?.last_employee_id;
  if (ultima != null) destacados.push(ultima);
  for (const entry of turno.data?.roster ?? []) {
    if (entry.out_at || entry.employee_id == null) continue;
    if (!destacados.includes(entry.employee_id)) destacados.push(entry.employee_id);
  }

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
      navigate(siguiente ?? "/pos", { replace: true });
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

      {/* Vertical: grilla y debajo el teclado. Horizontal (tablet acostada,
          1280×800): lado a lado, la grilla con su propio desplazamiento y el
          teclado siempre a la vista. */}
      <div className="flex w-full max-w-md flex-col items-center gap-6 md:landscape:max-w-5xl md:landscape:flex-row md:landscape:items-start md:landscape:justify-center">
        <div className="w-full md:landscape:max-h-[calc(100vh-10rem)] md:landscape:flex-1 md:landscape:overflow-y-auto md:landscape:p-1">
          <EmployeePicker
            value={employee?.id ?? null}
            onChange={(_id, next) => {
              setEmployee(next);
              setError(null);
            }}
            label="Quién opera"
            destacados={destacados}
            disabled={submitting}
          />
        </div>

        <div className="md:landscape:sticky md:landscape:top-4 md:landscape:shrink-0">
          <PinPad
            length={4}
            label="PIN personal"
            onSubmit={handlePin}
            disabled={submitting || !employee}
            errorMessage={error}
          />
        </div>
      </div>
    </div>
  );
}
