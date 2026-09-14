import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

import { getSalesSettings, setSalesSettings, type PaymentMethod, type SalesSettings } from "@/api/stores";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/EmptyState";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { errorMessage } from "@/lib/errors";

function linesToList(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

function listToLines(list: string[]): string {
  return list.join("\n");
}

function emptyPaymentMethod(): PaymentMethod {
  return { code: "", label: "", dian_code: "", enabled: true, requires_reference: false };
}

/** `GET/PUT /admin/stores/{id}/sales-settings`. */
export function SalesSection({ storeId }: { storeId: number | null }): React.JSX.Element {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["admin-sales-settings", storeId],
    queryFn: () => getSalesSettings(storeId as number),
    enabled: storeId !== null,
  });
  const [values, setValues] = useState<SalesSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (query.data) setValues(query.data);
  }, [query.data]);

  if (storeId === null) {
    return <EmptyState title="Elegí una sede" description="Creá una sede en la pestaña Sedes primero." />;
  }
  if (query.isLoading || !values) {
    return <Skeleton className="h-64 w-full" />;
  }
  if (query.isError) {
    return (
      <EmptyState
        role="alert"
        title="No se pudo cargar la configuración de ventas"
        description={errorMessage(query.error)}
        action={{ label: "Reintentar", onClick: () => void query.refetch() }}
      />
    );
  }

  function updatePaymentMethod(index: number, patch: Partial<PaymentMethod>) {
    setValues((v) =>
      v
        ? { ...v, payment_methods: v.payment_methods.map((m, i) => (i === index ? { ...m, ...patch } : m)) }
        : v,
    );
  }

  function removePaymentMethod(index: number) {
    setValues((v) => (v ? { ...v, payment_methods: v.payment_methods.filter((_, i) => i !== index) } : v));
  }

  function setCourses(text: string) {
    const courses = linesToList(text);
    setValues((v) => {
      if (!v) return v;
      const nextTargets: Record<string, number> = {};
      for (const course of courses) {
        nextTargets[course] = v.course_target_minutes[course] ?? 10;
      }
      return { ...v, courses, course_target_minutes: nextTargets };
    });
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!values) return;
    setSaving(true);
    setError(null);
    try {
      await setSalesSettings(storeId as number, values);
      await queryClient.invalidateQueries({ queryKey: ["admin-sales-settings", storeId] });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="max-w-2xl space-y-6" onSubmit={handleSubmit}>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="sales-tip">Propina sugerida (%, máx. 10)</Label>
          <Input
            id="sales-tip"
            type="number"
            min={0}
            max={10}
            step="0.5"
            className="h-11"
            value={values.tip_suggested_pct}
            onChange={(e) => setValues((v) => (v ? { ...v, tip_suggested_pct: Number(e.target.value) } : v))}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="sales-discount">Límite de descuento (%)</Label>
          <Input
            id="sales-discount"
            type="number"
            min={0}
            max={100}
            className="h-11"
            value={values.discount_limit_pct}
            onChange={(e) => setValues((v) => (v ? { ...v, discount_limit_pct: Number(e.target.value) } : v))}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="sales-discount-daily">Límite diario de descuento (%)</Label>
          <Input
            id="sales-discount-daily"
            type="number"
            min={0}
            max={100}
            className="h-11"
            value={values.discount_daily_limit_pct}
            onChange={(e) =>
              setValues((v) => (v ? { ...v, discount_daily_limit_pct: Number(e.target.value) } : v))
            }
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="sales-courtesy">Cortesías por turno</Label>
          <Input
            id="sales-courtesy"
            type="number"
            min={0}
            className="h-11"
            value={values.courtesy_shift_limit}
            onChange={(e) => setValues((v) => (v ? { ...v, courtesy_shift_limit: Number(e.target.value) } : v))}
          />
        </div>
      </div>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Medios de pago</legend>
        <div className="space-y-2">
          {values.payment_methods.map((method, index) => (
            <div key={index} className="flex flex-wrap items-end gap-2 rounded-md border p-2">
              <div className="space-y-1">
                <Label htmlFor={`pm-code-${index}`} className="text-xs">
                  Código
                </Label>
                <Input
                  id={`pm-code-${index}`}
                  className="h-9 w-28"
                  value={method.code}
                  onChange={(e) => updatePaymentMethod(index, { code: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor={`pm-label-${index}`} className="text-xs">
                  Nombre
                </Label>
                <Input
                  id={`pm-label-${index}`}
                  className="h-9 w-36"
                  value={method.label}
                  onChange={(e) => updatePaymentMethod(index, { label: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor={`pm-dian-${index}`} className="text-xs">
                  Código DIAN
                </Label>
                <Input
                  id={`pm-dian-${index}`}
                  className="h-9 w-28"
                  value={method.dian_code}
                  onChange={(e) => updatePaymentMethod(index, { dian_code: e.target.value })}
                />
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={`Quitar medio de pago ${method.label || index + 1}`}
                onClick={() => removePaymentMethod(index)}
              >
                <Trash2 className="size-4" aria-hidden="true" />
              </Button>
            </div>
          ))}
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-1"
          onClick={() => setValues((v) => (v ? { ...v, payment_methods: [...v.payment_methods, emptyPaymentMethod()] } : v))}
        >
          <Plus className="size-4" aria-hidden="true" />
          Agregar medio de pago
        </Button>
      </fieldset>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="sales-void-reasons">Motivos de anulación (uno por línea)</Label>
          <Textarea
            id="sales-void-reasons"
            value={listToLines(values.void_reasons)}
            onChange={(e) => setValues((v) => (v ? { ...v, void_reasons: linesToList(e.target.value) } : v))}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="sales-discount-reasons">Motivos de descuento (uno por línea)</Label>
          <Textarea
            id="sales-discount-reasons"
            value={listToLines(values.discount_reasons)}
            onChange={(e) => setValues((v) => (v ? { ...v, discount_reasons: linesToList(e.target.value) } : v))}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="sales-courtesy-reasons">Motivos de cortesía (uno por línea)</Label>
          <Textarea
            id="sales-courtesy-reasons"
            value={listToLines(values.courtesy_reasons)}
            onChange={(e) => setValues((v) => (v ? { ...v, courtesy_reasons: linesToList(e.target.value) } : v))}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="sales-stations">Estaciones (una por línea)</Label>
          <Textarea
            id="sales-stations"
            value={listToLines(values.stations)}
            onChange={(e) => setValues((v) => (v ? { ...v, stations: linesToList(e.target.value) } : v))}
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="sales-courses">Cursos (uno por línea)</Label>
        <Textarea id="sales-courses" value={listToLines(values.courses)} onChange={(e) => setCourses(e.target.value)} />
      </div>

      {values.courses.length > 0 ? (
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Tiempo objetivo por curso (minutos)</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {values.courses.map((course) => (
              <div key={course} className="flex items-center gap-2">
                <Label htmlFor={`course-min-${course}`} className="w-32 shrink-0 text-sm">
                  {course}
                </Label>
                <Input
                  id={`course-min-${course}`}
                  type="number"
                  min={1}
                  className="h-9 w-24"
                  value={values.course_target_minutes[course] ?? 10}
                  onChange={(e) =>
                    setValues((v) =>
                      v
                        ? {
                            ...v,
                            course_target_minutes: {
                              ...v.course_target_minutes,
                              [course]: Number(e.target.value),
                            },
                          }
                        : v,
                    )
                  }
                />
              </div>
            ))}
          </div>
        </fieldset>
      ) : null}

      {error ? (
        <p role="alert" className="text-sm font-medium text-destructive">
          {error}
        </p>
      ) : null}
      <Button type="submit" disabled={saving}>
        {saving ? "Guardando…" : "Guardar"}
      </Button>
    </form>
  );
}
