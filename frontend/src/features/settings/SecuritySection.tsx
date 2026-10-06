import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { getSalesSettings, setSalesSettings, type SalesSettings, type SecuritySettingsKey } from "@/api/stores";
import { FormField, FormSection, SaveBar, type PendingChange } from "@/components/admin";
import { EmptyState } from "@/components/EmptyState";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { errorMessage } from "@/lib/errors";

type Security = Pick<SalesSettings, SecuritySettingsKey>;

const CAMPOS: { key: SecuritySettingsKey; field: string; sufijo: string }[] = [
  { key: "employee_session_minutes", field: "Sesión de la persona", sufijo: " min" },
  { key: "pin_lock_attempts", field: "Intentos antes del bloqueo", sufijo: "" },
  { key: "pin_lock_minutes", field: "Bloqueo del PIN", sufijo: " min" },
];

function deLaConfiguracion(settings: SalesSettings): Security {
  return {
    employee_session_minutes: settings.employee_session_minutes,
    pin_lock_attempts: settings.pin_lock_attempts,
    pin_lock_minutes: settings.pin_lock_minutes,
  };
}

function cambiosDeSeguridad(guardado: Security, actual: Security): PendingChange[] {
  const cambios: PendingChange[] = [];
  for (const { key, field, sufijo } of CAMPOS) {
    const antes = guardado[key];
    const ahora = actual[key];
    if (antes !== ahora) {
      cambios.push({
        field,
        from: antes === null ? "el de fábrica" : `${antes}${sufijo}`,
        to: ahora === null ? "el de fábrica" : `${ahora}${sufijo}`,
        leaks: "Cambia Quién opera en las tablets",
      });
    }
  }
  return cambios;
}

/**
 * Ajustes › Seguridad: la sesión de la persona en la tablet y el bloqueo del
 * PIN. Antes vivían adentro de Ventas, que es de precio y motivos; se guardan
 * en el mismo recurso (`/admin/stores/{id}/sales-settings`), pero esta
 * pantalla manda la configuración de ventas tal cual la leyó y sólo cambia
 * estos tres.
 */
export function SecuritySection({ storeId }: { storeId: number | null }): React.JSX.Element {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["admin-sales-settings", storeId],
    queryFn: () => getSalesSettings(storeId as number),
    enabled: storeId !== null,
  });
  // Lo editado sin guardar; `null` = lo que se leyó del servidor. Sin efecto
  // que copie la consulta al estado: se deriva al dibujar. El padre monta
  // esta sección con `key` por sede, así lo editado no salta de sede.
  const [draft, setDraft] = useState<Security | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const values = draft ?? (query.data ? deLaConfiguracion(query.data) : null);

  if (storeId === null) {
    return <EmptyState title="Elegí una sede" description="Creá una sede en la pestaña Sedes primero." />;
  }
  if (query.isError) {
    return (
      <EmptyState
        role="alert"
        reason="error"
        title="No se pudo cargar la seguridad de las tablets"
        description={
          <>
            {errorMessage(query.error)} El formulario queda bloqueado: no se guarda encima de una configuración
            que no se pudo leer.
          </>
        }
        action={{ label: "Reintentar", onClick: () => void query.refetch() }}
      />
    );
  }
  if (query.isLoading || !values || !query.data) {
    return <Skeleton className="h-64 w-full" />;
  }

  const leida = query.data;
  const guardado = deLaConfiguracion(leida);
  const cambios = cambiosDeSeguridad(guardado, values);

  function patch(next: Partial<Security>) {
    setDraft((d) => ({ ...(d ?? guardado), ...next }));
  }

  async function handleSave() {
    if (!values) return;
    setSaving(true);
    setError(null);
    try {
      await setSalesSettings(storeId as number, { ...leida, ...values });
      await queryClient.invalidateQueries({ queryKey: ["admin-sales-settings", storeId] });
      setDraft(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-3">
      <FormSection
        title="Seguridad de las tablets"
        governs="Cuánto dura la identificación de una persona en la tablet sin usarla, y cuántos PIN equivocados la bloquean y por cuánto tiempo."
        reading={
          <>
            Vacío = el valor de fábrica ({leida.employee_session_minutes_default ?? 3} min de sesión,{" "}
            {leida.pin_lock_attempts_default ?? 5} intentos, {leida.pin_lock_minutes_default ?? 15} min de bloqueo).
          </>
        }
        doesNotDo="No toca el PIN de nadie ni desbloquea a quien ya está bloqueado: el cambio rige desde el próximo intento."
      >
        <FormField label="Sesión de la persona (minutos sin usar)" help="Pasado este tiempo sin tocar la tablet, pide el PIN otra vez.">
          {({ fieldId, describedBy }) => (
            <Input
              id={fieldId}
              aria-describedby={describedBy}
              type="number"
              min={1}
              max={240}
              className="h-11"
              placeholder={String(leida.employee_session_minutes_default ?? 3)}
              value={values.employee_session_minutes ?? ""}
              onChange={(e) => patch({ employee_session_minutes: e.target.value === "" ? null : Number(e.target.value) })}
            />
          )}
        </FormField>
        <FormField label="PIN equivocados antes del bloqueo" help="Al llegar a este número el PIN se bloquea y el administrador recibe un aviso.">
          {({ fieldId, describedBy }) => (
            <Input
              id={fieldId}
              aria-describedby={describedBy}
              type="number"
              min={2}
              max={20}
              className="h-11"
              placeholder={String(leida.pin_lock_attempts_default ?? 5)}
              value={values.pin_lock_attempts ?? ""}
              onChange={(e) => patch({ pin_lock_attempts: e.target.value === "" ? null : Number(e.target.value) })}
            />
          )}
        </FormField>
        <FormField label="Minutos de bloqueo del PIN" help="Cuánto queda bloqueado el PIN; ni el PIN correcto entra mientras tanto.">
          {({ fieldId, describedBy }) => (
            <Input
              id={fieldId}
              aria-describedby={describedBy}
              type="number"
              min={1}
              max={1440}
              className="h-11"
              placeholder={String(leida.pin_lock_minutes_default ?? 15)}
              value={values.pin_lock_minutes ?? ""}
              onChange={(e) => patch({ pin_lock_minutes: e.target.value === "" ? null : Number(e.target.value) })}
            />
          )}
        </FormField>
      </FormSection>

      {error ? (
        <p role="alert" className="text-sm font-medium text-destructive">
          {error}
        </p>
      ) : null}

      <SaveBar
        sectionName="Seguridad"
        changes={cambios}
        saving={saving}
        onSave={() => void handleSave()}
        onDiscard={() => setDraft(null)}
      />
    </div>
  );
}
