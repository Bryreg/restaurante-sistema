import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

import { getSalesSettings, setSalesSettings, type PaymentMethod, type SalesSettings } from "@/api/stores";
import { FormField, FormSection, SaveBar, type PendingChange } from "@/components/admin";
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

/**
 * Los cambios sin guardar (patrón 12). Las listas se cuentan en vez de
 * enumerarse: lo que el dueño necesita ver en la confirmación es que **la
 * lista que llena un desplegable del salón cambió de tamaño**, no las
 * catorce palabras que tiene adentro.
 */
function cambiosDeVentas(guardado: SalesSettings, actual: SalesSettings): PendingChange[] {
  const cambios: PendingChange[] = [];
  const numeros: { key: keyof SalesSettings; field: string; sufijo: string; leaks?: string }[] = [
    { key: "tip_suggested_pct", field: "Propina sugerida", sufijo: " %", leaks: "Cambia Salón › Cobro" },
    { key: "discount_limit_pct", field: "Límite de descuento", sufijo: " %", leaks: "Cambia Salón › Comanda › Descuento" },
    { key: "discount_daily_limit_pct", field: "Límite diario de descuento", sufijo: " %", leaks: "Cambia Salón › Comanda › Descuento" },
    { key: "courtesy_shift_limit", field: "Cortesías por turno", sufijo: "", leaks: "Cambia Salón › Comanda › Cortesía" },
  ];
  for (const { key, field, sufijo, leaks } of numeros) {
    const antes = guardado[key] as number;
    const ahora = actual[key] as number;
    if (antes !== ahora) cambios.push({ field, from: `${antes}${sufijo}`, to: `${ahora}${sufijo}`, leaks });
  }

  const listas: { key: keyof SalesSettings; field: string; leaks?: string }[] = [
    { key: "payment_methods", field: "Medios de pago", leaks: "Cambia Salón › Cobro" },
    { key: "void_reasons", field: "Motivos de anulación", leaks: "Llena el desplegable de Salón › Anular" },
    { key: "discount_reasons", field: "Motivos de descuento", leaks: "Llena el desplegable de Salón › Descuento" },
    { key: "courtesy_reasons", field: "Motivos de cortesía", leaks: "Llena el desplegable de Salón › Cortesía" },
    { key: "stations", field: "Estaciones", leaks: "Cambia Cocina y KDS" },
    { key: "courses", field: "Cursos", leaks: "Cambia Cocina y KDS" },
  ];
  for (const { key, field, leaks } of listas) {
    const antes = guardado[key] as unknown[];
    const ahora = actual[key] as unknown[];
    if (JSON.stringify(antes) !== JSON.stringify(ahora)) {
      cambios.push({ field, from: `${antes.length}`, to: `${ahora.length}`, leaks });
    }
  }
  if (JSON.stringify(guardado.course_target_minutes) !== JSON.stringify(actual.course_target_minutes)) {
    cambios.push({
      field: "Tiempo objetivo por curso",
      from: `${Object.keys(guardado.course_target_minutes).length} cursos`,
      to: `${Object.keys(actual.course_target_minutes).length} cursos`,
      leaks: "Cambia Cocina y KDS",
    });
  }
  return cambios;
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
        reason="error"
        title="No se pudo cargar la configuración de ventas"
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

  function patch(next: Partial<SalesSettings>) {
    setValues((v) => (v ? { ...v, ...next } : v));
  }

  function updatePaymentMethod(index: number, patchMethod: Partial<PaymentMethod>) {
    setValues((v) =>
      v
        ? { ...v, payment_methods: v.payment_methods.map((m, i) => (i === index ? { ...m, ...patchMethod } : m)) }
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

  async function handleSave() {
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

  const guardado = query.data as SalesSettings;
  const cambios = cambiosDeVentas(guardado, values);

  return (
    <div className="space-y-3">
      <FormSection
        title="Qué puede hacer el salón con el precio"
        governs="Los topes que el servidor hace cumplir cuando alguien descuenta, regala o pregunta la propina. Pasado el tope, la acción no se bloquea: pide la autorización de un supervisor."
        reading={
          <>
            El cobro propone <b className="font-bold text-foreground tabular-nums">{values.tip_suggested_pct} %</b>{" "}
            de propina —voluntaria, y nunca más de 10 % por ley—. Una persona puede descontar hasta{" "}
            <b className="font-bold text-foreground tabular-nums">{values.discount_limit_pct} %</b> por sí sola y
            el turno entero hasta{" "}
            <b className="font-bold text-foreground tabular-nums">{values.discount_daily_limit_pct} %</b>; de ahí
            en adelante hace falta el PIN de un supervisor. Las cortesías se cortan en{" "}
            <b className="font-bold text-foreground tabular-nums">{values.courtesy_shift_limit}</b> por turno.
          </>
        }
        doesNotDo="Ninguno de estos topes le impide vender a nadie: el servidor contesta pidiendo autorización, y con el PIN del supervisor la venta sigue. Lo que queda es el registro de quién autorizó."
      >
        <FormField
          label="Propina sugerida (%, máx. 10)"
          help="Lo que el cobro propone al presentar la cuenta. La propina es voluntaria y se separa de la venta y del impuesto (Ley 1935 de 2018)."
          scope={{ affects: [{ screen: "Salón › Cobro", verb: "Propone en" }] }}
        >
          {({ fieldId, describedBy }) => (
            <Input
              id={fieldId}
              aria-describedby={describedBy}
              type="number"
              min={0}
              max={10}
              step="0.5"
              className="h-11"
              value={values.tip_suggested_pct}
              onChange={(e) => patch({ tip_suggested_pct: Number(e.target.value) })}
            />
          )}
        </FormField>

        <FormField
          label="Límite de descuento (%)"
          help="Hasta acá descuenta cualquiera sin pedir permiso. Pasado el límite, el servidor pide el PIN de un supervisor."
          scope={{
            affects: [{ screen: "Salón › Comanda › Descuento", verb: "Frena" }],
            requires: "PIN de supervisor",
          }}
        >
          {({ fieldId, describedBy }) => (
            <Input
              id={fieldId}
              aria-describedby={describedBy}
              type="number"
              min={0}
              max={100}
              className="h-11"
              value={values.discount_limit_pct}
              onChange={(e) => patch({ discount_limit_pct: Number(e.target.value) })}
            />
          )}
        </FormField>

        <FormField
          label="Límite diario de descuento (%)"
          help="El tope del turno entero, sumando todos los descuentos. Existe para que muchos descuentos chicos no hagan lo que uno grande no puede."
          scope={{ affects: [{ screen: "Salón › Comanda › Descuento", verb: "Frena" }] }}
        >
          {({ fieldId, describedBy }) => (
            <Input
              id={fieldId}
              aria-describedby={describedBy}
              type="number"
              min={0}
              max={100}
              className="h-11"
              value={values.discount_daily_limit_pct}
              onChange={(e) => patch({ discount_daily_limit_pct: Number(e.target.value) })}
            />
          )}
        </FormField>

        <FormField
          label="Cortesías por turno"
          help="Cuántos platos se pueden regalar por turno. La cortesía no es un descuento del 100 %: sale en su propio reporte y con su propio motivo."
          scope={{ affects: [{ screen: "Salón › Comanda › Cortesía", verb: "Frena" }] }}
        >
          {({ fieldId, describedBy }) => (
            <Input
              id={fieldId}
              aria-describedby={describedBy}
              type="number"
              min={0}
              className="h-11"
              value={values.courtesy_shift_limit}
              onChange={(e) => patch({ courtesy_shift_limit: Number(e.target.value) })}
            />
          )}
        </FormField>
      </FormSection>

      <FormSection
        title="Medios de pago"
        columns="one"
        governs="Con qué se puede pagar en esta sede, y con qué código viaja cada medio al documento electrónico."
        reading={
          <>
            El cobro ofrece <b className="font-bold text-foreground tabular-nums">{values.payment_methods.length}</b>{" "}
            {values.payment_methods.length === 1 ? "medio de pago" : "medios de pago"}. El código DIAN es el que
            va impreso en el documento: si queda vacío, el documento sale sin él.
          </>
        }
      >
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
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="gap-1"
            onClick={() => patch({ payment_methods: [...values.payment_methods, emptyPaymentMethod()] })}
          >
            <Plus className="size-4" aria-hidden="true" />
            Agregar medio de pago
          </Button>
        </div>
      </FormSection>

      {/* Se ven como tres campos de texto aburridos y son los que llenan tres
          desplegables del salón. Sin marcas de alcance, nadie que mire esta
          pantalla lo sabría (patrón 10). */}
      <FormSection
        title="Los motivos tipados"
        governs="Las causas que el salón puede elegir cuando anula, descuenta o regala. Una por línea. No es texto libre: son las únicas opciones que el operador va a ver."
        reading={
          <>
            El salón tiene{" "}
            <b className="font-bold text-foreground tabular-nums">{values.void_reasons.length}</b> motivos para
            anular, <b className="font-bold text-foreground tabular-nums">{values.discount_reasons.length}</b>{" "}
            para descontar y{" "}
            <b className="font-bold text-foreground tabular-nums">{values.courtesy_reasons.length}</b> para dar
            cortesía. <b className="font-bold text-foreground">Una lista vacía deja el desplegable vacío</b>, y
            sin causa el servidor no deja completar la acción: el operador queda trabado sin entender por qué.
          </>
        }
        doesNotDo="Borrar un motivo de esta lista no toca lo ya registrado con él: los reportes siguen mostrando la causa que se eligió aquel día."
      >
        <FormField
          label="Motivos de anulación (uno por línea)"
          help="Aparecen al anular un ítem ya enviado a cocina, y son también las causas tipadas que reemplazan a «Sin identificar» en el cierre de turno."
          scope={{ affects: [{ screen: "Salón › Comanda › Anular", verb: "Llena el desplegable de" }] }}
        >
          {({ fieldId, describedBy }) => (
            <Textarea
              id={fieldId}
              aria-describedby={describedBy}
              value={listToLines(values.void_reasons)}
              onChange={(e) => patch({ void_reasons: linesToList(e.target.value) })}
            />
          )}
        </FormField>

        <FormField
          label="Motivos de descuento (uno por línea)"
          help="Aparecen al aplicar un descuento. Son los que después dejan separar «promoción» de «queja del cliente» en el reporte."
          scope={{ affects: [{ screen: "Salón › Comanda › Descuento", verb: "Llena el desplegable de" }] }}
        >
          {({ fieldId, describedBy }) => (
            <Textarea
              id={fieldId}
              aria-describedby={describedBy}
              value={listToLines(values.discount_reasons)}
              onChange={(e) => patch({ discount_reasons: linesToList(e.target.value) })}
            />
          )}
        </FormField>

        <FormField
          label="Motivos de cortesía (uno por línea)"
          help="Aparecen al regalar un plato. Distinguen la cortesía al cliente del consumo del personal, que no son lo mismo ni en el costo ni en el impuesto."
          scope={{ affects: [{ screen: "Salón › Comanda › Cortesía", verb: "Llena el desplegable de" }] }}
        >
          {({ fieldId, describedBy }) => (
            <Textarea
              id={fieldId}
              aria-describedby={describedBy}
              value={listToLines(values.courtesy_reasons)}
              onChange={(e) => patch({ courtesy_reasons: linesToList(e.target.value) })}
            />
          )}
        </FormField>

        <FormField
          label="Estaciones (una por línea)"
          help="A qué puesto de la cocina se manda cada plato. Sin estaciones, todo cae en una sola pantalla de cocina."
          scope={{ flag: "kitchen.view", affects: [{ screen: "Cocina y KDS", verb: "Reparte en" }] }}
        >
          {({ fieldId, describedBy }) => (
            <Textarea
              id={fieldId}
              aria-describedby={describedBy}
              value={listToLines(values.stations)}
              onChange={(e) => patch({ stations: linesToList(e.target.value) })}
            />
          )}
        </FormField>
      </FormSection>

      <FormSection
        title="Cursos y tiempo objetivo"
        columns="one"
        governs="En qué orden salen los platos de una mesa y cuánto debería tardar cada tanda. El tiempo objetivo es lo que pinta el semáforo de la cocina."
        reading={
          values.courses.length === 0 ? (
            <>Sin cursos, todos los platos de una comanda salen juntos y la cocina no tiene tandas que ordenar.</>
          ) : (
            <>
              La comanda se reparte en{" "}
              <b className="font-bold text-foreground tabular-nums">{values.courses.length}</b>{" "}
              {values.courses.length === 1 ? "curso" : "cursos"}: {values.courses.join(" · ")}. El tiempo objetivo
              no frena nada; pinta el semáforo de la cocina cuando se pasa.
            </>
          )
        }
      >
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="sales-courses" className="text-sm font-bold">
              Cursos (uno por línea)
            </Label>
            <Textarea id="sales-courses" value={listToLines(values.courses)} onChange={(e) => setCourses(e.target.value)} />
            <p className="text-xs leading-relaxed text-muted-foreground">
              Quitar un curso borra también su tiempo objetivo. Los platos ya enviados no cambian de curso.
            </p>
          </div>

          {values.courses.length > 0 ? (
            <fieldset className="space-y-2">
              <legend className="text-sm font-bold">Tiempo objetivo por curso (minutos)</legend>
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
                        patch({
                          course_target_minutes: {
                            ...values.course_target_minutes,
                            [course]: Number(e.target.value),
                          },
                        })
                      }
                    />
                  </div>
                ))}
              </div>
            </fieldset>
          ) : null}
        </div>
      </FormSection>

      {error ? (
        <p role="alert" className="text-sm font-medium text-destructive">
          {error}
        </p>
      ) : null}

      <SaveBar
        sectionName="Ventas"
        changes={cambios}
        saving={saving}
        onSave={() => void handleSave()}
        onDiscard={() => setValues(guardado)}
      />
    </div>
  );
}
