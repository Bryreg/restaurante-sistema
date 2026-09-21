import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

import { listUvt, setUvt, type UvtEntry } from "@/api/stores";
import { FormSection, SaveBar, type PendingChange } from "@/components/admin";
import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { errorMessage } from "@/lib/errors";
import { formatCOP } from "@/lib/money";

/** Los cambios sin guardar de la tabla, año por año (patrón 12). */
function cambiosDeUvt(guardadas: UvtEntry[], actuales: UvtEntry[]): PendingChange[] {
  const cambios: PendingChange[] = [];
  for (const fila of actuales) {
    const antes = guardadas.find((r) => r.year === fila.year);
    if (!antes) {
      cambios.push({ field: `UVT ${fila.year}`, from: "no estaba", to: formatCOP(fila.value) });
    } else if (antes.value !== fila.value) {
      cambios.push({ field: `UVT ${fila.year}`, from: formatCOP(antes.value), to: formatCOP(fila.value) });
    }
  }
  for (const antes of guardadas) {
    if (!actuales.some((r) => r.year === antes.year)) {
      cambios.push({ field: `UVT ${antes.year}`, from: formatCOP(antes.value), to: "quitada" });
    }
  }
  return cambios;
}

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
        reason="error"
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

  const guardadas = query.data ?? [];
  const cambios = cambiosDeUvt(guardadas, rows);
  const ultima = rows.length > 0 ? rows.reduce((a, b) => (a.year > b.year ? a : b)) : null;

  return (
    <div className="space-y-3">
      <FormSection
        title="La UVT de cada año"
        columns="one"
        governs="La Unidad de Valor Tributario con la que se miden los topes de ley. La publica la DIAN una vez al año y acá sólo se transcribe: el sistema no la calcula ni la actualiza solo."
        reading={
          ultima ? (
            <>
              El año más nuevo cargado es <b className="font-bold text-foreground tabular-nums">{ultima.year}</b>{" "}
              con <b className="font-bold text-foreground tabular-nums">{formatCOP(ultima.value)}</b>. Una venta
              vieja se sigue midiendo con la UVT de su año: por eso los años anteriores no se borran.
            </>
          ) : (
            <>
              Todavía no hay ningún año cargado. Sin UVT, los topes que dependen de ella no se pueden expresar en
              pesos.
            </>
          )
        }
        doesNotDo="Cambiar un valor de un año pasado no recalcula ninguna venta ya cobrada: lo que se congeló en el documento se queda como está."
      >
        <div className="space-y-2">
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
        </div>
      </FormSection>

      {error ? (
        <p role="alert" className="text-sm font-medium text-destructive">
          {error}
        </p>
      ) : null}

      <SaveBar
        sectionName="UVT"
        changes={cambios}
        saving={saving}
        onSave={() => void handleSave()}
        onDiscard={() => setRows(guardadas)}
      />
    </div>
  );
}
