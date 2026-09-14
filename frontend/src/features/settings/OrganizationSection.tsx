import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { getOrganization, updateOrganization } from "@/api/stores";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/EmptyState";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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

  async function handleSave(event: React.FormEvent) {
    event.preventDefault();
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
        title="No se pudo cargar la organización"
        description={errorMessage(query.error)}
        action={{ label: "Reintentar", onClick: () => void query.refetch() }}
      />
    );
  }

  return (
    <form className="max-w-md space-y-4" onSubmit={handleSave}>
      <div className="space-y-2">
        <Label htmlFor="org-name">Nombre de la organización</Label>
        <Input
          id="org-name"
          className="h-11"
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            setDirty(true);
          }}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? "org-name-error" : undefined}
        />
        {error ? (
          <p id="org-name-error" role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </div>
      <Button type="submit" disabled={saving || !dirty}>
        {saving ? "Guardando…" : "Guardar"}
      </Button>
    </form>
  );
}
