import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

import { listUvt, setUvt, type UvtEntry } from "@/api/stores";
import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { errorMessage } from "@/lib/errors";

/** `GET/PUT /admin/uvt` — tabla de UVT por año (SPEC-NEGOCIO § 8.1). */
export function UvtSection(): React.JSX.Element {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["admin-uvt"], queryFn: listUvt });
  const [rows, setRows] = useState<UvtEntry[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (query.data) setRows(query.data);
  }, [query.data]);

  if (query.isLoading) {
    return <Skeleton className="h-40 w-full max-w-sm" />;
  }
  if (query.isError) {
    return (
      <EmptyState
        role="alert"
        title="No se pudo cargar la tabla de UVT"
        description={errorMessage(query.error)}
        action={{ label: "Reintentar", onClick: () => void query.refetch() }}
      />
    );
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const cleaned = rows.filter((r) => r.year > 0 && r.value > 0);
      await setUvt(cleaned);
      await queryClient.invalidateQueries({ queryKey: ["admin-uvt"] });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  function addRow() {
    const lastYear = rows.length > 0 ? Math.max(...rows.map((r) => r.year)) : 2025;
    setRows((r) => [...r, { year: lastYear + 1, value: 0 }]);
  }

  return (
    <div className="max-w-sm space-y-3">
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">Todavía no hay valores de UVT cargados.</p>
      ) : null}
      {rows.map((row, index) => (
        <div key={index} className="flex items-end gap-2">
          <div className="space-y-1">
            <Label htmlFor={`uvt-year-${index}`} className="text-xs">
              Año
            </Label>
            <Input
              id={`uvt-year-${index}`}
              type="number"
              className="h-10 w-24"
              value={row.year}
              onChange={(e) =>
                setRows((r) => r.map((x, i) => (i === index ? { ...x, year: Number(e.target.value) } : x)))
              }
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`uvt-value-${index}`} className="text-xs">
              Valor
            </Label>
            <Input
              id={`uvt-value-${index}`}
              type="number"
              className="h-10 w-32"
              value={row.value}
              onChange={(e) =>
                setRows((r) => r.map((x, i) => (i === index ? { ...x, value: Number(e.target.value) } : x)))
              }
            />
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`Quitar UVT ${row.year}`}
            onClick={() => setRows((r) => r.filter((_, i) => i !== index))}
          >
            <Trash2 className="size-4" aria-hidden="true" />
          </Button>
        </div>
      ))}
      <Button type="button" variant="outline" size="sm" className="gap-1" onClick={addRow}>
        <Plus className="size-4" aria-hidden="true" />
        Agregar año
      </Button>
      {error ? (
        <p role="alert" className="text-sm font-medium text-destructive">
          {error}
        </p>
      ) : null}
      <div>
        <Button type="button" onClick={() => void handleSave()} disabled={saving}>
          {saving ? "Guardando…" : "Guardar"}
        </Button>
      </div>
    </div>
  );
}
