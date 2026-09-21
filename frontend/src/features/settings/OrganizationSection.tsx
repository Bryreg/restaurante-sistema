import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { getOrganization, updateOrganization } from "@/api/stores";
import { FormField, FormSection, SaveBar } from "@/components/admin";
import { EmptyState } from "@/components/EmptyState";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { errorMessage } from "@/lib/errors";

/** `GET/PATCH /admin/organization` — sólo el nombre en este pedido. */
export function OrganizationSection(): React.JSX.Element {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["admin-organization"], queryFn: getOrganization });
  const [name, setName] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (query.data && !dirty) {
      setName(query.data.name);
    }
  }, [query.data, dirty]);

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      await updateOrganization({ name });
      await queryClient.invalidateQueries({ queryKey: ["admin-organization"] });
      setDirty(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  if (query.isLoading) {
    return <Skeleton className="h-24 w-full max-w-md" />;
  }
  if (query.isError) {
    return (
      <EmptyState
        role="alert"
        reason="error"
        title="No se pudo cargar la organización"
        description={errorMessage(query.error)}
        action={{ label: "Reintentar", onClick: () => void query.refetch() }}
      />
    );
  }

  const guardado = query.data?.name ?? "";
  const cambios = name !== guardado ? [{ field: "Nombre de la organización", from: guardado, to: name }] : [];

  return (
    <div className="space-y-3">
      <FormSection
        title="La organización"
        governs="El nombre del negocio, que es el paraguas de todas las sedes. No es el nombre de la sede ni la razón social que va en el documento fiscal: ésos se editan en Sedes."
        reading={
          <>
            Todo lo que el sistema muestra por encima de la sede dice{" "}
            <b className="font-bold text-foreground">{name || "—"}</b>. El perfil de funciones y el historial
            cuelgan de acá, no de una sede.
          </>
        }
      >
        <FormField
          label="Nombre de la organización"
          help="Aparece en la cabecera del escritorio y en los reportes que abarcan más de una sede."
          error={error ?? undefined}
        >
          {({ fieldId, describedBy }) => (
            <Input
              id={fieldId}
              aria-describedby={describedBy}
              className="h-11"
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                setDirty(true);
              }}
              aria-invalid={Boolean(error)}
            />
          )}
        </FormField>
      </FormSection>

      <SaveBar
        sectionName="Organización"
        changes={cambios}
        saving={saving}
        onSave={() => void handleSave()}
        onDiscard={() => {
          setName(guardado);
          setDirty(false);
        }}
      />
    </div>
  );
}
